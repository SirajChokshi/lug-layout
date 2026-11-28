import type { CrossingRamp, CrossingTrackSystem, Palette, TrackPiece } from "@brr/schema/bundle";
import type { LdrawLibrary } from "../ldraw/library.ts";
import { walkPart, type PlacedPolygon } from "../ldraw/walk.ts";
import { measureRails } from "../verify/geometry.ts";
import { RAIL_SECTION_X } from "../verify/geometry-report.ts";
import { planOutline, type BakedOutline } from "./plan-outline.ts";
import { measureStud, rampFacts } from "./ramp-facts.ts";

export const LEVEL_CROSSING_FILE = "level-crossing.json";

const BUNDLE_PART_PREFIX = "ldraw:";

type CatalogPiece = Pick<TrackPiece, "part" | "kind" | "system" | "status">;

export interface LevelCrossingData {
  readonly systems: ReadonlyArray<CrossingTrackSystem>;
  readonly ramps: ReadonlyArray<CrossingRamp>;
}

function polygonsOf(library: LdrawLibrary, file: string): PlacedPolygon[] {
  const polygons: PlacedPolygon[] = [];
  const { missingFiles } = walkPart(library, file, { polygon: (p) => void polygons.push(p) });
  if (missingFiles.size > 0) {
    throw new Error(`${file} needs files the library lacks: ${[...missingFiles].join(", ")}`);
  }
  return polygons;
}

function partName(partId: string): string {
  return partId.startsWith(BUNDLE_PART_PREFIX) ? partId.slice(BUNDLE_PART_PREFIX.length) : partId;
}

function partFile(partId: string): string {
  return `${partName(partId)}.dat`;
}

function trackSystems(
  library: LdrawLibrary,
  pieces: ReadonlyArray<CatalogPiece>,
): CrossingTrackSystem[] {
  const systems: CrossingTrackSystem[] = [];
  for (const system of new Set(pieces.map((piece) => piece.system))) {
    const straight = pieces.find(
      (piece) =>
        piece.system === system && piece.kind === "straight" && piece.status === "certified",
    );
    if (!straight) continue;
    const rails = measureRails(library, partName(straight.part), RAIL_SECTION_X);
    const railTopLdu = Number(rails.railTopAboveUndersideLdu);
    if (!Number.isInteger(railTopLdu)) {
      throw new Error(
        `${straight.part}: rail top ${rails.railTopAboveUndersideLdu} LDU is not whole`,
      );
    }
    systems.push({ system, straight: straight.part, railTopLdu });
  }
  return systems;
}

export function levelCrossingData(
  library: LdrawLibrary,
  palette: Palette,
  pieces: ReadonlyArray<CatalogPiece>,
  studPrimitives: ReadonlyArray<string>,
): LevelCrossingData {
  const [studPrimitive] = studPrimitives;
  if (studPrimitive === undefined) throw new Error("the primitive table names no stud primitive");
  const stud = measureStud(polygonsOf(library, studPrimitive));
  const ramps: CrossingRamp[] = [];
  for (const part of palette.parts) {
    const id = `${BUNDLE_PART_PREFIX}${part.id}`;
    const file = partFile(part.id);
    const title = library.load(file)?.header.title ?? part.id;
    const ramp = rampFacts(id, title, polygonsOf(library, file), stud);
    if (ramp) ramps.push(ramp);
  }
  return { systems: trackSystems(library, pieces), ramps };
}

export interface OutlineLibraries {
  readonly library: (partId: string) => LdrawLibrary;
  readonly file: (partId: string) => string;
}

export function planOutlines(
  libraries: OutlineLibraries,
  parts: ReadonlyArray<string>,
): ReadonlyMap<string, BakedOutline> {
  return new Map(
    parts.map((part) => [
      part,
      planOutline(polygonsOf(libraries.library(part), libraries.file(part))),
    ]),
  );
}
