/** Outline fonts in the browser via HarfBuzz (WebAssembly): outlines, metrics and shaping. */
import * as hb from "harfbuzzjs";
import type { Point, Poly } from "./geometry";

export interface ShapedGlyph {
  gid: number;
  xAdvance: number;
  xOffset: number;
  yOffset: number;
}

export interface FontMetrics {
  ascender: number;
  descender: number;
  capHeight: number;
  xHeight: number;
}

/** Licensing fields from the font's own `name` table (empty when the font omits them). */
export interface FontLicense {
  copyright: string; // name ID 0
  designer: string; // name ID 9
  license: string; // name ID 13, licence description
  licenseUrl: string; // name ID 14
}

export class SourceFont {
  readonly upm: number;
  readonly name: string;
  readonly license: FontLicense;
  readonly unicodes: Set<number>;
  private readonly font: hb.Font;
  private readonly draw: hb.DrawFuncs;
  // flattening state shared by the draw callbacks
  private contours: Poly[] = [];
  private current: Poly = [];
  private step = 1;

  constructor(bytes: Uint8Array, faceIndex = 0, fallbackName = "Font") {
    const face = new hb.Face(new hb.Blob(bytes), faceIndex);
    this.font = new hb.Font(face);
    this.upm = face.upem;
    this.name = face.getName(4, "en") || face.getName(1, "en") || fallbackName;
    const field = (id: number) => (face.getName(id, "en") || "").trim();
    this.license = { copyright: field(0), designer: field(9), license: field(13), licenseUrl: field(14) };
    this.unicodes = new Set(face.collectUnicodes());

    const segments = (pts: Point[]) => {
      let length = 0;
      for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      return Math.max(2, Math.min(64, Math.ceil(length / this.step)));
    };
    const last = (): Point => this.current[this.current.length - 1];
    this.draw = new hb.DrawFuncs();
    this.draw.setMoveToFunc((x, y) => {
      this.current = [[x, y]];
      this.contours.push(this.current);
    });
    this.draw.setLineToFunc((x, y) => {
      this.current.push([x, y]);
    });
    this.draw.setQuadraticToFunc((cx, cy, x, y) => {
      const p0 = last();
      const n = segments([p0, [cx, cy], [x, y]]);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const mt = 1 - t;
        const a = mt * mt;
        const b = 2 * mt * t;
        const c = t * t;
        this.current.push([a * p0[0] + b * cx + c * x, a * p0[1] + b * cy + c * y]);
      }
    });
    this.draw.setCubicToFunc((c1x, c1y, c2x, c2y, x, y) => {
      const p0 = last();
      const n = segments([p0, [c1x, c1y], [c2x, c2y], [x, y]]);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const mt = 1 - t;
        const a = mt ** 3;
        const b = 3 * mt * mt * t;
        const c = 3 * mt * t * t;
        const d = t ** 3;
        this.current.push([a * p0[0] + b * c1x + c * c2x + d * x, a * p0[1] + b * c1y + c * c2y + d * y]);
      }
    });
    this.draw.setClosePathFunc(() => {
      const cur = this.current;
      if (cur.length > 1 && cur[0][0] === cur[cur.length - 1][0] && cur[0][1] === cur[cur.length - 1][1]) cur.pop();
      this.current = [];
    });
  }

  glyphOf(ch: string): number | undefined {
    const cp = ch.codePointAt(0)!;
    if (!this.unicodes.has(cp)) return undefined;
    const gid = this.font.nominalGlyph(cp);
    return gid ? gid : undefined;
  }

  /** Flattened contours of a glyph in font units (y up). */
  outline(gid: number): Poly[] {
    this.contours = [];
    this.current = [];
    this.step = this.upm / 150;
    this.font.drawGlyph(gid, this.draw);
    return this.contours.filter((c) => c.length >= 3);
  }

  advance(gid: number): number {
    return this.font.glyphHAdvance(gid);
  }

  private top(ch: string): number | undefined {
    const gid = this.glyphOf(ch);
    const ext = gid === undefined ? undefined : this.font.glyphExtents(gid);
    return ext && ext.height !== 0 ? ext.yBearing : undefined;
  }

  metrics(): FontMetrics {
    const ext = this.font.hExtents();
    const cap = this.font.getMetricPosition(hb.MetricsTag.CAP_HEIGHT);
    const xh = this.font.getMetricPosition(hb.MetricsTag.X_HEIGHT);
    const capHeight = cap && cap > 0 ? cap : this.top("H") ?? ext.ascender * 0.7;
    const xHeight = xh && xh > 0 ? xh : this.top("x") ?? capHeight * 0.7;
    return { ascender: ext.ascender, descender: ext.descender, capHeight, xHeight };
  }

  /** Shape one line of text (ligatures, conjuncts, matras, kerning). */
  shape(text: string): ShapedGlyph[] {
    const buf = new hb.Buffer();
    buf.addText(text);
    buf.guessSegmentProperties();
    hb.shape(this.font, buf);
    const infos = buf.getGlyphInfos();
    const positions = buf.getGlyphPositions();
    return infos.map((info, i) => ({ gid: info.codepoint, xAdvance: positions[i].xAdvance, xOffset: positions[i].xOffset, yOffset: positions[i].yOffset }));
  }
}
