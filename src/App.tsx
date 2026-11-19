import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Accordion,
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Divider,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Switch,
  Tabs,
  Text,
  Title,
  Tooltip,
  useMantineColorScheme,
} from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { useDebouncedValue, useViewportSize } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconClearAll,
  IconCopy,
  IconHandStop,
  IconPointer,
  IconTrash,
  IconFile,
  IconFileTypography,
  IconHelp,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLetterCase,
  IconDeviceDesktop,
  IconMoonStars,
  IconPencil,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconSun,
  IconTool,
  IconTypography,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import { api, type ConvertOptions, type FontDetail, type FontSummary, type GcodeParams, type Stroke, type StrokeStats } from "./api";
import { PageEditor } from "./PageEditor";
import { BUNDLED_FONTS, fontAsset } from "./bundled";
import { BoxToolbar, DEFAULT_CONVERT, FontField, FontTab, MachinePanel, PagePanel, TextPanel } from "./panels";
import { DEFAULT_PAGE, boxToMachine, loadState, newBox, pageDims, saveState, snapPosition, type PageSettings, type TextBox } from "./page";
import { useBoxRenders } from "./useBoxRenders";
import { logAction } from "./log";
import { useHistory, type CommitOptions } from "./useHistory";

const PANEL_WIDTH = 340;
const TOP_BAR = 52; // height of the floating title bar

const FONT_ACCEPT = {
  "font/ttf": [".ttf"],
  "font/otf": [".otf"],
  "font/collection": [".ttc", ".otc"],
  "application/octet-stream": [".ttf", ".otf", ".ttc", ".otc", ".jhf"],
  "application/x-font-ttf": [".ttf"],
  "application/vnd.ms-opentype": [".otf"],
  "text/plain": [".jhf"],
};

const SAMPLE_TEXT: Record<string, string> = {
  ascii: "Hello CNC!",
  devanagari: "नमस्ते दुनिया",
  telugu: "తెలుగు భాష",
};

const DEFAULT_GCODE: GcodeParams = {
  mode: "z",
  feed: 600,
  plunge_feed: 200,
  z_safe: 3,
  z_cut: -0.2,
  spindle: 0,
  laser_power: 1000,
  pen_up: "M3 S30",
  pen_down: "M3 S90",
  dwell: 0,
  join: 0.05,
};

/** A group of related controls in the floating bottom toolbar (sections are split by dividers). */
function ToolbarSection({ children }: { children: React.ReactNode }) {
  return (
    <Group gap={6} wrap="nowrap">
      {children}
    </Group>
  );
}

function errorToast(title: string, err: unknown) {
  notifications.show({ color: "red", title, message: err instanceof Error ? err.message : String(err), icon: <IconX size={18} /> });
}

/** Keyboard shortcuts and paste must not fire while the user types in a form field. */
function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

const saved = loadState();

/** Bundled font paths already installed in this browser (JSON array). */
const SEEDED_KEY = "ttf2hershey.bundledFonts";
/** Flag-only seeding record: when set, these five bundled fonts count as already installed. */
const LEGACY_SEEDED_KEY = "ttf2hershey.bundledFontsInstalled";
const LEGACY_BUNDLE = ["Caveat.ttf", "IndieFlower-Regular.ttf", "PatrickHand-Regular.ttf", "Kalam-Regular.ttf", "Gurajada-Regular.ttf"];
let seeding: Promise<void> | null = null;

/**
 * Install bundled fonts this browser has not installed yet, so fonts added to the bundle later
 * still arrive while a font the user removed stays removed. Returns null when there is nothing
 * to install. Shared promise: React StrictMode runs effects twice.
 */
