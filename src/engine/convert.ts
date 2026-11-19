/** Outline glyph → single-stroke centreline glyph. */
import { orderStrokes, pointAtDistance, polylineLength, rdp, smooth, type Point, type Poly } from "./geometry";
import { blurThreshold, despeckle, distanceTransform, rasterizeNonzero, skeletonize } from "./raster";
import { extractChains, extractDots, sample, simplifyGraph, traceSkeleton } from "./skeleton";

export interface ConvertOptions {
  resolution: number; // raster pixels per em
  prune: number; // spur pruning: tip within prune × junction radius is dropped
  fork: number; // terminal forks: both arms within fork × junction radius are dropped
  contract: number; // merge junctions closer than contract × junction radius
  smooth: number; // smoothing passes over the pixel centreline
  simplify: number; // Douglas-Peucker tolerance, fraction of the em
  extend: boolean; // re-aim free stroke ends and extend them to the outline
  dot: number; // blobs no longer than dot × stroke width become dots
  denoise: number; // Gaussian blur of the ink (sigma, fraction of the em) for rough fonts
  speck: number; // fill holes / drop specks smaller than (speck em)²
}

export const DEFAULT_CONVERT: ConvertOptions = {
  resolution: 600,
  prune: 1.6,
  fork: 3,
  contract: 1,
  smooth: 4,
  simplify: 0.002,
  extend: true,
  dot: 1.5,
  denoise: 0,
  speck: 0.02,
};

const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => String.fromCodePoint(a + i)).join("");
export const CHARSETS: Record<string, string> = {
  ascii: range(32, 127),
  latin1: range(32, 127) + range(160, 256),
  devanagari: range(0x0900, 0x0980),
  telugu: range(0x0c00, 0x0c80),
};

function inside(mask: Uint8Array, w: number, h: number, q: Point): boolean {
  const row = Math.floor(q[1]);
  const col = Math.floor(q[0]);
  return row >= 0 && row < h && col >= 0 && col < w && mask[row * w + col] === 1;
}

/** Remove the last `length` of arc from p. */
function trimEnd(p: Poly, length: number): Poly {
  let remaining = length;
  for (let i = p.length - 1; i > 0; i--) {
    const seg = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    if (seg >= remaining) {
      const cut: Point = seg > 0 ? [p[i][0] + ((p[i - 1][0] - p[i][0]) * remaining) / seg, p[i][1] + ((p[i - 1][1] - p[i][1]) * remaining) / seg] : p[i];
      return [...p.slice(0, i), cut];
    }
    remaining -= seg;
  }
  return p.slice(0, 1);
}

/**
 * Re-aim the last point of p and push it out to the outline: skeleton ends hook into terminal
 * corners, so drop the last half stroke width and continue along the remaining tangent.
 */
function retipEnd(p: Poly, mask: Uint8Array, w: number, h: number, halfWidth: number): Poly {
  const trimmed = trimEnd(p, Math.min(halfWidth, polylineLength(p) / 3));
  const end = trimmed[trimmed.length - 1];
  const back = pointAtDistance(trimmed.slice().reverse(), Math.max(3, halfWidth));
  let dx = end[0] - back[0];
  let dy = end[1] - back[1];
  const n = Math.hypot(dx, dy);
  if (n < 1e-6) return p;
  dx /= n;
  dy /= n;
  let t = 0;
  const step = 0.5;
  const reach = 4 * halfWidth;
  while (t + step <= reach && inside(mask, w, h, [end[0] + dx * (t + step), end[1] + dy * (t + step)])) t += step;
  return t >= step ? [...trimmed, [end[0] + dx * t, end[1] + dy * t]] : trimmed;
}

const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Centreline strokes (font units, y up) for one glyph outline (or several overlapping ones). */
export function glyphStrokes(contours: Poly[], upm: number, opts: ConvertOptions): Poly[] {
  if (!contours.length) return [];
  const s = opts.resolution / upm;
  const sigma = opts.denoise * opts.resolution;
  const pad = 4 + Math.ceil(3 * sigma);
  let xmin = Infinity;
  let ymin = Infinity;
  let xmax = -Infinity;
  let ymax = -Infinity;
  for (const c of contours)
    for (const [x, y] of c) {
      xmin = Math.min(xmin, x);
      xmax = Math.max(xmax, x);
      ymin = Math.min(ymin, y);
      ymax = Math.max(ymax, y);
    }
  const w = Math.ceil((xmax - xmin) * s) + 2 * pad;
  const h = Math.ceil((ymax - ymin) * s) + 2 * pad;
  const px = contours.map((c) => c.map(([x, y]): Point => [(x - xmin) * s + pad, (ymax - y) * s + pad]));
  let mask = rasterizeNonzero(px, w, h);
  if (sigma > 0) mask = blurThreshold(mask, w, h, sigma);
  mask = despeckle(mask, w, h, (opts.speck * opts.resolution) ** 2);
  if (!mask.some((v) => v)) return [];
  const dist = distanceTransform(mask, w, h);
  const graph = traceSkeleton(skeletonize(mask, w, h), dist, w, h);
  const dots = extractDots(graph, mask, dist, w, h, opts.dot);
  simplifyGraph(graph, opts.prune, opts.fork, opts.contract);

  const tolerance = opts.simplify * opts.resolution;
  const strokesPx: Poly[] = [];
  for (const chain of extractChains(graph)) {
    let p = smooth(chain.points, opts.smooth, chain.closed);
    if (opts.extend && !chain.closed && p.length >= 2) {
      const halfWidth = median(p.map((q) => sample(dist, w, h, q)));
      if (chain.endTip) p = retipEnd(p, mask, w, h, halfWidth);
      if (chain.startTip) p = retipEnd(p.slice().reverse(), mask, w, h, halfWidth).reverse();
    }
    strokesPx.push(rdp(p, tolerance));
  }
  for (const d of dots) {
    const r = Math.max(0.5 * d.radius, 1);
    const circle: Poly = [];
    for (let i = 0; i <= 8; i++) {
      const a = (i / 8) * 2 * Math.PI;
      circle.push([d.center[0] + r * Math.cos(a), d.center[1] + r * Math.sin(a)]);
    }
    strokesPx.push(circle);
  }
  const strokes = strokesPx
    .filter((p) => p.length >= 2)
    .map((p) => p.map(([x, y]): Point => [(x - pad) / s + xmin, ymax - (y - pad) / s]));
  return orderStrokes(strokes, [xmin, ymax]);
}
