import type { PartShapeAsset } from "@brr/catalog";
import {
  NO_OBSTACLE,
  OUTLINE_BOX_FLOATS,
  PlacedOutline,
  convexHull,
  outlineBox,
  type RoadSurfaceCells,
  type CrossingTrack,
  type LduRect,
  type LevelCrossing,
  type RampCandidate,
  type RampPart,
  type TrackClearance,
} from "@brr/domain";
import { CHUNK_LDU, STUD_LDU, chunkKey, chunkOf, rot90Cos, rot90Sin } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS, type ChunkInstances } from "@brr/render";
import { OUTLINE_UNITS_PER_LDU, type LevelCrossingFacts } from "@brr/schema/bundle";
import type { ChunkPartInstances } from "../scene/placements.ts";
import { withStuds } from "../scene/stud-stream.ts";
import type { ColorTable } from "../scene/viewer-scene.ts";
import type { PlacedModel } from "./placed-chunks.ts";
import type { PlacedTrackPiece } from "./track-drawing.ts";
import { cellKey, studSeats, type StudSeats } from "./track-obstacles.ts";

export interface SeatedRamp extends RampCandidate {
  readonly studMates: number;
}

export interface SuggestedCrossing {
  readonly crossing: LevelCrossing;
  readonly trackPlacements: ReadonlyArray<number>;
  readonly ramps: ReadonlyArray<SeatedRamp>;
}

export type ClearanceInBand = (band: readonly [number, number]) => TrackClearance;

interface RampAsset {
  readonly part: RampPart;
  readonly hull: Float64Array;
  readonly index: number;
  readonly color: number;
  readonly minY: number;
  readonly maxY: number;
}

const RAMP_CHUNK_KEY_OFFSET = -(2 ** 47);

export function rampChunkKey(chunkX: number, chunkZ: number): number {
  return RAMP_CHUNK_KEY_OFFSET - chunkKey(chunkX, chunkZ);
}

function rectsShareArea(a: LduRect, b: LduRect): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
}

function planHullOf(outline: RampPart["outline"]): Float64Array {
  const points = outline.flatMap((ring) =>
    ring.flatMap(([x, z]) => [x / OUTLINE_UNITS_PER_LDU, z / OUTLINE_UNITS_PER_LDU]),
  );
  return convexHull(Float64Array.from(points));
}

class LayoutProbe {
  private readonly seats = new Map<number, StudSeats>();
  private readonly fields = new Map<string, TrackClearance>();
  private readonly box = new Float64Array(OUTLINE_BOX_FLOATS);

  constructor(
    private readonly models: ReadonlyArray<PlacedModel>,
    private readonly clearanceInBand: ClearanceInBand,
  ) {}

  private clearanceIn(band: readonly [number, number]): TrackClearance {
    const key = `${band[0]}|${band[1]}`;
    let field = this.fields.get(key);
    if (!field) {
      field = this.clearanceInBand(band);
      this.fields.set(key, field);
    }
    return field;
  }

  studMates(candidate: RampCandidate): number {
    let seats = this.seats.get(candidate.undersideLdu);
    if (!seats) {
      seats = studSeats(this.models, candidate.undersideLdu);
      this.seats.set(candidate.undersideLdu, seats);
    }
    let mates = 0;
    for (const [x, z] of candidate.antiStuds) {
      if (seats.has(cellKey(Math.floor(x / STUD_LDU), Math.floor(z / STUD_LDU)))) mates++;
    }
    return mates;
  }

  obstructed(candidate: RampCandidate, asset: RampAsset): boolean {
    const field = this.clearanceIn([candidate.y + asset.minY, candidate.y + asset.maxY]);
    const cos = rot90Cos(candidate.rot);
    const sin = rot90Sin(candidate.rot);
    const { hull } = asset;
    const outline = new Float64Array(hull.length);
    for (let p = 0; p < hull.length; p += 2) {
      const x = hull[p] ?? 0;
      const z = hull[p + 1] ?? 0;
      outline[p] = candidate.x + cos * x + sin * z;
      outline[p + 1] = candidate.z - sin * x + cos * z;
    }
    outlineBox(outline, this.box, 0);
    return field.blocker(outline, this.box, 0, 0, 0, NO_OBSTACLE, NO_OBSTACLE) !== NO_OBSTACLE;
  }
}

export class CrossingRamps {
  private readonly ramps: ReadonlyArray<RampAsset>;
  private readonly railTops: ReadonlyMap<string, number>;

