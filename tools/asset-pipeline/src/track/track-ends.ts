import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LdrawLibrary } from "../ldraw/library.ts";
import { walkPart } from "../ldraw/walk.ts";
import { ZETA16_ORDER } from "@brr/math";
import { encodeZeta16, type TrackEnd } from "@brr/schema/bundle";
import {
  findZeta16Representation,
  ZETA16_STEP_RADIANS,
  type FieldRepresentation,
} from "./cyclotomic.ts";

export const LDU_PER_STUD = 20;
const UNROUNDED_TOLERANCE_LDU = 1e-6;
export const PART_FRAME_HEADING_GRID = ZETA16_STEP_RADIANS / 2;
const CERTIFIED_RESIDUAL_LIMIT_LDU = 0.0005;
const MARKERS_PATH = fileURLToPath(new URL("./track-end-markers.json", import.meta.url));

export interface TrackEndMarker {
  readonly file: string;
  readonly outwardSign: 1 | -1;
}

export interface MarkerEnd {
  readonly marker: string;
  readonly x: number;
  readonly z: number;
  readonly outward: number;
  readonly toleranceLdu: number;
}

function summarize(field: FieldRepresentation): NonNullable<TrackEnd["fieldSearch"]> {
  return {
    bestResidualLdu: field.residual * LDU_PER_STUD,
    solutionCount: field.solutionCount,
  };
}

export function loadTrackEndMarkers(): ReadonlyArray<TrackEndMarker> {
  const parsed: unknown = JSON.parse(readFileSync(MARKERS_PATH, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("markers" in parsed)) {
    throw new Error("track-end-markers.json: missing markers");
  }
  const { markers } = parsed;
  if (!Array.isArray(markers)) throw new Error("track-end-markers.json: markers must be an array");
  return markers.map((value: unknown) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("file" in value) ||
      !("outward" in value)
    ) {
      throw new Error("track-end-markers.json: each marker needs file and outward");
    }
    const { file, outward } = value;
    if (typeof file !== "string" || (outward !== "+x" && outward !== "-x")) {
      throw new Error(`track-end-markers.json: bad marker ${JSON.stringify(value)}`);
    }
    return { file, outwardSign: outward === "+x" ? 1 : -1 };
  });
}

export function findTrackEnds(
  library: LdrawLibrary,
  part: string,
  markers: ReadonlyArray<TrackEndMarker>,
): ReadonlyArray<MarkerEnd> {
  const bySign = new Map(markers.map((marker) => [marker.file, marker.outwardSign]));
  const ends: MarkerEnd[] = [];
  walkPart(library, `${part}.dat`, {
    reference: (placed) => {
      const sign = bySign.get(placed.file);
      if (sign === undefined) return "descend";
      const [a, , , , , , g, , , x, , z] = placed.world;
      const duplicate = ends.some(
        (end) => Math.hypot(end.x - x, end.z - z) < UNROUNDED_TOLERANCE_LDU,
      );
      if (!duplicate) {
        ends.push({
          marker: placed.file,
          x,
          z,
          outward: Math.atan2(g * sign, a * sign),
          toleranceLdu: Math.max(placed.positionToleranceLdu, UNROUNDED_TOLERANCE_LDU),
        });
      }
      return "skip";
    },
  });
  return ends.toSorted((p, q) => p.x - q.x || p.z - q.z);
}

function normalizeAngle(angle: number): number {
  const turn = 2 * Math.PI;
  return ((angle % turn) + turn) % turn;
}

export function entryInwardAngle(entry: MarkerEnd): number {
  return Math.round((entry.outward + Math.PI) / PART_FRAME_HEADING_GRID) * PART_FRAME_HEADING_GRID;
}

export function relativeToEntry(ends: ReadonlyArray<MarkerEnd>): ReadonlyArray<TrackEnd> {
  const entry = ends[0];
  if (entry === undefined) return [];
  const inward = entryInwardAngle(entry);
  const cos = Math.cos(-inward);
  const sin = Math.sin(-inward);
  return ends.map((end) => {
    const dx = end.x - entry.x;
    const dz = end.z - entry.z;
    const xStuds = (dx * cos - dz * sin) / LDU_PER_STUD;
    const zStuds = (dx * sin + dz * cos) / LDU_PER_STUD;
    const steps = normalizeAngle(end.outward - inward) / ZETA16_STEP_RADIANS;
    const headingSteps = Math.round(steps) % ZETA16_ORDER;
    const toleranceLdu = Math.max(end.toleranceLdu, entry.toleranceLdu);
    const field = findZeta16Representation({ x: xStuds, y: zStuds }, toleranceLdu / LDU_PER_STUD);
    const certified =
      field !== undefined &&
      field.solutionCount === 1 &&
      field.residual * LDU_PER_STUD <= CERTIFIED_RESIDUAL_LIMIT_LDU;
    return {
      marker: end.marker,
      xStuds,
      zStuds,
      headingSteps,
      headingResidualDegrees: ((steps - Math.round(steps)) * ZETA16_STEP_RADIANS * 180) / Math.PI,
      toleranceLdu,
      fieldSearch: field === undefined ? null : summarize(field),
      fieldCertified: certified,
      coefficients: certified ? encodeZeta16(field.coefficients) : null,
    };
  });
}
