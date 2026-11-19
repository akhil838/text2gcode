/**
 * The app's engine API. Everything runs in the browser: a Web Worker converts fonts and
 * writes files, and fonts are stored in IndexedDB. No server is involved.
 */
import type { Handlers } from "./engine/worker";
import type { ConvertOptions } from "./engine/convert";
import { logAction } from "./log";

export type { ConvertOptions };
export type Point = [number, number];
export type Stroke = Point[];

export interface FontSummary {
  id: string;
  name: string;
  filename: string;
  /** "outline": TTF/OTF converted to strokes; "stroke": a Hershey .jhf font, already single-stroke. */
  kind: "outline" | "stroke";
  scripts: string[];
  glyph_count: number;
}

export interface FontDetail extends FontSummary {
  options: ConvertOptions;
  units_per_em: number;
  ascender: number;
  descender: number;
  cap_height: number;
}

export type GlyphSheetData = Record<string, { advance: number; strokes: Stroke[] }>;

export interface RenderParams {
  font_id: string;
  text: string;
  height: number;
  line_spacing: number;
  letter_spacing: number;
  align: "left" | "center" | "right";
  optimize: boolean;
  /** Box width (mm) to wrap lines at; null grows the box to its longest line. */
  wrap_width: number | null;
}

export interface GcodeParams {
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

export interface StrokeStats {
  strokes: number;
  draw: number;
  travel: number;
  width: number;
  height: number;
}

export interface RenderResult {
  strokes: Stroke[];
  stats: StrokeStats;
  baseline: number;
  /** Box width in mm: the wrap width, or the ink width of an auto-width box. */
  frame_width: number;
}

export interface PageExport {
  strokes: Stroke[]; // mm, origin at the page's bottom-left, y up
  page: [number, number];
  format: "gcode" | "svg" | "dxf";
  gcode: GcodeParams;
  optimize: boolean;
  name: string;
}

const worker = new Worker(new URL("./engine/worker.ts", import.meta.url), { type: "module" });
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextId = 0;
worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
  const p = pending.get(e.data.id);
  if (!p) return;
  pending.delete(e.data.id);
  if (e.data.error !== undefined) p.reject(new Error(e.data.error));
  else p.resolve(e.data.result);
};

/** Call a worker method. An aborted signal rejects with AbortError (the worker still finishes). */
function call<K extends keyof Handlers>(method: K, args: Parameters<Handlers[K]>, signal?: AbortSignal): ReturnType<Handlers[K]> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  signal?.addEventListener("abort", () => {
    pending.delete(id);
    reject(new DOMException("Aborted", "AbortError"));
  });
  worker.postMessage({ id, method, args });
  return promise as ReturnType<Handlers[K]>;
}

export function saveText(text: string, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const api = {
  listFonts: () => call("listFonts", []),
  font: (id: string) => call("font", [id]) as Promise<FontDetail>,
  fontSheet: (id: string) => call("fontSheet", [id]) as Promise<GlyphSheetData>,
  fontFile: (id: string) => call("fontFile", [id]),
  /** `displayNames[i]`, when given, replaces the name read from `files[i]`. */
  async upload(files: File[], displayNames?: (string | undefined)[]) {
    const payload = await Promise.all(files.map(async (f, i) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), displayName: displayNames?.[i] })));
    const added = await call("addFonts", [payload]);
    for (const f of added) logAction("font added", `${f.name} (${f.filename}, id ${f.id})`);
    return added;
  },
  async remove(font: FontSummary) {
    await call("removeFont", [font.id]);
    logAction("font removed", `${font.name} (${font.filename}, id ${font.id})`);
  },
  async reconvert(id: string, options: ConvertOptions) {
    const detail = (await call("reconvert", [id, options])) as FontDetail;
    logAction("font reconverted", `${detail.name}: ${JSON.stringify(options)}`);
    return detail;
  },
  render: (params: RenderParams, signal?: AbortSignal) => call("render", [params], signal) as Promise<RenderResult>,
  plan: (strokes: Stroke[], optimize: boolean, signal?: AbortSignal) => call("plan", [strokes, optimize], signal),
  async exportPage(params: PageExport) {
    const file = await call("exportPage", [params]);
    saveText(file.text, file.filename, file.mime);
    logAction("page exported", `${file.filename} (${params.strokes.length} strokes)`);
  },
  async downloadFont(id: string, format: "jhf" | "svg" | "json") {
    const file = await call("downloadFont", [id, format]);
    saveText(file.text, file.filename, file.mime);
    logAction("stroke font downloaded", file.filename);
  },
};
