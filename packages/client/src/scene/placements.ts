import {
  CHUNK_LDU,
  PLATE_LDU,
  isRot90,
  rot90Cos,
  rot90Sin,
  type ChunkView,
  type World,
} from "@brr/domain";
import { INSTANCE_MATRIX_FLOATS, type ChunkInstances } from "@brr/render";

export type ChunkPartInstances = Omit<ChunkInstances, "studs">;

const MAX_PART_INDEX = 0xffff;

export class ModuleWriter {
  count = 0;
  private readonly originX: number;
  private readonly originZ: number;

  constructor(
    private readonly world: World,
    chunkX: number,
    chunkZ: number,
  ) {
    this.originX = chunkX * CHUNK_LDU;
    this.originZ = chunkZ * CHUNK_LDU;
  }

  push(part: number, color: number, x: number, z: number, yPlates: number, rot: number): void {
    this.world.add(part, color, this.originX + x, this.originZ + z, yPlates, rot);
    this.count++;
  }
}

export function chunkInstances(view: ChunkView): ChunkPartInstances {
  const partIndex = new Uint16Array(view.count);
  const matrices = new Float32Array(view.count * INSTANCE_MATRIX_FLOATS);
  for (let i = 0; i < view.count; i++) {
    const part = view.refId[i] ?? 0;
    if (part > MAX_PART_INDEX) throw new Error(`part index ${part} does not fit a render instance`);
    partIndex[i] = part;
    const turn = view.rot[i] ?? 0;
    if (!isRot90(turn)) throw new Error(`rotation ${turn} is not a quarter turn 0-3`);
    const cos = rot90Cos(turn);
    const sin = rot90Sin(turn);
    const o = i * INSTANCE_MATRIX_FLOATS;
    matrices[o] = cos;
    matrices[o + 1] = 0;
    matrices[o + 2] = sin;
    matrices[o + 3] = (view.x[i] ?? 0) - view.originX;
    matrices[o + 4] = 0;
    matrices[o + 5] = 1;
    matrices[o + 6] = 0;
    matrices[o + 7] = (view.yPlates[i] ?? 0) * PLATE_LDU;
    matrices[o + 8] = -sin;
    matrices[o + 9] = 0;
    matrices[o + 10] = cos;
    matrices[o + 11] = (view.z[i] ?? 0) - view.originZ;
  }
  return {
    originX: view.originX,
    originZ: view.originZ,
    count: view.count,
    partIndex,
    colorIndex: view.colorId,
    matrices,
  };
}
