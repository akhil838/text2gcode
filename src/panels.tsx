import { forwardRef, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Accordion,
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  NumberInput,
  SegmentedControl,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconAdjustments, IconCopy, IconDownload, IconPlus, IconRefresh, IconTrash } from "@tabler/icons-react";
import { api, type ConvertOptions, type FontDetail, type FontSummary, type GcodeParams, type GlyphSheetData } from "./api";
import { isBundledFile } from "./bundled";
import { DEFAULT_CONVERT } from "./engine/convert";
import { GlyphSheet } from "./GlyphSheet";
import { BACKGROUNDS, DEFAULT_SPACING, PAGE_SIZES, type BackgroundKind, type PageSettings, type PageSizeKey, type TextBox } from "./page";

/** NumberInput reports "" while the field is being edited; keep the old value then. */
export const num = (v: string | number, fallback: number) => (typeof v === "number" ? v : Number.parseFloat(v) || fallback);

export const FONT_EXTENSIONS = ".ttf,.otf,.ttc,.otc,.jhf";
const UPLOAD = "__upload__";

interface FontFieldProps {
  fonts: FontSummary[];
  value: string | null;
  /** True when the selected text box uses a font that was removed. */
  missing: boolean;
  hint: string;
  uploading: boolean;
  onChange: (id: string) => void;
  onUpload: (files: File[]) => void;
  onDelete: (font: FontSummary) => void;
}

