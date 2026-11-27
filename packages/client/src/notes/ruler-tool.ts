import {
  rulerSpan,
  sameRulerEnd,
  segmentDistance,
  snapRulerEnd,
  type NoteEntry,
  type NoteSpan,
  type RulerSnap,
  type SnapModel,
} from "@brr/domain";
import { planeHypot } from "@brr/math";
import type { RulerEndV2, RulerNoteV2 } from "@brr/schema/world";
import { rulerText } from "../edit/measure-tool.ts";
import { DRAFT_RGB, rgbOf, type NoteSketch } from "./note-sketch.ts";
import {
  studsAt,
  topmost,
  type NoteDraftKind,
  type NoteModelView,
  type NotePointer,
  type NoteTool,
  type NoteToolHost,
} from "./note-tool.ts";

type RulerSide = "from" | "to";

interface Snapped {
  readonly snap: RulerSnap;
  readonly model: NoteModelView | null;
}

type RulerGesture =
  | { readonly kind: "new"; readonly from: Snapped; to: Snapped; moved: boolean }
  | {
      readonly kind: "end";
      readonly entry: NoteEntry;
      readonly ruler: RulerNoteV2;
      readonly side: RulerSide;
      to: Snapped;
      moved: boolean;
    };

const DRAFT_LABEL_ID = "note-ruler-draft";

function snapModels(models: ReadonlyArray<NoteModelView>): SnapModel[] {
  return models.map(({ placement, box, under }) => ({
    placement,
    minX: box.minX,
    minZ: box.minZ,
    maxX: box.maxX,
    maxZ: box.maxZ,
    under,
  }));
}

function snapped(pointer: NotePointer): Snapped {
  const snap = snapRulerEnd(pointer.x, pointer.z, pointer.reachLdu, snapModels(pointer.models));
  return { snap, model: pointer.models[snap.model] ?? null };
}

function samePlace(a: Snapped, b: Snapped): boolean {
  return a.snap.x === b.snap.x && a.snap.z === b.snap.z;
}

function rulerOf(entry: NoteEntry | null): RulerNoteV2 | null {
  return entry?.note.kind === "ruler" ? entry.note : null;
}

function withEnd(ruler: RulerNoteV2, side: RulerSide, end: RulerEndV2): RulerNoteV2 {
  return side === "from" ? { ...ruler, from: end } : { ...ruler, to: end };
}

export function snapText({ snap, model }: Snapped): string {
  const at = studsAt(snap);
  if (!model) return `free end at ${at}`;
  switch (snap.kind) {
    case "corner":
      return `on ${model.label}, at a corner`;
    case "edge":
      return `on ${model.label}, at the middle of an edge`;
    case "centre":
      return `on ${model.label}, at its centre`;
    case "stud":
    case "point":
      return `on ${model.label}, at ${at}`;
    default: {
      const unhandled: never = snap.kind;
      throw new Error(`unhandled snap ${String(unhandled)}`);
    }
  }
}

function spanOf(a: Snapped, b: Snapped): NoteSpan {
  return { ax: a.snap.x, az: a.snap.z, bx: b.snap.x, bz: b.snap.z };
}

export class RulerTool implements NoteTool {
  private gesture: RulerGesture | null = null;
  private aim: Snapped | null = null;
  private reach = 0;

  constructor(private readonly host: NoteToolHost) {}

  hover(pointer: NotePointer | null): void {
    this.aim = pointer ? snapped(pointer) : null;
    if (pointer) this.reach = pointer.reachLdu;
  }

  press(pointer: NotePointer): void {
    this.hover(pointer);
    const aim = snapped(pointer);
    const selected = this.host.selected();
    const ruler = rulerOf(selected);
    const side = ruler ? this.grabbedSide(ruler, pointer) : null;
    if (selected && ruler && side) {
      this.gesture = { kind: "end", entry: selected, ruler, side, to: aim, moved: false };
      return;
    }
    this.gesture = { kind: "new", from: aim, to: aim, moved: false };
  }

