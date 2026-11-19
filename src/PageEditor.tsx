import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ActionIcon, Stack, Tooltip } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { IconFocusCentered, IconZoomIn, IconZoomOut } from "@tabler/icons-react";
import { Group, Label, Layer, Line, Rect, Shape, Stage, Tag, Text, Transformer } from "react-konva";
import type Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import type { Stroke } from "./api";
import { alignGuides, boxRect, boxSize, intersects, measure, smartSnap, unionRect, type GuideLine, type Measure, type Rect as Box } from "./guides";
import { snapPosition, type BoxRender, type PageSettings, type TextBox } from "./page";

export interface PageEditorProps {
  page: PageSettings;
  dims: [number, number]; // page width, height in mm
  boxes: TextBox[];
  renders: Record<string, BoxRender>;
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  /** Commit changed boxes as one undo step; edits sharing `key` within a second merge. */
  onChange: (boxes: TextBox[], key?: string) => void;
  onEdit: (id: string) => void;
  /** "move" selects and drags boxes (drag on empty canvas = selection rectangle); "hand" pans. */
  tool: "move" | "hand";
  /** Machine-ordered page strokes (mm, origin bottom-left) for travel display and simulation. */
  planned: Stroke[] | null;
  progress: number | null;
  showTravel: boolean;
  /** Receives the pointer position in page mm (y down) while it is over the page area. */
  pointerRef: RefObject<[number, number] | null>;
  height: number;
  /** Pixels covered by floating panels on the left / top; "fit" centers the page in the rest. */
  insetLeft?: number;
  insetTop?: number;
  insetBottom?: number;
  insetRight?: number;
  /** Floating controls shown above the selected boxes (hidden while dragging or resizing). */
  selectionToolbar?: ReactNode;
}

const INK = "#1d2a6e";
const PAPER = "#fffdf8";
const GUIDE = "#f03e3e"; // alignment guides
const MEASURE = "#e8590c"; // distance lines and labels
const MIN_SCALE = 0.3;
const MAX_SCALE = 40;

interface View {
  scale: number; // px per mm
  x: number;
  y: number;
}

function Background({ page, dims }: { page: PageSettings; dims: [number, number] }) {
  const [w, h] = dims;
  const { background, spacing, margin } = page;
  if (background === "blank") return null;
  if (background === "ruled") {
    return (
      <>
        <Shape
          listening={false}
          stroke="#9cc3e6"
          strokeWidth={1}
          strokeScaleEnabled={false}
          sceneFunc={(ctx, shape) => {
            ctx.beginPath();
            for (let y = margin; y <= h - 4; y += spacing) {
              ctx.moveTo(0, y);
              ctx.lineTo(w, y);
            }
            ctx.strokeShape(shape);
          }}
        />
        <Line listening={false} points={[margin, 0, margin, h]} stroke="#e8908f" strokeWidth={1.2} strokeScaleEnabled={false} />
      </>
    );
  }
  if (background === "dots") {
    return (
      <Shape
        listening={false}
        fill="#a9b4c2"
        sceneFunc={(ctx, shape) => {
          ctx.beginPath();
          for (let x = spacing; x < w; x += spacing)
            for (let y = spacing; y < h; y += spacing) {
              ctx.moveTo(x + 0.3, y);
              ctx.arc(x, y, 0.3, 0, Math.PI * 2);
            }
          ctx.fillShape(shape);
        }}
      />
    );
  }
  const grid = (step: number, color: string, width: number) => (
    <Shape
      key={step}
      listening={false}
      stroke={color}
      strokeWidth={width}
      strokeScaleEnabled={false}
      sceneFunc={(ctx, shape) => {
        ctx.beginPath();
        for (let x = step; x < w; x += step) {
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
        }
        for (let y = step; y < h; y += step) {
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
        }
        ctx.strokeShape(shape);
      }}
    />
  );
  if (background === "graph") return <>{[grid(1, "#d9ecdf", 0.6), grid(5, "#b7dcc3", 0.8), grid(10, "#86c39b", 1)]}</>;
  return grid(spacing, "#d3dbe6", 1);
}

