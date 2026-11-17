import type { PartAsset } from "@brr/catalog";
import { NO_STUD, type RoadSurface } from "@brr/domain";
import { STUD_LDU } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import type { ChunkPartInstances } from "../scene/placements.ts";
import { BOX_FLOATS, type LocalBox } from "./local-box.ts";

const HALF_STUD_LDU = STUD_LDU / 2;
const NO_OWNER = -1;

function exactLdu(value: number, what: string): number {
  const rounded = Math.round(value);
  if (rounded !== value) throw new Error(`${what} is ${value} LDU, not a whole LDU`);
  return rounded + 0;
}

function wholeCells(ldu: number, what: string): number {
  const cells = ldu / STUD_LDU;
  if (!Number.isInteger(cells)) throw new Error(`${what} spans ${ldu} LDU, not whole studs`);
  return cells;
}

export function roadSurface(
  instances: ChunkPartInstances,
  partBoxes: Float32Array,
  box: LocalBox,
  parts: ReadonlyArray<PartAsset>,
): RoadSurface {
  const minX = exactLdu(box.min[0], "surface min x");
  const minZ = exactLdu(box.min[2], "surface min z");
  const columns = wholeCells(exactLdu(box.max[0], "surface max x") - minX, "the surface");
  const rows = wholeCells(exactLdu(box.max[2], "surface max z") - minZ, "the surface");
  const cellCount = columns * rows;
  const top = new Int32Array(cellCount).fill(-0x7fff_ffff);
  const stud = new Int32Array(cellCount).fill(NO_STUD);
  const road = new Uint8Array(cellCount);
  const owner = new Int32Array(cellCount).fill(NO_OWNER);
  for (let i = 0; i < instances.count; i++) {
    const b = i * BOX_FLOATS;
    const boxTop = exactLdu(partBoxes[b + 4] ?? 0, "part top");
    const fromColumn = Math.ceil(((partBoxes[b] ?? 0) - minX - HALF_STUD_LDU) / STUD_LDU);
    const toColumn = Math.floor(((partBoxes[b + 3] ?? 0) - minX - HALF_STUD_LDU) / STUD_LDU);
    const fromRow = Math.ceil(((partBoxes[b + 2] ?? 0) - minZ - HALF_STUD_LDU) / STUD_LDU);
    const toRow = Math.floor(((partBoxes[b + 5] ?? 0) - minZ - HALF_STUD_LDU) / STUD_LDU);
    const isRoad = parts[instances.partIndex[i] ?? 0]?.role === "road" ? 1 : 0;
    for (let row = Math.max(0, fromRow); row <= Math.min(rows - 1, toRow); row++) {
      for (
        let column = Math.max(0, fromColumn);
        column <= Math.min(columns - 1, toColumn);
        column++
      ) {
        const cell = row * columns + column;
        if (boxTop <= (top[cell] ?? 0)) continue;
        top[cell] = boxTop;
        road[cell] = isRoad;
        stud[cell] = NO_STUD;
        owner[cell] = i;
      }
    }
  }
  for (let i = 0; i < instances.count; i++) {
    const part = parts[instances.partIndex[i] ?? 0];
    if (!part || part.role !== "road") continue;
    const o = i * INSTANCE_MATRIX_FLOATS;
    const m = instances.matrices;
    const studCount = part.studMatrices.length / INSTANCE_MATRIX_FLOATS;
    for (let s = 0; s < studCount; s++) {
      const so = s * INSTANCE_MATRIX_FLOATS;
      const sx = part.studMatrices[so + 3] ?? 0;
      const sy = part.studMatrices[so + 7] ?? 0;
      const sz = part.studMatrices[so + 11] ?? 0;
      const x = (m[o] ?? 0) * sx + (m[o + 1] ?? 0) * sy + (m[o + 2] ?? 0) * sz + (m[o + 3] ?? 0);
      const y =
        (m[o + 4] ?? 0) * sx + (m[o + 5] ?? 0) * sy + (m[o + 6] ?? 0) * sz + (m[o + 7] ?? 0);
      const z =
        (m[o + 8] ?? 0) * sx + (m[o + 9] ?? 0) * sy + (m[o + 10] ?? 0) * sz + (m[o + 11] ?? 0);
      const column = Math.floor((x - minX) / STUD_LDU);
      const row = Math.floor((z - minZ) / STUD_LDU);
      if (column < 0 || row < 0 || column >= columns || row >= rows) continue;
      const cell = row * columns + column;
      if (owner[cell] !== i) continue;
      const base = exactLdu(y, `${part.id} stud base`);
      stud[cell] = base;
      road[cell] = base < (top[cell] ?? 0) ? 1 : 0;
    }
  }
  return { minX, minZ, columns, rows, top, stud, road };
}
