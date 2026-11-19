# text2gcode

A browser app that turns any outline font (TTF, OTF, TTC) into a **single-stroke font**,
like the Hershey fonts. You can lay out text on a page and download **G-code, SVG or DXF**
for CNC routers, engravers, laser cutters and pen plotters.

A normal font describes the *outline* of each letter, so a CNC machine traces around
every letter twice. A single-stroke font has one centerline per stroke, which is what
a pen, drag knife, V-bit or laser needs.

**Everything runs in your browser.** There is no server: fonts are converted in a Web
Worker and stored in your browser (IndexedDB), and the page is saved in `localStorage`.
Nothing is uploaded anywhere. The site is a set of static files, so any static host
(GitHub Pages, Netlify, S3) can serve it.

Tested with sans/serif fonts, handwriting fonts (Bradley Hand, Noteworthy, Caveat,
Indie Flower, Patrick Hand, …), formal scripts (Snell Roundhand, Apple Chancery),
decorative/textured fonts (Chalkduster, with the *Rough / textured* preset), and complex
scripts: **Hindi/Devanagari** and **Telugu**, shaped with HarfBuzz. See the
**[example gallery](examples/README.md)**.

**Bundled fonts.** On the first visit, these fonts from `public/fonts/` are installed
automatically:

- eight open-licensed outline fonts: Caveat, Indie Flower, Patrick Hand, Shadows Into
  Light, Homemade Apple (handwriting), Kalam (Hindi), Gurajada and Mallanna (Telugu);
- sixteen **classic Hershey fonts** (`public/fonts/hershey/*.jhf`): Sans, Roman
  Simplex/Duplex/Triplex, Times, Script, Cursive, Gothic, Greek and Cyrillic. They are
  single-stroke already, so they are used as drawn, with no conversion.

Fonts added to the bundle later are installed on the next visit; a bundled font you
remove stays removed. The list, with credits and licences, is `src/bundled.ts`. You can
also upload your own Hershey `.jhf` files.

## Run it

```sh
npm install
npm run dev        # development server with hot reload
npm run build      # static site in dist/
npm run preview    # serve dist/ locally
```

### Deploy to GitHub Pages

The workflow in `.github/workflows/pages.yml` builds the site and publishes `dist/` on
every push to `main`. In the repository settings, set **Pages → Source** to
**GitHub Actions**.

## Using the app

- **Fonts**: pick a font from the **Font** dropdown at the top of the floating left
  panel. Its last entry, *+ Upload custom font…*, opens a file picker, and you can also
  drop font files anywhere on the window. Fonts stay in this browser until you remove
  them (🗑). The dropdown sets the font of the selected text boxes, or the default for
  new boxes when none is selected.
- **Page**: a sheet (A5, A4, A3, Letter or custom, portrait or landscape) with a
  background: blank, ruled notebook lines, grid, dot grid or graph paper. Add any
  number of **text boxes**:
  - Paste text (⌘/Ctrl+V): with one box selected it's added to that box as a new line;
    otherwise it lands under the pointer as new text, without selection handles.
  - Tools, as in Figma: **Move** (V) selects and drags boxes; **Hand** (H, or hold
    Space) pans. With Move, drag on empty canvas to draw a selection rectangle;
    Shift-click or Shift-drag adds to the selection, and ⌘/Ctrl+A selects all.
  - Drag boxes to move them. Pull a side or corner to set the box width: lines wrap
    to fit, and the height follows the text. The small toolbar above a selected box
    sets the text size (S/M/L/XL or exact mm). Rotate with the handle above the box.
    Double-click (or Enter) to edit.
  - Delete removes the selection; arrow keys nudge it 1 mm (Shift: 10 mm); ⌘/Ctrl+D
    duplicates it.
  - ⌘/Ctrl+Z undoes and ⇧⌘Z / Ctrl+Y redoes. A burst of typing or nudging counts as
    one step.
  - Each box has its own font, size, line pitch, tracking and alignment.
  - On ruled paper the baseline snaps to the lines; on grids the corner snaps to grid
    points.
  - **Smart guides**: while dragging, boxes snap to each other's and the page's
    edges and centres, with red alignment lines and orange distance labels (mm).
    Hold ⌥/Alt to measure without dragging, and ⌘/Ctrl while dragging to turn
    snapping off.
