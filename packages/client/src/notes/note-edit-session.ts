import { rulerEndPoint, rulerSpan, type NoteBody, type NoteEntry } from "@brr/domain";
import { STUD_LDU } from "@brr/math";
import { PROJECTION_FLOATS, SCENE_BACKEND, type ISceneBackend } from "@brr/render";
import { issueText } from "@brr/schema/decode";
import type { LayerRecordV2, NoteRecordV2, RulerEndV2, TextNoteV2 } from "@brr/schema/world";
import { inject, injectable } from "inversify";
import type { IPlaceableCatalog } from "../catalog/placeable-catalog.ts";
import { rulerText } from "../edit/measure-tool.ts";
import type { LabelView } from "../edit/size-labels.ts";
import type { ILayerService } from "../layers/layer-service.ts";
import { ANNOTATION_SERVICE, LAYER_SERVICE, PLACEABLE_CATALOG } from "../tokens.ts";
import type { IAnnotationService } from "./annotation-service.ts";
import { NoteSketch, SELECTED_RGB, rgbOf } from "./note-sketch.ts";
import type {
  NoteDraftKind,
  NotePointer,
  NoteStyle,
  NoteTool,
  NoteToolHost,
  NoteToolKind,
} from "./note-tool.ts";
import { RulerTool } from "./ruler-tool.ts";
import { textCorners, textHeightLdu, writeTextAxes, type TextAxes } from "./text-frame.ts";
import { TextTool } from "./text-tool.ts";
import { ZoneTool } from "./zone-tool.ts";

export const TEXT_PROJECTION_FLOATS = 3 * PROJECTION_FLOATS;
export const TEXT_ALONG_OFFSET = PROJECTION_FLOATS;
export const TEXT_UP_OFFSET = 2 * PROJECTION_FLOATS;

export const DEFAULT_NOTE_STYLE: NoteStyle = {
  zoneColor: "#d9822b",
  textColor: "#16222c",
  rulerColor: "#c62828",
  textHeightStuds: 4,
};

const NO_NOTES_LAYER =
  "This world has no notes layer, so there's nowhere to put a note. Notes go on a notes layer.";
const NO_OPEN_NOTES_LAYER = "Every notes layer is hidden or locked.";
const ATTACHED_MARK_HALF_LDU = STUD_LDU / 4;
const QUARTER_TURNS = 4;

export interface RulerEndView {
  readonly x: number;
  readonly z: number;
  readonly model: string | null;
}

export interface SelectedNoteView {
  readonly id: string;
  readonly note: NoteRecordV2;
  readonly fresh: boolean;
  readonly ends: { readonly from: RulerEndView; readonly to: RulerEndView } | null;
  readonly length: string | null;
}

export interface NoteToolView {
  readonly tool: NoteToolKind;
  readonly layer: number | null;
  readonly layers: ReadonlyArray<LayerRecordV2>;
  readonly style: NoteStyle;
  readonly selected: SelectedNoteView | null;
  readonly draft: NoteDraftKind | null;
  readonly detail: string | null;
  readonly refusal: string | null;
}

export interface NoteEditView {
  readonly noteTool: NoteToolView | null;
}

export interface NoteTextView {
  readonly id: string;
  readonly note: TextNoteV2;
}

export interface INoteEditSession {
  subscribe(listener: () => void): () => void;
  version(): number;
  view(): NoteEditView;
  start(planeY: number): void;
  setTool(tool: NoteToolKind | null): void;
  hover(pointer: NotePointer | null): void;
  press(pointer: NotePointer): void;
  drag(pointer: NotePointer): void;
  release(pointer: NotePointer | null): void;
  cancel(): void;
  finish(): void;
  deleteSelected(): void;
  turnSelected(direction: 1 | -1): void;
  select(id: string | null): void;
  updateSelected(body: NoteBody): void;
  setLayer(id: number): void;
  setStyle(patch: Partial<NoteStyle>): void;
  labels(): ReadonlyArray<LabelView>;
  texts(): ReadonlyArray<NoteTextView>;
  projectTexts(out: Float64Array): void;
}

