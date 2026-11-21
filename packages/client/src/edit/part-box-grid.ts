import { STUD_LDU } from "@brr/math";
import { BOX_FLOATS } from "./local-box.ts";

const BUCKET_LDU = 2 * STUD_LDU;
const MIN_X = 0;
const MIN_Z = 2;
const MAX_X = 3;
const MAX_Z = 5;

function bucketOf(ldu: number): number {
  return Math.floor(ldu / BUCKET_LDU);
}

export class LocalPartGrid {
  private constructor(
    private readonly bucketX0: number,
    private readonly bucketZ0: number,
    private readonly width: number,
    private readonly depth: number,
    private readonly starts: Int32Array,
    private readonly offsets: Int32Array,
  ) {}

  static of(partBoxes: Float32Array): LocalPartGrid {
    const count = partBoxes.length / BOX_FLOATS;
    if (count === 0) return new LocalPartGrid(0, 0, 0, 0, new Int32Array(1), new Int32Array(0));
    let x0 = Number.POSITIVE_INFINITY;
    let z0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let z1 = Number.NEGATIVE_INFINITY;
    for (let b = 0; b < partBoxes.length; b += BOX_FLOATS) {
      x0 = Math.min(x0, bucketOf(partBoxes[b + MIN_X] ?? 0));
      z0 = Math.min(z0, bucketOf(partBoxes[b + MIN_Z] ?? 0));
      x1 = Math.max(x1, bucketOf(partBoxes[b + MAX_X] ?? 0));
      z1 = Math.max(z1, bucketOf(partBoxes[b + MAX_Z] ?? 0));
    }
    const width = x1 - x0 + 1;
    const depth = z1 - z0 + 1;
    const starts = new Int32Array(width * depth + 1);
    const visit = (b: number, each: (bucket: number) => void): void => {
      const bx0 = bucketOf(partBoxes[b + MIN_X] ?? 0) - x0;
      const bx1 = bucketOf(partBoxes[b + MAX_X] ?? 0) - x0;
      const bz0 = bucketOf(partBoxes[b + MIN_Z] ?? 0) - z0;
      const bz1 = bucketOf(partBoxes[b + MAX_Z] ?? 0) - z0;
      for (let bz = bz0; bz <= bz1; bz++) {
        for (let bx = bx0; bx <= bx1; bx++) each(bz * width + bx);
      }
    };
    for (let b = 0; b < partBoxes.length; b += BOX_FLOATS) {
      visit(b, (bucket) => {
        starts[bucket + 1] = (starts[bucket + 1] ?? 0) + 1;
      });
    }
    for (let bucket = 0; bucket < width * depth; bucket++) {
      starts[bucket + 1] = (starts[bucket + 1] ?? 0) + (starts[bucket] ?? 0);
    }
    const offsets = new Int32Array(starts[width * depth] ?? 0);
    const cursors = starts.slice(0, width * depth);
    for (let b = 0; b < partBoxes.length; b += BOX_FLOATS) {
      visit(b, (bucket) => {
        const at = cursors[bucket] ?? 0;
        cursors[bucket] = at + 1;
        offsets[at] = b;
      });
    }
    return new LocalPartGrid(x0, z0, width, depth, starts, offsets);
  }

  firstColumn(localX: number): number {
    return Math.max(0, bucketOf(localX) - this.bucketX0);
  }

  lastColumn(localX: number): number {
    return Math.min(this.width - 1, bucketOf(localX) - this.bucketX0);
  }

  firstRow(localZ: number): number {
    return Math.max(0, bucketOf(localZ) - this.bucketZ0);
  }

  lastRow(localZ: number): number {
    return Math.min(this.depth - 1, bucketOf(localZ) - this.bucketZ0);
  }

  start(column: number, row: number): number {
    return this.starts[row * this.width + column] ?? 0;
  }

  end(column: number, row: number): number {
    return this.starts[row * this.width + column + 1] ?? 0;
  }

  boxAt(entry: number): number {
    return this.offsets[entry] ?? 0;
  }
}

const grids = new WeakMap<Float32Array, LocalPartGrid>();

export function partGridOf(partBoxes: Float32Array): LocalPartGrid {
  const known = grids.get(partBoxes);
  if (known) return known;
  const grid = LocalPartGrid.of(partBoxes);
  grids.set(partBoxes, grid);
  return grid;
}
