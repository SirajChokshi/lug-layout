import { INHERIT_COLOR, type ModelVoxels } from "@brr/catalog";
import type { Vec3 } from "@brr/schema/bundle";
import { PLATE_LDU, STUD_LDU } from "@brr/math";

export interface PlacedVoxels {
  readonly count: number;
  readonly cellX: Int32Array;
  readonly cellY: Int32Array;
  readonly cellZ: Int32Array;
  readonly colorIndex: Uint16Array;
  readonly yPhaseLdu: number;
}

const CELL_LDU: Vec3 = [STUD_LDU, PLATE_LDU, STUD_LDU];

function latticeCell(originLdu: number, cellLdu: number, axis: string): number {
  const cell = originLdu / cellLdu;
  if (!Number.isInteger(cell)) {
    throw new Error(
      `voxel grid ${axis} origin ${originLdu} LDU is not on the ${cellLdu} LDU lattice`,
    );
  }
  return cell;
}

export function placedVoxels(
  voxels: ModelVoxels,
  frameShift: Vec3,
  colorIndexOf: (ldrawColor: number) => number,
): PlacedVoxels {
  for (let axis = 0; axis < 3; axis++) {
    if (voxels.cellLdu[axis] !== CELL_LDU[axis]) {
      throw new Error(`voxel cells are ${voxels.cellLdu.join("×")} LDU, not ${CELL_LDU.join("×")}`);
    }
  }
  const baseX = latticeCell(voxels.origin[0] + frameShift[0], STUD_LDU, "x");
  const baseZ = latticeCell(voxels.origin[2] + frameShift[2], STUD_LDU, "z");
  const originY = voxels.origin[1] + frameShift[1];
  const yPhaseLdu = ((originY % PLATE_LDU) + PLATE_LDU) % PLATE_LDU;
  const baseY = Math.round((originY - yPhaseLdu) / PLATE_LDU);
  const [dimX, dimY] = voxels.dims;
  const count = voxels.cellIndex.length;
  const cellX = new Int32Array(count);
  const cellY = new Int32Array(count);
  const cellZ = new Int32Array(count);
  const colorIndex = new Uint16Array(count);
  const inherit = colorIndexOf(INHERIT_COLOR);
  for (let i = 0; i < count; i++) {
    const index = voxels.cellIndex[i] ?? 0;
    cellX[i] = baseX + (index % dimX);
    cellY[i] = baseY + (Math.floor(index / dimX) % dimY);
    cellZ[i] = baseZ + Math.floor(index / (dimX * dimY));
    const code = voxels.ldrawColor[i] ?? INHERIT_COLOR;
    colorIndex[i] = code === INHERIT_COLOR ? inherit : colorIndexOf(code);
  }
  return { count, cellX, cellY, cellZ, colorIndex, yPhaseLdu };
}
