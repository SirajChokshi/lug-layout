import { MM_PER_STUD } from "@brr/math";
import { writeStoredZip } from "@brr/storage/zip";
import type { DrawItem } from "./draw-list.ts";
import { TILED_SCALE_DENOMINATORS } from "./drawing-scale.ts";
import type { OrientationChoice, PageSize, PaperId } from "./paper.ts";
import type { SheetLayerId } from "./plan-drawing.ts";

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
  write(document: SheetDocument, baseName: string): Promise<SheetFile>;
}

export interface SheetEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

const PAGE_NUMBER_DIGITS = 2;

export function packedSheetFile(
  baseName: string,
  extension: string,
  mimeType: string,
  entries: ReadonlyArray<SheetEntry>,
  pages: number,
  notes: ReadonlyArray<string> = [],
): SheetFile {
  const [only] = entries;
  if (only && entries.length === 1) {
    return { fileName: `${baseName}.${extension}`, mimeType, bytes: only.bytes, pages, notes };
  }
  return {
    fileName: `${baseName}.${extension}.zip`,
    mimeType: "application/zip",
    bytes: writeStoredZip(
      entries.map((entry, i) => ({
        name: `${String(i + 1).padStart(PAGE_NUMBER_DIGITS, "0")}-${entry.name}.${extension}`,
        bytes: entry.bytes,
      })),
    ),
    pages,
    notes,
  };
}

export const IMAGE_PIXELS_PER_MM = 4;
export const MIN_PIXELS_PER_STUD = 1;
export const MAX_PIXELS_PER_STUD = MM_PER_STUD * IMAGE_PIXELS_PER_MM;
export const DEFAULT_PIXELS_PER_STUD = 8;

export function imageDenominator(pixelsPerStud: number): number {
  return MAX_PIXELS_PER_STUD / pixelsPerStud;
}

export type SheetLayout =
  | { readonly kind: "whole" }
  | { readonly kind: "image"; readonly pixelsPerStud: number }
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
    case "image":
      return Number.isInteger(layout.pixelsPerStud) &&
        layout.pixelsPerStud >= MIN_PIXELS_PER_STUD &&
        layout.pixelsPerStud <= MAX_PIXELS_PER_STUD
        ? []
        : [
            `An image is ${MIN_PIXELS_PER_STUD} to ${MAX_PIXELS_PER_STUD} whole pixels per stud; at ${MAX_PIXELS_PER_STUD} it draws the plan at 1:1.`,
          ];
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

export type SheetFormat = "svg" | "pdf" | "png";

export type SheetContent = "placements" | "tables";

export interface SheetSelection {
  readonly name: string;
  readonly content: SheetContent;
  readonly layers: ReadonlyArray<SheetLayerId>;
}

export interface SheetRequest {
  readonly selection: SheetSelection;
  readonly layout: SheetLayout;
  readonly format: SheetFormat;
}

const FILE_NAME_UNSAFE = /[^A-Za-z0-9-]+/gu;

function fileSafe(text: string): string {
  return text
    .trim()
    .replaceAll(FILE_NAME_UNSAFE, "-")
    .replaceAll(/^-+|-+$/gu, "");
}

export function sheetFileBase(planName: string, sheetName: string, layout: SheetLayout): string {
  const plan = fileSafe(planName) || "plan";
  const sheet = fileSafe(sheetName).toLowerCase() || "plan";
  switch (layout.kind) {
    case "whole":
      return `${plan}.${sheet}`;
    case "image":
      return `${plan}.${sheet}-${layout.pixelsPerStud}px-per-stud`;
    case "fit":
      return `${plan}.${sheet}-fit-${layout.paper}`;
    case "tiled":
      return `${plan}.${sheet}-tiled-${layout.paper}-1to${layout.denominator}`;
    default: {
      const unhandled: never = layout;
      throw new Error(`unhandled sheet layout ${String(unhandled)}`);
    }
  }
}

export function sheetSetFileBase(planName: string): string {
  return `${fileSafe(planName) || "plan"}.sheets`;
}

export function pageFilePrefix(sheetName: string): string {
  return fileSafe(sheetName).toLowerCase() || "plan";
}
