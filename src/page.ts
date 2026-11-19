import type { Stroke } from "./api";

export const PAGE_SIZES = {
  A5: [148, 210],
  A4: [210, 297],
  A3: [297, 420],
  Letter: [215.9, 279.4],
} as const;
export type PageSizeKey = keyof typeof PAGE_SIZES | "custom";

export type BackgroundKind = "blank" | "ruled" | "grid" | "dots" | "graph";
export const BACKGROUNDS: { value: BackgroundKind; label: string }[] = [
  { value: "blank", label: "Blank" },
  { value: "ruled", label: "Ruled" },
  { value: "grid", label: "Grid" },
  { value: "dots", label: "Dots" },
  { value: "graph", label: "Graph" },
];
/** Typical pitch (mm) for each background when the user switches to it. */
export const DEFAULT_SPACING: Record<BackgroundKind, number> = { blank: 5, ruled: 8, grid: 5, dots: 5, graph: 10 };

export interface PageSettings {
  size: PageSizeKey;
  custom: [number, number];
  landscape: boolean;
  background: BackgroundKind;
  spacing: number; // mm between lines / grid cells
  margin: number; // mm: ruled paper's top margin and red margin line
  snap: boolean;
}

export const DEFAULT_PAGE: PageSettings = {
  size: "A4",
  custom: [200, 100],
  landscape: true,
  background: "ruled",
  spacing: 8,
  margin: 25,
  snap: true,
};

export function pageDims(p: PageSettings): [number, number] {
  const [w, h] = p.size === "custom" ? p.custom : PAGE_SIZES[p.size];
  return p.landscape ? [Math.max(w, h), Math.min(w, h)] : [Math.min(w, h), Math.max(w, h)];
}

/** A text box on the page. Position is its top-left corner in page mm (y down). */
export interface TextBox {
  id: string;
  fontId: string | null;
  text: string;
  size: number; // cap height, mm
  lineSpacing: number;
  letterSpacing: number;
  align: "left" | "center" | "right";
  x: number;
  y: number;
  rotation: number; // degrees, clockwise on screen
  /** Box width in mm; lines wrap to fit it. Null/absent: the box grows to its longest line. */
  width?: number | null;
}

/** Server-rendered strokes of one box: mm, y up, bounding box from (0,0) to (width,height). */
export interface BoxRender {
  key: string;
  strokes: Stroke[];
  width: number;
  height: number;
  baseline: number; // first baseline, mm above the box's bottom edge
  error?: string;
}

export function newBox(fontId: string | null, text: string, x: number, y: number, size = 8): TextBox {
  return { id: crypto.randomUUID(), fontId, text, size, lineSpacing: 1.25, letterSpacing: 0, align: "left", x, y, rotation: 0, width: null };
}

/** Box strokes in machine coordinates: mm, origin at the page's bottom-left, y up. */
export function boxToMachine(box: TextBox, render: BoxRender, pageHeight: number): Stroke[] {
  const a = (box.rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return render.strokes.map((s) =>
    s.map(([sx, sy]) => {
      const ly = render.height - sy; // box-local, y down
      const px = box.x + sx * cos - ly * sin;
      const py = box.y + sx * sin + ly * cos;
      return [px, pageHeight - py] as [number, number];
    }),
  );
}

/** Snap a dragged box: first baseline onto ruled lines, or the corner onto the grid. */
export function snapPosition(x: number, y: number, render: BoxRender | undefined, page: PageSettings): [number, number] {
  if (!page.snap || page.background === "blank") return [x, y];
  if (page.background === "ruled") {
    if (!render || render.height === 0) return [x, y];
    const baselineOffset = render.height - render.baseline;
    const lineY = page.margin + Math.round((y + baselineOffset - page.margin) / page.spacing) * page.spacing;
    return [x, lineY - baselineOffset];
  }
  const step = page.background === "graph" ? 1 : page.spacing;
  return [Math.round(x / step) * step, Math.round(y / step) * step];
}

const STORAGE_KEY = "ttf2hershey.page.v1";

export interface SavedState {
  page: PageSettings;
  boxes: TextBox[];
}

export function loadState(): SavedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SavedState;
    return { page: { ...DEFAULT_PAGE, ...data.page }, boxes: data.boxes ?? [] };
  } catch {
    return null;
  }
}

export function saveState(state: SavedState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
