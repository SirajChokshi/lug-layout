import type { PartShapeAsset } from "@brr/catalog";
import {
  LevelCrossings,
  NO_OBSTACLE,
  OUTLINE_BOX_FLOATS,
  PlacedOutline,
  convexHull,
  outlineBox,
  type CrossingTrack,
  type LduRect,
  type LevelCrossing,
  type RampCandidate,
  type RampPart,
  type RoadPlacement,
  type TrackClearance,
} from "@brr/domain";
import { CHUNK_LDU, STUD_LDU, chunkKey, chunkOf, rot90Cos, rot90Sin } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS, type ChunkInstances } from "@brr/render";
import { OUTLINE_UNITS_PER_LDU, type LevelCrossingFacts } from "@brr/schema/bundle";
import type { ChunkPartInstances } from "../scene/placements.ts";
import { withStuds } from "../scene/stud-stream.ts";
import type { ColorTable } from "../scene/viewer-scene.ts";
import type { PlacedModel, PlacedModels } from "./placed-chunks.ts";
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

export type CarriesRunTrack = (model: PlacedModel) => boolean;

interface Suggestion {
  readonly crossings: ReadonlyArray<LevelCrossing>;
  readonly pieces: ReadonlyArray<PlacedTrackPiece>;
  readonly modelsVersion: number;
  readonly models: ReadonlyArray<PlacedModel>;
  readonly suggested: ReadonlyArray<SuggestedCrossing>;
}

interface RampAsset {
  readonly part: RampPart;
  readonly hull: Float64Array;
  readonly seatBox: LduRect;
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

function rectsMeet(a: LduRect, b: LduRect): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minZ <= b.maxZ && b.minZ <= a.maxZ;
}

