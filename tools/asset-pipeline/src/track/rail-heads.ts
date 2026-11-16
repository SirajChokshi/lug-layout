import type { LdrawLibrary } from "../ldraw/library.ts";
import { isStudPrimitive } from "../ldraw/parse.ts";
import { walkPart, type PlacedPolygon } from "../ldraw/walk.ts";

const FLAT_EPSILON = 1e-6;
const LATERAL_SCAN_LDU = 90;
const LATERAL_SCAN_STEP_LDU = 0.03125;
const RAIL_TOP_PROBE_RADIUS_LDU = 70;
const RAIL_LEVEL_BAND_LDU = 0.25;
export const RAIL_SECTION_INWARD_LDU = 20;

export interface PlanPoint {
  readonly x: number;
  readonly z: number;
}

export interface RailHeads {
  readonly topY: number;
  readonly polygons: ReadonlyArray<ReadonlyArray<PlanPoint>>;
}

export interface RailSection {
  readonly railCentresLdu: ReadonlyArray<number>;
  readonly halfSpacingLdu: number;
  readonly centreOffsetLdu: number;
}

function isFlat(polygon: PlacedPolygon): boolean {
  const [first, ...rest] = polygon.vertices;
  return (
    first !== undefined && rest.every((vertex) => Math.abs(vertex[1] - first[1]) < FLAT_EPSILON)
  );
}

interface FlatPolygon {
  readonly y: number;
  readonly outline: ReadonlyArray<PlanPoint>;
}

export function flatPolygons(library: LdrawLibrary, part: string): ReadonlyArray<FlatPolygon> {
  const flat: FlatPolygon[] = [];
  walkPart(library, `${part}.dat`, {
    reference: (placed) => (isStudPrimitive(placed.file) ? "skip" : "descend"),
    polygon: (placed) => {
      const y = placed.vertices[0]?.[1];
      if (y !== undefined && isFlat(placed)) {
        flat.push({ y, outline: placed.vertices.map(([x, , z]) => ({ x, z })) });
      }
    },
  });
  return flat;
}

function headsAtLevel(flat: ReadonlyArray<FlatPolygon>, level: number): RailHeads {
  return {
    topY: level,
    polygons: flat
      .filter((polygon) => Math.abs(polygon.y - level) <= RAIL_LEVEL_BAND_LDU)
      .map((polygon) => polygon.outline),
  };
}

export function railHeadsAtEnd(
  flat: ReadonlyArray<FlatPolygon>,
  origin: PlanPoint,
  along: number,
): RailHeads | null {
  const levels = [
    ...new Set(
      flat
        .filter((polygon) =>
          polygon.outline.some(
            (point) =>
              Math.hypot(point.x - origin.x, point.z - origin.z) <= RAIL_TOP_PROBE_RADIUS_LDU,
          ),
        )
        .map((polygon) => polygon.y),
    ),
  ].toSorted((a, b) => a - b);
  for (const level of levels) {
    const heads = headsAtLevel(flat, level);
    if (railSection(heads, origin, along, RAIL_SECTION_INWARD_LDU) !== null) return heads;
  }
  return null;
}

function insidePolygon(polygon: ReadonlyArray<PlanPoint>, point: PlanPoint): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a === undefined || b === undefined) continue;
    if (
      a.z > point.z !== b.z > point.z &&
      point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export function onRailHead(heads: RailHeads, point: PlanPoint): boolean {
  return heads.polygons.some((polygon) => insidePolygon(polygon, point));
}

export function railSection(
  heads: RailHeads,
  origin: PlanPoint,
  along: number,
  inwardLdu: number,
): RailSection | null {
  const centre = {
    x: origin.x + Math.cos(along) * inwardLdu,
    z: origin.z + Math.sin(along) * inwardLdu,
  };
  const normal = { x: -Math.sin(along), z: Math.cos(along) };
  const runs: Array<{ from: number; to: number }> = [];
  let open: number | null = null;
  for (
    let offset = -LATERAL_SCAN_LDU;
    offset <= LATERAL_SCAN_LDU;
    offset += LATERAL_SCAN_STEP_LDU
  ) {
    const inside = onRailHead(heads, {
      x: centre.x + normal.x * offset,
      z: centre.z + normal.z * offset,
    });
    if (inside && open === null) open = offset;
    if (!inside && open !== null) {
      runs.push({ from: open, to: offset - LATERAL_SCAN_STEP_LDU });
      open = null;
    }
  }
  const railCentresLdu = runs.map((run) => (run.from + run.to) / 2);
  const [near, far] = railCentresLdu;
  if (railCentresLdu.length !== 2 || near === undefined || far === undefined) return null;
  return { railCentresLdu, halfSpacingLdu: (far - near) / 2, centreOffsetLdu: (far + near) / 2 };
}
