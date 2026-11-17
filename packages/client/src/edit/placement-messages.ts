import type { PlacementSupport, LostSupport } from "./placed-chunks.ts";
import type { OffBaseplate } from "./track-drawing.ts";

export type RefusalRule = "road" | "first-layer" | "support" | "carries" | "track-support";

export interface Refusal {
  readonly rule: RefusalRule;
  readonly message: string;
}

function plates(count: number): string {
  return count === 1 ? "1 plate" : `${count} plates`;
}

export function supportRefusal(label: string, verdict: PlacementSupport): Refusal | null {
  if (verdict.layer === "first") {
    const { support } = verdict;
    switch (support.kind) {
      case "on-table":
        return null;
      case "blocked":
        return {
          rule: "first-layer",
          message: `${label} is first layer and rests on the table, but it would rise into cell (${support.cellX}, ${support.cellZ}), where ${verdict.blocker?.placeable.label ?? "a placement"} already stands ${plates(support.topPlates)} high.`,
        };
      default: {
        const unhandled: never = support;
        throw new Error(`unhandled first-layer support ${String(unhandled)}`);
      }
    }
  }
  const { support } = verdict;
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
    case "no-studs-engaged":
      return {
        rule: "support",
        message: `${label} would land at ${plates(support.yPlates)}, but none of its ${support.cells} base cells meets a stud there, and only ${support.touching} rest on a flat top.`,
      };
    default: {
      const unhandled: never = support;
      throw new Error(`unhandled support ${String(unhandled)}`);
    }
  }
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

export function trackRunRefusal(off: OffBaseplate): Refusal {
  return {
    rule: "track-support",
    message: `Track run refused: piece ${off.piece + 1} of ${off.pieces} (${off.pieceId}) has ${off.missing.count} of its ${off.cells} stud cells with no baseplate under them. Track sits on a baseplate.`,
  };
}

export function trackCarriedRefusal(label: string, off: OffBaseplate): Refusal {
  return {
    rule: "carries",
    message: `${label} carries track: without it, laid piece ${off.piece + 1} (${off.pieceId}) would have ${off.missing.count} of its ${off.cells} stud cells with no baseplate under them. Track sits on a baseplate.`,
  };
}
