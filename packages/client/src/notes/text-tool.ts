import type { NoteEntry, NotePoint } from "@brr/domain";
import type { TextNoteV2 } from "@brr/schema/world";
import { nearestStud } from "../edit/group-transform.ts";
import { DRAFT_RGB, type NoteSketch } from "./note-sketch.ts";
import {
  studAt,
  studsAt,
  topmost,
  type NoteDraftKind,
  type NotePointer,
  type NoteTool,
  type NoteToolHost,
} from "./note-tool.ts";
import { textContains, textCorners } from "./text-frame.ts";

export const NEW_LABEL_TEXT = "Label";

interface TextMove {
  readonly entry: NoteEntry;
  readonly text: TextNoteV2;
  readonly pressX: number;
  readonly pressZ: number;
  dx: number;
  dz: number;
}

export class TextTool implements NoteTool {
  private moving: TextMove | null = null;
  private placing: NotePoint | null = null;
  private cursor: NotePoint | null = null;

  constructor(private readonly host: NoteToolHost) {}

  get draggedId(): string | null {
    return this.moving?.entry.id ?? null;
  }

  get draggedDx(): number {
    return this.moving?.dx ?? 0;
  }

  get draggedDz(): number {
    return this.moving?.dz ?? 0;
  }

  hover(pointer: NotePointer | null): void {
    this.cursor = pointer ? studAt(pointer) : null;
  }

  press(pointer: NotePointer): void {
    this.hover(pointer);
    const under = topmost(
      this.host,
      (entry) =>
        entry.note.kind === "text" &&
        textContains(entry.note, pointer.x, pointer.z, pointer.reachLdu),
    );
    const text = under?.note.kind === "text" ? under.note : null;
    this.moving =
      under && text
        ? { entry: under, text, pressX: pointer.x, pressZ: pointer.z, dx: 0, dz: 0 }
        : null;
    this.placing = this.moving ? null : studAt(pointer);
  }

  drag(pointer: NotePointer): void {
    this.hover(pointer);
    const moving = this.moving;
    if (!moving) return;
    moving.dx = nearestStud(pointer.x - moving.pressX);
    moving.dz = nearestStud(pointer.z - moving.pressZ);
  }

  release(pointer: NotePointer | null): void {
    if (pointer) this.drag(pointer);
    const { moving, placing } = this;
    this.cancel();
    if (placing) this.place(placing);
    if (!moving) return;
    const { entry, text, dx, dz } = moving;
    const { index: _index, ...body } = text;
    const moved = dx !== 0 || dz !== 0;
    if (!moved || this.host.update(entry.id, { ...body, x: text.x + dx, z: text.z + dz })) {
      this.host.choose(entry.id);
    }
  }

  cancel(): boolean {
    const moving = this.moving !== null;
    this.moving = null;
    this.placing = null;
    return moving;
  }

  finish(): void {}

  takeBack(): boolean {
    return false;
  }

  draft(): NoteDraftKind | null {
    return this.moving ? "shape" : null;
  }

  detail(): string | null {
    if (this.moving) return `by ${studsAt({ x: this.moving.dx, z: this.moving.dz })}`;
    return this.cursor ? `at ${studsAt(this.cursor)}` : null;
  }

  replacing(): string | null {
    return null;
  }

  sketch(out: NoteSketch): void {
    const moving = this.moving;
    if (!moving) return;
    const { text, dx, dz } = moving;
    out.frame(textCorners({ ...text, x: text.x + dx, z: text.z + dz }), DRAFT_RGB);
  }

  private place(at: NotePoint): void {
    if (this.host.selectedEntry()) {
      this.host.choose(null);
      return;
    }
    const layer = this.host.newLayer();
    if (layer === null) return;
    const style = this.host.newStyle();
    const id = this.host.add({
      kind: "text",
      layer,
      text: NEW_LABEL_TEXT,
      x: at.x,
      z: at.z,
      rot: 0,
      heightStuds: style.textHeightStuds,
      color: style.textColor,
    });
    if (id !== null) this.host.choose(id, true);
  }
}
