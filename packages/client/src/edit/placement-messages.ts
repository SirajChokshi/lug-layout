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
  | "track-support"
  | "clearance"
  | "grade";

export interface Refusal {
  readonly rule: RefusalRule;
  readonly message: string;
}

function plates(count: number): string {
  return count === 1 ? "1 plate" : `${count} plates`;
}

function platesOf(ldu: number): string {
  return `${(ldu / PLATE_LDU).toFixed(2).replace(/\.?0+$/u, "")} plates`;
}

function ownerLabel(owner: VolumeOwner): string {
  switch (owner.kind) {
    case "model":
      return owner.model.placeable.label;
    case "track":
      return `laid track piece ${owner.piece + 1} (${owner.pieceId})`;
    case "pier":
      return `the ${plates(owner.plates)} brick pier under raised track`;
    default: {
      const unhandled: never = owner;
      throw new Error(`unhandled owner ${String(unhandled)}`);
    }
  }
}

function overlapText(placed: PlacedOverlap): string {
  const { overlap } = placed;
  const other = ownerLabel(placed.owner);
  return `${other} at cell (${overlap.cellX}, ${overlap.cellZ}): there it fills ${overlap.candidateBottomLdu} to ${overlap.candidateTopLdu} LDU above the baseplate tops, and ${other} fills ${overlap.bottomLdu} to ${overlap.topLdu} LDU`;
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

function crossedText(other: number, inModel: string | null): string {
  if (inModel !== null) return `the track in ${inModel}`;
  return other < 0 ? `piece ${-other} of this run` : `laid track piece ${other + 1}`;
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
        message: `Track run refused: ${at} crosses ${crossedText(block.other, block.inModel)} (${block.otherId}) at the same height without joining it. Track crosses level only through a real crossing part, or passes over with enough clearance.`,
      };
    case "low-clearance":
      return {
        rule: "clearance",
        message: `Track run refused: ${at} passes ${block.gapLdu} LDU (${platesOf(block.gapLdu)}) above the rails of ${crossedText(block.other, block.inModel)} (${block.otherId}), but the tallest train, ${block.gauge}, stands ${block.needLdu.toFixed(1)} LDU (${platesOf(block.needLdu)}) above its rails. Raise the upper track.`,
      };
    case "pier-off-baseplate":
      return {
        rule: "track-support",
        message: `Track run refused: the ${block.plates === 0 ? "ground joint" : `${plates(block.plates)} pier`} at an end of ${at} has ${block.missing.count} of its ${block.cells} stud cells off the baseplates. Every raised joint stands on a baseplate.`,
      };
    case "pier-blocked":
      return {
        rule: "overlap",
        message: block.with
          ? `Track run refused: the ${plates(block.plates)} pier at an end of ${at} would intersect ${overlapText(block.with)}.`
          : `Track run refused: the ${plates(block.plates)} pier at an end of ${at} would stand on piece ${(block.runPiece ?? 0) + 1} of this run.`,
      };
    case "too-steep":
      return {
        rule: "grade",
        message: `Track run refused: climbing from ${plates(block.fromPlates)} to ${plates(block.toPlates)} at ${plates(block.risePerPiece)} per piece needs ${Math.ceil(Math.abs(block.toPlates - block.fromPlates) / block.risePerPiece)} pieces, and the run has ${block.pieces}.`,
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
