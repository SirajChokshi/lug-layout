import type { UpperSupport } from "@brr/domain";
import { PLATE_LDU } from "@brr/math";
import type { LostSupport, PlacedOverlap, PlacementCheck, VolumeOwner } from "./placed-chunks.ts";
import type { OffBaseplate, RunBlock } from "./track-drawing.ts";

export type RefusalRule =
  | "road"
  | "first-layer"
  | "support"
  | "overlap"
  | "carries"
  | "track-support";

export interface Refusal {
  readonly rule: RefusalRule;
  readonly message: string;
}

function plates(count: number): string {
  return count === 1 ? "1 plate" : `${count} plates`;
}

function platesOf(ldu: number): string {
  return `${ldu / PLATE_LDU}`;
}

function ownerLabel(owner: VolumeOwner): string {
  switch (owner.kind) {
    case "model":
      return owner.model.placeable.label;
    case "track":
      return `laid track piece ${owner.piece + 1} (${owner.pieceId})`;
    default: {
      const unhandled: never = owner;
      throw new Error(`unhandled owner ${String(unhandled)}`);
    }
  }
}

function overlapText(placed: PlacedOverlap): string {
  const { overlap } = placed;
  return `${ownerLabel(placed.owner)} at cell (${overlap.cellX}, ${overlap.cellZ}): it fills ${platesOf(overlap.candidateBottomLdu)} to ${platesOf(overlap.candidateTopLdu)} plates there, and ${ownerLabel(placed.owner)} fills ${platesOf(overlap.bottomLdu)} to ${platesOf(overlap.topLdu)}`;
}

export function overlapRefusal(label: string, placed: PlacedOverlap): Refusal {
  return { rule: "overlap", message: `${label} would intersect ${overlapText(placed)}.` };
}

export function supportRefusal(
  label: string,
  support: UpperSupport,
  restsOn: VolumeOwner | null,
): Refusal | null {
  switch (support.kind) {
    case "studs":
    case "flat":
      return null;
    case "no-base":
      return {
        rule: "support",
        message: `${label} has no anti-studs and no flat base to rest on, so it can't be placed on studs.`,
      };
    case "on-table":
      return {
        rule: "first-layer",
        message: `${label} can't stand on the bare table: only baseplates, road plates and models with their own baseplate do. Put a baseplate under it.`,
      };
    case "flat-on-studs":
      return {
        rule: "support",
        message: `${label} has a solid bottom at cell (${support.cellX}, ${support.cellZ}), which would sit on studs ${plates(support.yPlates)} up.`,
      };
    case "off-lattice-top":
      return {
        rule: "support",
        message: `${label} would rest on ${support.cells} cells whose top isn't a whole number of plates above the baseplates (a road plate on the table tops out 1.5 plates up), so nothing can rest there yet.`,
      };
    case "no-studs-engaged":
      return {
        rule: "support",
        message: `${label} would rest on ${restsOn ? ownerLabel(restsOn) : "nothing"} at ${plates(support.yPlates)}, but none of its ${support.cells} base cells meets a stud there, and only ${support.touching} rest on a flat top.`,
      };
    default: {
      const unhandled: never = support;
      throw new Error(`unhandled support ${String(unhandled)}`);
    }
  }
}

export function checkRefusal(label: string, check: PlacementCheck): Refusal | null {
  if (check.overlap) return overlapRefusal(label, check.overlap);
  return check.support ? supportRefusal(label, check.support, check.restsOn) : null;
}

export function carriesRefusal(label: string, lost: ReadonlyArray<LostSupport>): Refusal | null {
  const first = lost[0];
  if (!first) return null;
  const others = lost.length > 1 ? ` and ${lost.length - 1} more` : "";
  return {
    rule: "carries",
    message: `${label} carries ${first.model.placeable.label}${others}, which would lose its support. Remove that first.`,
  };
}

export function trackRunRefusal(block: RunBlock): Refusal {
  const at = `piece ${block.piece + 1} of ${block.pieces} (${block.pieceId})`;
  switch (block.kind) {
    case "off-baseplate":
      return {
        rule: "track-support",
        message: `Track run refused: ${at} has ${block.missing.count} of the ${block.cells} stud cells between its ends with no baseplate under them. Track sits on a baseplate.`,
      };
    case "overlap":
      return {
        rule: "overlap",
        message: `Track run refused: ${at} would intersect ${overlapText(block.with)}.`,
      };
    case "crosses-track":
      return {
        rule: "overlap",
        message: `Track run refused: ${at} crosses ${block.other < 0 ? `piece ${-block.other} of this run` : `laid track piece ${block.other + 1}`} (${block.otherId}) without joining it. Track only crosses through a real crossing part.`,
      };
    default: {
      const unhandled: never = block;
      throw new Error(`unhandled run block ${String(unhandled)}`);
    }
  }
}

export function trackCarriedRefusal(label: string, off: OffBaseplate): Refusal {
  return {
    rule: "carries",
    message: `${label} carries track: without it, laid piece ${off.piece + 1} (${off.pieceId}) would have ${off.missing.count} of the ${off.cells} stud cells between its ends with no baseplate under them. Remove that piece first: in the track tool, click it and press Delete.`,
  };
}