function seedBundledFonts(): Promise<void> | null {
  const installed = new Set<string>(JSON.parse(localStorage.getItem(SEEDED_KEY) ?? "[]"));
  if (localStorage.getItem(LEGACY_SEEDED_KEY)) LEGACY_BUNDLE.forEach((p) => installed.add(p));
  const missing = BUNDLED_FONTS.filter((f) => !installed.has(f.path));
  if (!missing.length) return null;
  seeding ??= (async () => {
    const files = await Promise.all(
      missing.map(async ({ path }) => {
        const res = await fetch(fontAsset(path));
        if (!res.ok) throw new Error(`${path}: ${res.status}`);
        return new File([await res.arrayBuffer()], path.split("/").pop()!);
      }),
    );
    await api.upload(
      files,
      missing.map((f) => f.name),
    );
    missing.forEach((f) => installed.add(f.path));
    localStorage.setItem(SEEDED_KEY, JSON.stringify([...installed]));
    localStorage.removeItem(LEGACY_SEEDED_KEY);
  })();
  return seeding;
}

export function App() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const { height: viewportHeight, width: viewportWidth } = useViewportSize();
  // Below `compact` the settings panel becomes a drawer over the canvas; below `mobile` it is full width.
  const compact = viewportWidth > 0 && viewportWidth < 1100;
  const mobile = viewportWidth > 0 && viewportWidth < 700;
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth >= 1100);
  useEffect(() => setPanelOpen(!compact), [compact]);
  const panelWidth = mobile ? viewportWidth - 24 : PANEL_WIDTH;
  // Pixels on the left taken by the docked panel; a drawer floats over the canvas instead.
  const canvasLeft = panelOpen && !compact ? panelWidth + 24 : 0;
  const [tab, setTab] = useState<string | null>("write");

  const [fonts, setFonts] = useState<FontSummary[]>([]);
  const [fontsLoading, setFontsLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [activeFontId, setActiveFontId] = useState<string | null>(null);
  const [fontDetail, setFontDetail] = useState<FontDetail | null>(null);
  const [fontVersions, setFontVersions] = useState<Record<string, number>>({});
  const [convert, setConvert] = useState<ConvertOptions>(DEFAULT_CONVERT);
  const [reconverting, setReconverting] = useState(false);

  // Boxes and page settings share one undo history.
  const history = useHistory<{ page: PageSettings; boxes: TextBox[] }>({ page: saved?.page ?? DEFAULT_PAGE, boxes: saved?.boxes ?? [] });
  const { page, boxes } = history.present;
  const { commit, undo, redo } = history;
  const setBoxes = useCallback(
    (update: (bs: TextBox[]) => TextBox[], opts?: CommitOptions) => commit((s) => ({ ...s, boxes: update(s.boxes) }), opts),
    [commit],
  );
  const setPage = useCallback((p: PageSettings) => commit((s) => ({ ...s, page: p }), { key: "page" }), [commit]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [tool, setTool] = useState<"move" | "hand">("move");
  const [gcode, setGcode] = useState<GcodeParams>(DEFAULT_GCODE);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const pointerRef = useRef<[number, number] | null>(null);

  const [planned, setPlanned] = useState<{ strokes: Stroke[]; stats: StrokeStats } | null>(null);
  const [planning, setPlanning] = useState(false);
  const [showTravel, setShowTravel] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState("10");

  const dims = pageDims(page);
  const selectedBoxes = boxes.filter((b) => selectedIds.includes(b.id));
  const selectedBox = selectedBoxes.length === 1 ? selectedBoxes[0] : null;
  const highlightedFontId = selectedBoxes[0]?.fontId ?? activeFontId;
  const renders = useBoxRenders(boxes, fontVersions);

  // New boxes land on the nearest ruled line / grid point once their size is known.
  const pendingSnap = useRef(new Set<string>());
  useEffect(() => {
    for (const id of pendingSnap.current) {
      const box = boxes.find((b) => b.id === id);
      const r = renders[id];
      if (!box) pendingSnap.current.delete(id);
      if (!box || !r || r.height === 0) continue;
      pendingSnap.current.delete(id);
      const [x, y] = snapPosition(box.x, box.y, r, page);
      if (x !== box.x || y !== box.y) setBoxes((bs) => bs.map((b) => (b.id === id ? { ...b, x, y } : b)), { replace: true });
    }
  }, [renders, boxes, page]);

  useEffect(() => saveState({ page, boxes }), [page, boxes]);

  const refreshFonts = useCallback(async (select?: string) => {
    try {
      const list = await api.listFonts();
      setFonts(list);
      setActiveFontId((cur) => select ?? (cur && list.some((f) => f.id === cur) ? cur : list[0]?.id ?? null));
      return list;
    } catch (err) {
      errorToast("Could not load fonts", err);
      return [];
    } finally {
      setFontsLoading(false);
    }
  }, []);

  // First launch in this browser: install the bundled fonts, then start the page with a sample box.
  useEffect(() => {
    (seedBundledFonts() ?? Promise.resolve())
      .catch((err) => errorToast("Could not install the bundled fonts", err))
      .then(() => refreshFonts())
      .then((list) => {
        if (saved || !list?.length) return;
        const sample = newBox(list[0].id, SAMPLE_TEXT.ascii, 30, 30, 10);
        pendingSnap.current.add(sample.id);
        setBoxes((b) => (b.length ? b : [sample]), { replace: true });
      });
  }, [refreshFonts]);

  useEffect(() => {
    if (!highlightedFontId || !fonts.some((f) => f.id === highlightedFontId)) {
      setFontDetail(null);
      return;
    }
    let cancelled = false;
    api
      .font(highlightedFontId)
      .then((detail) => {
        if (cancelled) return;
        setFontDetail(detail);
        setConvert(detail.options);
      })
      .catch((err) => errorToast("Could not load font", err));
    return () => {
      cancelled = true;
    };
  }, [highlightedFontId, fonts]);

  /** One undo step for all `changed` boxes; `key` merges rapid edits of the same kind (typing, nudging). */
  const updateBoxes = useCallback(
    (changed: TextBox[], key?: string) => {
      const byId = new Map(changed.map((b) => [b.id, b]));
      setBoxes((bs) => bs.map((b) => byId.get(b.id) ?? b), key ? { key } : undefined);
    },
    [setBoxes],
  );
  const updateBox = useCallback((box: TextBox, key?: string) => updateBoxes([box], key), [updateBoxes]);
  const removeBoxes = useCallback(
    (ids: string[]) => {
      setBoxes((bs) => bs.filter((b) => !ids.includes(b.id)));
      setSelectedIds((s) => s.filter((id) => !ids.includes(id)));
    },
    [setBoxes],
  );
  const duplicateBoxes = useCallback(
    (ids: string[]) => {
      const copies = boxes.filter((b) => ids.includes(b.id)).map((b) => ({ ...b, id: crypto.randomUUID(), x: b.x + 5, y: b.y + 5 }));
      if (!copies.length) return;
      setBoxes((bs) => [...bs, ...copies]);
      setSelectedIds(copies.map((c) => c.id));
    },
    [boxes, setBoxes],
  );

  const addBox = useCallback(
    (text: string, at: [number, number] | null, select = true) => {
      const [pw, ph] = dims;
      const inside = at && at[0] >= 0 && at[1] >= 0 && at[0] < pw && at[1] < ph;
      const [x, y] = inside ? at : [pw * 0.1, ph * 0.15 + boxes.length * 12];
      const fontId = activeFontId ?? fonts[0]?.id ?? null;
      const box = newBox(fontId, text, x, y, selectedBox?.size ?? 8);
      pendingSnap.current.add(box.id);
      setBoxes((bs) => [...bs, box]);
      if (select) setSelectedIds([box.id]);
      return box;
    },
    [dims, boxes.length, activeFontId, fonts, selectedBox?.size, setBoxes],
  );

  const editBox = useCallback((id: string) => {
    setSelectedIds([id]);
    window.setTimeout(() => {
      textRef.current?.focus();
      textRef.current?.select();
    }, 30);
  }, []);

  // Paste: into the selected text box as a new line; otherwise a new, unselected box
  // appears under the pointer (just the text, no border or handles).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (tab !== "write" || isTyping(e.target)) return;
      const text = e.clipboardData?.getData("text/plain")?.replace(/\r\n?/g, "\n").trim();
      if (!text) return;
      e.preventDefault();
      if (selectedBox) updateBox({ ...selectedBox, text: selectedBox.text ? `${selectedBox.text}\n${text}` : text });
      else addBox(text, pointerRef.current, false);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [tab, addBox, selectedBox, updateBox]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tab !== "write" || isTyping(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        return redo();
      }
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        return undo();
      }
      if (e.key === "Escape") return setSelectedIds([]);
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        return setSelectedIds(boxes.map((b) => b.id));
      }
      if (!mod && !e.altKey && e.key.toLowerCase() === "v") return setTool("move");
      if (!mod && !e.altKey && e.key.toLowerCase() === "h") return setTool("hand");
      if (!selectedBoxes.length) return;
      const step = e.shiftKey ? 10 : 1;
      const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        removeBoxes(selectedIds);
      } else if (moves[e.key]) {
        e.preventDefault();
        const [dx, dy] = moves[e.key];
        updateBoxes(selectedBoxes.map((b) => ({ ...b, x: b.x + dx, y: b.y + dy })), `nudge:${selectedIds.join(",")}`);
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateBoxes(selectedIds);
      } else if (e.key === "Enter" && selectedBox) {
        e.preventDefault();
        editBox(selectedBox.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, boxes, selectedIds, selectedBoxes, selectedBox, removeBoxes, updateBoxes, duplicateBoxes, editBox, undo, redo]);

  // Whole page in machine coordinates, then ordered by the server exactly as export will be.
  const composed = useMemo(
    () => boxes.flatMap((b) => (renders[b.id] ? boxToMachine(b, renders[b.id], dims[1]) : [])),
    [boxes, renders, dims[1]], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [debouncedComposed] = useDebouncedValue(composed, 300);
  useEffect(() => {
    if (debouncedComposed.length === 0) {
      setPlanned(null);
      return;
    }
    const ctrl = new AbortController();
    setPlanning(true);
    api
      .plan(debouncedComposed, true, ctrl.signal)
      .then((p) => {
        setPlanned(p);
        setPlaying(false);
        setProgress(null);
      })
      .catch((err) => err.name !== "AbortError" && errorToast("Planning failed", err))
      .finally(() => !ctrl.signal.aborted && setPlanning(false));
    return () => ctrl.abort();
  }, [debouncedComposed]);

  const totalLength = planned?.stats.draw ?? 0;
  const frame = useRef(0);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const mmPerSecond = (gcode.feed / 60) * Number(speed);
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setProgress((p) => {
        const next = (p ?? 0) + dt * mmPerSecond;
        if (next >= totalLength) {
          setPlaying(false);
          return null;
        }
        return next;
      });
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [playing, speed, gcode.feed, totalLength]);

  async function handleDrop(files: File[]) {
    setUploading(true);
    const id = notifications.show({ loading: true, title: "Converting fonts", message: files.map((f) => f.name).join(", "), autoClose: false, withCloseButton: false });
    try {
      const added = await api.upload(files);
      notifications.update({ id, loading: false, color: "green", title: "Converted", message: `${added.map((f) => f.name).join(", ")} ready`, autoClose: 3000 });
      const last = added[added.length - 1];
      await refreshFonts(last?.id);
      if (last && selectedBoxes.length) updateBoxes(selectedBoxes.map((b) => ({ ...b, fontId: last.id })));
    } catch (err) {
      notifications.hide(id);
      errorToast("Upload failed", err);
    } finally {
      setUploading(false);
    }
  }

  async function handleDeleteFont(f: FontSummary) {
    try {
      await api.remove(f);
      await refreshFonts();
    } catch (err) {
      errorToast("Delete failed", err);
    }
  }

  function clearPage() {
    if (!window.confirm("Remove all text boxes from the page?")) return;
    logAction("page cleared", `${boxes.length} text boxes removed`);
    setBoxes(() => []);
    setSelectedIds([]);
  }

  function chooseFont(id: string) {
    setActiveFontId(id);
    if (!selectedBoxes.length) return;
    const script = fonts.find((f) => f.id === id)?.scripts.find((s) => s !== "ascii");
    updateBoxes(
      selectedBoxes.map((b) => ({ ...b, fontId: id, text: script && Object.values(SAMPLE_TEXT).includes(b.text) ? SAMPLE_TEXT[script] : b.text })),
    );
  }

  async function handleReconvert(options: ConvertOptions) {
    if (!fontDetail) return;
    setReconverting(true);
    try {
      const detail = await api.reconvert(fontDetail.id, options);
      setFontDetail(detail);
      setConvert(detail.options);
      setFontVersions((v) => ({ ...v, [detail.id]: (v[detail.id] ?? 0) + 1 }));
      notifications.show({ color: "green", title: "Reconverted", message: `${detail.name} updated` });
    } catch (err) {
      errorToast("Reconvert failed", err);
    } finally {
      setReconverting(false);
    }
  }

  async function handleExport(format: "gcode" | "svg" | "dxf") {
    // Pen commands override the Z / laser presets on the server, so send them only for the servo mode.
    const machine = gcode.mode === "custom" ? gcode : { ...gcode, pen_up: "", pen_down: "" };
    try {
      await api.exportPage({ strokes: composed, page: dims, format, gcode: machine, optimize: true, name: `page-${page.size}` });
    } catch (err) {
      errorToast("Export failed", err);
    }
  }

  const stats = planned?.stats;
  const minutes = stats ? stats.draw / gcode.feed + stats.travel / (gcode.feed * 3) : 0;
  const editorHeight = Math.max(460, viewportHeight); // the page canvas fills the window
  const offPage = composed.some((s) => s.some(([x, y]) => x < -0.01 || y < -0.01 || x > dims[0] + 0.01 || y > dims[1] + 0.01));
  const fontMissing = highlightedFontId !== null && !fontsLoading && !fonts.some((f) => f.id === highlightedFontId);

  const fontField = (
    <FontField
      fonts={fonts}
      value={highlightedFontId}
      missing={fontMissing}
      uploading={uploading}
      hint={
        selectedBoxes.length > 1
          ? `Applies to the ${selectedBoxes.length} selected text boxes.`
          : selectedBox
            ? "Applies to the selected text box."
            : "Used for new text boxes. You can also drop font files anywhere."
      }
      onChange={chooseFont}
      onUpload={handleDrop}
      onDelete={handleDeleteFont}
    />
  );

  // Floating, translucent, rounded panels over the full-bleed page canvas.
  const glass = {
    backdropFilter: "blur(10px)",
    background: "color-mix(in srgb, var(--mantine-color-body) 90%, transparent)",
  } as const;

  return (
    <Box pos="relative" h="100vh" w="100vw" style={{ overflow: "hidden" }}>

      <Dropzone.FullScreen accept={FONT_ACCEPT} onDrop={handleDrop} onReject={() => errorToast("Not a font", "Drop .ttf, .otf or .ttc files")}>
        <Stack align="center" justify="center" gap="xs" mih="60vh" style={{ pointerEvents: "none" }}>
          <IconUpload size={56} stroke={1.5} />
          <Title order={3}>Drop fonts to convert them</Title>
          <Text c="dimmed">TTF · OTF · TTC</Text>
        </Stack>
      </Dropzone.FullScreen>

        {tab === "write" && (
          <Box pos="relative">
            <PageEditor
              page={page}
              dims={dims}
              boxes={boxes}
              renders={renders}
              selectedIds={selectedIds}
              onSelect={setSelectedIds}
              onChange={updateBoxes}
              onEdit={editBox}
              tool={tool}
              planned={planned?.strokes ?? null}
              progress={progress}
              showTravel={showTravel}
              pointerRef={pointerRef}
              height={editorHeight}
              insetLeft={canvasLeft}
              insetTop={TOP_BAR + 12}
              insetBottom={64}
              selectionToolbar={
                selectedBoxes.length > 0 && (
                  <BoxToolbar
                    boxes={selectedBoxes}
                    onSize={(size) => updateBoxes(selectedBoxes.map((b) => ({ ...b, size })), `size:${selectedIds.join(",")}`)}
                    style={glass}
                  />
                )
              }
            />

            {panelOpen && (
            <Paper withBorder shadow="lg" radius="md" pos="absolute" top={TOP_BAR + 24} left={12} w={panelWidth} style={{ ...glass, overflow: "hidden", zIndex: 5 }}>
              <ScrollArea.Autosize mah={editorHeight - TOP_BAR - 36} type="hover" scrollbarSize={6}>
                <Box p="md">
                  {fontField}
                  <Accordion multiple defaultValue={["text", "page", "machine"]} mt="xs" styles={{ control: { paddingInline: 0 }, content: { paddingInline: 0 } }}>
                    <Accordion.Item value="text">
                      <Accordion.Control icon={<IconTypography size={16} />}>
                        {selectedBoxes.length > 1 ? `${selectedBoxes.length} text boxes` : "Text box"}
                      </Accordion.Control>
                      <Accordion.Panel>
                        {selectedBoxes.length > 1 ? (
                          <Group justify="space-between">
                            <Text size="sm" c="dimmed">
                              {selectedBoxes.length} boxes selected
                            </Text>
                            <Group gap="xs">
                              <Button size="xs" variant="default" leftSection={<IconCopy size={14} />} onClick={() => duplicateBoxes(selectedIds)}>
                                Duplicate
                              </Button>
                              <Button size="xs" variant="light" color="red" leftSection={<IconTrash size={14} />} onClick={() => removeBoxes(selectedIds)}>
                                Delete
                              </Button>
                            </Group>
                          </Group>
                        ) : (
                          <TextPanel
                            ref={textRef}
                            box={selectedBox}
                            onChange={(b) => updateBox(b, `edit:${b.id}`)}
                            onDuplicate={(id) => duplicateBoxes([id])}
                            onDelete={(id) => removeBoxes([id])}
                          />
                        )}
                      </Accordion.Panel>
                    </Accordion.Item>
                    <Accordion.Item value="page">
                      <Accordion.Control icon={<IconFile size={16} />}>Page</Accordion.Control>
                      <Accordion.Panel>
                        <PagePanel page={page} onChange={setPage} />
                      </Accordion.Panel>
                    </Accordion.Item>
                    <Accordion.Item value="machine" style={{ borderBottom: 0 }}>
                      <Accordion.Control icon={<IconTool size={16} />}>Machine &amp; export</Accordion.Control>
                      <Accordion.Panel>
                        <MachinePanel gcode={gcode} onChange={setGcode} onExport={handleExport} disabled={composed.length === 0} />
                      </Accordion.Panel>
                    </Accordion.Item>
                  </Accordion>
                </Box>
              </ScrollArea.Autosize>
            </Paper>
            )}

            <Paper
              withBorder
              shadow="md"
              radius="xl"
              pos="absolute"
              bottom={12}
              px="sm"
              py={6}
              style={{
                ...glass,
                // centred in the visible canvas (right of the panel when it is docked)
                left: `calc(${canvasLeft}px + (100% - ${canvasLeft}px) / 2)`,
                transform: "translateX(-50%)",
                width: "max-content",
                maxWidth: `calc(100% - ${canvasLeft + 24}px)`,
                overflowX: "auto",
              }}
            >
              <Group gap="sm" wrap="nowrap">
                <ToolbarSection>
                <SegmentedControl
                  size="xs"
                  radius="xl"
                  value={tool}
                  onChange={(v) => setTool(v as "move" | "hand")}
                  data={[
                    {
                      value: "move",
                      label: (
                        <Tooltip label="Move · select (V)">
                          <Center>
                            <IconPointer size={16} />
                          </Center>
                        </Tooltip>
                      ),
                    },
                    {
                      value: "hand",
                      label: (
                        <Tooltip label="Hand · pan (H, or hold Space)">
                          <Center>
                            <IconHandStop size={16} />
                          </Center>
                        </Tooltip>
                      ),
                    },
                  ]}
                />
                </ToolbarSection>
                <Divider orientation="vertical" />
                <ToolbarSection>
                <Tooltip label="Undo (⌘/Ctrl+Z)">
                  <ActionIcon variant="default" radius="xl" onClick={undo} disabled={!history.canUndo} aria-label="Undo">
                    <IconArrowBackUp size={16} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Redo (⇧⌘Z / Ctrl+Y)">
                  <ActionIcon variant="default" radius="xl" onClick={redo} disabled={!history.canRedo} aria-label="Redo">
                    <IconArrowForwardUp size={16} />
                  </ActionIcon>
                </Tooltip>
                </ToolbarSection>
                <Divider orientation="vertical" />
                <ToolbarSection>
                {compact ? (
                  <>
                    <Tooltip label="Add text">
                      <ActionIcon radius="xl" onClick={() => addBox("Your text", null)} disabled={fonts.length === 0} aria-label="Add text">
                        <IconPlus size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Clear the page">
                      <ActionIcon
                        radius="xl"
                        variant="default"
                        disabled={boxes.length === 0}
                        onClick={clearPage}
                        aria-label="Clear the page"
                      >
                        <IconClearAll size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </>
                ) : (
                  <>
                    <Button size="xs" radius="xl" leftSection={<IconPlus size={14} />} onClick={() => addBox("Your text", null)} disabled={fonts.length === 0}>
                      Add text
                    </Button>
                    <Button
                      size="xs"
                      radius="xl"
                      variant="default"
                      leftSection={<IconClearAll size={14} />}
                      disabled={boxes.length === 0}
                      onClick={clearPage}
                    >
                      Clear
                    </Button>
                  </>
                )}
                </ToolbarSection>
                <Divider orientation="vertical" />
                <ToolbarSection>
                {compact ? (
                  <Tooltip label={playing ? "Pause" : progress === null ? "Simulate drawing" : "Resume"}>
                    <ActionIcon radius="xl" variant="light" onClick={() => setPlaying((p) => !p)} disabled={!planned} aria-label="Simulate drawing">
                      {playing ? <IconPlayerPause size={16} /> : <IconPlayerPlay size={16} />}
                    </ActionIcon>
                  </Tooltip>
                ) : (
                  <Button
                    size="xs"
                    radius="xl"
                    variant="light"
                    leftSection={playing ? <IconPlayerPause size={14} /> : <IconPlayerPlay size={14} />}
                    onClick={() => setPlaying((p) => !p)}
                    disabled={!planned}
                  >
                    {playing ? "Pause" : progress === null ? "Simulate" : "Resume"}
                  </Button>
                )}
                <ActionIcon
                  variant="default"
                  radius="xl"
                  onClick={() => {
                    setPlaying(false);
                    setProgress(null);
                  }}
                  aria-label="Stop simulation"
                  disabled={progress === null}
                >
                  <IconPlayerStop size={14} />
                </ActionIcon>
                <Tooltip label="Simulation playback speed, relative to the feed rate">
                  <Group gap={4} wrap="nowrap">
                    {!compact && (
                      <Text size="xs" c="dimmed">
                        Speed
                      </Text>
                    )}
                    <SegmentedControl size="xs" radius="xl" value={speed} onChange={setSpeed} data={[{ label: "1×", value: "1" }, { label: "10×", value: "10" }, { label: "50×", value: "50" }]} />
                  </Group>
                </Tooltip>
                <Tooltip label="Draw the pen-up moves between strokes as dashed red lines">
                  <Switch size="xs" label={compact ? "Travel" : "Show travel"} checked={showTravel} onChange={(e) => setShowTravel(e.currentTarget.checked)} />
                </Tooltip>
                </ToolbarSection>
              </Group>
            </Paper>

            {/* Page summary: a small floating chip at the top middle of the canvas (wide windows only). */}
            {!compact && (
            <Paper
              withBorder
              shadow="sm"
              radius="xl"
              pos="absolute"
              top={12}
              h={TOP_BAR}
              px="md"
              style={{
                ...glass,
                left: `calc(${canvasLeft}px + (100% - ${canvasLeft}px) / 2)`,
                transform: "translateX(-50%)",
                width: "max-content",
              }}
            >
              <Group h="100%" gap="xs" wrap="nowrap">
                {planning && <Loader size="xs" />}
                {offPage && (
                  <Tooltip label="Some text extends beyond the sheet; the machine would draw outside the page">
                    <Badge color="orange" variant="light" size="sm">
                      off page
                    </Badge>
                  </Tooltip>
                )}
                <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                  {page.size === "custom" ? "Custom" : page.size} {dims[0]}×{dims[1]} mm · {boxes.length} box{boxes.length === 1 ? "" : "es"}
                  {stats && ` · ${stats.strokes} strokes · ≈${minutes.toFixed(1)} min`}
                </Text>
                <Tooltip
                  multiline
                  w={300}
                  label="Paste (⌘/Ctrl+V) to drop text where the pointer is · drag to move · corners resize, top handle rotates · double-click or Enter to edit · Delete removes · arrows nudge · scroll to pan, ⌘/Ctrl+scroll or pinch to zoom"
                >
                  <ActionIcon variant="subtle" radius="xl" color="gray" aria-label="Help">
                    <IconHelp size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Paper>
            )}
          </Box>
        )}

        {tab === "font" && (
          <FontTab
            font={fontDetail}
            fontField={fontField}
            convert={convert}
            onConvertChange={setConvert}
            onReconvert={handleReconvert}
            reconverting={reconverting}
            panelWidth={panelWidth}
            panelOpen={panelOpen}
            canvasLeft={canvasLeft}
            top={TOP_BAR + 24}
            height={editorHeight}
            glass={glass}
          />
        )}

      {/* Floating title bar (top-left) and navigation (top-right). */}
      <Paper
        withBorder
        shadow="md"
        radius="md"
        pos="absolute"
        top={12}
        left={12}
        h={TOP_BAR}
        px="md"
        style={{ ...glass, zIndex: 10, width: mobile ? "max-content" : panelWidth }}
      >
        <Group h="100%" gap="sm" wrap="nowrap">
          <IconFileTypography size={26} />
          <Stack gap={0}>
            <Title order={5} lh={1.2}>
              text2gcode
            </Title>
            {!mobile && (
              <Text c="dimmed" size="xs" lh={1.2}>
                fonts → single-stroke → G-code
              </Text>
            )}
          </Stack>
          {compact && (
            <Tooltip label={panelOpen ? "Hide settings" : "Show settings"}>
              <ActionIcon variant={panelOpen ? "light" : "default"} radius="md" size="lg" ml="auto" onClick={() => setPanelOpen((o) => !o)} aria-label="Toggle settings panel">
                {panelOpen ? <IconLayoutSidebarLeftCollapse size={18} /> : <IconLayoutSidebarLeftExpand size={18} />}
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </Paper>
      <Paper withBorder shadow="md" radius="xl" pos="absolute" top={12} right={12} h={TOP_BAR} px={6} style={{ ...glass, zIndex: 10 }}>
        <Group h="100%" gap={6} wrap="nowrap">
          <Tabs value={tab} onChange={setTab} variant="pills" radius="xl">
            <Tabs.List>
              <Tabs.Tab value="write" leftSection={<IconPencil size={16} />} aria-label="Page">
                {!compact && "Page"}
              </Tabs.Tab>
              <Tabs.Tab value="font" leftSection={<IconLetterCase size={16} />} aria-label="Hershey font">
                {!compact && "Hershey font"}
              </Tabs.Tab>
            </Tabs.List>
          </Tabs>
          <Tooltip label={`Theme: ${{ auto: "system", light: "light", dark: "dark" }[colorScheme]} (click to change)`}>
            <ActionIcon
              variant="default"
              size="lg"
              radius="xl"
              onClick={() => setColorScheme(({ auto: "light", light: "dark", dark: "auto" } as const)[colorScheme])}
              aria-label="Change color scheme"
            >
              {colorScheme === "auto" ? <IconDeviceDesktop size={18} /> : colorScheme === "dark" ? <IconMoonStars size={18} /> : <IconSun size={18} />}
            </ActionIcon>
          </Tooltip>
        </Group>
      </Paper>
    </Box>
  );
}
