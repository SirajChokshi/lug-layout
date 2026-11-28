import type { NoteBody, NoteEntry, NotePoint } from "@brr/domain";
import { STUD_LDU } from "@brr/math";
import type { WorldBox } from "@brr/render";
import type { PlacementRecordV1 } from "@brr/schema/world";
import { nearestStud } from "../edit/group-transform.ts";
import type { NoteSketch } from "./note-sketch.ts";

export const NOTE_TOOL_KINDS = ["zone", "text", "ruler"] as const;

export type NoteToolKind = (typeof NOTE_TOOL_KINDS)[number];

export function noteToolOf(mode: string): NoteToolKind | null {
  return NOTE_TOOL_KINDS.find((kind) => kind === mode) ?? null;
}

export type NoteDraftKind = "polygon" | "shape";

export interface NoteModelView {
  readonly placement: PlacementRecordV1;
  readonly label: string;
  readonly box: WorldBox;
  readonly under: boolean;
}

export interface NotePointer {
  readonly x: number;
  readonly z: number;
  readonly reachLdu: number;
  readonly models: ReadonlyArray<NoteModelView>;
}

export interface NoteStyle {
  readonly zoneColor: string;
  readonly textColor: string;
  readonly rulerColor: string;
  readonly textHeightStuds: number;
}

export interface NoteToolHost {
  entries(): ReadonlyArray<NoteEntry>;
  editable(entry: NoteEntry): boolean;
  selectedEntry(): NoteEntry | null;
  choose(id: string | null, fresh?: boolean): void;
  add(body: NoteBody): string | null;
  update(id: string, body: NoteBody): boolean;
  refuse(reason: string): void;
  newStyle(): NoteStyle;
  newLayer(): number | null;
}

export interface NoteTool {
  hover(pointer: NotePointer | null): void;
  press(pointer: NotePointer): void;
  drag(pointer: NotePointer): void;
  release(pointer: NotePointer | null): void;
  cancel(): boolean;
  finish(): void;
  takeBack(): boolean;
  draft(): NoteDraftKind | null;
  detail(): string | null;
  replacing(): string | null;
  sketch(out: NoteSketch): void;
}

export function studAt(pointer: NotePointer): NotePoint {
  return { x: nearestStud(pointer.x), z: nearestStud(pointer.z) };
}

export function samePoint(a: NotePoint, b: NotePoint): boolean {
  return a.x === b.x && a.z === b.z;
}

export function studsAt(point: NotePoint): string {
  return `${point.x / STUD_LDU}, ${point.z / STUD_LDU} studs`;
}

export function topmost(host: NoteToolHost, hits: (entry: NoteEntry) => boolean): NoteEntry | null {
  const entries = host.entries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && host.editable(entry) && hits(entry)) return entry;
  }
  return null;
}
