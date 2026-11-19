/** Raster steps of the pipeline: fill, distance transform, blur, despeckle, thinning. */
import type { Poly } from "./geometry";

/**
 * Fill closed polygons (pixel coordinates, y down) with the nonzero winding rule.
 * Pixel (row, col) is inside when its centre (col + 0.5, row + 0.5) has nonzero winding.
 */
export function rasterizeNonzero(contours: Poly[], w: number, h: number): Uint8Array {
  const stride = w + 1;
  const delta = new Int32Array(h * stride);
  for (const c of contours) {
    if (c.length < 3) continue;
    for (let i = 0; i < c.length; i++) {
      const [x0, y0] = c[i];
      const [x1, y1] = c[(i + 1) % c.length];
      if (y0 === y1) continue;
      const dir = y1 > y0 ? 1 : -1;
      const r0 = Math.min(h, Math.max(0, Math.ceil(Math.min(y0, y1) - 0.5)));
      const r1 = Math.min(h, Math.max(0, Math.ceil(Math.max(y0, y1) - 0.5)));
      for (let row = r0; row < r1; row++) {
        const t = (row + 0.5 - y0) / (y1 - y0);
        const xc = x0 + t * (x1 - x0);
        const col = Math.min(w, Math.max(0, Math.ceil(xc - 0.5)));
        delta[row * stride + col] += dir;
      }
    }
  }
  const mask = new Uint8Array(w * h);
  for (let row = 0; row < h; row++) {
    let winding = 0;
    for (let col = 0; col < w; col++) {
      winding += delta[row * stride + col];
      mask[row * w + col] = winding !== 0 ? 1 : 0;
    }
  }
  return mask;
}

const BIG = 1e20;

/** 1-D squared distance transform (Felzenszwalb & Huttenlocher) of f[0..n) into d. */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
  }
}

/** Exact Euclidean distance from every ink pixel to the nearest background pixel (as scipy's edt). */
export function distanceTransform(mask: Uint8Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] ? BIG : 0;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let col = 0; col < w; col++) {
    for (let row = 0; row < h; row++) f[row] = out[row * w + col];
    edt1d(f, h, d, v, z);
    for (let row = 0; row < h; row++) out[row * w + col] = d[row];
  }
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) f[col] = out[row * w + col];
    edt1d(f, w, d, v, z);
    for (let col = 0; col < w; col++) out[row * w + col] = Math.sqrt(d[col]);
  }
  return out;
}

/** Gaussian blur of a 0/1 mask then threshold at 0.5 (scipy gaussian_filter: truncate 4, mode reflect). */
export function blurThreshold(mask: Uint8Array, w: number, h: number, sigma: number): Uint8Array {
  const radius = Math.floor(4 * sigma + 0.5);
  const kernel = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    kernel[i + radius] = Math.exp((-0.5 * i * i) / (sigma * sigma));
    sum += kernel[i + radius];
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const reflect = (i: number, n: number) => {
    // scipy "reflect": d c b a | a b c d | d c b a
    const period = 2 * n;
    let m = ((i % period) + period) % period;
    if (m >= n) m = period - 1 - m;
    return m;
  };
  const tmp = new Float32Array(w * h);
  for (let row = 0; row < h; row++)
    for (let col = 0; col < w; col++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += kernel[k + radius] * mask[reflect(row + k, h) * w + col];
      tmp[row * w + col] = acc;
    }
  const out = new Uint8Array(w * h);
  for (let row = 0; row < h; row++)
    for (let col = 0; col < w; col++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += kernel[k + radius] * tmp[row * w + reflect(col + k, w)];
      out[row * w + col] = acc > 0.5 ? 1 : 0;
    }
  return out;
}

/** Connected components of `on` pixels; 4- or 8-connected. Labels start at 1; returns [labels, count]. */
export function label(on: (i: number) => boolean, w: number, h: number, eight: boolean): [Int32Array, number] {
  const labels = new Int32Array(w * h);
  const stack: number[] = [];
  let count = 0;
  for (let start = 0; start < w * h; start++) {
    if (labels[start] || !on(start)) continue;
    count++;
    labels[start] = count;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const r = (p / w) | 0;
      const c = p - r * w;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          if ((!dr && !dc) || (!eight && dr && dc)) continue;
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
          const q = rr * w + cc;
          if (!labels[q] && on(q)) {
            labels[q] = count;
            stack.push(q);
          }
        }
    }
  }
  return [labels, count];
}

