import type { UpperSupport } from "@brr/domain";
import type { GhostTone } from "@brr/render";
import type { RoadSnapView } from "./editor.ts";
import type { PlacementCheck, VolumeOwner } from "./placed-chunks.ts";
import type { RunBlock, TrackDragView } from "./track-drawing.ts";

export interface GhostFeedbackView {
  readonly tone: GhostTone;
  readonly message: string | null;
}

const FREE: GhostFeedbackView = { tone: "valid", message: null };

function cells(count: number): string {
  return count === 1 ? "1 cell" : `${count} cells`;
}

export function roadGhostFeedback(fit: RoadSnapView | null): GhostFeedbackView {
  if (!fit) return FREE;
  switch (fit.state) {
    case "free":
      return FREE;
    case "snapped":
      return { tone: "snapped", message: `Joins the road on ${cells(fit.joinedCells)}` };
    case "refused":
      return {
        tone: "blocked",
        message:
          fit.overlappingCells > 0
            ? `Overlaps a road plate on ${cells(fit.overlappingCells)}`
            : `Road edges don't line up on ${cells(fit.mismatchedCells)}`,
      };
    default: {
      const unhandled: never = fit.state;
      throw new Error(`unhandled road fit ${String(unhandled)}`);
    }
  }
}

export function trackGhostFeedback(drag: TrackDragView | null): GhostFeedbackView | null {
  if (!drag || drag.pieces === 0) return null;
  if (drag.blocked) return { tone: "blocked", message: runBlockReason(drag.blocked) };
  switch (drag.closure) {
    case "exact":
      return { tone: "snapped", message: "Joins the open end exactly" };
    case "impossible":
      return { tone: "blocked", message: "No exact join reaches that end" };
    case "limit":
      return { tone: "blocked", message: "No join found in time" };
    case null:
      return FREE;
    default: {
      const unhandled: never = drag.closure;
      throw new Error(`unhandled closure ${String(unhandled)}`);
    }
  }
}

function ownerName(owner: VolumeOwner): string {
  switch (owner.kind) {
    case "model":
      return owner.model.placeable.label;
    case "track":
      return `laid track (${owner.pieceId})`;
    default: {
      const unhandled: never = owner;
      throw new Error(`unhandled owner ${String(unhandled)}`);
    }
  }
}

function supportReason(support: UpperSupport): string | null {
  switch (support.kind) {
    case "studs":
    case "flat":
      return null;
    case "no-base":
      return "It has no base to stand on studs";
    case "on-table":
      return "Needs a baseplate under it";
    case "flat-on-studs":
      return "Its flat bottom would sit on studs";
    case "off-lattice-top":
      return "The top below isn't a whole plate high";
    case "no-studs-engaged":
      return "No studs to grip here";
    default: {
      const unhandled: never = support;
      throw new Error(`unhandled support ${String(unhandled)}`);
    }
  }
}

export function checkGhostFeedback(check: PlacementCheck): GhostFeedbackView | null {
  if (check.overlap) {
    return { tone: "blocked", message: `Bumps into ${ownerName(check.overlap.owner)}` };
  }
  const reason = check.support ? supportReason(check.support) : null;
  return reason === null ? null : { tone: "blocked", message: reason };
}

export function trackJoinFeedback(joins: number): GhostFeedbackView | null {
  if (joins === 0) return null;
  return {
    tone: "snapped",
    message: joins === 1 ? "Joins 1 track end" : `Joins ${joins} track ends`,
  };
}

function runBlockReason(block: RunBlock): string {
  switch (block.kind) {
    case "off-baseplate":
      return "Track needs a baseplate under it";
    case "overlap":
      return `Track bumps into ${ownerName(block.with.owner)}`;
    case "crosses-track":
      return "Crosses track without a crossing piece";
    default: {
      const unhandled: never = block;
      throw new Error(`unhandled run block ${String(unhandled)}`);
    }
  }
}
