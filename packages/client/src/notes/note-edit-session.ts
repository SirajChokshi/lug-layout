import {
  outlineCentroid,
  rulerEndPoint,
  rulerSpan,
  type NoteBody,
  type NoteEntry,
} from "@brr/domain";
import { STUD_LDU } from "@brr/math";
import { PROJECTION_FLOATS, SCENE_BACKEND, type ISceneBackend } from "@brr/render";
import type { Issue } from "@brr/schema/decode";
import type {
  LayerRecordV2,
  LegendNoteV2,
  NoteRecordV2,
  RulerEndV2,
  TextNoteV2,
} from "@brr/schema/world";
import { inject, injectable } from "inversify";
import type { IPlaceableCatalog } from "../catalog/placeable-catalog.ts";
import { rulerText } from "../edit/measure-tool.ts";
import type { LabelView } from "../edit/size-labels.ts";
import { ANNOTATION_SERVICE, PLACEABLE_CATALOG } from "../tokens.ts";
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
import {
  textCorners,
  textHeightLdu,
  textLines,
  writeTextAxes,
  type TextAxes,
} from "./text-frame.ts";
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
  owner: null,
};

const NO_NOTES_LAYER =
  "This world has no notes layer, so there's nowhere to put a note. Notes go on a notes layer.";
const NO_OPEN_NOTES_LAYER = "Every notes layer is hidden or locked.";
const ATTACHED_MARK_HALF_LDU = STUD_LDU / 4;
const QUARTER_TURNS = 4;

export interface NoteLayerView {
  readonly id: number;
  readonly name: string;
  readonly visible: boolean;
  readonly locked: boolean;
}

export interface NoteOwnerView {
  readonly id: number;
  readonly name: string;
  readonly color: string;
}

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
  readonly layers: ReadonlyArray<NoteLayerView>;
  readonly owners: ReadonlyArray<NoteOwnerView>;
  readonly style: NoteStyle;
  readonly selected: SelectedNoteView | null;
  readonly draft: NoteDraftKind | null;
  readonly detail: string | null;
  readonly refusal: string | null;
}

export interface NoteEditView {
  readonly noteTool: NoteToolView | null;
}

export interface LegendRowView {
  readonly color: string;
  readonly label: string;
}

export type NoteTextView =
  | {
      readonly kind: "text";
      readonly id: string;
      readonly lines: ReadonlyArray<string>;
      readonly color: string;
      readonly selected: boolean;
    }
  | {
      readonly kind: "legend";
      readonly id: string;
      readonly title: string | null;
      readonly rows: ReadonlyArray<LegendRowView>;
    };

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

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function noteIssueText(issues: ReadonlyArray<Issue>): string {
  return issues
    .map((issue) => {
      const field = issue.path.replace(/^note\.?/u, "");
      return capitalized(field === "" ? issue.message : `${field} ${issue.message}`);
    })
    .join("; ");
}

type PlacedText = TextNoteV2 | LegendNoteV2;

@injectable()
export class NoteEditSession implements INoteEditSession {
  private readonly listeners = new Set<() => void>();
  private readonly deliver = (listener: () => void): void => listener();
  private readonly host: NoteToolHost;
  private readonly textTool: TextTool;
  private readonly tools: Readonly<Record<NoteToolKind, NoteTool>>;
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
  private placedTexts: ReadonlyArray<PlacedText> = [];
  private placedIds: ReadonlyArray<string> = [];
  private textedVersion = -1;
  private textedSelection: string | null = null;
  private readonly axes: TextAxes = { alongX: 0, alongZ: 0, upX: 0, upZ: 0 };

  constructor(
    @inject(ANNOTATION_SERVICE) private readonly annotations: IAnnotationService,
    @inject(SCENE_BACKEND)
    private readonly backend: Pick<ISceneBackend, "setNoteShapes" | "projectToNdc">,
    @inject(PLACEABLE_CATALOG)
    private readonly catalog: Pick<IPlaceableCatalog, "resolveRef" | "placeables">,
  ) {
    this.host = {
      entries: () => this.annotations.notes(),
      editable: (entry) => this.editable(entry),
      selected: () => this.selectedEntry(),
      select: (id, fresh = false) => this.choose(id, fresh),
      add: (body) => this.add(body),
      update: (id, body) => this.update(id, body),
      refuse: (reason) => {
        this.refusal = reason;
      },
      style: () => this.style,
      newNote: () => this.newNote(),
    };
    this.textTool = new TextTool(this.host);
    this.tools = {
      zone: new ZoneTool(this.host),
      text: this.textTool,
      ruler: new RulerTool(this.host),
    };
    annotations.subscribe(() => this.notesChanged());
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
    this.selectedId = null;
    this.fresh = false;
    this.refusal = null;
    this.publish();
  }

  hover(pointer: NotePointer | null): void {
    const tool = this.active();
    if (!tool) return;
    if (pointer) this.reach = pointer.reachLdu;
    tool.hover(pointer);
    this.publish();
  }

