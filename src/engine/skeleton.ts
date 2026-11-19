/**
 * Skeleton → graph → strokes.
 * Coordinates are raster pixels (x, y), y down; pixel (row, col) is centred at (col + .5, row + .5).
 */
import { pointAtDistance, polylineLength, type Point, type Poly } from "./geometry";
import { label } from "./raster";

interface Node {
  pos: Point;
  radius: number; // distance-transform value: half the local stroke width
  terminal: boolean; // stroke end produced by collapsing a terminal fork
}

interface Edge {
  u: number;
  v: number;
  interior: Point[]; // pixel centres strictly between u and v, ordered u -> v
}

/** (edge id, true = the edge's `u` end) */
type End = [number, boolean];
const endKey = (e: End) => `${e[0]}:${e[1] ? 1 : 0}`;

export interface Chain {
  points: Poly;
  closed: boolean;
  startTip: boolean;
  endTip: boolean;
}

export interface Dot {
  center: Point;
  radius: number;
}

export function sample(field: ArrayLike<number>, w: number, h: number, p: Point): number {
  const row = Math.floor(p[1]);
  const col = Math.floor(p[0]);
  return row >= 0 && row < h && col >= 0 && col < w ? field[row * w + col] : 0;
}

export class SkeletonGraph {
  nodes = new Map<number, Node>();
  edges = new Map<number, Edge>();
  private next = 0;

  addNode(pos: Point, radius: number): number {
    const id = ++this.next;
    this.nodes.set(id, { pos, radius, terminal: false });
    return id;
  }

  addEdge(u: number, v: number, interior: Point[]): number {
    const id = ++this.next;
    this.edges.set(id, { u, v, interior });
    return id;
  }

  ends(n: number): End[] {
    const out: End[] = [];
    for (const [id, e] of this.edges) {
      if (e.u === n) out.push([id, true]);
      if (e.v === n) out.push([id, false]);
    }
    return out;
  }

  degree(n: number): number {
    return this.ends(n).length;
  }

  polyline(id: number, fromU = true): Poly {
    const e = this.edges.get(id)!;
    const pts: Poly = [this.nodes.get(e.u)!.pos, ...e.interior, this.nodes.get(e.v)!.pos];
    return fromU ? pts : pts.reverse();
  }

  length(id: number): number {
    return polylineLength(this.polyline(id));
  }
}

const OFFSETS: [number, number][] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

/** 8-connected adjacency, minus diagonal links already covered by a 4-connected detour. */
function pixelAdjacency(sk: Uint8Array, w: number, h: number): Map<number, number[]> {
  const on = (r: number, c: number) => r >= 0 && c >= 0 && r < h && c < w && sk[r * w + c] === 1;
  const adj = new Map<number, number[]>();
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      if (!sk[r * w + c]) continue;
      const nb: number[] = [];
      for (const [dr, dc] of OFFSETS) {
        if (!on(r + dr, c + dc)) continue;
        if (dr && dc && (on(r + dr, c) || on(r, c + dc))) continue;
        nb.push((r + dr) * w + c + dc);
      }
      adj.set(r * w + c, nb);
    }
  return adj;
}