  constructor(
    facts: LevelCrossingFacts,
    private readonly parts: ReadonlyArray<PartShapeAsset>,
    private readonly colors: ColorTable,
  ) {
    this.railTops = new Map(facts.systems.map((system) => [system.system, system.railTopLdu]));
    this.ramps = facts.ramps.map((ramp) => {
      const index = parts.findIndex((part) => part.id === ramp.part);
      const part = parts[index];
      if (!part?.outline)
        throw new Error(`ramp part ${ramp.part} has no plan outline in the bundle`);
      if (part.producedColor === undefined) {
        throw new Error(`ramp part ${ramp.part} has no sourced colour`);
      }
      return {
        part: { facts: ramp, outline: part.outline },
        hull: planHullOf(part.outline),
        index,
        color: colors.indexOfCode(part.producedColor),
        minY: part.boundsMin[1],
        maxY: part.boundsMax[1],
      };
    });
  }

  suggest(
    roads: RoadSurfaceCells,
    pieces: ReadonlyArray<PlacedTrackPiece>,
    models: ReadonlyArray<PlacedModel>,
    clearanceIn: ClearanceInBand,
  ): ReadonlyArray<SuggestedCrossing> {
    if (roads.empty || pieces.length === 0) return [];
    const tracks = pieces.map((piece): CrossingTrack => {
      const railTopLdu = this.railTops.get(piece.system);
      if (railTopLdu === undefined) {
        throw new Error(`track system ${piece.system} has no rail top in the bundle`);
      }
      return { outline: piece.outline, bedLdu: piece.bedLdu, railTopLdu };
    });
    const crossings = roads.crossings(
      tracks,
      this.ramps.map((ramp) => ramp.part),
    );
    if (crossings.length === 0) return [];
    const probe = new LayoutProbe(models, clearanceIn);
    return crossings.map((crossing) => ({
      crossing,
      trackPlacements: crossing.tracks.map((track) => pieces[track]?.placement ?? 0),
      ramps: this.seated(crossing, probe),
    }));
  }

  private seated(crossing: LevelCrossing, probe: LayoutProbe): ReadonlyArray<SeatedRamp> {
    let best: SeatedRamp[] = [];
    let bestCovered = 0;
    for (const asset of this.ramps) {
      const chosen: SeatedRamp[] = [];
      let covered = 0;
      for (const candidate of crossing.candidates) {
        if (candidate.part !== asset.part.facts.part) continue;
        if (chosen.some((ramp) => rectsShareArea(ramp.rect, candidate.rect))) continue;
        const studMates = probe.studMates(candidate);
        if (studMates === 0 || probe.obstructed(candidate, asset)) continue;
        chosen.push({ ...candidate, studMates });
        covered += candidate.roadwayCovered;
      }
      if (covered > bestCovered) {
        best = chosen;
        bestCovered = covered;
      }
    }
    return best;
  }

  outlines(crossings: ReadonlyArray<SuggestedCrossing>): ReadonlyArray<PlacedOutline> {
    return crossings.flatMap((crossing) =>
      crossing.ramps.map((ramp) =>
        PlacedOutline.onLattice(this.assetOf(ramp.part).part.outline, ramp.x, ramp.z, ramp.rot),
      ),
    );
  }

  private assetOf(part: string): RampAsset {
    const asset = this.ramps.find((candidate) => candidate.part.facts.part === part);
    if (!asset) throw new Error(`ramp part ${part} is not in the bundle`);
    return asset;
  }

  instances(crossings: ReadonlyArray<SuggestedCrossing>): ReadonlyMap<number, ChunkInstances> {
    const byChunk = new Map<number, SeatedRamp[]>();
    for (const ramp of crossings.flatMap((crossing) => crossing.ramps)) {
      const key = rampChunkKey(chunkOf(ramp.x), chunkOf(ramp.z));
      const ramps = byChunk.get(key) ?? [];
      ramps.push(ramp);
      byChunk.set(key, ramps);
    }
    const chunks = new Map<number, ChunkInstances>();
    for (const [key, ramps] of byChunk) chunks.set(key, this.chunk(ramps));
    return chunks;
  }

  private chunk(ramps: ReadonlyArray<SeatedRamp>): ChunkInstances {
    const [first] = ramps;
    const originX = first ? chunkOf(first.x) * CHUNK_LDU : 0;
    const originZ = first ? chunkOf(first.z) * CHUNK_LDU : 0;
    const count = ramps.length;
    const partIndex = new Uint16Array(count);
    const colorIndex = new Uint16Array(count);
    const matrices = new Float32Array(count * INSTANCE_MATRIX_FLOATS);
    ramps.forEach((ramp, i) => {
      const asset = this.assetOf(ramp.part);
      partIndex[i] = asset.index;
      colorIndex[i] = asset.color;
      const cos = rot90Cos(ramp.rot);
      const sin = rot90Sin(ramp.rot);
      matrices.set(
        [cos, 0, sin, ramp.x - originX, 0, 1, 0, ramp.y, -sin, 0, cos, ramp.z - originZ],
        i * INSTANCE_MATRIX_FLOATS,
      );
    });
    const base: ChunkPartInstances = { originX, originZ, count, partIndex, colorIndex, matrices };
    return withStuds(base, this.parts, this.colors);
  }
}
