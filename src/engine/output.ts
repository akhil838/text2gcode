/** File writers: G-code / SVG / DXF toolpaths and Hershey .jhf / SVG font / JSON stroke fonts. */
import type { Poly } from "./geometry";
import { bounds, stats } from "./layout";

export interface GcodeOptions {
  mode: "z" | "laser" | "custom";
  feed: number;
  plunge_feed: number;
  z_safe: number;
  z_cut: number;
  spindle: number;
  laser_power: number;
  pen_up: string;
  pen_down: string;
  dwell: number;
  join: number;
}

const commands = (spec: string) =>
  spec
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean);

export function toGcode(strokes: Poly[], o: GcodeOptions, comment = "", decimals = 3): string {
  const num = (v: number) => {
    let t = v.toFixed(decimals);
    if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.$/, "");
    return t === "-0" ? "0" : t;
  };
  let up: string[];
  let down: string[];
  let start: string[];
  let end: string[];
  if (o.mode === "z") {
    up = [`G0 Z${num(o.z_safe)}`];
    down = [`G1 Z${num(o.z_cut)} F${num(o.plunge_feed)}`];
    start = [`G0 Z${num(o.z_safe)}`, ...(o.spindle ? [`M3 S${num(o.spindle)}`, "G4 P2"] : [])];
    end = [`G0 Z${num(o.z_safe)}`, ...(o.spindle ? ["M5"] : [])];
  } else if (o.mode === "laser") {
    up = ["M5"];
    down = [`M3 S${num(o.laser_power)}`];
    start = ["M5"];
    end = ["M5"];
  } else {
    if (!o.pen_up || !o.pen_down) throw new Error("Servo pen mode needs both pen-up and pen-down commands");
    up = commands(o.pen_up);
    down = commands(o.pen_down);
    start = [...up];
    end = [...up];
  }
  if (o.dwell > 0) {
    up = [...up, `G4 P${num(o.dwell)}`];
    down = [...down, `G4 P${num(o.dwell)}`];
  }

  const out = comment
    .split("\n")
    .filter(Boolean)
    .map((l) => `(${l.replace(/[()]/g, "")})`);
  out.push("G21 (mm)", "G90 (absolute)", "G17", ...start);
  let penDown = false;
  let last: [number, number] | null = null;
  for (const s of strokes) {
    if (penDown && last && Math.hypot(s[0][0] - last[0], s[0][1] - last[1]) <= o.join) {
      out.push(`G1 X${num(s[0][0])} Y${num(s[0][1])}`);
    } else {
      if (penDown) out.push(...up);
      out.push(`G0 X${num(s[0][0])} Y${num(s[0][1])}`, ...down, `G1 F${num(o.feed)}`);
      penDown = true;
    }
    for (const [x, y] of s.slice(1)) out.push(`G1 X${num(x)} Y${num(y)}`);
    last = s[s.length - 1];
  }
  if (penDown) out.push(...up);
  out.push(...end, "G0 X0 Y0", "M2");
  return out.join("\n") + "\n";
}

/** SVG in mm; with `page` the document is that sheet (origin bottom-left), else the bounding box + margin. */
export function toSvg(strokes: Poly[], strokeWidth = 0.3, page?: [number, number], margin = 2): string {
  let [lo, hi] = bounds(strokes);
  if (page) [lo, hi] = [[0, 0], page];
  else if (strokes.length) [lo, hi] = [[lo[0] - margin, lo[1] - margin], [hi[0] + margin, hi[1] + margin]];
  const w = hi[0] - lo[0];
  const h = hi[1] - lo[1];
  const paths = strokes.map((s) => `<path d="M${s.map(([x, y]) => `${x.toFixed(3)} ${(-y).toFixed(3)}`).join(" L")}"/>`);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(3)}mm" height="${h.toFixed(3)}mm" viewBox="${lo[0].toFixed(3)} ${(-hi[1]).toFixed(3)} ${w.toFixed(3)} ${h.toFixed(3)}">\n` +
    `<g fill="none" stroke="black" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">\n${paths.join("\n")}\n</g>\n</svg>\n`
  );
}

/** Minimal AutoCAD R12 DXF with one POLYLINE per stroke (units: mm). */
export function toDxf(strokes: Poly[]): string {
  const out = ["0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "9", "$INSUNITS", "70", "4", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"];
  for (const s of strokes) {
    const closed = s.length > 2 && Math.abs(s[0][0] - s[s.length - 1][0]) < 1e-9 && Math.abs(s[0][1] - s[s.length - 1][1]) < 1e-9;
    const pts = closed ? s.slice(0, -1) : s;
    out.push("0", "POLYLINE", "8", "0", "66", "1", "70", closed ? "1" : "0", "10", "0.0", "20", "0.0", "30", "0.0");
    for (const [x, y] of pts) out.push("0", "VERTEX", "8", "0", "10", x.toFixed(4), "20", y.toFixed(4), "30", "0.0");
    out.push("0", "SEQEND", "8", "0");
  }
  out.push("0", "ENDSEC", "0", "EOF");
  return out.join("\n") + "\n";
}

