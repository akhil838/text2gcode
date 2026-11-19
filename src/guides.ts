/** Figma-style smart guides: edge/centre snapping between boxes and distance measurements. */
import type { BoxRender, TextBox } from "./page";

/** Axis-aligned rectangle in page mm (y down). */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A guide line [x1, y1, x2, y2] in page mm. */
export type GuideLine = [number, number, number, number];

export interface Measure {
  line: GuideLine;
  label: string;
  /** Where the label sits and which side of the line it goes. */
  at: [number, number];
  vertical: boolean;
}

/** Box size in mm: a fixed-width box's width, else its rendered ink; placeholder until rendered. */
export function boxSize(box: TextBox, render: BoxRender | undefined): [number, number] {
  const w = box.width ? box.width : render && render.width > 0 ? render.width : Math.max(20, box.size * 4);
  const h = render && render.height > 0 ? render.height : box.size * 1.4;
  return [w, h];
}

/** Bounding rectangle of a (possibly rotated) box placed at (x, y). */
export function boxRect(box: TextBox, render: BoxRender | undefined, x = box.x, y = box.y): Rect {
  const [w, h] = boxSize(box, render);
  const a = (box.rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [cx, cy] of [[0, 0], [w, 0], [0, h], [w, h]]) {
    xs.push(x + cx * cos - cy * sin);
    ys.push(y + cx * sin + cy * cos);
  }
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

const xLines = (r: Rect) => [r.left, (r.left + r.right) / 2, r.right];
const yLines = (r: Rect) => [r.top, (r.top + r.bottom) / 2, r.bottom];

/** Smallest rectangle containing all `rects`. */
export function unionRect(rects: Rect[]): Rect {
  return {
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}


function pageRect([pw, ph]: [number, number]): Rect {
  return { left: 0, top: 0, right: pw, bottom: ph };
}

/** Closest offset (within `threshold`) that aligns one of `own` with one of `targets`. */
function nearest(own: number[], targets: number[], threshold: number): number | null {
  let best: number | null = null;
  for (const s of own)
    for (const t of targets) {
      const d = t - s;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
  return best;
}

/** Offsets that snap `rect` onto other boxes' or the page's edges/centres; null = no match. */
export function smartSnap(rect: Rect, others: Rect[], page: [number, number], threshold: number): { dx: number | null; dy: number | null } {
  const all = [...others, pageRect(page)];
  return {
    dx: nearest(xLines(rect), all.flatMap(xLines), threshold),
    dy: nearest(yLines(rect), all.flatMap(yLines), threshold),
  };
}

const EPS = 0.01;

/** Guide lines for every edge/centre of `rect` that lines up exactly with another box or the page. */
export function alignGuides(rect: Rect, others: Rect[], page: [number, number]): GuideLine[] {
  const guides: GuideLine[] = [];
  const pr = pageRect(page);
  for (const o of [...others, pr]) {
    const span = o === pr ? [0, page[1]] : [Math.min(rect.top, o.top), Math.max(rect.bottom, o.bottom)];
    for (const x of xLines(rect)) if (xLines(o).some((t) => Math.abs(t - x) < EPS)) guides.push([x, span[0], x, span[1]]);
    const hspan = o === pr ? [0, page[0]] : [Math.min(rect.left, o.left), Math.max(rect.right, o.right)];
    for (const y of yLines(rect)) if (yLines(o).some((t) => Math.abs(t - y) < EPS)) guides.push([hspan[0], y, hspan[1], y]);
  }
  return guides;
}

const fmt = (mm: number) => (Math.round(mm * 10) / 10).toString();

/**
 * Distances from `rect` to the nearest box on each side (boxes that overlap it on the other
 * axis), or to the page edge when nothing is in the way.
 */
export function measure(rect: Rect, others: Rect[], page: [number, number]): Measure[] {
  const [pw, ph] = page;
  const out: Measure[] = [];
  const cy = (rect.top + rect.bottom) / 2;
  const cx = (rect.left + rect.right) / 2;
  const overlapY = (o: Rect) => o.top < rect.bottom && o.bottom > rect.top;
  const overlapX = (o: Rect) => o.left < rect.right && o.right > rect.left;
  const midY = (o: Rect) => (Math.max(o.top, rect.top) + Math.min(o.bottom, rect.bottom)) / 2;
  const midX = (o: Rect) => (Math.max(o.left, rect.left) + Math.min(o.right, rect.right)) / 2;

  const horizontal = (from: number, to: number, y: number) => {
    if (Math.abs(to - from) < 0.05) return;
    out.push({ line: [from, y, to, y], label: fmt(Math.abs(to - from)), at: [(from + to) / 2, y], vertical: false });
  };
  const vertical = (from: number, to: number, x: number) => {
    if (Math.abs(to - from) < 0.05) return;
    out.push({ line: [x, from, x, to], label: fmt(Math.abs(to - from)), at: [x, (from + to) / 2], vertical: true });
  };

  const left = others.filter((o) => overlapY(o) && o.right <= rect.left + EPS).sort((a, b) => b.right - a.right)[0];
  if (left) horizontal(left.right, rect.left, midY(left));
  else if (rect.left > 0) horizontal(0, rect.left, cy);

  const right = others.filter((o) => overlapY(o) && o.left >= rect.right - EPS).sort((a, b) => a.left - b.left)[0];
  if (right) horizontal(rect.right, right.left, midY(right));
  else if (rect.right < pw) horizontal(rect.right, pw, cy);

  const above = others.filter((o) => overlapX(o) && o.bottom <= rect.top + EPS).sort((a, b) => b.bottom - a.bottom)[0];
  if (above) vertical(above.bottom, rect.top, midX(above));
  else if (rect.top > 0) vertical(0, rect.top, cx);

  const below = others.filter((o) => overlapX(o) && o.top >= rect.bottom - EPS).sort((a, b) => a.top - b.top)[0];
  if (below) vertical(rect.bottom, below.top, midX(below));
  else if (rect.bottom < ph) vertical(rect.bottom, ph, cx);

  return out;
}
