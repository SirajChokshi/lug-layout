import { SLOT_LIVE, type ChunkView, type World } from "@brr/domain";
import { CHUNK_LDU, PLATE_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
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
  const partIndex = new Uint16Array(view.liveCount);
  const colorIndex = new Uint16Array(view.liveCount);
  const matrices = new Float32Array(view.liveCount * INSTANCE_MATRIX_FLOATS);
  let n = 0;
  for (let i = 0; i < view.count; i++) {
    if (((view.flags[i] ?? 0) & SLOT_LIVE) === 0) continue;
    const part = view.refId[i] ?? 0;
    if (part > MAX_PART_INDEX) throw new Error(`part index ${part} does not fit a render instance`);
    partIndex[n] = part;
    colorIndex[n] = view.colorId[i] ?? 0;
    const turn = view.rot[i] ?? 0;
    if (!isRot90(turn)) throw new Error(`rotation ${turn} is not a quarter turn 0-3`);
    const cos = rot90Cos(turn);
    const sin = rot90Sin(turn);
    const o = n * INSTANCE_MATRIX_FLOATS;
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
    n++;
  }
  return {
    originX: view.originX,
    originZ: view.originZ,
    count: n,
    partIndex,
    colorIndex,
    matrices,
  };
}

export interface PlacementDump {
  readonly refId: ReadonlyArray<number>;
  readonly colorId: ReadonlyArray<number>;
  readonly x: ReadonlyArray<number>;
  readonly z: ReadonlyArray<number>;
  readonly yPlates: ReadonlyArray<number>;
  readonly rot: ReadonlyArray<number>;
}

export function dumpPlacements(world: World): PlacementDump {
  const refId: number[] = [];
  const colorId: number[] = [];
  const x: number[] = [];
  const z: number[] = [];
  const yPlates: number[] = [];
  const rot: number[] = [];
  for (const chunk of world.chunks()) {
    for (let i = 0; i < chunk.count; i++) {
      if (((chunk.flags[i] ?? 0) & SLOT_LIVE) === 0) continue;
      refId.push(chunk.refId[i] ?? 0);
      colorId.push(chunk.colorId[i] ?? 0);
      x.push(chunk.x[i] ?? 0);
      z.push(chunk.z[i] ?? 0);
      yPlates.push(chunk.yPlates[i] ?? 0);
      rot.push(chunk.rot[i] ?? 0);
    }
  }
  return { refId, colorId, x, z, yPlates, rot };
}
