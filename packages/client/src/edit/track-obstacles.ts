import { STUD_LDU, chunkKey, chunkOf } from "@brr/math";
import { BOX_FLOATS } from "./local-box.ts";
import type { PlacedModel } from "./placed-chunks.ts";

const CELL_KEY_STRIDE = 2 ** 26;
const CELL_KEY_OFFSET = 2 ** 25;
const HALF_STUD_LDU = STUD_LDU / 2;
const SEATED_TOP = 1;
const NO_MODELS: ReadonlyArray<PlacedModel> = [];
export const OBSTACLE_RECT_FLOATS = 4;

export interface StudSeats {
  has(cellKey: number): boolean;
}

export type ObstacleKind = "solid" | "unseated";

export interface TrackObstacles {
  readonly rects: Float64Array;
  readonly owners: Int32Array;
  readonly unseated: Uint8Array;
  readonly outlines: ReadonlyArray<Float64Array>;
  readonly outlineOwners: Int32Array;
  readonly labels: ReadonlyArray<string>;
  readonly seats: StudSeats;
}

export const NO_TRACK_OBSTACLES: TrackObstacles = {
  rects: new Float64Array(0),
  owners: new Int32Array(0),
  unseated: new Uint8Array(0),
  outlines: [],
  outlineOwners: new Int32Array(0),
  labels: [],
  seats: new Set(),
};

export interface SolidOutline {
  readonly outline: Float64Array;
  readonly label: string;
}

export interface StandingOutline extends SolidOutline {
  readonly railTopLdu: number;
  readonly topLdu: number;
}

export function sameNumbers(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameOutlineList(a: ReadonlyArray<Float64Array>, b: ReadonlyArray<Float64Array>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const outline = a[i];
    const other = b[i];
    if (!outline || !other || !sameNumbers(outline, other)) return false;
  }
  return true;
}