@injectable()
export class NoteEditSession implements INoteEditSession, NoteToolHost {
  private readonly listeners = new Set<() => void>();
  private readonly deliver = (listener: () => void): void => listener();
  private readonly textTool = new TextTool(this);
  private readonly tools: Readonly<Record<NoteToolKind, NoteTool>> = {
    zone: new ZoneTool(this),
    text: this.textTool,
    ruler: new RulerTool(this),
  };
  private readonly axes: TextAxes = { alongX: 0, alongZ: 0, upX: 0, upZ: 0 };
  private tool: NoteToolKind | null = null;
  private selectedId: string | null = null;
  private fresh = false;
  private refusal: string | null = null;
  private chosenLayer: number | null = null;
  private style: NoteStyle = DEFAULT_NOTE_STYLE;
  private planeY: number | null = null;
  private reach = STUD_LDU;
  private changes = 0;
  private shown: NoteEditView = { noteTool: null };
  private shownLabels: ReadonlyArray<LabelView> = [];
  private textViews: ReadonlyArray<NoteTextView> = [];
  private textedVersion = -1;

  constructor(
    @inject(ANNOTATION_SERVICE) private readonly annotations: IAnnotationService,
    @inject(SCENE_BACKEND)
    private readonly backend: Pick<ISceneBackend, "setNoteShapes" | "projectToNdc">,
    @inject(PLACEABLE_CATALOG)
    private readonly catalog: Pick<IPlaceableCatalog, "resolveRef" | "placeables">,
    @inject(LAYER_SERVICE) private readonly layers: Pick<ILayerService, "table" | "subscribe">,
  ) {
    annotations.subscribe(() => this.notesOrLayersChanged());
    layers.subscribe(() => this.notesOrLayersChanged());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  version(): number {
    return this.changes;
  }

  view(): NoteEditView {
    return this.shown;
  }

  start(planeY: number): void {
    this.planeY = planeY;
    this.publish();
  }

  setTool(tool: NoteToolKind | null): void {
    if (tool === this.tool) return;
    this.active()?.cancel();
    this.active()?.hover(null);
    this.tool = tool;
    this.choose(null);
    this.refusal = null;
    this.publish();
  }

  hover(pointer: NotePointer | null): void {
    this.act((tool) => tool.hover(pointer), pointer);
  }

  press(pointer: NotePointer): void {
    this.refusal = null;
    this.act((tool) => tool.press(pointer), pointer);
  }

  drag(pointer: NotePointer): void {
    this.act((tool) => tool.drag(pointer), pointer);
  }

  release(pointer: NotePointer | null): void {
    this.act((tool) => tool.release(pointer), pointer);
  }

  cancel(): void {
    this.refusal = null;
    this.act((tool) => {
      if (!tool.cancel()) this.choose(null);
    }, null);
  }

  finish(): void {
    this.act((tool) => tool.finish(), null);
  }

  deleteSelected(): void {
    this.act((tool) => {
      const id = this.selectedId;
      if (tool.takeBack() || id === null) return;
      const issues = this.annotations.remove(id);
      if (issues.length > 0) this.refuse(issueText(issues));
      else this.choose(null);
    }, null);
  }

  turnSelected(direction: 1 | -1): void {
    const entry = this.selectedEntry();
    if (entry?.note.kind !== "text") return;
    const { index: _index, ...text } = entry.note;
    this.refusal = null;
    this.update(entry.id, { ...text, rot: (text.rot + direction + QUARTER_TURNS) % QUARTER_TURNS });
    this.publish();
  }

  select(id: string | null): void {
    this.choose(id);
    this.publish();
  }

  updateSelected(body: NoteBody): void {
    const id = this.selectedId;
    if (id === null) return;
    this.refusal = null;
    this.fresh = false;
    this.update(id, body);
    this.publish();
  }

  setLayer(id: number): void {
    this.chosenLayer = id;
    this.publish();
  }

  setStyle(patch: Partial<NoteStyle>): void {
    this.style = { ...this.style, ...patch };
    this.publish();
  }

  labels(): ReadonlyArray<LabelView> {
    return this.shownLabels;
  }

  texts(): ReadonlyArray<NoteTextView> {
    return this.textViews;
  }

  projectTexts(out: Float64Array): void {
    const views = this.textViews;
    const count = Math.min(views.length, Math.floor(out.length / TEXT_PROJECTION_FLOATS));
    const y = this.planeY ?? 0;
    const { draggedId, draggedDx, draggedDz } = this.textTool;
    for (let i = 0; i < count; i++) {
      const view = views[i];
      if (!view) continue;
      const { note } = view;
      const at = i * TEXT_PROJECTION_FLOATS;
      const moving = view.id === draggedId;
      const x = note.x + (moving ? draggedDx : 0);
      const z = note.z + (moving ? draggedDz : 0);
      const axes = writeTextAxes(note.rot, this.axes);
      const height = textHeightLdu(note);
      this.backend.projectToNdc(x, y, z, out, at);
      const alongX = x + axes.alongX * height;
      const alongZ = z + axes.alongZ * height;
      this.backend.projectToNdc(alongX, y, alongZ, out, at + TEXT_ALONG_OFFSET);
      this.backend.projectToNdc(
        x + axes.upX * height,
        y,
        z + axes.upZ * height,
        out,
        at + TEXT_UP_OFFSET,
      );
    }
  }

  entries(): ReadonlyArray<NoteEntry> {
    return this.annotations.notes();
  }

  editable(entry: NoteEntry): boolean {
    const layer = this.shownLayer(entry.note.layer);
    return layer !== null && !layer.locked;
  }

  selectedEntry(): NoteEntry | null {
    const id = this.selectedId;
    return id === null ? null : (this.entries().find((entry) => entry.id === id) ?? null);
  }

  choose(id: string | null, fresh = false): void {
    this.selectedId = id;
    this.fresh = id !== null && fresh;
  }

  add(body: NoteBody): string | null {
    const added = this.annotations.add(body);
    if (added.ok) return added.value;
    this.refuse(issueText(added.issues));
    return null;
  }

  update(id: string, body: NoteBody): boolean {
    const issues = this.annotations.update(id, body);
    if (issues.length > 0) this.refuse(issueText(issues));
    return issues.length === 0;
  }

  refuse(reason: string): void {
    this.refusal = reason;
  }

  newStyle(): NoteStyle {
    return this.style;
  }

  newLayer(): number | null {
    const layer = this.targetLayer();
    if (layer === null) this.refuse(this.layerRefusal());
    return layer;
  }

  private act(work: (tool: NoteTool) => void, pointer: NotePointer | null): void {
    const tool = this.active();
    if (!tool) return;
    if (pointer) this.reach = pointer.reachLdu;
    work(tool);
    this.publish();
  }

  private active(): NoteTool | null {
    return this.tool === null ? null : this.tools[this.tool];
  }

  private noteLayers(): ReadonlyArray<LayerRecordV2> {
    return this.layers.table().layers.filter((layer) => layer.kind === "notes");
  }

  private shownLayer(id: number): LayerRecordV2 | null {
    const layer = this.layers.table().layer(id);
    return layer?.visible ? layer : null;
  }

  private targetLayer(): number | null {
    const open = this.noteLayers().filter((layer) => layer.visible && !layer.locked);
    return (open.find((layer) => layer.id === this.chosenLayer) ?? open[0])?.id ?? null;
  }

  private layerRefusal(): string {
    return this.noteLayers().length === 0 ? NO_NOTES_LAYER : NO_OPEN_NOTES_LAYER;
  }

  private notesOrLayersChanged(): void {
    const entry = this.selectedEntry();
    if (!entry || !this.editable(entry)) this.choose(null);
    this.publish();
  }

  private publish(): void {
    this.redraw();
    this.retext();
    this.shown = { noteTool: this.toolView() };
    this.changes++;
    this.listeners.forEach(this.deliver);
  }

  private toolView(): NoteToolView | null {
    const tool = this.active();
    if (this.tool === null || !tool) return null;
    const layer = this.targetLayer();
    return {
      tool: this.tool,
      layer,
      layers: this.noteLayers(),
      style: this.style,
      selected: this.selectedView(),
      draft: tool.draft(),
      detail: tool.detail(),
      refusal: this.refusal ?? (layer === null ? this.layerRefusal() : null),
    };
  }

  private selectedView(): SelectedNoteView | null {
    const entry = this.selectedEntry();
    if (!entry) return null;
    const { note } = entry;
    const ruler = note.kind === "ruler" ? note : null;
    return {
      id: entry.id,
      note,
      fresh: this.fresh,
      ends: ruler ? { from: this.endView(ruler.from), to: this.endView(ruler.to) } : null,
      length: ruler ? rulerText(rulerSpan(ruler)) : null,
    };
  }

  private endView(end: RulerEndV2): RulerEndView {
    const { x, z } = rulerEndPoint(end);
    if (end.on === "point") return { x, z, model: null };
    const target = this.catalog.resolveRef(end.ref, end.color);
    const placeable = target ? this.catalog.placeables()[target.refId] : null;
    return { x, z, model: placeable?.label ?? end.ref };
  }

  private redraw(): void {
    const y = this.planeY;
    if (y === null) return;
    const sketch = new NoteSketch(y);
    const tool = this.active();
    const replaced = tool?.replacing() ?? null;
    for (const entry of this.entries()) {
      if (entry.id !== replaced && this.shownLayer(entry.note.layer))
        this.sketchNote(entry, sketch);
    }
    const selected = this.selectedEntry();
    if (selected && selected.id !== replaced) this.sketchSelection(selected.note, sketch);
    tool?.sketch(sketch);
    this.backend.setNoteShapes(sketch.shapes());
    this.shownLabels = sketch.labels;
  }

  private sketchNote({ id, note }: NoteEntry, out: NoteSketch): void {
    if (note.kind === "zone") {
      out.zone(note.outline, rgbOf(note.color));
      const xs = note.outline.map(([x]) => x);
      const zs = note.outline.map(([, z]) => z);
      const x = (Math.min(...xs) + Math.max(...xs)) / 2;
      out.label(`${id}-name`, "note", note.name, x, (Math.min(...zs) + Math.max(...zs)) / 2);
    }
    if (note.kind === "ruler") {
      const span = rulerSpan(note);
      const rgb = rgbOf(note.color);
      out.ruler(span, rgb);
      for (const end of [note.from, note.to]) {
        const point = rulerEndPoint(end);
        if (end.on === "model") out.square(point.x, point.z, ATTACHED_MARK_HALF_LDU, rgb);
      }
      out.label(id, "ruler", rulerText(span), (span.ax + span.bx) / 2, (span.az + span.bz) / 2);
    }
  }

  private sketchSelection(note: NoteRecordV2, out: NoteSketch): void {
    const handle = this.reach / 2;
    if (note.kind === "zone") {
      out.outline(note.outline, true, SELECTED_RGB);
      for (const [x, z] of note.outline) out.square(x, z, handle, SELECTED_RGB);
    }
    if (note.kind === "ruler") {
      const { ax, az, bx, bz } = rulerSpan(note);
      out.square(ax, az, handle, SELECTED_RGB);
      out.square(bx, bz, handle, SELECTED_RGB);
    }
    if (note.kind === "text" && this.textTool.draggedId === null) {
      out.frame(textCorners(note), SELECTED_RGB);
    }
  }

  private retext(): void {
    const version = this.annotations.version();
    if (version === this.textedVersion) return;
    this.textedVersion = version;
    this.textViews = this.entries().flatMap(({ id, note }) =>
      note.kind === "text" && this.shownLayer(note.layer) ? [{ id, note }] : [],
    );
  }
}
