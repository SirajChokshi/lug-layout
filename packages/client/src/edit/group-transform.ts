import type { PlacementPose } from "@brr/domain";
import {
  QUARTER_TURN_16,
  STUD_LDU,
  addZeta16,
  isRot90,
  normalizeHeading16,
  pose16,
  rot90Cos,
  rot90Sin,
  rotateZeta16,
  subtractZeta16,
  zeta16,
  type Pose16,
  type Rot90,
  type Zeta16,
} from "@brr/math";
import type { WorldBox } from "@brr/render";
import { quarterTurned, type TurnDirection } from "./turn.ts";

export const QUAD_FLOATS = 8;
const QUAD_CORNERS = 4;

export interface LatticePoint {
  readonly x: number;
  readonly z: number;
}

function quarterTurn(turns: number): Rot90 {
  const turn = quarterTurned(0, turns);
  if (!isRot90(turn)) throw new Error(`${turns} quarter turns is not a quarter turn 0-3`);
  return turn;
}

export function unionBox(boxes: ReadonlyArray<WorldBox>): WorldBox {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    minZ = Math.min(minZ, box.minZ);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
    maxZ = Math.max(maxZ, box.maxZ);
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

export function nearestStud(ldu: number): number {
  return Math.round(ldu / STUD_LDU) * STUD_LDU + 0;
}

export function latticeCentre(box: WorldBox): LatticePoint {
  return { x: nearestStud((box.minX + box.maxX) / 2), z: nearestStud((box.minZ + box.maxZ) / 2) };
}

export function translated(pose: PlacementPose, dx: number, dz: number): PlacementPose {
  return { ...pose, x: pose.x + dx + 0, z: pose.z + dz + 0 };
}

export function turnedAbout(
  pose: PlacementPose,
  pivot: LatticePoint,
  direction: TurnDirection,
): PlacementPose {
  const turn = quarterTurn(direction);
  const cos = rot90Cos(turn);
  const sin = rot90Sin(turn);
  const dx = pose.x - pivot.x;
  const dz = pose.z - pivot.z;
  return {
    ...pose,
    x: pivot.x + cos * dx + sin * dz + 0,
    z: pivot.z - sin * dx + cos * dz + 0,
    rot: quarterTurned(pose.rot, direction),
  };
}

function latticeZeta16(x: number, z: number): Zeta16 {
  return zeta16([BigInt(x / STUD_LDU), 0n, 0n, 0n, BigInt(z / STUD_LDU), 0n, 0n, 0n]);
}

export function pieceTranslated(pose: Pose16, dx: number, dz: number): Pose16 {
  return pose16(addZeta16(pose.position, latticeZeta16(dx, dz)), pose.heading);
}

export function pieceTurnedAbout(
  pose: Pose16,
  pivot: LatticePoint,
  direction: TurnDirection,
): Pose16 {
  const centre = latticeZeta16(pivot.x, pivot.z);
  const steps = -QUARTER_TURN_16 * direction;
  const offset = rotateZeta16(subtractZeta16(pose.position, centre), steps);
  return pose16(addZeta16(centre, offset), normalizeHeading16(pose.heading + steps));
}

export function pieceRelativePose(pose: Pose16, frame: PlacementPose): Pose16 {
  const steps = QUARTER_TURN_16 * frame.rot;
  const offset = subtractZeta16(pose.position, latticeZeta16(frame.x, frame.z));
  return pose16(rotateZeta16(offset, steps), normalizeHeading16(pose.heading + steps));
}

export function relativePose(pose: PlacementPose, frame: PlacementPose): PlacementPose {
  const back = quarterTurn(-frame.rot);
  const cos = rot90Cos(back);
  const sin = rot90Sin(back);
  const dx = pose.x - frame.x;
  const dz = pose.z - frame.z;
  return {
    ...pose,
    x: cos * dx + sin * dz + 0,
    z: -sin * dx + cos * dz + 0,
    yPlates: pose.yPlates - frame.yPlates,
    rot: quarterTurned(pose.rot, -frame.rot),
  };
}

export function stacksOf(
  count: number,
  restsOn: (rider: number, base: number) => boolean,
): ReadonlyArray<number> {
  const parent = Array.from({ length: count }, (_, index) => index);
  const root = (index: number): number => {
    let at = index;
    while (parent[at] !== at) at = parent[at] ?? at;
    return at;
  };
  for (let rider = 0; rider < count; rider++) {
    for (let base = 0; base < count; base++) {
      if (rider !== base && restsOn(rider, base)) parent[root(rider)] = root(base);
    }
  }
  return parent.map((_, index) => root(index));
}

export function restStacks(
  poses: ReadonlyArray<PlacementPose>,
  stacks: ReadonlyArray<number>,
  restingHeights: ReadonlyArray<number>,
): ReadonlyArray<PlacementPose> {
  const lowest = new Map<number, number>();
  poses.forEach((pose, index) => {
    const stack = stacks[index] ?? index;
    lowest.set(stack, Math.min(lowest.get(stack) ?? Number.POSITIVE_INFINITY, pose.yPlates));
  });
  const base = new Map<number, number>();
  poses.forEach((pose, index) => {
    const stack = stacks[index] ?? index;
    const lift = pose.yPlates - (lowest.get(stack) ?? 0);
    base.set(stack, Math.max(base.get(stack) ?? 0, (restingHeights[index] ?? 0) - lift));
  });
  return poses.map((pose, index) => {
    const stack = stacks[index] ?? index;
    return { ...pose, yPlates: (base.get(stack) ?? 0) + pose.yPlates - (lowest.get(stack) ?? 0) };
  });
}

function sideOf(quad: Float64Array, corner: number, x: number, z: number): number {
  const next = (corner + 1) % QUAD_CORNERS;
  const ax = quad[corner * 2] ?? 0;
  const az = quad[corner * 2 + 1] ?? 0;
  const bx = quad[next * 2] ?? 0;
  const bz = quad[next * 2 + 1] ?? 0;
  return Math.sign((bx - ax) * (z - az) - (bz - az) * (x - ax));
}

function insideQuad(quad: Float64Array, x: number, z: number): boolean {
  let positive = false;
  let negative = false;
  for (let corner = 0; corner < QUAD_CORNERS; corner++) {
    const side = sideOf(quad, corner, x, z);
    if (side > 0) positive = true;
    if (side < 0) negative = true;
  }
  return !(positive && negative);
}

function quadArea(quad: Float64Array): number {
  let twiceArea = 0;
  for (let corner = 0; corner < QUAD_CORNERS; corner++) {
    const next = (corner + 1) % QUAD_CORNERS;
    twiceArea +=
      (quad[corner * 2] ?? 0) * (quad[next * 2 + 1] ?? 0) -
      (quad[next * 2] ?? 0) * (quad[corner * 2 + 1] ?? 0);
  }
  return Math.abs(twiceArea) / 2;
}

export function footprintInside(quad: Float64Array, box: WorldBox): boolean {
  return (
    quadArea(quad) > 0 &&
    insideQuad(quad, box.minX, box.minZ) &&
    insideQuad(quad, box.maxX, box.minZ) &&
    insideQuad(quad, box.maxX, box.maxZ) &&
    insideQuad(quad, box.minX, box.maxZ)
  );
}
