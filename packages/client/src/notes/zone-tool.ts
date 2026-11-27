import {
  NO_CORNER,
  nearestCorner,
  shiftedOutline,
  studRect,
  withCornerAt,
  zoneContains,
  type NoteEntry,
  type NotePoint,
  type ZoneOutline,
} from "@brr/domain";
import { ZONE_VERTEX_MIN, type StudPoint, type ZoneNoteV2 } from "@brr/schema/world";
import { areaText } from "../edit/size-labels.ts";
import { DRAFT_RGB, rgbOf, type NoteSketch } from "./note-sketch.ts";
import {
  onStud,
  samePoint,
  studAt,
  studsAt,
  topmost,
  type NoteDraftKind,
  type NotePointer,
  type NoteTool,
  type NoteToolHost,
} from "./note-tool.ts";

type ZoneGesture =
  | { readonly kind: "rect"; readonly from: NotePoint; to: NotePoint; moved: boolean }
  | {
      readonly kind: "move";
      readonly entry: NoteEntry;
      readonly zone: ZoneNoteV2;
      readonly pressX: number;
      readonly pressZ: number;
      dx: number;
      dz: number;
    }
  | {
      readonly kind: "corner";
      readonly entry: NoteEntry;
      readonly zone: ZoneNoteV2;
      readonly index: number;
      to: NotePoint;
    }
  | { readonly kind: "corner-click"; at: NotePoint };

const TOO_FEW_CORNERS = `A zone needs at least ${ZONE_VERTEX_MIN} corners.`;
const FLAT_RECTANGLE = "Drag across at least one stud each way to draw a rectangle.";

function zoneOf(entry: NoteEntry | null): ZoneNoteV2 | null {
  return entry?.note.kind === "zone" ? entry.note : null;
}

function nextZoneName(entries: ReadonlyArray<NoteEntry>): string {
  const zones = entries.filter((entry) => entry.note.kind === "zone").length;
  return `Zone ${zones + 1}`;
}

function cornersText(count: number): string {
  return `${count} ${count === 1 ? "corner" : "corners"}`;
}

export class ZoneTool implements NoteTool {
  private gesture: ZoneGesture | null = null;
  private corners: NotePoint[] = [];
  private cursor: NotePoint | null = null;
  private reach = 0;

  constructor(private readonly host: NoteToolHost) {}

  hover(pointer: NotePointer | null): void {
    this.cursor = pointer ? studAt(pointer) : null;
    if (pointer) this.reach = pointer.reachLdu;
  }

  press(pointer: NotePointer): void {
    this.hover(pointer);
    const at = studAt(pointer);
    if (this.corners.length > 0) {
      this.gesture = { kind: "corner-click", at };
      return;
    }
    const selectedEntry = this.host.selected();
    const selected = zoneOf(selectedEntry);
    if (selected && selectedEntry) {
      const index = nearestCorner(selected.outline, pointer.x, pointer.z, pointer.reachLdu);
      if (index !== NO_CORNER) {
        this.gesture = { kind: "corner", entry: selectedEntry, zone: selected, index, to: at };
        return;
      }
    }
    const under = topmost(
      this.host,
      (entry) =>
        entry.note.kind === "zone" && zoneContains(entry.note.outline, pointer.x, pointer.z),
    );
    const zone = zoneOf(under);
    if (under && zone) {
      this.gesture = {
        kind: "move",
        entry: under,
        zone,
        pressX: pointer.x,
        pressZ: pointer.z,
        dx: 0,
        dz: 0,
      };
      return;
    }
    this.gesture = { kind: "rect", from: at, to: at, moved: false };
  }

  drag(pointer: NotePointer): void {
    this.hover(pointer);
    const gesture = this.gesture;
    if (!gesture) return;
    switch (gesture.kind) {
      case "rect":
        gesture.to = studAt(pointer);
        gesture.moved ||= !samePoint(gesture.from, gesture.to);
        return;
      case "move":
        gesture.dx = onStud(pointer.x - gesture.pressX);
        gesture.dz = onStud(pointer.z - gesture.pressZ);
        return;
      case "corner":
        gesture.to = studAt(pointer);
        return;
      case "corner-click":
        gesture.at = studAt(pointer);
        return;
      default: {
        const unhandled: never = gesture;
        throw new Error(`unhandled zone gesture ${String(unhandled)}`);
      }
    }
  }

