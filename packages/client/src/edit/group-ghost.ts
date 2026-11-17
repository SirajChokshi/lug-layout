import { PLATE_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS, type ChunkInstances } from "@brr/render";
import type { PendingPose } from "./placed-chunks.ts";

const MATRIX_COLUMNS = 4;

interface Frame {
  readonly cos: number;
  readonly sin: number;
  readonly tx: number;
  readonly ty: number;
  readonly tz: number;
}

function frameOf(pose: PendingPose, originX: number, originZ: number): Frame {
  const rot = pose.rot;
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  return {
    cos: rot90Cos(rot),
    sin: rot90Sin(rot),
    tx: pose.x - originX,
    ty: pose.yPlates * PLATE_LDU,
    tz: pose.z - originZ,
  };
}

function writeMatrix(
  source: Float32Array,
  from: number,
  target: Float32Array,
  to: number,
  frame: Frame,
): void {
  const s = from * INSTANCE_MATRIX_FLOATS;
  const t = to * INSTANCE_MATRIX_FLOATS;
  for (let col = 0; col < MATRIX_COLUMNS; col++) {
    const row0 = source[s + col] ?? 0;
    const row2 = source[s + 8 + col] ?? 0;
    target[t + col] = frame.cos * row0 + frame.sin * row2;
    target[t + 4 + col] = source[s + 4 + col] ?? 0;
    target[t + 8 + col] = -frame.sin * row0 + frame.cos * row2;
  }
  target[t + 3] = (target[t + 3] ?? 0) + frame.tx;
  target[t + 7] = (target[t + 7] ?? 0) + frame.ty;
  target[t + 11] = (target[t + 11] ?? 0) + frame.tz;
}

export function groupGhost(
  poses: ReadonlyArray<PendingPose>,
  originX: number,
  originZ: number,
): ChunkInstances {
  let parts = 0;
  let studs = 0;
  for (const pose of poses) {
    parts += pose.placeable.parts.count;
    studs += pose.placeable.studs.count;
  }
  const ghost: ChunkInstances = {
    originX: 0,
    originZ: 0,
    count: parts,
    partIndex: new Uint16Array(parts),
    colorIndex: new Uint16Array(parts),
    matrices: new Float32Array(parts * INSTANCE_MATRIX_FLOATS),
    studs: {
      count: studs,
      primitiveIndex: new Uint8Array(studs),
      colorIndex: new Uint16Array(studs),
      matrices: new Float32Array(studs * INSTANCE_MATRIX_FLOATS),
    },
  };
  let part = 0;
  let stud = 0;
  for (const pose of poses) {
    const frame = frameOf(pose, originX, originZ);
    const source = pose.placeable;
    for (let i = 0; i < source.parts.count; i++, part++) {
      ghost.partIndex[part] = source.parts.partIndex[i] ?? 0;
      ghost.colorIndex[part] = source.parts.colorIndex[i] ?? 0;
      writeMatrix(source.parts.matrices, i, ghost.matrices, part, frame);
    }
    for (let i = 0; i < source.studs.count; i++, stud++) {
      ghost.studs.primitiveIndex[stud] = source.studs.primitiveIndex[i] ?? 0;
      ghost.studs.colorIndex[stud] = source.studs.colorIndex[i] ?? 0;
      writeMatrix(source.studs.matrices, i, ghost.studs.matrices, stud, frame);
    }
  }
  return ghost;
}
