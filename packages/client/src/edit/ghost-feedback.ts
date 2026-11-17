import type { GhostTone } from "@brr/render";
import type { ModuleFitView, RoadSnapView, TrackCommitResult } from "./editor.ts";
import type { Placeable } from "./placeable.ts";
import type { TrackDragView } from "./track-drawing.ts";

export interface GhostFeedbackView {
  readonly tone: GhostTone;
  readonly message: string | null;
}

const FREE: GhostFeedbackView = { tone: "valid", message: null };

function studs(count: number): string {
  return count === 1 ? "1 stud" : `${count} studs`;
}

function partNumber(placeable: Placeable): string {
  return placeable.group.replace(/^[a-z]+:/u, "");
}

export function partName(placeable: Placeable): string {
  switch (placeable.kind) {
    case "road-plate":
      return `${partNumber(placeable)} road plate`;
    case "baseplate":
      return `${partNumber(placeable)} baseplate`;
    case "mils-module":
    case "model":
      return placeable.label;
    default: {
      const unhandled: never = placeable.kind;
      throw new Error(`unhandled kind ${String(unhandled)}`);
    }
  }
}

export function roadGhostFeedback(
  fit: RoadSnapView | null,
  neighbour: string | null,
): GhostFeedbackView {
  if (!fit) return FREE;
  const other = neighbour ?? "the road";
  switch (fit.state) {
    case "free":
      return FREE;
    case "snapped":
      return { tone: "snapped", message: `Joins ${other} along ${studs(fit.joinedCells)}` };
    case "refused":
      return {
        tone: "blocked",
        message:
          fit.overlappingCells > 0
            ? `Overlaps ${other}`
            : `Edges miss ${other} on ${studs(fit.mismatchedCells)}`,
      };
    default: {
      const unhandled: never = fit.state;
      throw new Error(`unhandled road fit ${String(unhandled)}`);
    }
  }
}

function edges(count: number): string {
  return count === 1 ? "1 module edge" : `${count} module edges`;
}

export function moduleGhostFeedback(fit: ModuleFitView | null): GhostFeedbackView | null {
  if (!fit) return null;
  if (fit.occupied) return { tone: "blocked", message: "That module square is taken" };
  if (fit.joined > 0 && fit.mismatched === 0) {
    return { tone: "snapped", message: `Joins ${edges(fit.joined)}` };
  }
  return null;
}

const NO_EXACT_JOIN = "No exact join reaches that end";
const NO_JOIN_IN_TIME = "No join found in time";

export function trackRefusalMessage(commit: TrackCommitResult | null): string | null {
  switch (commit) {
    case "refused-impossible":
      return NO_EXACT_JOIN;
    case "refused-limit":
      return NO_JOIN_IN_TIME;
    case "laid":
    case "joined":
    case "switch-straight":
    case "switch-branching":
    case null:
      return null;
    default: {
      const unhandled: never = commit;
      throw new Error(`unhandled commit ${String(unhandled)}`);
    }
  }
}

export function trackGhostFeedback(drag: TrackDragView | null): GhostFeedbackView | null {
  if (!drag || drag.pieces === 0) return null;
  switch (drag.closure) {
    case "exact":
      return { tone: "snapped", message: "Joins the open end exactly" };
    case "impossible":
      return { tone: "blocked", message: NO_EXACT_JOIN };
    case "limit":
      return { tone: "blocked", message: NO_JOIN_IN_TIME };
    case null:
      return FREE;
    default: {
      const unhandled: never = drag.closure;
      throw new Error(`unhandled closure ${String(unhandled)}`);
    }
  }
}
