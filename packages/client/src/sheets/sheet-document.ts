import type { DrawItem } from "./draw-list.ts";
import { TILED_SCALE_DENOMINATORS } from "./drawing-scale.ts";
import type { OrientationChoice, PageSize, PaperId } from "./paper.ts";

export interface SheetPage {
  readonly name: string;
  readonly size: PageSize;
  readonly items: ReadonlyArray<DrawItem>;
}

export interface SheetDocument {
  readonly title: string;
  readonly pages: ReadonlyArray<SheetPage>;
}

export interface SheetFile {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly pages: number;
  readonly notes: ReadonlyArray<string>;
}

export interface ISheetWriter {
  write(document: SheetDocument, baseName: string): SheetFile;
}

export type SheetLayout =
  | { readonly kind: "whole" }
  | {
      readonly kind: "fit";
      readonly paper: PaperId;
      readonly orientation: OrientationChoice;
    }
  | {
      readonly kind: "tiled";
      readonly paper: PaperId;
      readonly orientation: OrientationChoice;
      readonly denominator: number;
      readonly overlapMm: number;
    };

export const MIN_OVERLAP_MM = 5;
export const MAX_OVERLAP_MM = 30;
export const DEFAULT_OVERLAP_MM = 10;

export function sheetLayoutProblems(layout: SheetLayout): ReadonlyArray<string> {
  switch (layout.kind) {
    case "whole":
    case "fit":
      return [];
    case "tiled": {
      const problems: string[] = [];
      if (!TILED_SCALE_DENOMINATORS.includes(layout.denominator)) {
        problems.push(
          `Tiled sheets print at ${TILED_SCALE_DENOMINATORS.map((n) => `1:${n}`).join(", ")}, not 1:${layout.denominator}.`,
        );
      }
      if (
        !Number.isFinite(layout.overlapMm) ||
        layout.overlapMm < MIN_OVERLAP_MM ||
        layout.overlapMm > MAX_OVERLAP_MM
      ) {
        problems.push(
          `The overlap is ${MIN_OVERLAP_MM} to ${MAX_OVERLAP_MM} mm, so registration marks fit inside it.`,
        );
      }
      return problems;
    }
    default: {
      const unhandled: never = layout;
      throw new Error(`unhandled sheet layout ${String(unhandled)}`);
    }
  }
}

export type SheetFormat = "svg" | "pdf";

export interface SheetRequest {
  readonly layout: SheetLayout;
  readonly format: SheetFormat;
}

const FILE_NAME_UNSAFE = /[^A-Za-z0-9-]+/gu;

export function sheetFileBase(planName: string, layout: SheetLayout): string {
  const safe = planName.trim().replaceAll(FILE_NAME_UNSAFE, "-") || "plan";
  switch (layout.kind) {
    case "whole":
      return `${safe}.plan`;
    case "fit":
      return `${safe}.plan-fit-${layout.paper}`;
    case "tiled":
      return `${safe}.plan-tiled-${layout.paper}-1to${layout.denominator}`;
    default: {
      const unhandled: never = layout;
      throw new Error(`unhandled sheet layout ${String(unhandled)}`);
    }
  }
}
