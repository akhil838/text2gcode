import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { BoxRender, TextBox } from "./page";

const EMPTY: Omit<BoxRender, "key"> = { strokes: [], width: 0, height: 0, baseline: 0 };
const THROTTLE_MS = 120;

const renderKey = (box: TextBox, fontVersions: Record<string, number>) =>
  JSON.stringify([box.fontId, fontVersions[box.fontId ?? ""] ?? 0, box.text, box.size, box.lineSpacing, box.letterSpacing, box.align, box.width ?? null]);

/**
 * Worker-rendered strokes for every box, refreshed whenever a box's font, text, typography or
 * width changes, or its font is reconverted (fontVersions bump). Throttled per box: during a
 * continuous change (typing, resizing) a render goes out at most every THROTTLE_MS and each
 * result is shown as it arrives; the last change is always rendered.
 */
export function useBoxRenders(boxes: TextBox[], fontVersions: Record<string, number>): Record<string, BoxRender> {
  const [renders, setRenders] = useState<Record<string, BoxRender>>({});
  const latest = useRef(new Map<string, TextBox>());
  const versions = useRef(fontVersions);
  const requested = useRef(new Map<string, string>()); // newest wanted key per box
  const timers = useRef(new Map<string, number>()); // pending throttled render per box

  useEffect(() => {
    versions.current = fontVersions;

    const run = async (id: string) => {
      timers.current.delete(id);
      const box = latest.current.get(id);
      const key = requested.current.get(id);
      if (!box?.fontId || !key) return;
      try {
        const res = await api.render({
          font_id: box.fontId,
          text: box.text,
          height: box.size,
          line_spacing: box.lineSpacing,
          letter_spacing: box.letterSpacing,
          align: box.align,
          optimize: false,
          wrap_width: box.width ?? null,
        });
        // A newer request may be pending; this result is still the best one available.
        const now = latest.current.get(id);
        if (now?.fontId && now.text.trim()) {
          setRenders((r) => ({ ...r, [id]: { key, strokes: res.strokes, width: res.frame_width, height: res.stats.height, baseline: res.baseline } }));
        }
      } catch (err) {
        if (requested.current.get(id) !== key) return;
        const error = err instanceof Error ? err.message : String(err);
        setRenders((r) => ({ ...r, [id]: { ...(r[id] ?? EMPTY), key, error } }));
      }
      // Changes that arrived while this render ran still need one.
      if (requested.current.get(id) !== key && !timers.current.has(id)) schedule(id);
    };
    const schedule = (id: string) => timers.current.set(id, window.setTimeout(() => run(id), THROTTLE_MS));

    const alive = new Set(boxes.map((b) => b.id));
    for (const box of boxes) {
      latest.current.set(box.id, box);
      const key = renderKey(box, versions.current);
      if (requested.current.get(box.id) === key) continue;
      requested.current.set(box.id, key);
      if (!box.fontId || !box.text.trim()) {
        window.clearTimeout(timers.current.get(box.id));
        timers.current.delete(box.id);
        setRenders((r) => ({ ...r, [box.id]: { key, ...EMPTY } }));
        continue;
      }
      if (!timers.current.has(box.id)) schedule(box.id);
    }
    for (const id of [...requested.current.keys()]) {
      if (alive.has(id)) continue;
      requested.current.delete(id);
      latest.current.delete(id);
      window.clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      setRenders(({ [id]: _gone, ...rest }) => rest);
    }
  }, [boxes, fontVersions]);

  return renders;
}