function sameLabels(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function sameObstacles(a: TrackObstacles, b: TrackObstacles): boolean {
  return (
    sameNumbers(a.rects, b.rects) &&
    sameNumbers(a.owners, b.owners) &&
    sameNumbers(a.unseated, b.unseated) &&
    sameNumbers(a.outlineOwners, b.outlineOwners) &&
    sameOutlineList(a.outlines, b.outlines) &&
    sameLabels(a.labels, b.labels) &&
    sameSeats(a.seats, b.seats)
  );
}

export function withOutlines(
  obstacles: TrackObstacles,
  solids: ReadonlyArray<SolidOutline>,
): TrackObstacles {
  if (solids.length === 0) return obstacles;
  const base = obstacles.labels.length;
  return {
    ...obstacles,
    outlines: [...obstacles.outlines, ...solids.map((solid) => solid.outline)],
    outlineOwners: Int32Array.from([...obstacles.outlineOwners, ...solids.map((_, k) => base + k)]),
    labels: [...obstacles.labels, ...solids.map((solid) => solid.label)],
  };
}

export function cellKey(cellX: number, cellZ: number): number {
  return (cellX + CELL_KEY_OFFSET) * CELL_KEY_STRIDE + (cellZ + CELL_KEY_OFFSET);
}

class LayoutSeats implements StudSeats {
  private readonly byChunk = new Map<number, PlacedModel[]>();
  private readonly models: PlacedModel[] = [];

  constructor(
    models: ReadonlyArray<PlacedModel>,
    private readonly baseLdu: number,
  ) {
    for (const model of models) {
      const { box } = model;
      if (box.minY > baseLdu || box.maxY < baseLdu) continue;
      this.models.push(model);
      for (let cz = chunkOf(box.minZ); cz <= chunkOf(box.maxZ); cz++) {
        for (let cx = chunkOf(box.minX); cx <= chunkOf(box.maxX); cx++) {
          const key = chunkKey(cx, cz);
          const inChunk = this.byChunk.get(key);
          if (inChunk) inChunk.push(model);
          else this.byChunk.set(key, [model]);
        }
      }
    }
  }

  has(key: number): boolean {
    const cellX = Math.floor(key / CELL_KEY_STRIDE) - CELL_KEY_OFFSET;
    const cellZ = key - (cellX + CELL_KEY_OFFSET) * CELL_KEY_STRIDE - CELL_KEY_OFFSET;
    const chunk = chunkKey(
      chunkOf(cellX * STUD_LDU + HALF_STUD_LDU),
      chunkOf(cellZ * STUD_LDU + HALF_STUD_LDU),
    );
    for (const model of this.byChunk.get(chunk) ?? NO_MODELS) {
      if (model.seatsStudAt(cellX, cellZ, this.baseLdu)) return true;
    }
    return false;
  }

  sameAs(other: LayoutSeats): boolean {
    if (other.baseLdu !== this.baseLdu || other.models.length !== this.models.length) return false;
    for (let i = 0; i < this.models.length; i++) {
      if (other.models[i] !== this.models[i]) return false;
    }
    return true;
  }
}

export function studSeats(models: ReadonlyArray<PlacedModel>, baseLdu: number): StudSeats {
  return new LayoutSeats(models, baseLdu);
}

export function sameSeats(a: StudSeats, b: StudSeats): boolean {
  return a === b || (a instanceof LayoutSeats && b instanceof LayoutSeats && a.sameAs(b));
}

class ObstacleList {
  private readonly rects: Record<ObstacleKind, number[]> = { solid: [], unseated: [] };
  private readonly owners: Record<ObstacleKind, number[]> = { solid: [], unseated: [] };

  push(
    owner: number,
    kind: ObstacleKind,
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
  ): void {
    this.rects[kind].push(minX, minZ, maxX, maxZ);
    this.owners[kind].push(owner);
  }

  obstacles(labels: ReadonlyArray<string>, seats: StudSeats): TrackObstacles {
    const { solid, unseated } = this.owners;
    return {
      rects: Float64Array.from([...this.rects.solid, ...this.rects.unseated]),
      owners: Int32Array.from([...solid, ...unseated]),
      unseated: Uint8Array.from([...solid.map(() => 0), ...unseated.map(() => 1)]),
      outlines: [],
      outlineOwners: new Int32Array(0),
      labels,
      seats,
    };
  }

  pushUnseated(
    owner: number,
    seats: StudSeats,
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
  ): void {
    const cellX0 = Math.floor(minX / STUD_LDU);
    const cellX1 = Math.ceil(maxX / STUD_LDU);
    const cellZ0 = Math.floor(minZ / STUD_LDU);
    const cellZ1 = Math.ceil(maxZ / STUD_LDU);
    for (let cellZ = cellZ0; cellZ < cellZ1; cellZ++) {
      let runStart: number | null = null;
      for (let cellX = cellX0; cellX <= cellX1; cellX++) {
        const unseated = cellX < cellX1 && !seats.has(cellKey(cellX, cellZ));
        if (unseated && runStart === null) runStart = cellX;
        if (!unseated && runStart !== null) {
          this.push(
            owner,
            "unseated",
            Math.max(minX, runStart * STUD_LDU),
            Math.max(minZ, cellZ * STUD_LDU),
            Math.min(maxX, cellX * STUD_LDU),
            Math.min(maxZ, (cellZ + 1) * STUD_LDU),
          );
          runStart = null;
        }
      }
    }
  }
}

export function seatsPending(
  models: ReadonlyArray<PlacedModel>,
  trackRange: readonly [number, number],
): boolean {
  const [bottom] = trackRange;
  return models.some((model) => {
    if (!model.placeable.studsPending) return false;
    const boxes = model.worldPartBoxes();
    for (let b = 0; b < boxes.length; b += BOX_FLOATS) {
      if ((boxes[b + 4] ?? 0) === bottom) return true;
    }
    return false;
  });
}

export type ModelReach = (model: PlacedModel) => boolean;

export type TrackPartsOf = (model: PlacedModel) => ReadonlySet<number>;

export const EVERY_MODEL: ModelReach = () => true;

export const REACHES = 1;

export function trackObstacles(
  models: ReadonlyArray<PlacedModel>,
  trackRange: readonly [number, number],
  trackParts: TrackPartsOf,
  reaches: ModelReach = EVERY_MODEL,
): TrackObstacles {
  const reaching = new Uint8Array(models.length);
  for (let owner = 0; owner < models.length; owner++) {
    const model = models[owner];
    reaching[owner] = model && reaches(model) ? REACHES : 0;
  }
  return obstaclesOver(models, trackRange, trackParts, reaching);
}

export function obstaclesOver(
  models: ReadonlyArray<PlacedModel>,
  trackRange: readonly [number, number],
  trackParts: TrackPartsOf,
  reaching: Uint8Array,
): TrackObstacles {
  const [bottom, top] = trackRange;
  const seats = studSeats(
    models.filter((_, owner) => reaching[owner] === REACHES),
    bottom,
  );
  const list = new ObstacleList();
  models.forEach((model, owner) => {
    if (reaching[owner] !== REACHES) return;
    const boxes = model.worldPartBoxes();
    const track = trackParts(model);
    const { seatedTops } = model.placeable;
    for (let b = 0; b < boxes.length; b += BOX_FLOATS) {
      const part = b / BOX_FLOATS;
      if (track.has(part)) continue;
      const minX = boxes[b] ?? 0;
      const minY = boxes[b + 1] ?? 0;
      const minZ = boxes[b + 2] ?? 0;
      const maxX = boxes[b + 3] ?? 0;
      const maxY = boxes[b + 4] ?? 0;
      const maxZ = boxes[b + 5] ?? 0;
      if (minY < top && maxY > bottom) list.push(owner, "solid", minX, minZ, maxX, maxZ);
      else if (maxY === bottom && seatedTops[part] !== SEATED_TOP) {
        list.pushUnseated(owner, seats, minX, minZ, maxX, maxZ);
      }
    }
  });
  return list.obstacles(
    models.map((model) => model.placeable.label),
    seats,
  );
}

export function withStanding(
  band: { readonly obstacles: TrackObstacles; readonly pending: boolean },
  [bottom, top]: readonly [number, number],
  standing: ReadonlyArray<StandingOutline>,
): { readonly obstacles: TrackObstacles; readonly pending: boolean } {
  const trains = standing.filter((vehicle) => vehicle.railTopLdu < top && bottom < vehicle.topLdu);
  return { obstacles: withOutlines(band.obstacles, trains), pending: band.pending };
}

export function solidRectsIn(
  models: ReadonlyArray<PlacedModel>,
  [bottom, top]: readonly [number, number],
  trackParts: (model: PlacedModel) => ReadonlySet<number>,
): Float64Array {
  const rects: number[] = [];
  for (const model of models) {
    if (model.box.minY >= top || model.box.maxY <= bottom) continue;
    const boxes = model.worldPartBoxes();
    const track = trackParts(model);
    for (let b = 0; b < boxes.length; b += BOX_FLOATS) {
      if (track.has(b / BOX_FLOATS)) continue;
      if ((boxes[b + 1] ?? 0) >= top || (boxes[b + 4] ?? 0) <= bottom) continue;
      rects.push(boxes[b] ?? 0, boxes[b + 2] ?? 0, boxes[b + 3] ?? 0, boxes[b + 5] ?? 0);
    }
  }
  return Float64Array.from(rects);
}