export function traceSkeleton(sk: Uint8Array, dist: Float64Array, w: number, h: number): SkeletonGraph {
  const adj = pixelAdjacency(sk, w, h);
  const xy = (p: number): Point => [(p % w) + 0.5, Math.floor(p / w) + 0.5];
  const g = new SkeletonGraph();
  const nodeOf = new Map<number, number>();

  // Junction pixels (degree >= 3) that touch each other form one junction node.
  const junction = new Set([...adj].filter(([, nb]) => nb.length >= 3).map(([p]) => p));
  const seen = new Set<number>();
  for (const p of junction) {
    if (seen.has(p)) continue;
    const cluster: number[] = [];
    const stack = [p];
    seen.add(p);
    while (stack.length) {
      const q = stack.pop()!;
      cluster.push(q);
      for (const nb of adj.get(q)!)
        if (junction.has(nb) && !seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
    }
    const pts = cluster.map(xy);
    const mean: Point = [pts.reduce((a, q) => a + q[0], 0) / pts.length, pts.reduce((a, q) => a + q[1], 0) / pts.length];
    const nid = g.addNode(mean, Math.max(...cluster.map((q) => dist[q])));
    for (const q of cluster) nodeOf.set(q, nid);
  }
  for (const [p, nb] of adj) if (nb.length <= 1) nodeOf.set(p, g.addNode(xy(p), dist[p]));

  const usedSteps = new Set<string>();
  const visited = new Set<number>();
  for (const [p, nid] of nodeOf) {
    for (const q of adj.get(p)!) {
      if (usedSteps.has(`${p}>${q}`) || nodeOf.get(q) === nid) continue;
      usedSteps.add(`${p}>${q}`);
      const interior: Point[] = [];
      let prev = p;
      let cur = q;
      while (!nodeOf.has(cur)) {
        interior.push(xy(cur));
        visited.add(cur);
        const next = adj.get(cur)!.find((n) => n !== prev)!;
        prev = cur;
        cur = next;
      }
      usedSteps.add(`${cur}>${prev}`);
      g.addEdge(nid, nodeOf.get(cur)!, interior);
    }
  }

  // Whatever is left are closed loops without any junction (e.g. the letter O).
  for (const [p, nb] of adj) {
    if (nodeOf.has(p) || visited.has(p)) continue;
    visited.add(p);
    const nid = g.addNode(xy(p), dist[p]);
    const interior: Point[] = [];
    let prev = p;
    let cur = nb[0];
    while (cur !== p) {
      interior.push(xy(cur));
      visited.add(cur);
      const next = adj.get(cur)!.find((n) => n !== prev)!;
      prev = cur;
      cur = next;
    }
    g.addEdge(nid, nid, interior);
  }
  return g;
}

/**
 * Replace compact ink blobs (periods, i-dots) by dots: a blob whose bounding box's long
 * side is at most `factor` times its stroke width. Its skeleton is removed from the graph.
 */
export function extractDots(g: SkeletonGraph, mask: Uint8Array, dist: Float64Array, w: number, h: number, factor: number): Dot[] {
  const [labels, count] = label((i) => mask[i] === 1, w, h, true);
  const boxes = Array.from({ length: count + 1 }, () => ({ r0: Infinity, r1: -Infinity, c0: Infinity, c1: -Infinity, radius: 0 }));
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (!l) continue;
    const r = Math.floor(i / w);
    const c = i - r * w;
    const b = boxes[l];
    b.r0 = Math.min(b.r0, r);
    b.r1 = Math.max(b.r1, r + 1);
    b.c0 = Math.min(b.c0, c);
    b.c1 = Math.max(b.c1, c + 1);
    b.radius = Math.max(b.radius, dist[i]);
  }

  const parent = new Map<number, number>([...g.nodes.keys()].map((n) => [n, n]));
  const find = (a: number): number => {
    while (parent.get(a) !== a) {
      parent.set(a, parent.get(parent.get(a)!)!);
      a = parent.get(a)!;
    }
    return a;
  };
  for (const e of g.edges.values()) parent.set(find(e.u), find(e.v));
  const components = new Map<number, number[]>();
  for (const n of g.nodes.keys()) {
    const root = find(n);
    components.set(root, [...(components.get(root) ?? []), n]);
  }

  const dots: Dot[] = [];
  for (const nodes of components.values()) {
    const lab = nodes.map((n) => sample(labels, w, h, g.nodes.get(n)!.pos)).find((l) => l) ?? 0;
    if (!lab) continue;
    const b = boxes[lab];
    if (Math.max(b.r1 - b.r0, b.c1 - b.c0) > factor * 2 * b.radius) continue;
    dots.push({ center: [(b.c0 + b.c1) / 2, (b.r0 + b.r1) / 2], radius: b.radius });
    const members = new Set(nodes);
    for (const [id, e] of [...g.edges]) if (members.has(e.u)) g.edges.delete(id);
    for (const n of nodes) g.nodes.delete(n);
  }
  return dots;
}

const look = (node: Node) => Math.max(3, 1.5 * node.radius);

function direction(g: SkeletonGraph, end: End, distance: number): Point {
  const pl = g.polyline(end[0], end[1]);
  const p = pointAtDistance(pl, distance);
  const d: Point = [p[0] - pl[0][0], p[1] - pl[0][1]];
  const n = Math.hypot(d[0], d[1]);
  return n > 1e-9 ? [d[0] / n, d[1] / n] : d;
}

