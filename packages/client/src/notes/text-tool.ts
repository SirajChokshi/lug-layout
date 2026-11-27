import type { NoteEntry, NotePoint } from "@brr/domain";
import type { TextNoteV2 } from "@brr/schema/world";
import { DRAFT_RGB, type NoteSketch } from "./note-sketch.ts";
import {
  onStud,
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

type TextGesture =
  | { readonly kind: "place"; readonly at: NotePoint }
  | {
      readonly kind: "move";
      readonly entry: NoteEntry;
      readonly text: TextNoteV2;
      readonly pressX: number;
      readonly pressZ: number;
      dx: number;
      dz: number;
    };

function textOf(entry: NoteEntry | null): TextNoteV2 | null {
  return entry?.note.kind === "text" ? entry.note : null;
}

export class TextTool implements NoteTool {
  private gesture: TextGesture | null = null;
  private cursor: NotePoint | null = null;

  constructor(private readonly host: NoteToolHost) {}

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
    const text = textOf(under);
    this.gesture =
      under && text
        ? {
            kind: "move",
            entry: under,
            text,
            pressX: pointer.x,
            pressZ: pointer.z,
            dx: 0,
            dz: 0,
          }
        : { kind: "place", at: studAt(pointer) };
  }

  drag(pointer: NotePointer): void {
    this.hover(pointer);
    const gesture = this.gesture;
    if (gesture?.kind !== "move") return;
    gesture.dx = onStud(pointer.x - gesture.pressX);
    gesture.dz = onStud(pointer.z - gesture.pressZ);
  }

  release(pointer: NotePointer | null): void {
    if (pointer) this.drag(pointer);
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture) return;
    if (gesture.kind === "place") {
      this.place(gesture.at);
      return;
    }
    const { entry, text, dx, dz } = gesture;
    if (dx !== 0 || dz !== 0) {
      const { index: _index, ...body } = text;
      if (!this.host.update(entry.id, { ...body, x: text.x + dx, z: text.z + dz })) return;
    }
    this.host.select(entry.id);
  }

  cancel(): boolean {
    const moving = this.gesture !== null;
    this.gesture = null;
    return moving;
  }

  finish(): void {}

  takeBack(): boolean {
    return false;
  }

  draft(): NoteDraftKind | null {
    return this.gesture?.kind === "move" ? "move" : null;
  }

  detail(): string | null {
    const gesture = this.gesture;
    if (gesture?.kind === "move") {
      return `by ${studsAt({ x: gesture.dx, z: gesture.dz })}`;
    }
    return this.cursor ? `at ${studsAt(this.cursor)}` : null;
  }

  replacing(): string | null {
    return null;
  }

  get draggedId(): string | null {
    return this.gesture?.kind === "move" ? this.gesture.entry.id : null;
  }

  get draggedDx(): number {
    return this.gesture?.kind === "move" ? this.gesture.dx : 0;
  }

  get draggedDz(): number {
    return this.gesture?.kind === "move" ? this.gesture.dz : 0;
  }

  sketch(out: NoteSketch): void {
    const gesture = this.gesture;
    if (gesture?.kind !== "move") return;
    const { text, dx, dz } = gesture;
    out.frame(textCorners({ ...text, x: text.x + dx, z: text.z + dz }), DRAFT_RGB);
  }

  private place(at: NotePoint): void {
    if (this.host.selected()) {
      this.host.select(null);
      return;
    }
    const base = this.host.newNote();
    if (!base) return;
    const style = this.host.style();
    const id = this.host.add({
      kind: "text",
      ...base,
      text: NEW_LABEL_TEXT,
      x: at.x,
      z: at.z,
      rot: 0,
      heightStuds: style.textHeightStuds,
      color: style.textColor,
    });
    if (id !== null) this.host.select(id, true);
  }
}
