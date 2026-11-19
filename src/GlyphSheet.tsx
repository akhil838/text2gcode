import { useEffect, useMemo, useRef, useState } from "react";
import { useElementSize } from "@mantine/hooks";
import { useComputedColorScheme } from "@mantine/core";
import { api, type FontDetail, type GlyphSheetData } from "./api";

/**
 * Load the uploaded font file into the page so the sheet can draw the original glyphs.
 * Returns the CSS family once loaded, or null (still loading, or a format the browser
 * cannot load, such as some .ttc collections).
 */
function useOriginalFont(fontId: string): string | null {
  const [family, setFamily] = useState<string | null>(null);
  useEffect(() => {
    const name = `t2h-original-${fontId}`;
    const existing = [...document.fonts].find((f) => f.family === name && f.status === "loaded");
    if (existing) {
      setFamily(name);
      return;
    }
    setFamily(null);
    let cancelled = false;
    api
      .fontFile(fontId)
      .then((bytes) => {
        if (!bytes) throw new Error("stroke font: no outline to show");
        return new FontFace(name, bytes as BufferSource).load();
      })
      .then((face) => {
        document.fonts.add(face);
        if (!cancelled) setFamily(name);
      })
      .catch(() => {
        /* the sheet still shows the strokes */
      });
    return () => {
      cancelled = true;
    };
  }, [fontId]);
  return family;
}

/** Grid of every converted glyph: the original character, faint, under the extracted strokes. */
export function GlyphSheet({ font, glyphs, minCell = 96 }: { font: FontDetail; glyphs: GlyphSheetData; minCell?: number }) {
  const { ref: box, width } = useElementSize();
  const canvas = useRef<HTMLCanvasElement>(null);
  const dark = useComputedColorScheme("light") === "dark";
  const original = useOriginalFont(font.id);
  // Object keys list integer-like keys ("0".."9") first, so sort by code point explicitly.
  const chars = useMemo(
    () =>
      Object.keys(glyphs)
        .filter((ch) => glyphs[ch].strokes.length > 0)
        .sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!),
    [glyphs],
  );
  // As many columns of at least `minCell` px as fit, stretched to fill the width exactly.
  const columns = Math.max(1, Math.floor(width / minCell));
  const cell = width > 0 ? width / columns : minCell;
  const rows = Math.ceil(chars.length / columns);
  const height = Math.ceil(rows * cell);

  useEffect(() => {
    const el = canvas.current;
    if (!el || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(width * dpr);
    el.height = Math.round(height * dpr);
    const ctx = el.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = dark ? "#1a1b1e" : "#ffffff";
    ctx.fillRect(0, 0, width, height);

    const span = font.ascender - font.descender;
    const scale = (cell * 0.72) / Math.max(span, font.units_per_em);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    chars.forEach((ch, i) => {
      const g = glyphs[ch];
      const x0 = (i % columns) * cell;
      const y0 = Math.floor(i / columns) * cell;
      ctx.strokeStyle = dark ? "#2c2e33" : "#eef1f4";
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, cell - 1, cell - 1);
      ctx.fillStyle = dark ? "#868e96" : "#868e96";
      ctx.font = "11px monospace";
      ctx.fillText(ch, x0 + 5, y0 + 13);

      const ox = x0 + (cell - g.advance * scale) / 2;
      const baseline = y0 + cell * 0.12 + font.ascender * scale + 6;
      ctx.strokeStyle = dark ? "#364fc7" : "#a5d8ff";
      ctx.beginPath();
      ctx.moveTo(ox, baseline);
      ctx.lineTo(ox + g.advance * scale, baseline);
      ctx.stroke();

      // The original glyph: 1 em of the font is units_per_em font units, so it matches the strokes.
      if (original) {
        ctx.fillStyle = dark ? "rgba(255,255,255,0.13)" : "rgba(17,20,24,0.10)";
        ctx.font = `${font.units_per_em * scale}px "${original}"`;
        ctx.textBaseline = "alphabetic";
        ctx.fillText(ch, ox, baseline);
      }

      ctx.strokeStyle = dark ? "#f1f3f5" : "#111418";
      ctx.lineWidth = 1.6;
      for (const s of g.strokes) {
        ctx.beginPath();
        s.forEach(([x, y], k) => {
          const px = ox + x * scale;
          const py = baseline - y * scale;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      }
    });
  }, [font, glyphs, chars, columns, width, height, cell, dark, original]);

  return (
    <div ref={box} style={{ width: "100%" }}>
      <canvas ref={canvas} style={{ width: "100%", height, display: "block", borderRadius: 8 }} />
    </div>
  );
}
