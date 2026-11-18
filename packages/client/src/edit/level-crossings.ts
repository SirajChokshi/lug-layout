import type { PartShapeAsset } from "@brr/catalog";
import {
  planLevelCrossings,
  type CrossingConflict,
  type CrossingPlan,
  type CrossingTrackPiece,
  type LduRect,
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

export interface TrackCrossingInput {
  readonly pieces: ReadonlyArray<CrossingTrackPiece>;
  readonly meets: TrackMeetsRect;
  readonly proposedFrom: number;
  readonly region: LduRect | null;
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

export class LevelCrossingParts {
  readonly partIndex: number;
  readonly color: number;
  readonly part: PartShapeAsset;

  constructor(
    readonly recipe: LevelCrossingRecipe,
    private readonly parts: ReadonlyArray<PartShapeAsset>,
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
