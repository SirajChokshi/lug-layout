import { OUTLINE_BOX_FLOATS } from "@brr/domain";
import { CHUNK_LDU, STUD_LDU, chunkKey, chunkOf } from "@brr/math";
import type { WorldBox } from "@brr/render";

const NO_BOXES: ReadonlyArray<number> = [];
const CONTAINS = 0;
const OVERLAPS = 1;

type BoxRelation = typeof CONTAINS | typeof OVERLAPS;

function cellFloor(ldu: number): number {
  return Math.floor(ldu / STUD_LDU) * STUD_LDU;
}

function cellEnd(ldu: number): number {
  return cellFloor(ldu) + STUD_LDU;
}

export function writeChunkSquares(planBoxes: Float64Array, squares: Float64Array): Float64Array {
  for (let at = 0; at < planBoxes.length; at += OUTLINE_BOX_FLOATS) {
    squares[at] = chunkOf(planBoxes[at] ?? 0) * CHUNK_LDU;
    squares[at + 1] = chunkOf(planBoxes[at + 1] ?? 0) * CHUNK_LDU;
    squares[at + 2] = (chunkOf(planBoxes[at + 2] ?? 0) + 1) * CHUNK_LDU;
    squares[at + 3] = (chunkOf(planBoxes[at + 3] ?? 0) + 1) * CHUNK_LDU;
  }
  return squares;
}

export class PlanReach {
  private readonly byChunk = new Map<number, number[]>();
  private readonly seenIn: Int32Array;
  private epoch = 0;

  private constructor(private readonly cells: Float64Array) {
    const boxes = cells.length / OUTLINE_BOX_FLOATS;
    this.seenIn = new Int32Array(boxes);
    for (let index = 0; index < boxes; index++) {
      const at = index * OUTLINE_BOX_FLOATS;
      for (let cz = chunkOf(cells[at + 1] ?? 0); cz <= chunkOf(cells[at + 3] ?? 0); cz++) {
        for (let cx = chunkOf(cells[at] ?? 0); cx <= chunkOf(cells[at + 2] ?? 0); cx++) {
          const key = chunkKey(cx, cz);
          const inChunk = this.byChunk.get(key);
          if (inChunk) inChunk.push(index);
          else this.byChunk.set(key, [index]);
        }
      }
    }
  }

  static of(planBoxes: Float64Array): PlanReach {
    const cells = new Float64Array(planBoxes.length);
    for (let at = 0; at < planBoxes.length; at += OUTLINE_BOX_FLOATS) {
      cells[at] = cellFloor(planBoxes[at] ?? 0);
      cells[at + 1] = cellFloor(planBoxes[at + 1] ?? 0);
      cells[at + 2] = cellEnd(planBoxes[at + 2] ?? 0);
      cells[at + 3] = cellEnd(planBoxes[at + 3] ?? 0);
    }
    return new PlanReach(cells);
  }

  with(planBoxes: Float64Array): PlanReach {
    const added = PlanReach.of(planBoxes).cells;
    const cells = new Float64Array(this.cells.length + added.length);
    cells.set(this.cells);
    cells.set(added, this.cells.length);
    return new PlanReach(cells);
  }

  covers(planBoxes: Float64Array): boolean {
    for (let at = 0; at < planBoxes.length; at += OUTLINE_BOX_FLOATS) {
      const minX = planBoxes[at] ?? 0;
      const minZ = planBoxes[at + 1] ?? 0;
      const maxX = planBoxes[at + 2] ?? 0;
      const maxZ = planBoxes[at + 3] ?? 0;
      if (!this.someBox(minX, minZ, maxX, maxZ, CONTAINS)) return false;
    }
    return true;
  }

  reaches(box: WorldBox): boolean {
    return this.someBox(box.minX, box.minZ, box.maxX, box.maxZ, OVERLAPS);
  }

  private someBox(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    relation: BoxRelation,
  ): boolean {
    const epoch = ++this.epoch;
    const cells = this.cells;
    for (let cz = chunkOf(minZ); cz <= chunkOf(maxZ); cz++) {
      for (let cx = chunkOf(minX); cx <= chunkOf(maxX); cx++) {
        for (const index of this.byChunk.get(chunkKey(cx, cz)) ?? NO_BOXES) {
          if (this.seenIn[index] === epoch) continue;
          this.seenIn[index] = epoch;
          const at = index * OUTLINE_BOX_FLOATS;
          const cellMinX = cells[at] ?? 0;
          const cellMinZ = cells[at + 1] ?? 0;
          const cellMaxX = cells[at + 2] ?? 0;
          const cellMaxZ = cells[at + 3] ?? 0;
          const related =
            relation === CONTAINS
              ? cellMinX <= minX && maxX <= cellMaxX && cellMinZ <= minZ && maxZ <= cellMaxZ
              : minX <= cellMaxX && cellMinX <= maxX && minZ <= cellMaxZ && cellMinZ <= maxZ;
          if (related) return true;
        }
      }
    }
    return false;
  }
}