const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];

/** A spur is a short dead end near a junction; terminals left by a collapsed fork never are. */
function isSpurTip(g: SkeletonGraph, tip: number, junction: Node, factor: number): boolean {
  const node = g.nodes.get(tip)!;
  return g.degree(tip) === 1 && !node.terminal && Math.hypot(node.pos[0] - junction.pos[0], node.pos[1] - junction.pos[1]) < factor * junction.radius;
}

/** Collapse terminal forks: a stroke that ends in two short diverging spurs (square/slanted ends). */
function pruneForks(g: SkeletonGraph, factor: number): boolean {
  let changed = false;
  for (const nid of [...g.nodes.keys()]) {
    const node = g.nodes.get(nid);
    if (!node) continue;
    const ends = g.ends(nid);
    if (ends.length !== 3) continue;
    const spurs: [End, number][] = [];
    for (const end of ends) {
      const e = g.edges.get(end[0])!;
      const other = end[1] ? e.v : e.u;
      if (other !== nid && isSpurTip(g, other, node, factor)) spurs.push([end, other]);
    }
    if (spurs.length !== 2) continue;
    const [[e1, tip1], [e2, tip2]] = spurs;
    const p1 = g.nodes.get(tip1)!.pos;
    const p2 = g.nodes.get(tip2)!.pos;
    if (Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) >= factor * node.radius) continue; // too far apart for one terminal
    const main = ends.find((e) => endKey(e) !== endKey(e1) && endKey(e) !== endKey(e2))!;
    const l = look(node);
    const mainDir = direction(g, main, l);
    const d1 = direction(g, e1, l);
    const d2 = direction(g, e2, l);
    if (Math.min(dot(d1, mainDir), dot(d2, mainDir)) < -0.94) continue; // one "spur" continues the main stroke
    const bis: Point = [d1[0] + d2[0], d1[1] + d2[1]];
    const norm = Math.hypot(bis[0], bis[1]);
    if (norm < 1e-9 || dot([bis[0] / norm, bis[1] / norm], mainDir) > -0.5) continue; // spurs don't point away
    for (const [[eid], tip] of spurs) {
      g.edges.delete(eid);
      g.nodes.delete(tip);
    }
    node.terminal = true;
    changed = true;
  }
  return changed;
}

/** Drop short tip branches near a junction, unless they continue another branch straight through it. */
function pruneSpurs(g: SkeletonGraph, factor: number): boolean {
  let changed = false;
  const candidates = [...g.edges].filter(([, e]) => e.u !== e.v).map(([id]) => id);
  candidates.sort((a, b) => g.length(a) - g.length(b));
  for (const id of candidates) {
    const e = g.edges.get(id);
    if (!e) continue;
    const du = g.degree(e.u);
    const dv = g.degree(e.v);
    let tip: number;
    let junction: number;
    if (du === 1 && dv >= 3) [tip, junction] = [e.u, e.v];
    else if (dv === 1 && du >= 3) [tip, junction] = [e.v, e.u];
    else continue;
    const j = g.nodes.get(junction)!;
    if (!isSpurTip(g, tip, j, factor)) continue;
    const l = look(j);
    const spurEnd: End = [id, e.u === junction];
    const spurDir = direction(g, spurEnd, l);
    if (g.ends(junction).some((end) => endKey(end) !== endKey(spurEnd) && dot(spurDir, direction(g, end, l)) < -0.94)) continue;
    g.edges.delete(id);
    g.nodes.delete(tip);
    changed = true;
  }
  return changed;
}

