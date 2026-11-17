import type { PartAsset } from "@brr/catalog";
import { riserCourses, type BaseCells } from "@brr/domain";
import {
  BRICK_LDU,
  PLATE_LDU,
  STUD_LDU,
  ZETA16_ORDER,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";

export interface PierPart {
  readonly partIndex: number;
  readonly color: number;
  readonly part: PartAsset;
}

export interface PierKit {
  readonly brick: PierPart;
  readonly plate: PierPart;
}

export interface Pier {
  readonly key: string;
  readonly centreX: number;
  readonly centreZ: number;
  readonly longAlongZ: boolean;
  readonly heightPlates: number;
  readonly cells: BaseCells;
}

export interface PierFootprint {
  readonly longStuds: number;
  readonly shortStuds: number;
}

const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const ODD_STUD_PHASE_LDU = STUD_LDU / 2;

function extentStuds(part: PartAsset, axis: 0 | 2): number {
  return Math.round((part.boundsMax[axis] - part.boundsMin[axis]) / STUD_LDU);
}

function longAlongX(part: PartAsset): boolean {
  return extentStuds(part, 0) >= extentStuds(part, 2);
}

function partHeightLdu(part: PartAsset): number {
  return Math.round(part.boundsMax[1] - part.boundsMin[1]);
}

export function pierFootprint(kit: PierKit): PierFootprint {
  const { brick, plate } = kit;
  const long = Math.max(extentStuds(brick.part, 0), extentStuds(brick.part, 2));
  const short = Math.min(extentStuds(brick.part, 0), extentStuds(brick.part, 2));
  const plateLong = Math.max(extentStuds(plate.part, 0), extentStuds(plate.part, 2));
  const plateShort = Math.min(extentStuds(plate.part, 0), extentStuds(plate.part, 2));
  if (long !== plateLong || short !== plateShort) {
    throw new Error(`pier brick ${brick.part.id} and plate ${plate.part.id} differ in plan size`);
  }
  if (partHeightLdu(brick.part) !== BRICK_LDU || partHeightLdu(plate.part) !== PLATE_LDU) {
    throw new Error(`pier parts must be one brick and one plate tall`);
  }
  return { longStuds: long, shortStuds: short };
}

function snapCentre(ldu: number, studs: number): number {
  const phase = studs % 2 === 0 ? 0 : ODD_STUD_PHASE_LDU;
  return Math.round((ldu - phase) / STUD_LDU) * STUD_LDU + phase + 0;
}

function footprintCells(
  centreX: number,
  centreZ: number,
  studsX: number,
  studsZ: number,
): BaseCells {
  const x0 = Math.round((centreX - (studsX * STUD_LDU) / 2) / STUD_LDU);
  const z0 = Math.round((centreZ - (studsZ * STUD_LDU) / 2) / STUD_LDU);
  const count = studsX * studsZ;
  const cells = {
    count,
    cellX: new Int32Array(count),
    cellZ: new Int32Array(count),
    flat: new Uint8Array(count),
  };
  for (let i = 0; i < count; i++) {
    cells.cellX[i] = x0 + (i % studsX);
    cells.cellZ[i] = z0 + Math.floor(i / studsX);
  }
  return cells;
}

export function pierAt(end: Pose16, heightPlates: number, footprint: PierFootprint): Pier {
  const studs = zeta16ToStuds(end.position);
  const theta = end.heading * HEADING_RADIANS;
  const longAlongZ = Math.abs(Math.cos(theta)) >= Math.abs(Math.sin(theta)) - 1e-9;
  const studsX = longAlongZ ? footprint.shortStuds : footprint.longStuds;
  const studsZ = longAlongZ ? footprint.longStuds : footprint.shortStuds;
  const centreX = snapCentre(studs.x * STUD_LDU, studsX);
  const centreZ = snapCentre(studs.z * STUD_LDU, studsZ);
  return {
    key: `${centreX},${centreZ},${longAlongZ ? "z" : "x"},${heightPlates}`,
    centreX,
    centreZ,
    longAlongZ,
    heightPlates,
    cells: footprintCells(centreX, centreZ, studsX, studsZ),
  };
}

export function footprintAt(end: Pose16, footprint: PierFootprint): BaseCells {
  return pierAt(end, 0, footprint).cells;
}

export function pierCourseCount(pier: Pier): number {
  const { bricks, plates } = riserCourses(pier.heightPlates);
  return bricks + plates;
}

function writeCourse(
  out: Float32Array,
  slot: number,
  part: PartAsset,
  pier: Pier,
  bottomLdu: number,
  originX: number,
  originZ: number,
): void {
  const turn = longAlongX(part) === pier.longAlongZ;
  const c = turn ? 0 : 1;
  const s = turn ? 1 : 0;
  const lx = (part.boundsMin[0] + part.boundsMax[0]) / 2;
  const lz = (part.boundsMin[2] + part.boundsMax[2]) / 2;
  const o = slot * INSTANCE_MATRIX_FLOATS;
  out[o] = c;
  out[o + 1] = 0;
  out[o + 2] = -s;
  out[o + 3] = pier.centreX - (c * lx - s * lz) - originX;
  out[o + 4] = 0;
  out[o + 5] = 1;
  out[o + 6] = 0;
  out[o + 7] = bottomLdu - part.boundsMin[1];
  out[o + 8] = s;
  out[o + 9] = 0;
  out[o + 10] = c;
  out[o + 11] = pier.centreZ - (s * lx + c * lz) - originZ;
}

export function writePier(
  pier: Pier,
  kit: PierKit,
  partIndex: Uint16Array,
  colorIndex: Uint16Array,
  matrices: Float32Array,
  first: number,
  originX: number,
  originZ: number,
): number {
  const { bricks, plates } = riserCourses(pier.heightPlates);
  let slot = first;
  let bottom = 0;
  for (let course = 0; course < bricks + plates; course++) {
    const use = course < bricks ? kit.brick : kit.plate;
    partIndex[slot] = use.partIndex;
    colorIndex[slot] = use.color;
    writeCourse(matrices, slot, use.part, pier, bottom, originX, originZ);
    bottom += course < bricks ? BRICK_LDU : PLATE_LDU;
    slot++;
  }
  return slot - first;
}