/** Font dropdown: bundled fonts, then the user's own (removable) fonts and an upload entry. */
export function FontField({ fonts, value, missing, hint, uploading, onChange, onUpload, onDelete }: FontFieldProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const uploaded = (f: FontSummary) => !isBundledFile(f.filename);
  return (
    <Stack gap={4}>
        <Select
          label="Font"
          placeholder={missing ? "font was removed, pick another" : fonts.length ? "pick a font" : uploading ? "installing fonts…" : "upload a font to start"}
          error={missing ? "font no longer available" : undefined}
          value={missing ? null : value}
          searchable
          allowDeselect={false}
          maxDropdownHeight={360}
          rightSection={uploading ? <Loader size="xs" /> : undefined}
          data={[
            ...[
              { group: "Fonts", items: fonts.filter((f) => f.kind === "outline" && !uploaded(f)) },
              { group: "Hershey single-stroke", items: fonts.filter((f) => f.kind === "stroke" && !uploaded(f)) },
            ]
              .filter((g) => g.items.length)
              .map((g) => ({ group: g.group, items: g.items.map((f) => ({ value: f.id, label: f.name })) })),
            { group: "Your fonts", items: [...fonts.filter(uploaded).map((f) => ({ value: f.id, label: f.name })), { value: UPLOAD, label: "+ Upload font…" }] },
          ]}
          filter={({ options, search }) =>
            options.map((g) =>
              "items" in g
                ? { ...g, items: g.items.filter((o) => o.value === UPLOAD || o.label.toLowerCase().includes(search.toLowerCase())) }
                : g,
            )
          }
          renderOption={({ option }) => {
            if (option.value === UPLOAD) {
              return (
                <Group gap={6} c="indigo" wrap="nowrap">
                  <IconPlus size={14} />
                  <Text size="sm" fw={500}>
                    Upload font…
                  </Text>
                </Group>
              );
            }
            const f = fonts.find((x) => x.id === option.value);
            return (
              <Group gap={6} justify="space-between" w="100%" wrap="nowrap">
                <Text size="sm" truncate>
                  {option.label}
                </Text>
                <Group gap={3} wrap="nowrap">
                  {f?.scripts
                    .filter((s) => s !== "ascii")
                    .map((s) => (
                      <Badge key={s} size="xs" variant="light">
                        {s}
                      </Badge>
                    ))}
                  {f && uploaded(f) && (
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="red"
                      aria-label={`Remove ${f.name}`}
                      // keep the click from selecting the option or closing the dropdown
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Remove "${f.name}" from this browser?`)) onDelete(f);
                      }}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  )}
                </Group>
              </Group>
            );
          }}
          onChange={(v) => {
            if (v === UPLOAD) fileInput.current?.click();
            else if (v) onChange(v);
          }}
        />
      <Text size="xs" c="dimmed">
        {hint}
      </Text>
      <input
        ref={fileInput}
        type="file"
        accept={FONT_EXTENSIONS}
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = "";
          if (files.length) onUpload(files);
        }}
      />
    </Stack>
  );
}

export function PagePanel({ page, onChange }: { page: PageSettings; onChange: (p: PageSettings) => void }) {
  const set = (patch: Partial<PageSettings>) => onChange({ ...page, ...patch });
  return (
    <Stack gap="xs">
      <SimpleGrid cols={2} spacing="xs">
        <Select
          label="Size"
          value={page.size}
          allowDeselect={false}
          onChange={(v) => v && set({ size: v as PageSizeKey })}
          data={[...Object.keys(PAGE_SIZES), { value: "custom", label: "Custom" }]}
        />
        <Select
          label="Background"
          value={page.background}
          allowDeselect={false}
          onChange={(v) => v && set({ background: v as BackgroundKind, spacing: DEFAULT_SPACING[v as BackgroundKind] })}
          data={BACKGROUNDS}
        />
      </SimpleGrid>
      {page.size === "custom" && (
        <SimpleGrid cols={2} spacing="xs">
          <NumberInput label="Width (mm)" value={page.custom[0]} min={10} max={2000} onChange={(v) => set({ custom: [num(v, page.custom[0]), page.custom[1]] })} />
          <NumberInput label="Height (mm)" value={page.custom[1]} min={10} max={2000} onChange={(v) => set({ custom: [page.custom[0], num(v, page.custom[1])] })} />
        </SimpleGrid>
      )}
      <Group justify="space-between" align="center">
        <SegmentedControl
          size="xs"
          value={page.landscape ? "landscape" : "portrait"}
          onChange={(v) => set({ landscape: v === "landscape" })}
          data={[
            { label: "Portrait", value: "portrait" },
            { label: "Landscape", value: "landscape" },
          ]}
        />
        <Switch size="xs" label={page.background === "ruled" ? "Snap to lines" : "Snap to grid"} checked={page.snap} disabled={page.background === "blank"} onChange={(e) => set({ snap: e.currentTarget.checked })} />
      </Group>
      {(page.background === "ruled" || page.background === "grid" || page.background === "dots") && (
        <SimpleGrid cols={2} spacing="xs">
          <NumberInput label={page.background === "ruled" ? "Line spacing (mm)" : "Grid (mm)"} value={page.spacing} min={2} max={50} step={0.5} decimalScale={2} onChange={(v) => set({ spacing: num(v, page.spacing) })} />
          {page.background === "ruled" && <NumberInput label="Margin (mm)" value={page.margin} min={0} max={100} onChange={(v) => set({ margin: num(v, page.margin) })} />}
        </SimpleGrid>
      )}
    </Stack>
  );
}

interface TextPanelProps {
  box: TextBox | null;
  onChange: (box: TextBox) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

export const TextPanel = forwardRef<HTMLTextAreaElement, TextPanelProps>(function TextPanel({ box, onChange, onDuplicate, onDelete }, textRef) {
  if (!box) {
    return (
      <Text size="sm" c="dimmed">
        Paste text anywhere on the page (⌘/Ctrl + V) or use <b>Add text</b>. Click a box to select it, drag to move, pull a side or corner to
        set its width (lines wrap), double-click to edit. Delete removes it; arrow keys nudge it 1 mm (Shift: 10 mm).
      </Text>
    );
  }
  const set = (patch: Partial<TextBox>) => onChange({ ...box, ...patch });
  return (
    <Stack gap="xs">
      <Textarea ref={textRef} value={box.text} onChange={(e) => set({ text: e.currentTarget.value })} autosize minRows={2} maxRows={8} placeholder="Type something…" />
      <SimpleGrid cols={3} spacing="xs">
        <NumberInput label="Height (mm)" value={box.size} min={0.5} step={1} decimalScale={2} onChange={(v) => set({ size: num(v, box.size) })} />
        <NumberInput label="Line pitch" value={box.lineSpacing} min={0.5} step={0.05} decimalScale={2} onChange={(v) => set({ lineSpacing: num(v, box.lineSpacing) })} />
        <NumberInput label="Tracking" value={box.letterSpacing} step={0.01} decimalScale={3} onChange={(v) => set({ letterSpacing: num(v, 0) })} />
        <NumberInput label="X (mm)" value={box.x} step={1} decimalScale={2} onChange={(v) => set({ x: num(v, box.x) })} />
        <NumberInput label="Y (mm)" value={box.y} step={1} decimalScale={2} onChange={(v) => set({ y: num(v, box.y) })} />
        <NumberInput label="Rotation °" value={box.rotation} step={5} decimalScale={1} onChange={(v) => set({ rotation: num(v, 0) })} />
      </SimpleGrid>
      <Group gap="xs" wrap="nowrap">
        <SegmentedControl flex={1} size="xs" value={box.align} onChange={(v) => set({ align: v as TextBox["align"] })} data={["left", "center", "right"]} />
        <Tooltip label="Duplicate (⌘/Ctrl + D)">
          <ActionIcon variant="default" onClick={() => onDuplicate(box.id)} aria-label="Duplicate text box">
            <IconCopy size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Delete (Del)">
          <ActionIcon variant="light" color="red" onClick={() => onDelete(box.id)} aria-label="Delete text box">
            <IconTrash size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Stack>
  );
});

/** Text size presets (cap height, mm) for the floating toolbar. */
const SIZE_PRESETS = [
  { label: "S", value: "5" },
  { label: "M", value: "8" },
  { label: "L", value: "12" },
  { label: "XL", value: "20" },
];

interface BoxToolbarProps {
  /** The selected boxes; the size applies to all of them. */
  boxes: TextBox[];
  onSize: (size: number) => void;
  style?: CSSProperties;
}

/** Floating font-size control above the selected text boxes (everything else is in the side panel). */
export function BoxToolbar({ boxes, onSize, style }: BoxToolbarProps) {
  const size = boxes.every((b) => b.size === boxes[0].size) ? boxes[0].size : null;
  return (
    <Paper withBorder shadow="md" radius="xl" px={8} py={6} style={style}>
      <Group gap={8} wrap="nowrap">
        <Tooltip label="Text size (cap height)">
          <SegmentedControl size="xs" radius="xl" value={SIZE_PRESETS.find((p) => Number(p.value) === size)?.value ?? ""} onChange={(v) => onSize(Number(v))} data={SIZE_PRESETS} />
        </Tooltip>
        <NumberInput
          size="xs"
          radius="xl"
          w={84}
          min={0.5}
          max={500}
          step={0.5}
          decimalScale={2}
          suffix=" mm"
          placeholder="mixed"
          value={size ?? ""}
          onChange={(v) => typeof v === "number" && v > 0 && onSize(v)}
          aria-label="Text size in mm"
        />
      </Group>
    </Paper>
  );
}

interface MachinePanelProps {
  gcode: GcodeParams;
  onChange: (g: GcodeParams) => void;
  onExport: (format: "gcode" | "svg" | "dxf") => void;
  disabled: boolean;
}

export function MachinePanel({ gcode, onChange, onExport, disabled }: MachinePanelProps) {
  const set = <K extends keyof GcodeParams>(key: K, value: GcodeParams[K]) => onChange({ ...gcode, [key]: value });
  return (
    <Stack gap="xs">
      <SegmentedControl
        fullWidth
        size="xs"
        value={gcode.mode}
        onChange={(v) => set("mode", v as GcodeParams["mode"])}
        data={[
          { label: "Router / Z pen", value: "z" },
          { label: "Laser", value: "laser" },
          { label: "Servo pen", value: "custom" },
        ]}
      />
      <SimpleGrid cols={2} spacing="xs">
        <NumberInput label="Feed (mm/min)" value={gcode.feed} min={1} step={50} onChange={(v) => set("feed", num(v, 600))} />
        {gcode.mode === "z" && (
          <>
            <NumberInput label="Plunge feed" value={gcode.plunge_feed} min={1} step={50} onChange={(v) => set("plunge_feed", num(v, 200))} />
            <NumberInput label="Safe Z (mm)" value={gcode.z_safe} step={0.5} decimalScale={3} onChange={(v) => set("z_safe", num(v, 3))} />
            <NumberInput label="Cut Z (mm)" value={gcode.z_cut} step={0.05} decimalScale={3} onChange={(v) => set("z_cut", num(v, -0.2))} />
            <NumberInput label="Spindle RPM" description="0 = leave off" value={gcode.spindle} min={0} step={1000} onChange={(v) => set("spindle", num(v, 0))} />
          </>
        )}
        {gcode.mode === "laser" && <NumberInput label="Laser power (S)" value={gcode.laser_power} min={0} step={50} onChange={(v) => set("laser_power", num(v, 1000))} />}
        {gcode.mode === "custom" && (
          <>
            <TextInput label="Pen up" value={gcode.pen_up} onChange={(e) => set("pen_up", e.currentTarget.value)} />
            <TextInput label="Pen down" value={gcode.pen_down} onChange={(e) => set("pen_down", e.currentTarget.value)} />
          </>
        )}
        <NumberInput label="Dwell (s)" description="after pen moves" value={gcode.dwell} min={0} step={0.05} decimalScale={2} onChange={(v) => set("dwell", num(v, 0))} />
      </SimpleGrid>
      <Text size="xs" c="dimmed">
        Exports the whole page. Machine origin (X0 Y0) is the page's bottom-left corner.
      </Text>
      <Button fullWidth leftSection={<IconDownload size={16} />} onClick={() => onExport("gcode")} disabled={disabled}>
        Download G-code
      </Button>
      <Group grow gap="xs">
        <Button variant="light" leftSection={<IconDownload size={14} />} onClick={() => onExport("svg")} disabled={disabled}>
          SVG
        </Button>
        <Button variant="light" leftSection={<IconDownload size={14} />} onClick={() => onExport("dxf")} disabled={disabled}>
          DXF
        </Button>
      </Group>
    </Stack>
  );
}

export { DEFAULT_CONVERT };

const PRESETS: Record<string, Partial<ConvertOptions>> = {
  clean: { denoise: 0, speck: 0.02, smooth: 4 },
  rough: { denoise: 0.012, speck: 0.06, smooth: 6 },
};

interface FontTabProps {
  font: FontDetail | null;
  fontField: React.ReactNode;
  convert: ConvertOptions;
  onConvertChange: (c: ConvertOptions) => void;
  onReconvert: (c: ConvertOptions) => void;
  reconverting: boolean;
  /** Layout shared with the Page tab: floating panel width, top offset, window height, panel style. */
  panelWidth: number;
  panelOpen: boolean;
  /** Pixels on the left taken by the docked panel (0 when it floats as a drawer). */
  canvasLeft: number;
  top: number;
  height: number;
  glass: React.CSSProperties;
}

const DOWNLOADS = [
  { format: "jhf", label: "Hershey .jhf", note: "Classic Hershey format · ASCII only" },
  { format: "svg", label: "SVG font", note: "Inkscape Hershey Text · every glyph" },
  { format: "json", label: "JSON", note: "Full precision · for your own code" },
] as const;

/** The Hershey font tab: floating settings panel on the left, glyph sheet filling the rest. */
export function FontTab({ font, fontField, convert, onConvertChange, onReconvert, reconverting, panelWidth, panelOpen, canvasLeft, top, height, glass }: FontTabProps) {
  const setC = <K extends keyof ConvertOptions>(key: K, value: ConvertOptions[K]) => onConvertChange({ ...convert, [key]: value });
  // The sheet is converted in the worker (cached per font and settings); reload after a reconvert.
  const [glyphs, setGlyphs] = useState<GlyphSheetData | null>(null);
  useEffect(() => {
    if (!font) return;
    let cancelled = false;
    setGlyphs(null);
    api.fontSheet(font.id).then((g) => !cancelled && setGlyphs(g));
    return () => {
      cancelled = true;
    };
  }, [font]);
  const sheetLeft = canvasLeft || 12;

  return (
    <Box pos="relative" h={height} style={{ background: "var(--mantine-color-default-hover)" }}>
      {panelOpen && (
      <Paper withBorder shadow="lg" radius="md" pos="absolute" top={top} left={12} w={panelWidth} style={{ ...glass, overflow: "hidden", zIndex: 5 }}>
        <ScrollArea.Autosize mah={height - top - 12} type="hover" scrollbarSize={6}>
          <Box p="md">
            {fontField}
            {font && (
              <Accordion multiple defaultValue={["download", "convert"]} mt="xs" styles={{ control: { paddingInline: 0 }, content: { paddingInline: 0 } }}>
                <Accordion.Item value="download">
                  <Accordion.Control icon={<IconDownload size={16} />}>Download stroke font</Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="xs">
                      {DOWNLOADS.map((d) => (
                        <Group key={d.format} gap="sm" wrap="nowrap">
                          <Button size="xs" w={118} variant={d.format === "jhf" ? "filled" : "light"} onClick={() => api.downloadFont(font.id, d.format)}>
                            {d.label}
                          </Button>
                          <Text size="xs" c="dimmed">
                            {d.note}
                          </Text>
                        </Group>
                      ))}
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
                {font.kind === "stroke" ? (
                  <Accordion.Item value="convert" style={{ borderBottom: 0 }}>
                    <Accordion.Control icon={<IconAdjustments size={16} />}>Hershey font</Accordion.Control>
                    <Accordion.Panel>
                      <Text size="xs" c="dimmed">
                        Already single-stroke, so there is nothing to convert: the strokes are used exactly as drawn.
                      </Text>
                    </Accordion.Panel>
                  </Accordion.Item>
                ) : (
                <Accordion.Item value="convert" style={{ borderBottom: 0 }}>
                  <Accordion.Control icon={<IconAdjustments size={16} />}>Conversion settings</Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="xs">
                      <SegmentedControl
                        fullWidth
                        size="xs"
                        value={convert.denoise > 0 ? "rough" : "clean"}
                        onChange={(v) => onConvertChange({ ...convert, ...PRESETS[v] })}
                        data={[
                          { label: "Clean outlines", value: "clean" },
                          { label: "Rough / textured", value: "rough" },
                        ]}
                      />
                      <SimpleGrid cols={2} spacing="xs">
                        <NumberInput label="Denoise" description="blur, em" value={convert.denoise} min={0} step={0.002} decimalScale={4} onChange={(v) => setC("denoise", num(v, 0))} />
                        <NumberInput label="Speck" description="hole/speck, em" value={convert.speck} min={0} step={0.01} decimalScale={3} onChange={(v) => setC("speck", num(v, 0.02))} />
                        <NumberInput label="Prune" description="spur × width" value={convert.prune} min={0} step={0.1} decimalScale={2} onChange={(v) => setC("prune", num(v, 1.6))} />
                        <NumberInput label="Fork" description="end fork × width" value={convert.fork} min={0} step={0.1} decimalScale={2} onChange={(v) => setC("fork", num(v, 3))} />
                        <NumberInput label="Smooth" description="passes" value={convert.smooth} min={0} max={50} step={1} onChange={(v) => setC("smooth", Math.round(num(v, 4)))} />
                        <NumberInput label="Simplify" description="tolerance, em" value={convert.simplify} min={0} step={0.001} decimalScale={4} onChange={(v) => setC("simplify", num(v, 0.002))} />
                        <NumberInput label="Resolution" description="px per em" value={convert.resolution} min={150} max={2000} step={50} onChange={(v) => setC("resolution", Math.round(num(v, 600)))} />
                        <NumberInput label="Dot" description="blob → dot ratio" value={convert.dot} min={0} step={0.1} decimalScale={2} onChange={(v) => setC("dot", num(v, 1.5))} />
                      </SimpleGrid>
                      <Switch size="xs" label="Extend stroke ends to the outline" checked={convert.extend} onChange={(e) => setC("extend", e.currentTarget.checked)} />
                      <Group grow gap="xs">
                        <Button size="xs" leftSection={<IconRefresh size={14} />} loading={reconverting} onClick={() => onReconvert(convert)}>
                          Reconvert
                        </Button>
                        <Button size="xs" variant="default" disabled={reconverting} onClick={() => onReconvert(DEFAULT_CONVERT)}>
                          Defaults
                        </Button>
                      </Group>
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
                )}
              </Accordion>
            )}
          </Box>
        </ScrollArea.Autosize>
      </Paper>
      )}

      <Paper withBorder shadow="lg" radius="md" pos="absolute" top={top} left={sheetLeft} right={12} bottom={12} style={{ ...glass, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {font ? (
          <>
            <Group justify="space-between" px="md" py="sm" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
              <Group gap="xs">
                <Title order={5}>{font.name}</Title>
                {font.kind === "stroke" ? (
                  <Badge size="sm" variant="light" color="teal">
                    Hershey single-stroke
                  </Badge>
                ) : (
                  font.scripts.map((s) => (
                    <Badge key={s} size="sm" variant="light">
                      {s}
                    </Badge>
                  ))
                )}
              </Group>
              <Group gap="xs">
                {(!glyphs || reconverting) && <Loader size="xs" />}
                <Text size="sm" c="dimmed">
                  {glyphs
                    ? `${Object.keys(glyphs).length} glyphs · ${font.kind === "stroke" ? "strokes as drawn" : "original in grey, strokes on top"}`
                    : `Converting ${font.glyph_count} glyphs…`}
                </Text>
              </Group>
            </Group>
            <ScrollArea flex={1} type="auto">
              {glyphs && (
                <Box p="md" style={{ opacity: reconverting ? 0.4 : 1 }}>
                  <GlyphSheet font={font} glyphs={glyphs} />
                </Box>
              )}
            </ScrollArea>
          </>
        ) : (
          <Stack align="center" justify="center" h="100%" gap={4}>
            <Title order={4}>No font selected</Title>
            <Text c="dimmed" size="sm">
              Pick a font or upload one in the panel on the left.
            </Text>
          </Stack>
        )}
      </Paper>
    </Box>
  );
}
