import type { PartAsset } from "@brr/catalog";
import {
  planLevelCrossings,
  type CrossingConflict,
  type CrossingPlan,
  type CrossingTrackPiece,
  type LevelCrossing,
  type RoadPlacement,
  type TrackMeetsRect,
} from "@brr/domain";
import { CHUNK_LDU, chunkKey, chunkOf, rot90Cos, rot90Sin } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS, type ChunkInstances } from "@brr/render";
import type { LevelCrossingRecipe } from "@brr/schema/bundle";
import type { ChunkPartInstances } from "../scene/placements.ts";
import { withStuds } from "../scene/stud-stream.ts";
import type { ColorTable } from "../scene/viewer-scene.ts";

const CROSSING_KEY_BASE = 2 ** 47;
const REPRESENTATION_EPSILON_LDU = 1e-6;
const TRIANGLE_FLOATS = 6;

export interface TrackCrossingInput {
  readonly pieces: ReadonlyArray<CrossingTrackPiece>;
  readonly meets: TrackMeetsRect;
}

export interface CrossingConflictView {
  readonly track: number;
  readonly road: number;
  readonly reason: CrossingConflict;
  readonly text: string;
}

export interface CrossingView {
  readonly crossings: number;
  readonly ramps: number;
  readonly part: string;
  readonly conflicts: ReadonlyArray<CrossingConflictView>;
}

export interface CrossingRampDump {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rot: number;
}

export const CROSSING_REASONS: Readonly<Record<CrossingConflict, string>> = {
  "raised-road":
    "the road plate's surface is not at the track's bed, so the track would run through it",
  "not-straight": "only a straight piece can cross a road; curves, switches and crossings can't",
  "off-lattice": "the straight is off the stud grid, so the crossing's ramps could not sit exactly",
  "along-road": "the track would run along the road instead of across it",
  "not-straight-road": "a level crossing needs a straight road plate, not a curve or a junction",
  "narrow-roadway": "the roadway is narrower than the crossing's ramps",
  "roadway-off-grid": "the roadway's centre is off the stud grid",
  "ramps-off-road": "the crossing's ramps would run off the roadway",
  "ramps-hit-track": "the crossing's ramps would sit on other track",
  "ramps-overlap": "the ramps of two crossings would overlap",
};

export function crossingChunkKey(chunkX: number, chunkZ: number): number {
  return CROSSING_KEY_BASE + chunkKey(chunkX, chunkZ);
}

function separated(
  axisX: number,
  axisZ: number,
  triangles: Float64Array,
  offset: number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): boolean {
  let triMin = Number.POSITIVE_INFINITY;
  let triMax = Number.NEGATIVE_INFINITY;
  for (let v = 0; v < 3; v++) {
    const p =
      axisX * (triangles[offset + v * 2] ?? 0) + axisZ * (triangles[offset + v * 2 + 1] ?? 0);
    if (p < triMin) triMin = p;
    if (p > triMax) triMax = p;
  }
  const a = axisX * minX + axisZ * minZ;
  const b = axisX * maxX + axisZ * minZ;
  const c = axisX * minX + axisZ * maxZ;
  const d = axisX * maxX + axisZ * maxZ;
  const rectMin = Math.min(a, b, c, d);
  const rectMax = Math.max(a, b, c, d);
  const slack = REPRESENTATION_EPSILON_LDU * Math.hypot(axisX, axisZ);
  return triMax <= rectMin + slack || triMin >= rectMax - slack;
}

export function planTrianglesMeetRect(
  triangles: Float64Array,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): boolean {
  for (let t = 0; t + TRIANGLE_FLOATS <= triangles.length; t += TRIANGLE_FLOATS) {
    if (separated(1, 0, triangles, t, minX, maxX, minZ, maxZ)) continue;
    if (separated(0, 1, triangles, t, minX, maxX, minZ, maxZ)) continue;
    let apart = false;
    for (let e = 0; e < 3 && !apart; e++) {
      const ax = triangles[t + e * 2] ?? 0;
      const az = triangles[t + e * 2 + 1] ?? 0;
      const bx = triangles[t + ((e + 1) % 3) * 2] ?? 0;
      const bz = triangles[t + ((e + 1) % 3) * 2 + 1] ?? 0;
      if (ax === bx && az === bz) continue;
      apart = separated(az - bz, bx - ax, triangles, t, minX, maxX, minZ, maxZ);
    }
    if (!apart) return true;
  }
  return false;
}

export class LevelCrossingParts {
  readonly partIndex: number;
  readonly color: number;
  readonly part: PartAsset;

  constructor(
    readonly recipe: LevelCrossingRecipe,
    private readonly parts: ReadonlyArray<PartAsset>,
    private readonly colors: ColorTable,
  ) {
    const index = parts.findIndex((part) => part.id === recipe.part);
    const part = parts[index];
    if (!part) throw new Error(`level crossing part ${recipe.part} is not in the bundle`);
    if (part.producedColor === undefined) {
      throw new Error(`level crossing part ${recipe.part} has no sourced produced colour`);
    }
    this.partIndex = index;
    this.part = part;
    this.color = colors.indexOfCode(part.producedColor);
  }

  plan(roads: ReadonlyArray<RoadPlacement>, track: TrackCrossingInput): CrossingPlan {
    return planLevelCrossings(this.recipe, roads, track.pieces, track.meets);
  }

  view(plan: CrossingPlan): CrossingView {
    return {
      crossings: plan.crossings.length,
      ramps: plan.crossings.reduce((sum, crossing) => sum + crossing.slopes.length, 0),
      part: this.recipe.part.replace("ldraw:", ""),
      conflicts: plan.conflicts.map((conflict) => ({
        ...conflict,
        text: CROSSING_REASONS[conflict.reason],
      })),
    };
  }

  ramps(plan: CrossingPlan): ReadonlyArray<CrossingRampDump> {
    return plan.crossings.flatMap((crossing) =>
      crossing.slopes.map(({ x, y, z, rot }) => ({ x, y, z, rot })),
    );
  }

  chunks(plan: CrossingPlan): ReadonlyMap<number, ChunkInstances> {
    const byChunk = new Map<number, LevelCrossing["slopes"][number][]>();
    for (const crossing of plan.crossings) {
      for (const slope of crossing.slopes) {
        const key = crossingChunkKey(chunkOf(slope.x), chunkOf(slope.z));
        const list = byChunk.get(key) ?? [];
        list.push(slope);
        byChunk.set(key, list);
      }
    }
    const chunks = new Map<number, ChunkInstances>();
    for (const [key, slopes] of byChunk) {
      const [first] = slopes;
      if (!first) continue;
      const originX = chunkOf(first.x) * CHUNK_LDU;
      const originZ = chunkOf(first.z) * CHUNK_LDU;
      const count = slopes.length;
      const matrices = new Float32Array(count * INSTANCE_MATRIX_FLOATS);
      slopes.forEach((slope, i) => {
        const cos = rot90Cos(slope.rot);
        const sin = rot90Sin(slope.rot);
        matrices.set(
          [cos, 0, sin, slope.x - originX, 0, 1, 0, slope.y, -sin, 0, cos, slope.z - originZ],
          i * INSTANCE_MATRIX_FLOATS,
        );
      });
      const base: ChunkPartInstances = {
        originX,
        originZ,
        count,
        partIndex: new Uint16Array(count).fill(this.partIndex),
        colorIndex: new Uint16Array(count).fill(this.color),
        matrices,
      };
      chunks.set(key, withStuds(base, this.parts, this.colors, undefined));
    }
    return chunks;
  }
}