  press(pointer: NotePointer): void {
    const tool = this.active();
    if (!tool) return;
    this.reach = pointer.reachLdu;
    this.refusal = null;
    tool.press(pointer);
    this.publish();
  }

  drag(pointer: NotePointer): void {
    const tool = this.active();
    if (!tool) return;
    this.reach = pointer.reachLdu;
    tool.drag(pointer);
    this.publish();
  }

  release(pointer: NotePointer | null): void {
    const tool = this.active();
    if (!tool) return;
    tool.release(pointer);
    this.publish();
  }

  cancel(): void {
    const tool = this.active();
    if (!tool) return;
    if (!tool.cancel()) this.selectedId = null;
    this.refusal = null;
    this.publish();
  }

  finish(): void {
    this.active()?.finish();
    this.publish();
  }

  deleteSelected(): void {
    const tool = this.active();
    if (!tool) return;
    if (!tool.takeBack()) {
      const id = this.selectedId;
      const issues = id === null ? [] : this.annotations.remove(id);
      if (issues.length > 0) this.refusal = noteIssueText(issues);
      else this.selectedId = null;
    }
    this.publish();
  }

  turnSelected(direction: 1 | -1): void {
    const entry = this.selectedEntry();
    if (entry?.note.kind !== "text") return;
    const { index: _index, ...text } = entry.note;
    const rot = (text.rot + direction + QUARTER_TURNS) % QUARTER_TURNS;
    this.refusal = null;
    this.update(entry.id, { ...text, rot });
    this.publish();
  }

  select(id: string | null): void {
    this.choose(id, false);
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
    const placed = this.placedTexts;
    const count = Math.min(placed.length, Math.floor(out.length / TEXT_PROJECTION_FLOATS));
    const y = this.planeY ?? 0;
    const dragged = this.textTool.draggedId;
    for (let i = 0; i < count; i++) {
      const note = placed[i];
      if (!note) continue;
      const at = i * TEXT_PROJECTION_FLOATS;
      const moving = dragged !== null && this.placedIds[i] === dragged;
      const x = note.x + (moving ? this.textTool.draggedDx : 0);
      const z = note.z + (moving ? this.textTool.draggedDz : 0);
      this.backend.projectToNdc(x, y, z, out, at);
      if (note.kind === "legend") {
        this.backend.projectToNdc(x, y, z, out, at + TEXT_ALONG_OFFSET);
        this.backend.projectToNdc(x, y, z, out, at + TEXT_UP_OFFSET);
        continue;
      }
      const axes = writeTextAxes(note.rot, this.axes);
      const height = textHeightLdu(note);
      const alongX = x + axes.alongX * height;
      const alongZ = z + axes.alongZ * height;
      this.backend.projectToNdc(alongX, y, alongZ, out, at + TEXT_ALONG_OFFSET);
      const upX = x + axes.upX * height;
      const upZ = z + axes.upZ * height;
      this.backend.projectToNdc(upX, y, upZ, out, at + TEXT_UP_OFFSET);
    }
  }

  private active(): NoteTool | null {
    return this.tool === null ? null : this.tools[this.tool];
  }

  private layers(): ReadonlyArray<LayerRecordV2> {
    return this.annotations.document().layers;
  }

  private noteLayers(): ReadonlyArray<LayerRecordV2> {
    return this.layers().filter((layer) => layer.kind === "notes");
  }

  private shownLayer(id: number): LayerRecordV2 | null {
    const layer = this.layers().find((candidate) => candidate.id === id);
    return layer?.visible ? layer : null;
  }

  private editable(entry: NoteEntry): boolean {
    const layer = this.shownLayer(entry.note.layer);
    return layer !== null && !layer.locked;
  }

  private targetLayer(): number | null {
    const open = this.noteLayers().filter((layer) => layer.visible && !layer.locked);
    const chosen = open.find((layer) => layer.id === this.chosenLayer);
    return (chosen ?? open[0])?.id ?? null;
  }

  private owner(): number | null {
    const { owner } = this.style;
    const listed = this.annotations
      .document()
      .contributors?.some((contributor) => contributor.id === owner);
    return owner !== null && listed === true ? owner : null;
  }

  private newNote(): Pick<NoteBody, "layer" | "owner"> | null {
    const layer = this.targetLayer();
    if (layer === null) {
      this.refusal = this.noteLayers().length === 0 ? NO_NOTES_LAYER : NO_OPEN_NOTES_LAYER;
      return null;
    }
    const owner = this.owner();
    return owner === null ? { layer } : { layer, owner };
  }

  private add(body: NoteBody): string | null {
    const added = this.annotations.add(body);
    if (added.ok) return added.value;
    this.refusal = noteIssueText(added.issues);
    return null;
  }

  private update(id: string, body: NoteBody): boolean {
    const issues = this.annotations.update(id, body);
    if (issues.length === 0) return true;
    this.refusal = noteIssueText(issues);
    return false;
  }

