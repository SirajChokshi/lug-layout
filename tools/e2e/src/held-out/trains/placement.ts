import { type SeededRandom } from "../generator.ts";
import { type Vec3 } from "../assembly.ts";
import { STUD_LDU } from "@brr/math";
import {
  type Axis,
  type Block,
  type HoleLine,
  type Sign,
  VERTICAL,
  across,
} from "./part-geometry.ts";
import type { Box, PartReading } from "./part-readings.ts";
import {
  type TrainModel,
  apply,
  rotationsTaking,
  subtract,
  transformedBox,
  yaw,
} from "./train-model.ts";
import type { Mat3, TrainPools } from "./train-pools.ts";
export const MARGIN_LDU = 1;
export const CONTACT_FRACTION = 0.5;
export const LATERAL_SEARCH_LDU = 90;
export const SEAT_TRIES = 6;
export const MAX_PIVOT_PLATES = 9;
export const END_TRIES = 8;
export const PLAIN_AXLE_LDU = 0.5;
export const BODY_SLACK_STUDS = 6;
export const BODY_TRIES = 40;
export const BEARING_CLEARANCE_LDU = 1;
export const UP: { readonly axis: Axis; readonly sign: Sign } = { axis: VERTICAL, sign: 1 };
export const LATERAL: Axis = 2;
export const TRAVEL: Axis = 0;

export interface RailHeadBands {
  readonly part: string;
  readonly inner: number;
  readonly outer: number;
}

export interface Carrier {
  readonly index: number;
  readonly unit: string;
  readonly bottom: number;
  readonly top: number;
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
}

export function rotatedBounds(box: Box, rotation: Mat3): Box {
  return transformedBox(box, rotation, [0, 0, 0]);
}

export function reading(pools: TrainPools, reference: string): PartReading {
  const found = pools.readings.get(reference);
  if (!found) throw new Error(`no reading for ${reference}`);
  return found;
}

export function onLattice(value: number, origin: number): boolean {
  const steps = (value - origin) / STUD_LDU;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}

export function placeBlock(
  model: TrainModel,
  pools: TrainPools,
  block: Block,
  turns: number,
  corner: readonly [number, number],
  topY: number,
  color: number,
  unit: string,
): number {
  const rotation = yaw(turns);
  const box = rotatedBounds(block.bounds, rotation);
  return model.place(
    reading(pools, block.reference),
    rotation,
    [corner[0] - box.min[0], topY - box.max[1], corner[1] - box.min[2]],
    color,
    unit,
  );
}

export function placeBlockOn(
  model: TrainModel,
  pools: TrainPools,
  block: Block,
  turns: number,
  corner: readonly [number, number],
  bottomY: number,
  color: number,
  unit: string,
): number {
  const box = rotatedBounds(block.bounds, yaw(turns));
  return placeBlock(
    model,
    pools,
    block,
    turns,
    corner,
    bottomY + box.max[1] - box.min[1],
    color,
    unit,
  );
}

export function footprint(block: Block, turns: number): readonly [number, number] {
  return turns % 2 === 0 ? [block.width, block.depth] : [block.depth, block.width];
}

export function pickColor(random: SeededRandom, pools: TrainPools): number {
  return random.choice(pools.colors) ?? 0;
}

export interface BearingOption {
  readonly block: Block;
  readonly turns: number;
  readonly hole: HoleLine;
  readonly holeX: number;
  readonly holeDepth: number;
  readonly box: Box;
}

export function bearingOptions(
  pools: TrainPools,
  axis: Axis,
  singleHole: boolean,
): ReadonlyArray<BearingOption> {
  return pools.bearings.flatMap((block) =>
    [0, 1, 2, 3].flatMap((turns) => {
      const rotation = yaw(turns);
      const box = rotatedBounds(block.bounds, rotation);
      const lines = block.holes.flatMap((hole) => {
        const direction: [number, number, number] = [0, 0, 0];
        direction[hole.axis] = 1;
        const rotated = apply(rotation, direction);
        if (Math.abs(rotated[axis]) !== 1) return [];
        const point: [number, number, number] = [0, 0, 0];
        const [p, q] = across(hole.axis);
        point[p] = hole.at[0];
        point[q] = hole.at[1];
        const world = apply(rotation, point);
        return [{ hole, world }];
      });
      if (lines.length === 0 || (singleHole && block.holes.length !== 1)) return [];
      return lines.map(({ hole, world }) => ({
        block,
        turns,
        hole,
        holeX: world[TRAVEL] - box.min[TRAVEL],
        holeDepth: box.max[VERTICAL] - world[VERTICAL],
        box,
      }));
    }),
  );
}

export function spacerStack(
  pools: TrainPools,
  width: number,
  depth: number,
  plates: number,
): ReadonlyArray<{ block: Block; turns: number }> | null {
  const fitting = pools.spacers.flatMap((block) =>
    [0, 1].flatMap((turns) => {
      const [w, d] = footprint(block, turns);
      return w === width && d === depth ? [{ block, turns }] : [];
    }),
  );
  const stack: Array<{ block: Block; turns: number }> = [];
  let left = plates;
  while (left > 0) {
    const next = fitting
      .filter((item) => item.block.heightPlates <= left)
      .toSorted((a, b) => b.block.heightPlates - a.block.heightPlates)[0];
    if (!next) return null;
    stack.push(next);
    left -= next.block.heightPlates;
  }
  return stack;
}

export function placeAlong(
  model: TrainModel,
  part: { readonly reading: PartReading },
  localAxis: { readonly axis: Axis; readonly sign: Sign },
  localPoint: Vec3,
  worldAxis: { readonly axis: Axis; readonly sign: Sign },
  worldPoint: Vec3,
  color: number,
  unit: string,
): number {
  const [rotation] = rotationsTaking(localAxis, worldAxis);
  if (!rotation) throw new Error("no rotation takes the axis");
  return model.place(
    part.reading,
    rotation,
    subtract(worldPoint, apply(rotation, localPoint)),
    color,
    unit,
  );
}

export function pointOnLine(axis: Axis, at: readonly [number, number], along: number): Vec3 {
  const point: [number, number, number] = [0, 0, 0];
  const [p, q] = across(axis);
  point[axis] = along;
  point[p] = at[0];
  point[q] = at[1];
  return point;
}

export const PIVOT_PART_SUFFIX = " pivot";

export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}