/** Fill enclosed holes and remove ink islands smaller than `minArea` pixels. */
export function despeckle(mask: Uint8Array, w: number, h: number, minArea: number): Uint8Array {
  if (minArea <= 0) return mask;
  const out = mask.slice();
  const [holes, nh] = label((i) => !mask[i], w, h, false);
  if (nh) {
    const sizes = new Int32Array(nh + 1);
    for (let i = 0; i < holes.length; i++) sizes[holes[i]]++;
    const border = new Set<number>();
    for (let c = 0; c < w; c++) border.add(holes[c]).add(holes[(h - 1) * w + c]);
    for (let r = 0; r < h; r++) border.add(holes[r * w]).add(holes[r * w + w - 1]);
    for (let i = 0; i < holes.length; i++) {
      const l = holes[i];
      if (l && !border.has(l) && sizes[l] < minArea) out[i] = 1;
    }
  }
  const [islands, ni] = label((i) => out[i] === 1, w, h, true);
  if (ni) {
    const sizes = new Int32Array(ni + 1);
    for (let i = 0; i < islands.length; i++) sizes[islands[i]]++;
    for (let i = 0; i < islands.length; i++) if (islands[i] && sizes[islands[i]] < minArea) out[i] = 0;
  }
  return out;
}

// Zhang-Suen lookup table, exactly as scikit-image's _fast_skeletonize. 1 and 3 are removed in
// the first sub-pass, 2 and 3 in the second.
// From scikit-image (skimage/morphology/_skeletonize_various_cy.pyx, v0.26.0):
// Copyright (C) 2019, the scikit-image team. BSD-3-Clause, https://github.com/scikit-image/scikit-image/blob/main/LICENSE.txt
const LUT = new Uint8Array([
  0, 0, 0, 1, 0, 0, 1, 3, 0, 0, 3, 1, 1, 0, 1, 3, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 3, 0, 3, 3,
  0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 3, 0, 2, 2,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 3, 0, 2, 0,
  0, 0, 3, 1, 0, 0, 1, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
  3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  2, 3, 1, 3, 0, 0, 1, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  2, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 0, 1, 0, 0, 0, 0, 2, 2, 0, 0, 2, 0, 0, 0,
]);

/** One-pixel-wide skeleton (scikit-image `skeletonize`, Zhang-Suen with its lookup table). */
export function skeletonize(mask: Uint8Array, w: number, h: number): Uint8Array {
  const W = w + 2;
  const H = h + 2;
  let skel = new Uint8Array(W * H);
  for (let r = 0; r < h; r++) skel.set(mask.subarray(r * w, r * w + w), (r + 1) * W + 1);
  const cleaned = skel.slice();
  let removed = true;
  while (removed) {
    removed = false;
    for (let pass = 0; pass < 2; pass++) {
      const first = pass === 0;
      for (let r = 1; r < H - 1; r++) {
        const o = r * W;
        for (let c = 1; c < W - 1; c++) {
          const i = o + c;
          if (!skel[i]) continue;
          const n =
            LUT[
              skel[i - W - 1] +
                2 * skel[i - W] +
                4 * skel[i - W + 1] +
                8 * skel[i + 1] +
                16 * skel[i + W + 1] +
                32 * skel[i + W] +
                64 * skel[i + W - 1] +
                128 * skel[i - 1]
            ];
          if (n === 0) continue;
          if (n === 3 || (n === 1 && first) || (n === 2 && !first)) {
            cleaned[i] = 0;
            removed = true;
          }
        }
      }
      skel = cleaned.slice();
    }
  }
  const out = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) out.set(skel.subarray((r + 1) * W + 1, (r + 1) * W + 1 + w), r * w);
  return out;
}
