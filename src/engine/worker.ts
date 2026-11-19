/// <reference lib="webworker" />
/**
 * Conversion engine worker: owns the fonts (IndexedDB), converts glyphs, lays out text and
 * writes export files, so the page never blocks. Called through `api.ts`.
 *
 * Two kinds of font: outline fonts (TTF/OTF, shaped by HarfBuzz and converted to strokes) and
 * stroke fonts (classic Hershey .jhf, already single-stroke and used as they are).
 */
import { CHARSETS, DEFAULT_CONVERT, glyphStrokes, type ConvertOptions } from "./convert";
import { SourceFont, type FontLicense } from "./font";
import type { Point, Poly } from "./geometry";
import { HERSHEY_LICENSE, parseJhf } from "./hershey";
import { FontEngine, bounds, layoutShaped, layoutStrokeFont, orderPaths, stats } from "./layout";
import { exportComment, toDxf, toGcode, toJhf, toJson, toSvg, toSvgFont, type GcodeOptions, type StrokeFont } from "./output";
import { store, type StoredFont } from "./store";
import { isBundledFile } from "../bundled";

type Loaded =
  | { kind: "outline"; stored: StoredFont; name: string; engine: FontEngine; scripts: string[] }
  | { kind: "stroke"; stored: StoredFont; name: string; font: StrokeFont; scripts: string[] };

const fonts = new Map<string, Loaded>();

const OUTLINE_EXTENSIONS = [".ttf", ".otf", ".ttc", ".otc"];
const isStrokeFile = (filename: string) => filename.toLowerCase().endsWith(".jhf");
const stem = (filename: string) => filename.replace(/\.[^.]+$/, "");

function load(stored: StoredFont): Loaded {
  if (isStrokeFile(stored.filename)) {
    const name = stored.name ?? stem(stored.filename);
    return { kind: "stroke", stored, name, font: parseJhf(new TextDecoder().decode(stored.bytes), name), scripts: ["ascii"] };
  }
  const src = new SourceFont(stored.bytes, 0, stem(stored.filename));
  const scripts = ["ascii", "devanagari", "telugu"].filter((s) => [...CHARSETS[s]].filter((c) => src.unicodes.has(c.codePointAt(0)!)).length >= 20);
  return { kind: "outline", stored, name: stored.name ?? src.name, engine: new FontEngine(src, stored.options), scripts: scripts.length ? scripts : ["ascii"] };
}

const ready = (async () => {
  for (const stored of await store.fonts()) {
    try {
      fonts.set(stored.id, load(stored));
    } catch {
      /* a font that no longer loads is skipped */
    }
  }
})();

function get(id: string): Loaded {
  const f = fonts.get(id);
  if (!f) throw new Error("This font is no longer available");
  return f;
}

function summary(f: Loaded) {
  const glyphCount =
    f.kind === "stroke"
      ? Object.values(f.font.glyphs).filter((g) => g.strokes.length).length
      : f.scripts.reduce((n, s) => n + [...CHARSETS[s]].filter((c) => f.engine.src.glyphOf(c) !== undefined).length, 0);
  return { id: f.stored.id, name: f.name, filename: f.stored.filename, kind: f.kind, scripts: f.scripts, glyph_count: glyphCount };
}

const licenseOf = (f: Loaded): FontLicense => (f.kind === "stroke" ? HERSHEY_LICENSE : f.engine.src.license);

function detail(f: Loaded) {
  if (f.kind === "stroke") {
    const { font } = f;
    return { ...summary(f), options: DEFAULT_CONVERT, units_per_em: font.units_per_em, ascender: font.ascender, descender: font.descender, cap_height: font.cap_height };
  }
  const m = f.engine.src.metrics();
  return { ...summary(f), options: f.engine.options, units_per_em: f.engine.src.upm, ascender: m.ascender, descender: m.descender, cap_height: m.capHeight };
}

const round3 = (s: Poly) => s.map(([x, y]): Point => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);

/** Every glyph as strokes: a stroke font as is; an outline font converted (cached in IndexedDB per settings). */
async function sheet(f: Loaded): Promise<StrokeFont> {
  if (f.kind === "stroke") return f.font;
  const key = `${f.stored.id}|${JSON.stringify(f.engine.options)}`;
  const cached = await store.sheet(key);
  if (cached) return cached.font;
  const { src } = f.engine;
  const m = src.metrics();
  const font: StrokeFont = { name: f.name, units_per_em: src.upm, ascender: m.ascender, descender: m.descender, cap_height: m.capHeight, x_height: m.xHeight, glyphs: {} };
  for (const ch of new Set(f.scripts.flatMap((s) => [...CHARSETS[s]]))) {
    const gid = src.glyphOf(ch);
    if (gid === undefined) continue;
    const groupKey = `${gid}:0:0`;
    let strokes = f.engine.groups.get(groupKey);
    if (!strokes) {
      strokes = glyphStrokes(f.engine.outline(gid), src.upm, f.engine.options);
      f.engine.groups.set(groupKey, strokes);
    }
    font.glyphs[ch] = { advance: src.advance(gid), strokes: strokes.map(round3) };
  }
  await store.putSheet({ key, fontId: f.stored.id, font });
  return font;
}

