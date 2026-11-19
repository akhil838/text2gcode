/** Polyline helpers. */

export type Point = [number, number];
export type Poly = Point[];

export const dist = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);

export function polylineLength(p: Poly): number {
  let total = 0;
  for (let i = 1; i < p.length; i++) total += dist(p[i - 1], p[i]);
  return total;
}

/** Point at arc length `d` from p[0] (clamped to the last point). */
export function pointAtDistance(p: Poly, d: number): Point {
  let travelled = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    const seg = dist(a, b);
    if (travelled + seg >= d && seg > 0) {
      const t = (d - travelled) / seg;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    travelled += seg;
  }
  return p[p.length - 1];
}

/** Binomial [1 2 1]/4 smoothing; open polylines keep their end points fixed. */
export function smooth(p: Poly, passes: number, closed: boolean): Poly {
  if (passes <= 0 || p.length < 3) return p;
  if (closed) {
    const first = p[0];
    const last = p[p.length - 1];
    let ring = Math.abs(first[0] - last[0]) < 1e-8 && Math.abs(first[1] - last[1]) < 1e-8 ? p.slice(0, -1) : p.slice();
    if (ring.length < 3) return p;
    const n = ring.length;
    for (let k = 0; k < passes; k++) {
      const next: Poly = new Array(n);
      for (let i = 0; i < n; i++) {
        const a = ring[(i - 1 + n) % n];
        const b = ring[i];
        const c = ring[(i + 1) % n];
        next[i] = [(a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4];
      }
      ring = next;
    }
    return [...ring, ring[0]];
  }
  let cur = p;
  for (let k = 0; k < passes; k++) {
    const next = cur.slice();
    for (let i = 1; i < cur.length - 1; i++) {
      next[i] = [(cur[i - 1][0] + 2 * cur[i][0] + cur[i + 1][0]) / 4, (cur[i - 1][1] + 2 * cur[i][1] + cur[i + 1][1]) / 4];
    }
    cur = next;
  }
  return cur;
}

/** Ramer-Douglas-Peucker simplification (iterative). */
export function rdp(p: Poly, eps: number): Poly {
  const n = p.length;
  if (n < 3 || eps <= 0) return p;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    if (j <= i + 1) continue;
    const a = p[i];
    const b = p[j];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const len = Math.hypot(abx, aby);
    let best = -1;
    let bestD = -1;
    for (let k = i + 1; k < j; k++) {
      const q = p[k];
      const d = len === 0 ? Math.hypot(q[0] - a[0], q[1] - a[1]) : Math.abs(abx * (q[1] - a[1]) - aby * (q[0] - a[0])) / len;
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    if (bestD > eps) {
      keep[best] = 1;
      stack.push([i, best], [best, j]);
    }
  }
  return p.filter((_, k) => keep[k]);
}

/** Greedy nearest-neighbour ordering; open strokes may be reversed to cut travel. */
export function orderStrokes(strokes: Poly[], start: Point): Poly[] {
  const remaining = strokes.slice();
  const ordered: Poly[] = [];
  let cur = start;
  while (remaining.length) {
    let bestI = 0;
    let bestRev = false;
    let bestD = Infinity;
    remaining.forEach((s, i) => {
      const d0 = dist(s[0], cur);
      if (d0 < bestD) [bestI, bestRev, bestD] = [i, false, d0];
      const d1 = dist(s[s.length - 1], cur);
      if (d1 < bestD) [bestI, bestRev, bestD] = [i, true, d1];
    });
    let s = remaining.splice(bestI, 1)[0];
    if (bestRev) s = s.slice().reverse();
    ordered.push(s);
    cur = s[s.length - 1];
  }
  return ordered;
}
