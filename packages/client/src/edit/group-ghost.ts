import type { PlacementPose } from "@brr/domain";
import { PLATE_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS, type ChunkInstances } from "@brr/render";
import { relativePose } from "./group-transform.ts";
import type { Placeable } from "./placeable.ts";

export interface GhostMember {
  readonly placeable: Pick<Placeable, "parts" | "studs">;
  readonly pose: PlacementPose;
}

const TRANSLATION_X = 3;
const TRANSLATION_Y = 7;
const TRANSLATION_Z = 11;
const ROW_1 = 4;
const ROW_2 = 8;
const MATRIX_COLUMNS = 4;

function writeMoved(
  source: Float32Array,
  count: number,
  pose: PlacementPose,
  target: Float32Array,
  firstSlot: number,
): void {
  if (!isRot90(pose.rot)) throw new Error(`rotation ${pose.rot} is not a quarter turn 0-3`);
  const cos = rot90Cos(pose.rot);
  const sin = rot90Sin(pose.rot);
  for (let i = 0; i < count; i++) {
    const s = i * INSTANCE_MATRIX_FLOATS;
    const t = (firstSlot + i) * INSTANCE_MATRIX_FLOATS;
    for (let col = 0; col < MATRIX_COLUMNS; col++) {
      const row0 = source[s + col] ?? 0;
      const row2 = source[s + ROW_2 + col] ?? 0;
      target[t + col] = cos * row0 + sin * row2;
      target[t + ROW_1 + col] = source[s + ROW_1 + col] ?? 0;
      target[t + ROW_2 + col] = -sin * row0 + cos * row2;
    }
    target[t + TRANSLATION_X] = (target[t + TRANSLATION_X] ?? 0) + pose.x;
    target[t + TRANSLATION_Y] = (target[t + TRANSLATION_Y] ?? 0) + pose.yPlates * PLATE_LDU;
    target[t + TRANSLATION_Z] = (target[t + TRANSLATION_Z] ?? 0) + pose.z;
  }
}

export function groupGhost(members: ReadonlyArray<GhostMember>, lead: number): ChunkInstances {
  const frame = members[lead]?.pose;
  if (!frame) throw new Error(`the group has no member ${lead}`);
  const [only, second] = members;
  if (only && !second) return { ...only.placeable.parts, studs: only.placeable.studs };
  let parts = 0;
  let studs = 0;
  for (const { placeable } of members) {
    parts += placeable.parts.count;
    studs += placeable.studs.count;
  }
  const partIndex = new Uint16Array(parts);
  const colorIndex = new Uint16Array(parts);
  const matrices = new Float32Array(parts * INSTANCE_MATRIX_FLOATS);
  const primitiveIndex = new Uint8Array(studs);
  const studColors = new Uint16Array(studs);
  const studMatrices = new Float32Array(studs * INSTANCE_MATRIX_FLOATS);
  let part = 0;
  let stud = 0;
  for (const member of members) {
    const relative = relativePose(member.pose, frame);
    const { parts: own, studs: ownStuds } = member.placeable;
    partIndex.set(own.partIndex.subarray(0, own.count), part);
    colorIndex.set(own.colorIndex.subarray(0, own.count), part);
    writeMoved(own.matrices, own.count, relative, matrices, part);
    primitiveIndex.set(ownStuds.primitiveIndex.subarray(0, ownStuds.count), stud);
    studColors.set(ownStuds.colorIndex.subarray(0, ownStuds.count), stud);
    writeMoved(ownStuds.matrices, ownStuds.count, relative, studMatrices, stud);
    part += own.count;
    stud += ownStuds.count;
  }
  return {
    originX: 0,
    originZ: 0,
    count: parts,
    partIndex,
    colorIndex,
    matrices,
    studs: { count: studs, primitiveIndex, colorIndex: studColors, matrices: studMatrices },
  };
}