function joined(a: LduRect | null, b: LduRect): LduRect {
  if (!a) return b;
  return {
    minX: Math.min(a.minX, b.minX),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

function seatBoxOf(facts: RampPart["facts"], hull: Float64Array): LduRect {
  let box: LduRect = facts.footprint;
  for (let p = 0; p < hull.length; p += 2) {
    const x = hull[p] ?? 0;
    const z = hull[p + 1] ?? 0;
    box = joined(box, { minX: x, minZ: z, maxX: x, maxZ: z });
  }
  for (const [x, z] of facts.antiStuds) {
    box = joined(box, {
      minX: x - STUD_LDU,
      minZ: z - STUD_LDU,
      maxX: x + STUD_LDU,
      maxZ: z + STUD_LDU,
    });
  }
  return box;
}

function posed(box: LduRect, candidate: RampCandidate): LduRect {
  const cos = rot90Cos(candidate.rot);
  const sin = rot90Sin(candidate.rot);
  const ax = candidate.x + cos * box.minX + sin * box.minZ;
  const az = candidate.z - sin * box.minX + cos * box.minZ;
  const bx = candidate.x + cos * box.maxX + sin * box.maxZ;
  const bz = candidate.z - sin * box.maxX + cos * box.maxZ;
  return {
    minX: Math.min(ax, bx),
    minZ: Math.min(az, bz),
    maxX: Math.max(ax, bx),
    maxZ: Math.max(az, bz),
  };
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

function changedModelBoxes(
  last: Suggestion,
  models: ReadonlyArray<PlacedModel>,
  version: number,
  carriesRunTrack: CarriesRunTrack,
): ReadonlyArray<LduRect> | null {
  if (last.modelsVersion === version) return [];
  const before = new Set(last.models);
  const now = new Set(models);
  const changed: PlacedModel[] = [];
  for (const model of models) if (!before.has(model)) changed.push(model);
  for (const model of last.models) if (!now.has(model)) changed.push(model);
  if (changed.some(carriesRunTrack)) return null;
  return changed.map(({ box }) => ({
    minX: box.minX,
    minZ: box.minZ,
    maxX: box.maxX,
    maxZ: box.maxZ,
  }));
}

export class CrossingRamps {
  private readonly ramps: ReadonlyArray<RampAsset>;
  private readonly railTops: ReadonlyMap<string, number>;
  private readonly levelCrossings: LevelCrossings;
  private readonly tracksByOutline = new WeakMap<PlacedOutline, Map<string, CrossingTrack>>();
  private piecesSeen: ReadonlyArray<PlacedTrackPiece> | null = null;
  private tracksSeen: ReadonlyArray<CrossingTrack> = [];
  private lastSuggestion: Suggestion | null = null;
  private readonly seatRegions = new WeakMap<ReadonlyArray<RampCandidate>, LduRect | null>();

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
      const hull = planHullOf(part.outline);
      return {
        part: { facts: ramp, outline: part.outline },
        hull,
        seatBox: seatBoxOf(ramp, hull),
        index,
        color: colors.indexOfCode(part.producedColor),
        minY: part.boundsMin[1],
        maxY: part.boundsMax[1],
      };
    });
    this.levelCrossings = new LevelCrossings(this.ramps.map((ramp) => ramp.part));
  }

  suggest(
    roads: ReadonlyArray<RoadPlacement>,
    pieces: ReadonlyArray<PlacedTrackPiece>,
    placed: PlacedModels,
    clearanceIn: ClearanceInBand,
    carriesRunTrack: CarriesRunTrack,
  ): ReadonlyArray<SuggestedCrossing> {
    if (roads.length === 0 || pieces.length === 0) {
      this.forget();
      return [];
    }
    const crossings = this.levelCrossings.crossings(roads, this.tracksOf(pieces));
    if (crossings.length === 0) {
      this.lastSuggestion = null;
      return [];
    }
    const last = this.lastSuggestion;
    if (
      last &&
      last.pieces === pieces &&
      last.modelsVersion === placed.version &&
      last.crossings === crossings
    ) {
      return last.suggested;
    }
    const models = placed.models();
    const changed = last ? changedModelBoxes(last, models, placed.version, carriesRunTrack) : null;
    const seatedBefore = new Map(
      last?.suggested.map((suggestion) => [suggestion.crossing.candidates, suggestion.ramps]),
    );
    let probe: LayoutProbe | null = null;
    const suggested = crossings.map((crossing) => {
      const before = changed ? seatedBefore.get(crossing.candidates) : undefined;
      const ramps =
        before && changed && !this.meetsSeatRegion(changed, crossing.candidates)
          ? before
          : this.seated(crossing, (probe ??= new LayoutProbe(models, clearanceIn)));
      return {
        crossing,
        trackPlacements: crossing.tracks.map((track) => pieces[track]?.placement ?? 0),
        ramps,
      };
    });
    this.lastSuggestion = {
      crossings,
      pieces,
      modelsVersion: placed.version,
      models: [...models],
      suggested,
    };
    return suggested;
  }

  private meetsSeatRegion(
    changed: ReadonlyArray<LduRect>,
    candidates: ReadonlyArray<RampCandidate>,
  ): boolean {
    const region = this.seatRegionOf(candidates);
    return region !== null && changed.some((box) => rectsMeet(box, region));
  }

  private seatRegionOf(candidates: ReadonlyArray<RampCandidate>): LduRect | null {
    const known = this.seatRegions.get(candidates);
    if (known !== undefined) return known;
    let region: LduRect | null = null;
    for (const candidate of candidates) {
      region = joined(region, posed(this.assetOf(candidate.part).seatBox, candidate));
    }
    this.seatRegions.set(candidates, region);
    return region;
  }

  private forget(): void {
    this.lastSuggestion = null;
    this.piecesSeen = null;
    this.tracksSeen = [];
    this.levelCrossings.crossings([], []);
  }

  private tracksOf(pieces: ReadonlyArray<PlacedTrackPiece>): ReadonlyArray<CrossingTrack> {
    if (pieces !== this.piecesSeen) {
      this.piecesSeen = pieces;
      this.tracksSeen = pieces.map((piece) => this.trackOf(piece));
    }
    return this.tracksSeen;
  }

  private trackOf(piece: PlacedTrackPiece): CrossingTrack {
    let bySystem = this.tracksByOutline.get(piece.outline);
    if (!bySystem) {
      bySystem = new Map();
      this.tracksByOutline.set(piece.outline, bySystem);
    }
    const key = `${piece.system}|${piece.bedLdu}`;
    let track = bySystem.get(key);
    if (!track) {
      const railTopLdu = this.railTops.get(piece.system);
      if (railTopLdu === undefined) {
        throw new Error(`track system ${piece.system} has no rail top in the bundle`);
      }
      track = { outline: piece.outline, bedLdu: piece.bedLdu, railTopLdu };
      bySystem.set(key, track);
    }
    return track;
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
