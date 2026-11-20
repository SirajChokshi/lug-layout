import { STUD_LDU } from "@brr/math";
import { BOX_FLOATS } from "./local-box.ts";
import type { PlacedModel } from "./placed-chunks.ts";

const CELL_KEY_STRIDE = 2 ** 26;
const CELL_KEY_OFFSET = 2 ** 25;
const ON_LATTICE = 1;
export const RECT_FLOATS = 4;

export function cellKey(cellX: number, cellZ: number): number {
  return (cellX + CELL_KEY_OFFSET) * CELL_KEY_STRIDE + (cellZ + CELL_KEY_OFFSET);
}

export function studSeats(models: ReadonlyArray<PlacedModel>, baseLdu: number): Set<number> {
  const seats = new Set<number>();
  for (const model of models) {
    const onLattice = model.placeable.studLattice.onLattice;
    for (let i = 0; i < model.placeable.studs.count; i++) {
      if (onLattice[i] !== ON_LATTICE || model.studBaseLdu(i) !== baseLdu) continue;
      seats.add(cellKey(model.studCellX(i), model.studCellZ(i)));
    }
  }
  return seats;
}

export type CarriedTrack = (model: PlacedModel) => ReadonlySet<number>;

export interface SolidRects {
  readonly rects: Float64Array;
  readonly owner: Int32Array;
  readonly part: Int32Array;
}

export interface TrackObstacles {
  readonly solid: SolidRects;
  readonly studless: Float64Array;
  readonly seatsPending: boolean;
}

export const NO_TRACK_OBSTACLES: TrackObstacles = {
  solid: { rects: new Float64Array(0), owner: new Int32Array(0), part: new Int32Array(0) },
  studless: new Float64Array(0),
  seatsPending: false,
};

class SolidList {
  private readonly rects: number[] = [];
  private readonly owners: number[] = [];
  private readonly parts: number[] = [];

  add(
    boxes: Float64Array,
    band: readonly [number, number],
    carried: ReadonlySet<number>,
    owner: number,
  ): void {
    const [bottom, top] = band;
    for (let b = 0; b < boxes.length; b += BOX_FLOATS) {
      const part = b / BOX_FLOATS;
      if (carried.has(part)) continue;
      if ((boxes[b + 1] ?? 0) >= top || (boxes[b + 4] ?? 0) <= bottom) continue;
      this.rects.push(boxes[b] ?? 0, boxes[b + 2] ?? 0, boxes[b + 3] ?? 0, boxes[b + 5] ?? 0);
      this.owners.push(owner);
      this.parts.push(part);
    }
  }

  frozen(): SolidRects {
    return {
      rects: Float64Array.from(this.rects),
      owner: Int32Array.from(this.owners),
      part: Int32Array.from(this.parts),
    };
  }
}

export function solidRects(
  boxes: Float64Array,
  band: readonly [number, number],
  carried: ReadonlySet<number>,
): SolidRects {
  const list = new SolidList();
  list.add(boxes, band, carried, 0);
  return list.frozen();
}

export function modelSolidRects(
  models: ReadonlyArray<PlacedModel>,
  band: readonly [number, number],
  carriedTrack: CarriedTrack,
): SolidRects {
  const list = new SolidList();
  models.forEach((model, owner) => {
    if (model.box.minY >= band[1] || model.box.maxY <= band[0]) return;
    list.add(model.worldPartBoxes(), band, carriedTrack(model), owner);
  });
  return list.frozen();
}

function pushUnseated(
  rects: number[],
  seats: ReadonlySet<number>,
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
        rects.push(
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

function studlessRects(models: ReadonlyArray<PlacedModel>, bottom: number): Float64Array {
  const seats = studSeats(models, bottom);
  const rects: number[] = [];
  for (const model of models) {
    const boxes = model.worldPartBoxes();
    for (let b = 0; b < boxes.length; b += BOX_FLOATS) {
      if ((boxes[b + 4] ?? 0) !== bottom) continue;
      pushUnseated(
        rects,
        seats,
        boxes[b] ?? 0,
        boxes[b + 2] ?? 0,
        boxes[b + 3] ?? 0,
        boxes[b + 5] ?? 0,
      );
    }
  }
  return Float64Array.from(rects);
}

export function trackObstacles(
  models: ReadonlyArray<PlacedModel>,
  trackRange: readonly [number, number],
  carriedTrack: CarriedTrack,
): TrackObstacles {
  return {
    solid: modelSolidRects(models, trackRange, carriedTrack),
    studless: studlessRects(models, trackRange[0]),
    seatsPending: seatsPending(models, trackRange),
  };
}