export function exportComment(strokes: Poly[], page: [number, number]): string {
  const st = stats(strokes);
  return `text2gcode page ${page[0]} x ${page[1]} mm, origin bottom-left\n${st.strokes} strokes, draw ${st.draw.toFixed(0)} mm, travel ${st.travel.toFixed(0)} mm`;
}

// --- stroke fonts --------------------------------------------------------------

export interface StrokeFont {
  name: string;
  units_per_em: number;
  ascender: number;
  descender: number;
  cap_height: number;
  x_height: number;
  glyphs: Record<string, { advance: number; strokes: Poly[] }>;
  /** Source font's notices: a converted font is a derivative and must keep them. */
  copyright?: string;
  license?: string;
  license_url?: string;
}

const R = "R".charCodeAt(0);
const HMIN = -49;
const HMAX = 44;
const BASELINE = 9; // Hershey Roman: caps span y = -12 .. 9

/** Hershey .jhf: ASCII 32..126, one glyph per line, coordinates as chars offset from 'R'. */
export function toJhf(font: StrokeFont, capHeight = 21): string {
  const glyphs = Array.from({ length: 95 }, (_, i) => font.glyphs[String.fromCharCode(32 + i)]);
  let scale = capHeight / font.cap_height;
  let xs = 1;
  let up = 1;
  let down = 1;
  for (const g of glyphs) {
    if (!g) continue;
    xs = Math.max(xs, g.advance / 2);
    for (const s of g.strokes)
      for (const [x, y] of s) {
        xs = Math.max(xs, Math.abs(x - g.advance / 2));
        if (y > 0) up = Math.max(up, y);
        else down = Math.max(down, -y);
      }
  }
  scale = Math.min(scale, Math.min(-HMIN, HMAX) / xs, (BASELINE - HMIN) / up, (HMAX - BASELINE) / down);
  const space = font.glyphs[" "]?.advance ?? font.units_per_em * 0.3;
  const clamp = (v: number) => Math.min(HMAX, Math.max(HMIN, v));
  const lines = glyphs.map((g, i) => {
    const half = ((g?.advance ?? space) * scale) / 2;
    const pairs = [String.fromCharCode(Math.round(-half) + R) + String.fromCharCode(Math.round(half) + R)];
    (g?.strokes ?? []).forEach((s, k) => {
      const pts: [number, number][] = [];
      for (const [x, y] of s) {
        const q: [number, number] = [clamp(Math.round(x * scale - half)), clamp(Math.round(BASELINE - y * scale))];
        if (!pts.length || pts[pts.length - 1][0] !== q[0] || pts[pts.length - 1][1] !== q[1]) pts.push(q);
      }
      if (pts.length === 1) pts.push(pts[0]);
      if (k && pairs.length > 1) pairs.push(" R");
      pairs.push(...pts.map(([x, y]) => String.fromCharCode(x + R) + String.fromCharCode(y + R)));
    });
    return `${String(32 + i).padStart(5)}${String(pairs.length).padStart(3)}${pairs.join("")}`;
  });
  return lines.join("\n") + "\n";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n1 = (v: number) => String(Math.round(v * 10) / 10);

/** SVG font (the format of Inkscape's Hershey Text extension). */
export function toSvgFont(font: StrokeFont): string {
  const id = font.name.replace(/[^A-Za-z0-9_-]/g, "") || "StrokeFont";
  const space = font.glyphs[" "]?.advance ?? font.units_per_em * 0.3;
  const glyphs = Object.entries(font.glyphs).map(([ch, g]) => {
    const d = g.strokes.length ? ` d="${g.strokes.map((s) => "M " + s.map(([x, y]) => `${n1(x)} ${n1(y)}`).join(" L ")).join(" ")}"` : "";
    const code = ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    return `<glyph unicode="${esc(ch)}" glyph-name="uni${code}" horiz-adv-x="${g.advance}"${d}/>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" version="1.1">',
    `<metadata>${[
      `Single-stroke font generated by text2gcode from ${esc(font.name)}.`,
      font.copyright && esc(font.copyright),
      font.license && esc(font.license),
      font.license_url && esc(font.license_url),
    ]
      .filter(Boolean)
      .join("\n")}</metadata>`,
    "<defs>",
    `<font id="${id}" horiz-adv-x="${space}">`,
    `<font-face font-family="${esc(font.name)}" units-per-em="${font.units_per_em}" ascent="${font.ascender}" descent="${font.descender}" cap-height="${font.cap_height}" x-height="${font.x_height}"/>`,
    `<missing-glyph horiz-adv-x="${space}"/>`,
    ...glyphs,
    "</font>",
    "</defs>",
    "</svg>",
    "",
  ].join("\n");
}

export function toJson(font: StrokeFont): string {
  return JSON.stringify({ format: "text2gcode-strokefont", version: 1, ...font });
}