export function PageEditor(props: PageEditorProps) {
  const { page, dims, boxes, renders, selectedIds, onSelect, onChange, onEdit, tool, planned, progress, showTravel, pointerRef, height, insetLeft = 0, insetTop = 0, insetBottom = 0, insetRight = 56, selectionToolbar } = props;
  const [transforming, setTransforming] = useState(false);
  const { ref: toolbarRef, width: toolbarWidth, height: toolbarHeight } = useElementSize();
  const { ref: wrapper, width } = useElementSize();
  const stage = useRef<Konva.Stage>(null);
  const transformer = useRef<Konva.Transformer>(null);
  const [view, setView] = useState<View>({ scale: 2, x: 20, y: 20 });
  const [pw, ph] = dims;

  const fit = () => {
    if (width === 0) return;
    const availW = width - insetLeft - insetRight;
    const availH = height - insetTop - insetBottom;
    const scale = Math.min((availW - 48) / pw, (availH - 48) / ph);
    setView({ scale, x: insetLeft + (availW - pw * scale) / 2, y: insetTop + (availH - ph * scale) / 2 });
  };
  // Refit when the sheet or the viewport changes size.
  useEffect(fit, [width, height, pw, ph, insetLeft, insetTop, insetBottom, insetRight]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomAt = (factor: number, px = width / 2, py = height / 2) =>
    setView((v) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      return { scale, x: px - ((px - v.x) / v.scale) * scale, y: py - ((py - v.y) / v.scale) * scale };
    });

  useEffect(() => {
    const tr = transformer.current;
    if (!tr) return;
    // Re-attaching nodes mid-resize would restart the transform; just refresh the frame.
    if (!tr.isTransforming()) {
      const nodes = progress === null ? selectedIds.map((id) => stage.current?.findOne(`#box-${id}`)).filter((n): n is Konva.Node => !!n) : [];
      tr.nodes(nodes);
    }
    tr.forceUpdate();
    tr.getLayer()?.batchDraw();
  }, [selectedIds, renders, boxes, progress]);

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const p = stage.current?.getPointerPosition();
    if (!p) return;
    if (e.evt.ctrlKey || e.evt.metaKey || Math.abs(e.evt.deltaY) > Math.abs(e.evt.deltaX) * 2) {
      zoomAt(e.evt.deltaY > 0 ? 1 / 1.12 : 1.12, p.x, p.y);
    } else {
      setView((v) => ({ ...v, x: v.x - e.evt.deltaX, y: v.y - e.evt.deltaY }));
    }
  };

  const trackPointer = () => {
    const p = stage.current?.getPointerPosition();
    pointerRef.current = p ? [(p.x - view.x) / view.scale, (p.y - view.y) / view.scale] : null;
  };

  const simulating = progress !== null;

  // Alt held with a box selected shows its distances (Figma's measure mode).
  const [alt, setAlt] = useState(false);
  useEffect(() => {
    const update = (e: KeyboardEvent) => setAlt(e.altKey);
    const reset = () => setAlt(false);
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("blur", reset);
    };
  }, []);
  const [dragOverlay, setDragOverlay] = useState<{ guides: GuideLine[]; measures: Measure[] } | null>(null);

  // Space held = temporary hand tool, as in Figma.
  const [space, setSpace] = useState(false);
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && t.closest("input, textarea, select, [contenteditable='true']") !== null;
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing(e.target)) {
        e.preventDefault();
        setSpace(true);
      }
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && setSpace(false);
    const reset = () => setSpace(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", reset);
    };
  }, []);
  const panning = tool === "hand" || space;

  const rectOf = (b: TextBox) => boxRect(b, renders[b.id]);
  const othersThan = (ids: string[]) => boxes.filter((b) => !ids.includes(b.id)).map(rectOf);
  const selectedBoxes = boxes.filter((b) => selectedIds.includes(b.id));
  const overlay =
    dragOverlay ??
    (alt && selectedBoxes.length && !simulating
      ? { guides: [], measures: measure(unionRect(selectedBoxes.map(rectOf)), othersThan(selectedIds), dims) }
      : null);

  // Selection rectangle (page mm), drawn by dragging on empty canvas with the move tool.
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number; base: string[] } | null>(null);
  const pointerMm = (): [number, number] | null => {
    const p = stage.current?.getPointerPosition();
    return p ? [(p.x - view.x) / view.scale, (p.y - view.y) / view.scale] : null;
  };
  const marqueeRect = (m: NonNullable<typeof marquee>): Box => ({
    left: Math.min(m.x0, m.x1),
    top: Math.min(m.y0, m.y1),
    right: Math.max(m.x0, m.x1),
    bottom: Math.max(m.y0, m.y1),
  });
  useEffect(() => {
    if (!marquee) return;
    const end = () => setMarquee(null);
    window.addEventListener("mouseup", end);
    return () => window.removeEventListener("mouseup", end);
  }, [marquee !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Group drag: every selected box follows the one under the pointer.
  const drag = useRef<{ ids: string[]; start: Map<string, [number, number]> } | null>(null);
  const lastDelta = useRef<readonly [number, number]>([0, 0]);
  const startDrag = (box: TextBox) => {
    const ids = selectedIds.includes(box.id) ? selectedIds : [box.id];
    drag.current = { ids, start: new Map(boxes.filter((b) => ids.includes(b.id)).map((b) => [b.id, [b.x, b.y]])) };
    lastDelta.current = [0, 0];
  };
  /** Snap the moving selection: other boxes' and the page's edges/centres first, then grid/lines (single unrotated box). */
  const moveSelection = (box: TextBox, nx: number, ny: number, free: boolean) => {
    const d = drag.current;
    if (!d) return;
    const [sx, sy] = d.start.get(box.id) ?? [box.x, box.y];
    let dx = nx - sx;
    let dy = ny - sy;
    const moving = boxes.filter((b) => d.ids.includes(b.id));
    const movedRect = () => unionRect(moving.map((b) => boxRect(b, renders[b.id], d.start.get(b.id)![0] + dx, d.start.get(b.id)![1] + dy)));
    const others = othersThan(d.ids);
    if (!free) {
      const smart = smartSnap(movedRect(), others, dims, 6 / view.scale);
      const single = moving.length === 1 && !box.rotation;
      const [gx, gy] = single ? snapPosition(sx + dx, sy + dy, renders[box.id], page) : [sx + dx, sy + dy];
      dx = smart.dx !== null ? dx + smart.dx : gx - sx;
      dy = smart.dy !== null ? dy + smart.dy : gy - sy;
    }
    for (const b of moving) {
      const [bx, by] = d.start.get(b.id)!;
      stage.current?.findOne(`#box-${b.id}`)?.position({ x: bx + dx, y: by + dy });
    }
    const rect = movedRect();
    setDragOverlay({ guides: alignGuides(rect, others, dims), measures: measure(rect, others, dims) });
    lastDelta.current = [dx, dy];
  };

  return (
    <div ref={wrapper} style={{ position: "relative", width: "100%", height, overflow: "hidden", background: "var(--mantine-color-default-hover)", cursor: panning ? "grab" : undefined }}>
      {width > 0 && (
        <Stage
          ref={stage}
          width={width}
          height={height}
          scaleX={view.scale}
          scaleY={view.scale}
          x={view.x}
          y={view.y}
          draggable={panning}
          onDragEnd={(e) => {
            if (e.target === stage.current) setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
          }}
          onWheel={onWheel}
          onMouseMove={() => {
            trackPointer();
            if (!marquee) return;
            const p = pointerMm();
            if (!p) return;
            const next = { ...marquee, x1: p[0], y1: p[1] };
            setMarquee(next);
            const rect = marqueeRect(next);
            const hits = boxes.filter((b) => intersects(rectOf(b), rect)).map((b) => b.id);
            onSelect([...new Set([...next.base, ...hits])]);
          }}
          onMouseUp={() => setMarquee(null)}
          onMouseLeave={() => (pointerRef.current = null)}
          onMouseDown={(e) => {
            if (panning || simulating || (e.target !== stage.current && e.target.name() !== "paper")) return;
            const p = pointerMm();
            if (!p) return;
            const base = e.evt.shiftKey ? selectedIds : [];
            onSelect(base);
            setMarquee({ x0: p[0], y0: p[1], x1: p[0], y1: p[1], base });
          }}
        >
          <Layer>
            <Rect x={1.2} y={1.6} width={pw} height={ph} fill="rgba(0,0,0,0.18)" listening={false} />
            <Rect name="paper" width={pw} height={ph} fill={PAPER} />
            <Background page={page} dims={dims} />
          </Layer>
          <Layer>
            {boxes.map((box) => {
              const r = renders[box.id];
              const [w, h] = boxSize(box, r);
              const selected = selectedIds.includes(box.id);
              const placeholder = !box.fontId ? "choose a font" : r?.error ? r.error : !r ? "rendering…" : r.strokes.length === 0 ? "empty text" : null;
              return (
                <Group
                  key={box.id}
                  id={`box-${box.id}`}
                  x={box.x}
                  y={box.y}
                  rotation={box.rotation}
                  draggable={!simulating && !panning}
                  listening={!panning}
                  onMouseDown={(e) => {
                    e.cancelBubble = true;
                    if (e.evt.shiftKey) onSelect(selected ? selectedIds.filter((id) => id !== box.id) : [...selectedIds, box.id]);
                    else if (!selected) onSelect([box.id]);
                  }}
                  onDragStart={() => startDrag(box)}
                  onDragMove={(e) => moveSelection(box, e.target.x(), e.target.y(), e.evt.metaKey || e.evt.ctrlKey)}
                  onDragEnd={() => {
                    const d = drag.current;
                    drag.current = null;
                    setDragOverlay(null);
                    if (!d) return;
                    const [dx, dy] = lastDelta.current;
                    onChange(boxes.filter((b) => d.ids.includes(b.id)).map((b) => ({ ...b, x: d.start.get(b.id)![0] + dx, y: d.start.get(b.id)![1] + dy })));
                  }}
                  onDblClick={() => onEdit(box.id)}
                  onDblTap={() => onEdit(box.id)}
                  onMouseEnter={() => stage.current && (stage.current.container().style.cursor = "move")}
                  onMouseLeave={() => stage.current && (stage.current.container().style.cursor = "")}
                >
                  <Rect
                    name="frame"
                    width={w}
                    height={h}
                    fill="rgba(0,0,0,0.001)"
                    stroke={selected ? "#4c6ef5" : placeholder ? "#adb5bd" : undefined}
                    strokeWidth={1}
                    dash={[4, 4]}
                    strokeScaleEnabled={false}
                  />
                  {r && r.strokes.length > 0 && (
                    // One shape for all strokes, sized to the box frame: the group's bounds (which
                    // the transformer resizes) stay the frame even when a long word overflows it.
                    <Shape
                      name="ink"
                      width={w}
                      height={h}
                      stroke={INK}
                      opacity={simulating ? 0.15 : 1}
                      strokeWidth={1.6}
                      strokeScaleEnabled={false}
                      lineCap="round"
                      lineJoin="round"
                      listening={false}
                      perfectDrawEnabled={false}
                      sceneFunc={(ctx, shape) => {
                        ctx.beginPath();
                        for (const s of r.strokes) {
                          ctx.moveTo(s[0][0], r.height - s[0][1]);
                          for (let i = 1; i < s.length; i++) ctx.lineTo(s[i][0], r.height - s[i][1]);
                        }
                        ctx.strokeShape(shape);
                      }}
                    />
                  )}
                  {placeholder && <Text text={placeholder} fontSize={Math.max(2.5, box.size * 0.45)} fill={r?.error ? "#e03131" : "#868e96"} y={h + 1} listening={false} />}
                </Group>
              );
            })}
            <Transformer
              ref={transformer}
              listening={!panning}
              keepRatio={false}
              enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right", "middle-left", "middle-right"]}
              rotationSnaps={[0, 90, 180, 270]}
              rotationSnapTolerance={4}
              anchorSize={9}
              anchorCornerRadius={2}
              borderStroke="#4c6ef5"
              anchorStroke="#4c6ef5"
              ignoreStroke
              boundBoxFunc={(oldBox, newBox) => (Math.abs(newBox.width) < 16 ? oldBox : newBox)}
              onTransformStart={() => setTransforming(true)}
              onTransform={() => {
                // Resizing sets the box width (text rewraps); the height follows the text. The new
                // width goes straight onto the Konva frame so the next move measures from it.
                const changed = (transformer.current?.nodes() ?? []).flatMap((node) => {
                  const box = boxes.find((b) => `box-${b.id}` === node.id());
                  const sx = Math.abs(node.scaleX());
                  node.scale({ x: 1, y: 1 });
                  // Transformer nodes are the box groups (attached by id above).
                  const group = node as Konva.Group;
                  const frame = group.findOne(".frame");
                  if (!box || !frame || Math.abs(sx - 1) < 1e-6) return [];
                  const width = Math.max(box.size, frame.width() * sx);
                  frame.width(width);
                  group.findOne(".ink")?.width(width);
                  return [{ ...box, x: node.x(), y: node.y(), width: Math.round(width * 10) / 10 }];
                });
                if (changed.length) onChange(changed, `resize:${changed.map((b) => b.id).join(",")}`);
              }}
              onTransformEnd={() => {
                setTransforming(false);
                const changed = (transformer.current?.nodes() ?? []).flatMap((node) => {
                  const box = boxes.find((b) => `box-${b.id}` === node.id());
                  if (!box) return [];
                  node.scale({ x: 1, y: 1 });
                  return [{ ...box, x: node.x(), y: node.y(), rotation: Math.round(node.rotation() * 10) / 10 }];
                });
                if (changed.length) onChange(changed, `resize:${changed.map((b) => b.id).join(",")}`);
              }}
            />
          </Layer>
          {marquee && (
            <Layer listening={false}>
              {(() => {
                const r = marqueeRect(marquee);
                return <Rect x={r.left} y={r.top} width={r.right - r.left} height={r.bottom - r.top} fill="rgba(76,110,245,0.08)" stroke="#4c6ef5" strokeWidth={1} strokeScaleEnabled={false} />;
              })()}
            </Layer>
          )}
          {overlay && (
            <Layer listening={false}>
              {overlay.guides.map((g, i) => (
                <Line key={`g${i}`} points={g} stroke={GUIDE} strokeWidth={1} strokeScaleEnabled={false} />
              ))}
              {overlay.measures.map((m, i) => {
                const tick = 4 / view.scale;
                const [x1, y1, x2, y2] = m.line;
                const ticks = m.vertical
                  ? [x1 - tick, y1, x1 + tick, y1, x2 - tick, y2, x2 + tick, y2]
                  : [x1, y1 - tick, x1, y1 + tick, x2, y2 - tick, x2, y2 + tick];
                return (
                  <Group key={`m${i}`}>
                    <Line points={m.line} stroke={MEASURE} strokeWidth={1} strokeScaleEnabled={false} />
                    <Line points={ticks.slice(0, 4)} stroke={MEASURE} strokeWidth={1} strokeScaleEnabled={false} />
                    <Line points={ticks.slice(4)} stroke={MEASURE} strokeWidth={1} strokeScaleEnabled={false} />
                    <Label x={m.at[0] + (m.vertical ? tick : 0)} y={m.at[1] - (m.vertical ? 0 : tick)}>
                      <Tag fill={MEASURE} cornerRadius={3 / view.scale} pointerDirection={m.vertical ? "left" : "down"} pointerWidth={0.01} pointerHeight={0.01} />
                      <Text text={m.label} fontSize={11 / view.scale} fontStyle="bold" padding={3 / view.scale} fill="#fff" />
                    </Label>
                  </Group>
                );
              })}
            </Layer>
          )}
          {planned && (simulating || showTravel) && (
            <Layer listening={false}>
              <Shape
                sceneFunc={(ctx) => {
                  const c = ctx._context;
                  const s = view.scale;
                  const y = (v: number) => ph - v;
                  c.lineCap = "round";
                  c.lineJoin = "round";
                  if (showTravel) {
                    c.setLineDash([4 / s, 4 / s]);
                    c.strokeStyle = "rgba(224,49,49,0.55)";
                    c.lineWidth = 1 / s;
                    c.beginPath();
                    c.moveTo(0, y(0));
                    for (const st of planned) {
                      c.lineTo(st[0][0], y(st[0][1]));
                      c.moveTo(st[st.length - 1][0], y(st[st.length - 1][1]));
                    }
                    c.stroke();
                    c.setLineDash([]);
                  }
                  if (!simulating) return;
                  let budget = progress;
                  let tip: [number, number] = [0, 0];
                  c.strokeStyle = INK;
                  c.lineWidth = 1.8 / s;
                  c.beginPath();
                  for (const st of planned) {
                    if (budget <= 0) break;
                    c.moveTo(st[0][0], y(st[0][1]));
                    tip = st[0];
                    for (let i = 1; i < st.length && budget > 0; i++) {
                      const seg = Math.hypot(st[i][0] - st[i - 1][0], st[i][1] - st[i - 1][1]);
                      const t = Math.min(1, budget / seg);
                      tip = [st[i - 1][0] + (st[i][0] - st[i - 1][0]) * t, st[i - 1][1] + (st[i][1] - st[i - 1][1]) * t];
                      c.lineTo(tip[0], y(tip[1]));
                      budget -= seg;
                    }
                  }
                  c.stroke();
                  c.fillStyle = "#1c7ed6";
                  c.beginPath();
                  c.arc(tip[0], y(tip[1]), 4 / s, 0, Math.PI * 2);
                  c.fill();
                }}
              />
            </Layer>
          )}
        </Stage>
      )}
      {selectionToolbar &&
        (() => {
          const shown = selectedBoxes.length > 0 && !simulating && !marquee && !dragOverlay && !transforming;
          const r = selectedBoxes.length ? unionRect(selectedBoxes.map(rectOf)) : { left: 0, top: 0, right: 0, bottom: 0 };
          const gap = 12;
          const above = view.y + r.top * view.scale - toolbarHeight - gap;
          const top = above >= insetTop + 8 ? above : view.y + r.bottom * view.scale + gap;
          const centre = view.x + ((r.left + r.right) / 2) * view.scale;
          const left = Math.min(Math.max(centre - toolbarWidth / 2, insetLeft + 8), width - insetRight - toolbarWidth - 8);
          // Stays mounted (hidden) so its measured size is ready the moment it shows.
          return (
            <div ref={toolbarRef} style={{ position: "absolute", top, left, zIndex: 4, visibility: shown && toolbarWidth ? "visible" : "hidden" }}>
              {selectionToolbar}
            </div>
          );
        })()}
      <Stack gap={4} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)" }}>
        <Tooltip label="Zoom in" position="left">
          <ActionIcon variant="default" radius="xl" size="lg" onClick={() => zoomAt(1.25)} aria-label="Zoom in">
            <IconZoomIn size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Fit page" position="left">
          <ActionIcon variant="default" radius="xl" size="lg" onClick={fit} aria-label="Fit page">
            <IconFocusCentered size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Zoom out" position="left">
          <ActionIcon variant="default" radius="xl" size="lg" onClick={() => zoomAt(1 / 1.25)} aria-label="Zoom out">
            <IconZoomOut size={16} />
          </ActionIcon>
        </Tooltip>
      </Stack>
    </div>
  );
}
