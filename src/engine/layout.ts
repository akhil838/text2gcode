/** Text layout (shaped outline fonts and single-stroke fonts), stroke ordering and statistics. */
import { glyphStrokes, type ConvertOptions } from "./convert";
import type { SourceFont } from "./font";
import type { Point, Poly } from "./geometry";
import type { StrokeFont } from "./output";

export interface LayoutOptions {
  height: number; // cap height in output units (mm)
  lineSpacing: number; // baseline-to-baseline, multiple of the em
  letterSpacing: number; // extra space between glyphs, fraction of the em
  align: "left" | "center" | "right";
  /** Box width in output units: lines wrap at word boundaries and align within it. Null: no wrapping. */
  wrapWidth?: number | null;
}

/**
 * Split `text` into display lines: hard breaks always; with `width`, greedy word wrap using
 * `measure` (output units). A word wider than the box stays on its own line.
 */
function wrapLines(text: string, width: number | null | undefined, measure: (s: string) => number): string[] {
  const paragraphs = text.replace(/\t/g, "    ").split("\n");
  if (!width) return paragraphs;
  return paragraphs.flatMap((paragraph) => {
    const lines: string[] = [];
    let current = "";
    for (const token of paragraph.split(/(\s+)/)) {
      if (!token) continue;
      const candidate = current + token;
      if (current.trim() && !/^\s+$/.test(token) && measure(candidate.trimEnd()) > width) {
        lines.push(current.trimEnd());
        current = token;
      } else {
        current = candidate;
      }
    }
    lines.push(current.trimEnd());
    return lines;
  });
}

/** Horizontal offset of a line of width `w` in a frame of width `frame`. */
const alignOffset = (align: LayoutOptions["align"], frame: number, w: number) => (align === "center" ? (frame - w) / 2 : align === "right" ? frame - w : 0);

export interface StrokeStats {
  strokes: number;
  draw: number;
  travel: number;
  width: number;
  height: number;
}

/** A font plus the caches that make repeated layout cheap (valid for one set of convert options). */
export class FontEngine {
  readonly outlines = new Map<number, Poly[]>();
  readonly groups = new Map<string, Poly[]>();
  constructor(
    readonly src: SourceFont,
    readonly options: ConvertOptions,
  ) {}

  outline(gid: number): Poly[] {
    let o = this.outlines.get(gid);
    if (!o) {
      o = this.src.outline(gid);
      this.outlines.set(gid, o);
    }
    return o;
  }
}

/**
 * Shape and skeletonize `text`. Glyphs whose outlines overlap horizontally (cursive joins,
 * the Devanagari headline) are skeletonized together so the join becomes one stroke.
 * Returns strokes in output units, first baseline at y = 0, y up.
 */
export function layoutShaped(engine: FontEngine, text: string, opts: LayoutOptions): Poly[] {
  const { src } = engine;
  const upm = src.upm;
  const scale = opts.height / src.metrics().capHeight;

  const strokesFor = (gids: number[], offsets: Point[]): Poly[] => {
    const [bx, by] = offsets[0];
    const parts = gids.map((gid, i) => [gid, Math.round(offsets[i][0] - bx), Math.round(offsets[i][1] - by)] as const);
    const key = parts.map((p) => p.join(":")).join("|");
    let local = engine.groups.get(key);
    if (!local) {
      const contours = parts.flatMap(([gid, dx, dy]) => engine.outline(gid).map((c) => c.map(([x, y]): Point => [x + dx, y + dy])));
      local = glyphStrokes(contours, upm, engine.options);
      engine.groups.set(key, local);
    }
    return local.map((s) => s.map(([x, y]): Point => [x + bx, y + by]));
  };

  const lines: [Poly[], number][] = [];
  const lineWidth = (s: string) => src.shape(s).reduce((w, g) => w + g.xAdvance + opts.letterSpacing * upm, 0) * scale;
  wrapLines(text, opts.wrapWidth, lineWidth).forEach((line, row) => {
      if (!line) {
        lines.push([[], 0]); // an empty line still takes up its line pitch
        return;
      }
      const y = -row * opts.lineSpacing * upm;
      let x = 0;
      const placed: { gid: number; off: Point; xmin: number; xmax: number }[] = [];
      for (const g of src.shape(line)) {
        const off: Point = [x + g.xOffset, y + g.yOffset];
        const contours = engine.outline(g.gid);
        if (contours.length) {
          let xmin = Infinity;
          let xmax = -Infinity;
          for (const c of contours) for (const [px] of c) [xmin, xmax] = [Math.min(xmin, px + off[0]), Math.max(xmax, px + off[0])];
          placed.push({ gid: g.gid, off, xmin, xmax });
        }
        x += g.xAdvance + opts.letterSpacing * upm;
      }
      // Horizontally overlapping glyphs are skeletonized as one image.
      placed.sort((a, b) => a.xmin - b.xmin);
      const groups: (typeof placed)[] = [];
      for (const item of placed) {
        const last = groups[groups.length - 1];
        if (last && item.xmin < Math.max(...last.map((g) => g.xmax))) last.push(item);
        else groups.push([item]);
      }
      const strokes = groups.flatMap((grp) =>
        strokesFor(
          grp.map((g) => g.gid),
          grp.map((g) => g.off),
        ).map((s) => s.map(([px, py]): Point => [px * scale, py * scale])),
      );
      lines.push([strokes, x * scale]);
    });

  const frame = opts.wrapWidth ?? Math.max(0, ...lines.map(([, w]) => w));
  return lines.flatMap(([strokes, w]) => strokes.map((s) => s.map(([px, py]): Point => [px + alignOffset(opts.align, frame, w), py])));
}