async function sha12(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface RenderParams {
  font_id: string;
  text: string;
  height: number;
  line_spacing: number;
  letter_spacing: number;
  align: "left" | "center" | "right";
  optimize: boolean;
  /** Box width (mm) to wrap at; null for a box that grows to fit its longest line. */
  wrap_width?: number | null;
}

const handlers = {
  async listFonts() {
    await ready;
    return [...fonts.values()].sort((a, b) => a.stored.added - b.stored.added).map(summary);
  },

  /** `displayName` overrides the name read from the font (used for the bundled Hershey fonts). */
  async addFonts(files: { name: string; bytes: Uint8Array; displayName?: string }[]) {
    await ready;
    const added = [];
    for (const { name, bytes, displayName } of files) {
      if (!isStrokeFile(name) && !OUTLINE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) {
        throw new Error(`${name}: use a .ttf, .otf, .ttc or .otc font, or a Hershey .jhf font`);
      }
      const id = await sha12(bytes);
      let f = fonts.get(id);
      if (!f) {
        const stored: StoredFont = { id, filename: name, name: displayName, bytes, options: DEFAULT_CONVERT, added: Date.now() };
        try {
          f = load(stored);
        } catch (err) {
          throw new Error(`${name}: not a readable font (${err instanceof Error ? err.message : err})`);
        }
        await store.putFont(stored);
        fonts.set(id, f);
      }
      added.push(summary(f));
    }
    return added;
  },

  async removeFont(id: string) {
    const f = fonts.get(id);
    if (f && isBundledFile(f.stored.filename)) throw new Error(`${f.name} is a bundled font and cannot be removed`);
    fonts.delete(id);
    await store.removeFont(id);
    return { ok: true };
  },

  async font(id: string) {
    await ready;
    return detail(get(id));
  },

  async fontSheet(id: string) {
    await ready;
    return (await sheet(get(id))).glyphs;
  },

  /** The original font file, for drawing the outline behind the strokes (outline fonts only). */
  async fontFile(id: string) {
    await ready;
    const f = get(id);
    return f.kind === "outline" ? f.stored.bytes : null;
  },

  async reconvert(id: string, options: ConvertOptions) {
    await ready;
    if (get(id).kind === "stroke") throw new Error("Hershey fonts are already single-stroke; there is nothing to convert");
    const stored = { ...get(id).stored, options };
    await store.putFont(stored);
    const f = load(stored); // fresh engine: the stroke caches belong to the old settings
    fonts.set(id, f);
    return detail(f);
  },

  /**
   * Strokes of one text box: mm, y up, bottom of the ink at y = 0, plus the first baseline
   * height and the box width. An auto-width box starts at its ink's left edge; a wrapping box
   * keeps x from its own left edge, so alignment holds within the box.
   */
  async render(p: RenderParams) {
    await ready;
    const f = get(p.font_id);
    const opts = { height: p.height, lineSpacing: p.line_spacing, letterSpacing: p.letter_spacing, align: p.align, wrapWidth: p.wrap_width };
    let strokes = f.kind === "stroke" ? layoutStrokeFont(f.font, p.text, opts) : layoutShaped(f.engine, p.text, opts);
    const [lo] = bounds(strokes);
    const baseline = strokes.length ? -lo[1] : 0;
    const dx = p.wrap_width ? 0 : lo[0];
    strokes = strokes.map((s) => s.map(([x, y]): Point => [x - dx, y - lo[1]]));
    if (p.optimize) strokes = orderPaths(strokes);
    const st = stats(strokes);
    return { strokes: strokes.map(round3), stats: st, baseline: Math.round(baseline * 1000) / 1000, frame_width: p.wrap_width || st.width };
  },

  /** Order page strokes for the machine (exactly what export emits) and report stats. */
  async plan(strokes: Poly[], optimize: boolean) {
    const ordered = optimize ? orderPaths(strokes) : strokes;
    return { strokes: ordered, stats: stats(ordered) };
  },

  async exportPage(p: { strokes: Poly[]; page: [number, number]; format: "gcode" | "svg" | "dxf"; gcode: GcodeOptions; optimize: boolean; name: string }) {
    const strokes = p.optimize ? orderPaths(p.strokes) : p.strokes;
    const name = p.name.replace(/[^A-Za-z0-9_-]/g, "-") || "page";
    if (p.format === "svg") return { filename: `${name}.svg`, mime: "image/svg+xml", text: toSvg(strokes, 0.3, p.page) };
    if (p.format === "dxf") return { filename: `${name}.dxf`, mime: "application/dxf", text: toDxf(strokes) };
    return { filename: `${name}.gcode`, mime: "text/plain", text: toGcode(strokes, p.gcode, exportComment(strokes, p.page)) };
  },

  async downloadFont(id: string, format: "jhf" | "svg" | "json") {
    await ready;
    const f = get(id);
    const license = licenseOf(f);
    // The source font's notices travel with the converted font (.jhf has no place for them).
    const font: StrokeFont = { ...(await sheet(f)), copyright: license.copyright || undefined, license: license.license || undefined, license_url: license.licenseUrl || undefined };
    const name = f.name.replace(/[^A-Za-z0-9_-]/g, "-") || "font";
    const text = format === "jhf" ? toJhf(font) : format === "svg" ? toSvgFont(font) : toJson(font);
    const mime = { jhf: "text/plain", svg: "image/svg+xml", json: "application/json" }[format];
    return { filename: `${name}-hershey.${format}`, mime, text };
  },
};

export type Handlers = typeof handlers;

self.onmessage = async (e: MessageEvent<{ id: number; method: keyof Handlers; args: unknown[] }>) => {
  const { id, method, args } = e.data;
  try {
    const result = await (handlers[method] as (...a: unknown[]) => unknown)(...args);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
