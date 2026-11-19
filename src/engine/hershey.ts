/** Read classic Hershey `.jhf` stroke fonts (already single-stroke: no conversion needed). */
import type { Point } from "./geometry";
import type { StrokeFont } from "./output";
import type { FontLicense } from "./font";

/** The acknowledgements the Hershey font licence requires to travel with the font data. */
export const HERSHEY_LICENSE: FontLicense = {
  copyright: "The Hershey Fonts were originally created by Dr. A. V. Hershey while working at the U. S. National Bureau of Standards (1967).",
  designer: "Dr. A. V. Hershey",
  license:
    "The format of the font data in this distribution was originally created by James Hurt, Cognition, Inc. " +
    "This distribution of the Hershey Fonts may be used by anyone for any purpose, commercial or otherwise, providing that these acknowledgements are distributed with the font data, " +
    "and the font data is not converted into the format distributed by the U.S. NTIS.",
  licenseUrl: "",
};

const R = "R".charCodeAt(0);

/**
 * Parse a .jhf file. Each glyph: 5-char number, 3-char vertex count (including the margin
 * pair), left/right margins, then coordinate pairs as characters offset from 'R'; " R" lifts
 * the pen; long glyphs may wrap onto following lines. Glyph i is ASCII 32 + i; anything past
 * '~' (these files carry a 96th glyph at DEL) is ignored.
 * Returns font units with the origin on the baseline at the glyph's left margin, y up.
 */
export function parseJhf(text: string, name: string): StrokeFont {
  const lines = text.split(/\r?\n/);
  const raw: { ch: string; advance: number; strokes: Point[][] }[] = [];
  let i = 0;
  while (i < lines.length && raw.length < 95) {
    const line = lines[i++];
    if (!line.trim()) continue;
    const count = Number.parseInt(line.slice(5, 8), 10);
    if (!Number.isFinite(count) || count < 1) throw new Error(`not a Hershey .jhf file (line ${i})`);
    let data = line.slice(8);
    while (data.length < 2 * count && i < lines.length) data += lines[i++];
    const left = data.charCodeAt(0) - R;
    const right = data.charCodeAt(1) - R;
    const strokes: Point[][] = [];
    let current: Point[] = [];
    for (let k = 1; k < count; k++) {
      const pair = data.slice(2 * k, 2 * k + 2);
      if (pair === " R") {
        if (current.length) strokes.push(current);
        current = [];
      } else {
        current.push([pair.charCodeAt(0) - R - left, pair.charCodeAt(1) - R]);
      }
    }
    if (current.length) strokes.push(current);
    raw.push({ ch: String.fromCharCode(32 + raw.length), advance: right - left, strokes });
  }
  if (!raw.length) throw new Error("empty .jhf file");

  // Hershey y points down. Find the baseline and cap height from 'H' (fonts differ in scale).
  const ys = (ch: string) => raw.find((g) => g.ch === ch)?.strokes.flat().map(([, y]) => y) ?? [];
  const hYs = ys("H");
  const baseline = hYs.length ? Math.max(...hYs) : 9;
  const capHeight = hYs.length ? baseline - Math.min(...hYs) : 21;
  const xYs = ys("x");
  const xHeight = xYs.length ? baseline - Math.min(...xYs) : capHeight * 0.7;

  const glyphs: StrokeFont["glyphs"] = {};
  let ascender = capHeight;
  let descender = 0;
  for (const g of raw) {
    const strokes = g.strokes.map((s) => s.map(([x, y]): Point => [x, baseline - y]));
    for (const [, y] of strokes.flat()) [ascender, descender] = [Math.max(ascender, y), Math.min(descender, y)];
    // A single-point stroke (a dot) is drawn as a zero-length segment.
    glyphs[g.ch] = { advance: g.advance, strokes: strokes.map((s) => (s.length === 1 ? [s[0], s[0]] : s)) };
  }
  return { name, units_per_em: Math.round(capHeight / 0.7), ascender, descender, cap_height: capHeight, x_height: xHeight, glyphs };
}