export function bounds(strokes: Poly[]): [Point, Point] {
  let lo: Point = [Infinity, Infinity];
  let hi: Point = [-Infinity, -Infinity];
  for (const s of strokes)
    for (const [x, y] of s) {
      lo = [Math.min(lo[0], x), Math.min(lo[1], y)];
      hi = [Math.max(hi[0], x), Math.max(hi[1], y)];
    }
  return strokes.length ? [lo, hi] : [
    [0, 0],
    [0, 0],
  ];
}

/**
 * Per-character layout for a single-stroke font (no shaping): glyph advances only.
 * Characters the font lacks use its '?' glyph, or a space when it has none.
 * Returns strokes in output units, first baseline at y = 0, y up.
 */
export function layoutStrokeFont(font: StrokeFont, text: string, opts: LayoutOptions): Poly[] {
  const scale = opts.height / font.cap_height;
  const space = font.glyphs[" "]?.advance ?? font.units_per_em * 0.3;
  const glyph = (ch: string) => font.glyphs[ch] ?? (ch === " " ? undefined : font.glyphs["?"]);
  const step = (ch: string) => (glyph(ch)?.advance ?? space) + opts.letterSpacing * font.units_per_em;
  const lineWidth = (s: string) => [...s].reduce((w, ch) => w + step(ch), 0) * scale;
  const lines: [Poly[], number][] = wrapLines(text, opts.wrapWidth, lineWidth).map((line, row) => {
    const y = -row * opts.lineSpacing * font.units_per_em;
    let x = 0;
    const strokes: Poly[] = [];
    for (const ch of line) {
      const g = glyph(ch);
      if (g) strokes.push(...g.strokes.map((s) => s.map(([px, py]): Point => [(px + x) * scale, (py + y) * scale])));
      x += step(ch);
    }
    return [strokes, x * scale];
  });
  const frame = opts.wrapWidth ?? Math.max(0, ...lines.map(([, w]) => w));
  return lines.flatMap(([strokes, w]) => strokes.map((s) => s.map(([px, py]): Point => [px + alignOffset(opts.align, frame, w), py])));
}

/** Greedy nearest-neighbour order over all strokes from `start`; open strokes may be reversed. */
export function orderPaths(strokes: Poly[], start: Point = [0, 0]): Poly[] {
  const left = strokes.slice();
  const out: Poly[] = [];
  let cur = start;
  while (left.length) {
    let bestI = 0;
    let bestRev = false;
    let bestD = Infinity;
    for (let i = 0; i < left.length; i++) {
      const s = left[i];
      const d0 = Math.hypot(s[0][0] - cur[0], s[0][1] - cur[1]);
      if (d0 < bestD) [bestI, bestRev, bestD] = [i, false, d0];
      const e = s[s.length - 1];
      const d1 = Math.hypot(e[0] - cur[0], e[1] - cur[1]);
      if (d1 < bestD) [bestI, bestRev, bestD] = [i, true, d1];
    }
    let s = left.splice(bestI, 1)[0];
    if (bestRev) s = s.slice().reverse();
    out.push(s);
    cur = s[s.length - 1];
  }
  return out;
}

export function stats(strokes: Poly[]): StrokeStats {
  let draw = 0;
  let travel = 0;
  strokes.forEach((s, i) => {
    for (let k = 1; k < s.length; k++) draw += Math.hypot(s[k][0] - s[k - 1][0], s[k][1] - s[k - 1][1]);
    if (i > 0) {
      const p = strokes[i - 1][strokes[i - 1].length - 1];
      travel += Math.hypot(s[0][0] - p[0], s[0][1] - p[1]);
    }
  });
  const [lo, hi] = bounds(strokes);
  return { strokes: strokes.length, draw, travel, width: hi[0] - lo[0], height: hi[1] - lo[1] };
}