/** Merge two junctions joined by a very short edge (e.g. the split centre of an X). */
function contractShort(g: SkeletonGraph, factor: number): boolean {
  let changed = false;
  const ids = [...g.edges.keys()].sort((a, b) => g.length(a) - g.length(b));
  for (const id of ids) {
    const e = g.edges.get(id);
    if (!e || e.u === e.v) continue;
    const a = g.nodes.get(e.u)!;
    const b = g.nodes.get(e.v)!;
    if (g.degree(e.u) < 3 || g.degree(e.v) < 3) continue;
    if (g.length(id) >= factor * Math.max(a.radius, b.radius)) continue;
    const keep = e.u;
    const gone = e.v;
    g.edges.delete(id);
    a.pos = [(a.pos[0] + b.pos[0]) / 2, (a.pos[1] + b.pos[1]) / 2];
    a.radius = Math.max(a.radius, b.radius);
    for (const other of g.edges.values()) {
      if (other.u === gone) other.u = keep;
      if (other.v === gone) other.v = keep;
    }
    g.nodes.delete(gone);
    changed = true;
  }
  return changed;
}

function mergeDegree2(g: SkeletonGraph): boolean {
  let changed = false;
  for (const nid of [...g.nodes.keys()]) {
    const ends = g.ends(nid);
    if (ends.length !== 2 || ends[0][0] === ends[1][0]) continue;
    const [[ea, aAtU], [eb, bAtU]] = ends;
    const a = g.edges.get(ea)!;
    const b = g.edges.get(eb)!;
    // a runs x -> nid, b runs nid -> y
    const aPts = aAtU ? a.interior.slice().reverse() : a.interior;
    const x = aAtU ? a.v : a.u;
    const bPts = bAtU ? b.interior : b.interior.slice().reverse();
    const y = bAtU ? b.v : b.u;
    g.addEdge(x, y, [...aPts, g.nodes.get(nid)!.pos, ...bPts]);
    g.edges.delete(ea);
    g.edges.delete(eb);
    g.nodes.delete(nid);
    changed = true;
  }
  return changed;
}

export function simplifyGraph(g: SkeletonGraph, prune: number, fork: number, contract: number) {
  for (let i = 0; i < 100; i++) {
    let changed = pruneForks(g, fork);
    changed = pruneSpurs(g, prune) || changed;
    changed = contractShort(g, contract) || changed;
    changed = mergeDegree2(g) || changed;
    if (!changed) return;
  }
}

/** Join edges through junctions, pairing the straightest continuations first (X → 2 strokes, T → bar + stem). */
export function extractChains(g: SkeletonGraph): Chain[] {
  const pair = new Map<string, End>();
  for (const [nid, node] of g.nodes) {
    const ends = g.ends(nid);
    if (ends.length < 2) continue;
    const l = look(node);
    const dirs = ends.map((e) => direction(g, e, l));
    const scored: [number, number, number][] = [];
    for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) scored.push([dot(dirs[i], dirs[j]), i, j]);
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const taken = new Set<number>();
    for (const [, i, j] of scored) {
      if (taken.has(i) || taken.has(j)) continue;
      pair.set(endKey(ends[i]), ends[j]);
      pair.set(endKey(ends[j]), ends[i]);
      taken.add(i).add(j);
    }
  }

  const visited = new Set<number>();
  const chains: Chain[] = [];
  const nodeAt = (end: End) => {
    const e = g.edges.get(end[0])!;
    return end[1] ? e.u : e.v;
  };
  const walk = (start: End) => {
    const pts: Poly = [];
    let cur: End = start;
    let exit: End;
    let next: End | undefined;
    while (true) {
      const [id, fromU] = cur;
      visited.add(id);
      const pl = g.polyline(id, fromU);
      pts.push(...(pts.length ? pl.slice(1) : pl));
      exit = [id, !fromU];
      next = pair.get(endKey(exit));
      if (!next || visited.has(next[0])) break;
      cur = next;
    }
    chains.push({
      points: pts,
      closed: next !== undefined && endKey(next) === endKey(start),
      startTip: !pair.has(endKey(start)) && g.degree(nodeAt(start)) === 1,
      endTip: !pair.has(endKey(exit)) && g.degree(nodeAt(exit)) === 1,
    });
  };

  for (const nid of g.nodes.keys())
    for (const end of g.ends(nid)) if (!pair.has(endKey(end)) && !visited.has(end[0])) walk(end);
  for (const id of [...g.edges.keys()]) if (!visited.has(id)) walk([id, true]);
  for (const [nid, node] of g.nodes) if (g.degree(nid) === 0) chains.push({ points: [node.pos, node.pos], closed: false, startTip: false, endTip: false });
  return chains;
}
