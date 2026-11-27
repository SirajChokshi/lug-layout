import {
  studRect,
  zoneContains,
  type NoteEntry,
  type NotePoint,
  type ZoneOutline,
} from "@brr/domain";
import { planeHypot } from "@brr/math";
import { ZONE_VERTEX_MIN, type StudPoint, type ZoneNoteV2 } from "@brr/schema/world";
import { nearestStud } from "../edit/group-transform.ts";
import { areaText } from "../edit/size-labels.ts";
import { DRAFT_RGB, rgbOf, type NoteSketch } from "./note-sketch.ts";
import {
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
  | { readonly kind: "corner-click"; at: NotePoint }
  | {
      readonly kind: "move" | "corner";
      readonly entry: NoteEntry;
      readonly zone: ZoneNoteV2;
      readonly corner: number;
      readonly pressX: number;
      readonly pressZ: number;
      x: number;
      z: number;
    };

const NO_CORNER = -1;
const TOO_FEW_CORNERS = `A zone needs at least ${ZONE_VERTEX_MIN} corners.`;
const FLAT_RECTANGLE = "Drag across at least one stud each way to draw a rectangle.";

function nearestCorner(outline: ZoneOutline, x: number, z: number, reach: number): number {
  let best = NO_CORNER;
  let bestDistance = reach;
  outline.forEach(([cornerX, cornerZ], i) => {
    const distance = planeHypot(cornerX - x, cornerZ - z);
    if (distance > bestDistance) return;
    best = i;
    bestDistance = distance;
  });
  return best;
}

function studOutline(points: ReadonlyArray<NotePoint>): StudPoint[] {
  return points.map((point) => [point.x, point.z]);
}

function changedOutline(gesture: Extract<ZoneGesture, { kind: "move" | "corner" }>): StudPoint[] {
  const { zone, corner, x, z } = gesture;
  return zone.outline.map(([cornerX, cornerZ], i) => {
    if (gesture.kind === "move") return [cornerX + x + 0, cornerZ + z + 0];
    return i === corner ? [x, z] : [cornerX, cornerZ];
  });
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
    const pressed = { pressX: pointer.x, pressZ: pointer.z, x: 0, z: 0 };
    const selected = this.host.selectedEntry();
    if (selected?.note.kind === "zone") {
      const corner = nearestCorner(selected.note.outline, pointer.x, pointer.z, pointer.reachLdu);
      if (corner !== NO_CORNER) {
        const zone = selected.note;
        this.gesture = { kind: "corner", entry: selected, zone, corner, ...pressed, ...at };
        return;
      }
    }
    const under = topmost(
      this.host,
      (entry) =>
        entry.note.kind === "zone" && zoneContains(entry.note.outline, pointer.x, pointer.z),
    );
    this.gesture =
      under?.note.kind === "zone"
        ? { kind: "move", entry: under, zone: under.note, corner: NO_CORNER, ...pressed }
        : { kind: "rect", from: at, to: at, moved: false };
  }

  drag(pointer: NotePointer): void {
    this.hover(pointer);
    const gesture = this.gesture;
    if (!gesture) return;
    const at = studAt(pointer);
    switch (gesture.kind) {
      case "rect":
        gesture.to = at;
        gesture.moved ||= !samePoint(gesture.from, at);
        return;
      case "corner-click":
        gesture.at = at;
        return;
      case "move":
        gesture.x = nearestStud(pointer.x - gesture.pressX);
        gesture.z = nearestStud(pointer.z - gesture.pressZ);
        return;
      case "corner":
        gesture.x = at.x;
        gesture.z = at.z;
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
    switch (gesture?.kind) {
      case undefined:
        return;
      case "rect":
        if (!gesture.moved) this.clickGround(gesture.from);
        else this.addZone(studRect(gesture.from, gesture.to));
        return;
      case "corner-click":
        this.addCorner(gesture.at);
        return;
      case "move":
      case "corner":
        this.changeZone(gesture);
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
    const gesture = this.gesture;
    if (gesture?.kind === "move" || gesture?.kind === "corner") return "shape";
    return gesture?.kind === "rect" && gesture.moved ? "shape" : null;
  }

  detail(): string | null {
    const gesture = this.gesture;
    const count = this.corners.length;
    if (count > 0) {
      const close =
        count >= ZONE_VERTEX_MIN ? ", click the first corner or press Enter to close" : "";
      return `${count} ${count === 1 ? "corner" : "corners"}${close}`;
    }
    if (gesture?.kind === "rect" && gesture.moved) {
      const { from, to } = gesture;
      return studRect(from, to)
        ? areaText(Math.abs(to.x - from.x), Math.abs(to.z - from.z))
        : FLAT_RECTANGLE;
    }
    if (gesture?.kind === "move") return `${gesture.zone.name}, by ${studsAt(gesture)}`;
    if (gesture?.kind === "corner") return `corner to ${studsAt(gesture)}`;
    return this.cursor ? `at ${studsAt(this.cursor)}` : null;
  }

  replacing(): string | null {
    const gesture = this.gesture;
    return gesture?.kind === "move" || gesture?.kind === "corner" ? gesture.entry.id : null;
  }

  sketch(out: NoteSketch): void {
    const gesture = this.gesture;
    const first = this.corners[0];
    if (first) {
      const band = this.cursor ? [...this.corners, this.cursor] : this.corners;
      out.outline(studOutline(band), false, DRAFT_RGB);
      out.square(first.x, first.z, this.reach / 2, DRAFT_RGB);
      return;
    }
    if (gesture?.kind === "rect") {
      const rect = gesture.moved ? studRect(gesture.from, gesture.to) : null;
      if (rect) out.zone(rect, DRAFT_RGB);
    }
    if (gesture?.kind === "move" || gesture?.kind === "corner") {
      out.zone(changedOutline(gesture), rgbOf(gesture.zone.color));
    }
  }

  private clickGround(at: NotePoint): void {
    if (this.host.selectedEntry()) this.host.choose(null);
    else this.addCorner(at);
  }

  private changeZone(gesture: Extract<ZoneGesture, { kind: "move" | "corner" }>): void {
    const { entry, zone } = gesture;
    const outline = changedOutline(gesture);
    const unchanged = outline.every(([x, z], i) => {
      const corner = zone.outline[i];
      return corner?.[0] === x && corner[1] === z;
    });
    const { index: _index, ...body } = zone;
    if (unchanged || this.host.update(entry.id, { ...body, outline })) this.host.choose(entry.id);
  }

  private addCorner(at: NotePoint): void {
    const first = this.corners[0];
    const last = this.corners.at(-1);
    if (last && samePoint(last, at)) return;
    const closing =
      first !== undefined &&
      this.corners.length >= ZONE_VERTEX_MIN &&
      planeHypot(first.x - at.x, first.z - at.z) <= this.reach;
    if (closing) this.closePolygon();
    else this.corners = [...this.corners, at];
  }

  private closePolygon(): void {
    if (this.corners.length < ZONE_VERTEX_MIN) this.host.refuse(TOO_FEW_CORNERS);
    else if (this.addZone(studOutline(this.corners))) this.corners = [];
  }

  private addZone(outline: StudPoint[] | null): boolean {
    if (!outline) {
      this.host.refuse(FLAT_RECTANGLE);
      return false;
    }
    const layer = this.host.newLayer();
    if (layer === null) return false;
    const zones = this.host.entries().filter((entry) => entry.note.kind === "zone").length;
    const id = this.host.add({
      kind: "zone",
      layer,
      name: `Zone ${zones + 1}`,
      color: this.host.newStyle().zoneColor,
      outline,
    });
    if (id !== null) this.host.choose(id);
    return id !== null;
  }
}