  drag(pointer: NotePointer): void {
    this.hover(pointer);
    const gesture = this.gesture;
    if (!gesture) return;
    gesture.to = snapped(pointer);
    gesture.moved ||=
      gesture.kind === "new" ? !samePlace(gesture.from, gesture.to) : !this.endUnchanged(gesture);
  }

  release(pointer: NotePointer | null): void {
    if (pointer) this.drag(pointer);
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture) return;
    if (gesture.kind === "end") {
      if (!gesture.moved || this.endUnchanged(gesture)) return;
      const { index: _index, ...body } = withEnd(gesture.ruler, gesture.side, gesture.to.snap.end);
      this.host.update(gesture.entry.id, body);
      return;
    }
    if (!gesture.moved) {
      this.click(pointer);
      return;
    }
    if (samePlace(gesture.from, gesture.to)) return;
    const base = this.host.newNote();
    if (!base) return;
    const id = this.host.add({
      kind: "ruler",
      ...base,
      from: gesture.from.snap.end,
      to: gesture.to.snap.end,
      color: this.host.style().rulerColor,
    });
    if (id !== null) this.host.select(id);
  }

  cancel(): boolean {
    const drafting = this.gesture !== null;
    this.gesture = null;
    return drafting;
  }

  finish(): void {}

  takeBack(): boolean {
    return false;
  }

  draft(): NoteDraftKind | null {
    const gesture = this.gesture;
    if (!gesture?.moved) return null;
    return gesture.kind === "new" ? "ruler" : "ruler-end";
  }

  detail(): string | null {
    const gesture = this.gesture;
    if (gesture?.moved) {
      const span = this.draftSpan(gesture);
      return `${rulerText(span)} · ${snapText(gesture.to)}`;
    }
    return this.aim ? snapText(this.aim) : null;
  }

  replacing(): string | null {
    const gesture = this.gesture;
    return gesture?.kind === "end" && gesture.moved ? gesture.entry.id : null;
  }

  sketch(out: NoteSketch): void {
    const gesture = this.gesture;
    if (!gesture?.moved) {
      if (this.aim) this.marker(this.aim, out);
      return;
    }
    const span = this.draftSpan(gesture);
    const rgb = gesture.kind === "end" ? rgbOf(gesture.ruler.color) : DRAFT_RGB;
    out.ruler(span, rgb);
    if (gesture.kind === "new") this.marker(gesture.from, out);
    this.marker(gesture.to, out);
    out.label(
      DRAFT_LABEL_ID,
      "draft",
      rulerText(span),
      (span.ax + span.bx) / 2,
      (span.az + span.bz) / 2,
    );
  }

  private marker({ snap, model }: Snapped, out: NoteSketch): void {
    out.square(snap.x, snap.z, this.reach / 2, DRAFT_RGB);
    if (model) out.rect(model.box, DRAFT_RGB);
  }

  private draftSpan(gesture: RulerGesture): NoteSpan {
    if (gesture.kind === "new") return spanOf(gesture.from, gesture.to);
    return rulerSpan(withEnd(gesture.ruler, gesture.side, gesture.to.snap.end));
  }

  private endUnchanged(gesture: Extract<RulerGesture, { kind: "end" }>): boolean {
    return sameRulerEnd(gesture.ruler[gesture.side], gesture.to.snap.end);
  }

  private grabbedSide(ruler: RulerNoteV2, pointer: NotePointer): RulerSide | null {
    const span = rulerSpan(ruler);
    const toFrom = planeHypot(span.ax - pointer.x, span.az - pointer.z);
    const toTo = planeHypot(span.bx - pointer.x, span.bz - pointer.z);
    if (Math.min(toFrom, toTo) > pointer.reachLdu) return null;
    return toFrom <= toTo ? "from" : "to";
  }

  private click(pointer: NotePointer | null): void {
    const under =
      pointer &&
      topmost(this.host, (entry) => {
        if (entry.note.kind !== "ruler") return false;
        const { ax, az, bx, bz } = rulerSpan(entry.note);
        return segmentDistance(ax, az, bx, bz, pointer.x, pointer.z) <= pointer.reachLdu;
      });
    this.host.select(under ? under.id : null);
  }
}