  release(pointer: NotePointer | null): void {
    if (pointer) this.drag(pointer);
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture) return;
    switch (gesture.kind) {
      case "rect":
        this.releaseRect(gesture.from, gesture.to, gesture.moved);
        return;
      case "move":
        this.releaseMove(gesture.entry, gesture.zone, gesture.dx, gesture.dz);
        return;
      case "corner":
        this.releaseCorner(gesture.entry, gesture.zone, gesture.index, gesture.to);
        return;
      case "corner-click":
        this.addCorner(gesture.at);
        return;
      default: {
        const unhandled: never = gesture;
        throw new Error(`unhandled zone gesture ${String(unhandled)}`);
      }
    }
  }

  cancel(): boolean {
    const drafting = this.gesture !== null || this.corners.length > 0;
    this.gesture = null;
    this.corners = [];
    return drafting;
  }

  finish(): void {
    if (this.corners.length > 0) this.closePolygon();
  }

  takeBack(): boolean {
    if (this.corners.length === 0) return false;
    this.corners = this.corners.slice(0, -1);
    return true;
  }

  draft(): NoteDraftKind | null {
    if (this.corners.length > 0) return "polygon";
    switch (this.gesture?.kind) {
      case "rect":
        return this.gesture.moved ? "rect" : null;
      case "move":
        return "move";
      case "corner":
        return "corner";
      case "corner-click":
      case undefined:
        return null;
      default: {
        const unhandled: never = this.gesture;
        throw new Error(`unhandled zone gesture ${String(unhandled)}`);
      }
    }
  }

  detail(): string | null {
    const gesture = this.gesture;
    if (this.corners.length > 0) {
      const closable = this.corners.length >= ZONE_VERTEX_MIN;
      return `${cornersText(this.corners.length)}${closable ? ", click the first corner or press Enter to close" : ""}`;
    }
    if (gesture?.kind === "rect" && gesture.moved) {
      const rect = studRect(gesture.from, gesture.to);
      return rect ? this.rectText(gesture.from, gesture.to) : FLAT_RECTANGLE;
    }
    if (gesture?.kind === "move")
      return `${gesture.zone.name}, by ${studsAt({ x: gesture.dx, z: gesture.dz })}`;
    if (gesture?.kind === "corner") return `corner to ${studsAt(gesture.to)}`;
    return this.cursor ? `at ${studsAt(this.cursor)}` : null;
  }

  replacing(): string | null {
    const gesture = this.gesture;
    return gesture?.kind === "move" || gesture?.kind === "corner" ? gesture.entry.id : null;
  }

  sketch(out: NoteSketch): void {
    const gesture = this.gesture;
    const handle = this.reach / 2;
    if (this.corners.length > 0) {
      const band = this.cursor ? [...this.corners, this.cursor] : this.corners;
      out.outline(this.studOutline(band), false, DRAFT_RGB);
      const first = this.corners[0];
      if (first) out.square(first.x, first.z, handle, DRAFT_RGB);
      return;
    }
    if (!gesture) return;
    switch (gesture.kind) {
      case "rect": {
        const rect = gesture.moved ? studRect(gesture.from, gesture.to) : null;
        if (rect) out.zone(rect, DRAFT_RGB);
        return;
      }
      case "move":
        out.zone(
          shiftedOutline(gesture.zone.outline, gesture.dx, gesture.dz),
          rgbOf(gesture.zone.color),
        );
        return;
      case "corner":
        out.zone(
          withCornerAt(gesture.zone.outline, gesture.index, gesture.to),
          rgbOf(gesture.zone.color),
        );
        out.square(gesture.to.x, gesture.to.z, handle, DRAFT_RGB);
        return;
      case "corner-click":
        return;
      default: {
        const unhandled: never = gesture;
        throw new Error(`unhandled zone gesture ${String(unhandled)}`);
      }
    }
  }

  private rectText(from: NotePoint, to: NotePoint): string {
    return areaText(Math.abs(to.x - from.x), Math.abs(to.z - from.z));
  }

  private studOutline(points: ReadonlyArray<NotePoint>): ZoneOutline {
    return points.map((point): StudPoint => [point.x, point.z]);
  }

  private releaseRect(from: NotePoint, to: NotePoint, moved: boolean): void {
    if (!moved) {
      this.clickGround(from);
      return;
    }
    const outline = studRect(from, to);
    if (!outline) {
      this.host.refuse(FLAT_RECTANGLE);
      return;
    }
    this.addZone(outline);
  }

  private clickGround(at: NotePoint): void {
    if (this.host.selected()) {
      this.host.select(null);
      return;
    }
    this.addCorner(at);
  }

  private releaseMove(entry: NoteEntry, zone: ZoneNoteV2, dx: number, dz: number): void {
    if (dx === 0 && dz === 0) {
      this.host.select(entry.id);
      return;
    }
    const { index: _index, ...body } = zone;
    if (this.host.update(entry.id, { ...body, outline: shiftedOutline(zone.outline, dx, dz) })) {
      this.host.select(entry.id);
    }
  }

  private releaseCorner(entry: NoteEntry, zone: ZoneNoteV2, index: number, to: NotePoint): void {
    const corner = zone.outline[index];
    if (!corner || (corner[0] === to.x && corner[1] === to.z)) return;
    const { index: _index, ...body } = zone;
    this.host.update(entry.id, { ...body, outline: withCornerAt(zone.outline, index, to) });
  }

  private addCorner(at: NotePoint): void {
    const first = this.corners[0];
    const last = this.corners.at(-1);
    if (last && samePoint(last, at)) return;
    if (first && this.corners.length >= ZONE_VERTEX_MIN && this.nearFirst(first, at)) {
      this.closePolygon();
      return;
    }
    this.corners = [...this.corners, at];
  }

  private nearFirst(first: NotePoint, at: NotePoint): boolean {
    return (
      samePoint(first, at) ||
      nearestCorner([[first.x, first.z]], at.x, at.z, this.reach) !== NO_CORNER
    );
  }

  private closePolygon(): void {
    if (this.corners.length < ZONE_VERTEX_MIN) {
      this.host.refuse(TOO_FEW_CORNERS);
      return;
    }
    if (this.addZone(this.studOutline(this.corners))) this.corners = [];
  }

  private addZone(outline: ZoneOutline): boolean {
    const base = this.host.newNote();
    if (!base) return false;
    const id = this.host.add({
      kind: "zone",
      ...base,
      name: nextZoneName(this.host.entries()),
      color: this.host.style().zoneColor,
      outline: outline.map(([x, z]) => [x, z]),
    });
    if (id === null) return false;
    this.host.select(id);
    return true;
  }
}