  private choose(id: string | null, fresh: boolean): void {
    this.selectedId = id;
    this.fresh = id !== null && fresh;
  }

  private selectedEntry(): NoteEntry | null {
    const id = this.selectedId;
    if (id === null) return null;
    return this.annotations.notes().find((entry) => entry.id === id) ?? null;
  }

  private notesChanged(): void {
    const entry = this.selectedEntry();
    if (!entry || !this.editable(entry)) {
      this.selectedId = null;
      this.fresh = false;
    }
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
    const document = this.annotations.document();
    const layer = this.targetLayer();
    return {
      tool: this.tool,
      layer,
      layers: this.noteLayers().map(({ id, name, visible, locked }) => ({
        id,
        name,
        visible,
        locked,
      })),
      owners: (document.contributors ?? []).map(({ id, name, color }) => ({ id, name, color })),
      style: { ...this.style, owner: this.owner() },
      selected: this.selectedView(),
      draft: tool.draft(),
      detail: tool.detail(),
      refusal: this.refusal ?? (layer === null ? this.layerRefusal() : null),
    };
  }

  private layerRefusal(): string {
    return this.noteLayers().length === 0 ? NO_NOTES_LAYER : NO_OPEN_NOTES_LAYER;
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

  private visible(entry: NoteEntry): boolean {
    return this.shownLayer(entry.note.layer) !== null;
  }

  private redraw(): void {
    const y = this.planeY;
    if (y === null) return;
    const sketch = new NoteSketch(y);
    const tool = this.active();
    const replaced = tool?.replacing() ?? null;
    for (const entry of this.annotations.notes()) {
      if (entry.id !== replaced && this.visible(entry)) this.sketchNote(entry, sketch);
    }
    const selected = this.selectedEntry();
    if (selected && selected.id !== replaced) this.sketchSelection(selected.note, sketch);
    tool?.sketch(sketch);
    this.backend.setNoteShapes(sketch.shapes());
    this.shownLabels = sketch.labels;
  }

  private sketchNote({ id, note }: NoteEntry, out: NoteSketch): void {
    switch (note.kind) {
      case "zone": {
        out.zone(note.outline, rgbOf(note.color));
        const centre = outlineCentroid(note.outline);
        out.label(`${id}-name`, "note", note.name, centre.x, centre.z);
        return;
      }
      case "ruler": {
        const span = rulerSpan(note);
        const rgb = rgbOf(note.color);
        out.ruler(span, rgb);
        for (const end of [note.from, note.to]) {
          if (end.on !== "model") continue;
          const point = rulerEndPoint(end);
          out.square(point.x, point.z, ATTACHED_MARK_HALF_LDU, rgb);
        }
        out.label(id, "ruler", rulerText(span), (span.ax + span.bx) / 2, (span.az + span.bz) / 2);
        return;
      }
      case "text":
      case "legend":
        return;
      default: {
        const unhandled: never = note;
        throw new Error(`unhandled note ${String(unhandled)}`);
      }
    }
  }

  private sketchSelection(note: NoteRecordV2, out: NoteSketch): void {
    const handle = this.reach / 2;
    switch (note.kind) {
      case "zone":
        out.outline(note.outline, true, SELECTED_RGB);
        for (const [x, z] of note.outline) out.square(x, z, handle, SELECTED_RGB);
        return;
      case "ruler": {
        const { ax, az, bx, bz } = rulerSpan(note);
        out.square(ax, az, handle, SELECTED_RGB);
        out.square(bx, bz, handle, SELECTED_RGB);
        return;
      }
      case "text":
        if (this.textTool.draggedId === null) out.frame(textCorners(note), SELECTED_RGB);
        return;
      case "legend":
        return;
      default: {
        const unhandled: never = note;
        throw new Error(`unhandled note ${String(unhandled)}`);
      }
    }
  }

  private retext(): void {
    const notesVersion = this.annotations.version();
    if (notesVersion === this.textedVersion && this.selectedId === this.textedSelection) return;
    this.textedVersion = notesVersion;
    this.textedSelection = this.selectedId;
    const views: NoteTextView[] = [];
    const placed: PlacedText[] = [];
    const ids: string[] = [];
    for (const entry of this.annotations.notes()) {
      const { note } = entry;
      if (!this.visible(entry)) continue;
      if (note.kind === "text" || note.kind === "legend") ids.push(entry.id);
      if (note.kind === "text") {
        placed.push(note);
        views.push({
          kind: "text",
          id: entry.id,
          lines: textLines(note.text),
          color: note.color,
          selected: entry.id === this.selectedId,
        });
      } else if (note.kind === "legend") {
        placed.push(note);
        views.push({
          kind: "legend",
          id: entry.id,
          title: note.title ?? null,
          rows: note.entries,
        });
      }
    }
    this.textViews = views;
    this.placedTexts = placed;
    this.placedIds = ids;
  }
}