- **Simulation**: *Simulate* animates the pen over the whole page in machine order, at
  1×, 10× or 50× the feed rate. *Show travel* draws the pen-up moves.
- **Machine & export**: router/Z pen, laser (M3/M5), or a servo pen with custom
  commands. Downloads (G-code, SVG, DXF) contain the whole page, with the machine
  origin at its bottom-left corner.
- **Hershey font** tab: a glyph sheet of the converted font with each original
  character drawn faintly behind its strokes, plus conversion settings. Downloads:
  Hershey `.jhf` (ASCII only), SVG font (Inkscape's *Hershey Text* format), JSON.

Text is shaped with HarfBuzz (ligatures, conjuncts, matras, kerning). Glyphs that touch
(cursive joins, the Devanagari headline) are skeletonized together, so the connection
becomes one continuous stroke with no pen lift.

## How it works

The converter lives in `src/engine/` and runs in a Web Worker (`worker.ts`):

1. **Outline** (`font.ts`): HarfBuzz (WebAssembly) reads glyph outlines, metrics and
   shapes text; Bézier curves are flattened.
2. **Raster** (`raster.ts`): contours are filled with the nonzero winding rule at
   600 px/em. Optional denoise blurs rough edges, and tiny holes or specks are removed.
3. **Skeleton** (`raster.ts`): the ink is thinned to a one-pixel medial line
   (Zhang-Suen, the same lookup table as scikit-image), and an exact distance transform
   gives the local stroke half-width.
4. **Graph cleanup** (`skeleton.ts`): the skeleton becomes a graph of junctions and
   branches. Terminal forks (square or slanted stroke ends) are collapsed, short spurs
   are pruned unless they continue a stroke straight through the junction, near-coincident
   junctions (the centre of an X) are merged, and compact blobs (periods, i-dots)
   become small dots.
5. **Strokes** (`convert.ts`): at every junction the straightest continuations are
   paired, so an X becomes two strokes and a T a crossbar plus a stem. Chains are smoothed,
   free ends are re-aimed and extended to the ink edge, and polylines are simplified
   (Douglas-Peucker).

Layout, stroke ordering and the G-code/SVG/DXF and `.jhf`/SVG-font/JSON writers are in
`layout.ts` and `output.ts`. Fonts and cached glyph sheets are stored by `store.ts`.

## Licences and credits

Each bundled font's licence file is shipped next to it in `public/fonts/` (deployed with
the site); `src/bundled.ts` lists authors and licences.

| Fonts | Licence | File |
| --- | --- | --- |
| Caveat, Indie Flower, Patrick Hand, Shadows Into Light, Kalam, Gurajada, Mallanna | SIL Open Font License 1.1 | `public/fonts/OFL-*.txt` |
| Homemade Apple | Apache License 2.0 | `public/fonts/LICENSE-homemadeapple.txt` |
| Hershey fonts (from [kamalmostafa/hershey-fonts](https://github.com/kamalmostafa/hershey-fonts)) | Hershey Fonts licence | `public/fonts/hershey/HERSHEY-LICENSE.txt` |

The Hershey Fonts were originally created by Dr. A. V. Hershey while working at the U. S.
National Bureau of Standards. The format of the font data was originally created by
James Hurt, Cognition, Inc.

A stroke font converted from an outline font is a derivative of it. The SVG font and
JSON downloads keep the source font's copyright and licence notice; `.jhf` has no room
for one, so keep the licence file with it. Check the licence of fonts you upload before
sharing what you make from them.

Software: HarfBuzz (Old MIT) and harfbuzzjs (MIT), the skeletonization lookup table from
scikit-image (BSD-3-Clause), React, Mantine, Konva and Tabler Icons (MIT).

## Tuning (Hershey font tab → Conversion settings)

| symptom | try |
|---|---|
| little whiskers at stroke ends or corners | raise *Prune* (1.6) or *Fork* (3.0) |
| real short strokes disappear (e.g. the bar of a `t`) | lower *Prune* |
| textured / rough / grunge fonts make a mess | the *Rough / textured* preset |
| wobbly lines | raise *Smooth*, or *Simplify* 0.004 |
| too many points in the G-code | raise *Simplify* |

Fonts with a mostly even stroke width (sans, handwriting, marker, monoline script)
give the best results. Very high-contrast serif fonts give a usable centerline, but
serifs show up as short ticks.
