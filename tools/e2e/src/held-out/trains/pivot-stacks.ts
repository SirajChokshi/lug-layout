import { type SeededRandom } from "../generator.ts";
import { PLATE_LDU } from "@brr/math";
import { type Block, VERTICAL } from "./part-geometry.ts";
import type { Box } from "./part-readings.ts";
import {
  LATERAL,
  MAX_PIVOT_PLATES,
  PLAIN_AXLE_LDU,
  TRAVEL,
  UP,
  onLattice,
  pickColor,
  placeAlong,
  placeBlock,
  pointOnLine,
  rotatedBounds,
} from "./placement.ts";
import { type TrainModel, apply, yaw } from "./train-model.ts";
import type { AxlePart, TrainPools } from "./train-pools.ts";
export interface PivotOption {
  readonly block: Block;
  readonly turns: number;
  readonly holes: ReadonlyArray<readonly [number, number]>;
  readonly box: Box;
}

export function pivotOptions(pools: TrainPools): ReadonlyArray<PivotOption> {
  return pools.pivotPlates.flatMap((block) =>
    [0, 1].map((turns) => {
      const rotation = yaw(turns);
      const box = rotatedBounds(block.bounds, rotation);
      const holes = block.holes
        .filter((hole) => hole.axis === VERTICAL)
        .map((hole) => {
          const world = apply(rotation, pointOnLine(VERTICAL, hole.at, 0));
          return [world[TRAVEL] - box.min[TRAVEL], world[LATERAL] - box.min[LATERAL]] as const;
        });
      return { block, turns, holes, box };
    }),
  );
}

export function stackAt(
  model: TrainModel,
  pools: TrainPools,
  option: PivotOption,
  corner: readonly [number, number],
  topY: number,
  plates: number,
  color: number,
  unit: string,
  joinTo: number | null,
): ReadonlyArray<number> {
  const indices: number[] = [];
  let previous = joinTo;
  for (let k = 0; k < plates; k++) {
    const index = placeBlock(
      model,
      pools,
      option.block,
      option.turns,
      corner,
      topY - k * PLATE_LDU,
      color,
      unit,
    );
    if (previous !== null) model.join(previous, index);
    indices.push(index);
    previous = index;
  }
  return indices;
}

export function pivotPartAxles(pools: TrainPools): ReadonlyArray<AxlePart> {
  return pools.axles.filter((axle) => {
    const plates = (axle.span.to - axle.span.from) / PLATE_LDU - 1;
    const { min, max } = axle.reading.bounds;
    const plain =
      max[axle.span.axis] - axle.span.to <= PLAIN_AXLE_LDU &&
      axle.span.from - min[axle.span.axis] <= PLAIN_AXLE_LDU;
    return plain && Number.isInteger(plates) && plates >= 2 && plates <= MAX_PIVOT_PLATES;
  });
}

export function verticalLink(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  pivot: readonly [number, number],
  bottom: number,
  top: number,
  members: ReadonlyArray<number>,
  unit: string,
): number | null {
  const axle = random.choice(
    pivotPartAxles(pools).filter(
      (candidate) => candidate.span.to - candidate.span.from === top - bottom,
    ),
  );
  if (!axle) return null;
  const index = placeAlong(
    model,
    axle,
    { axis: axle.span.axis, sign: 1 },
    pointOnLine(axle.span.axis, axle.span.at, axle.span.from),
    UP,
    [pivot[0], bottom, pivot[1]],
    pickColor(random, pools),
    unit,
  );
  for (const member of members) model.join(index, member);
  return index;
}

export function linkLengths(pools: TrainPools): ReadonlyArray<number> {
  return [...new Set(pivotPartAxles(pools).map((axle) => axle.span.to - axle.span.from))].toSorted(
    (a, b) => a - b,
  );
}

export interface PlacedStack {
  readonly indices: ReadonlyArray<number>;
  readonly pivot: readonly [number, number];
  readonly box: Box;
}

export function stackWithHoleAt(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  options: ReadonlyArray<PivotOption>,
  pivot: readonly [number, number],
  topY: number,
  plates: number,
  latticeX: number,
  latticeZ: number,
  fits: (box: Box) => boolean,
  unit: string,
  joinTo: number | null,
): PlacedStack | null {
  for (const option of random.shuffled(options)) {
    for (const hole of random.shuffled(option.holes)) {
      const corner = [pivot[0] - hole[0], pivot[1] - hole[1]] as const;
      if (!onLattice(corner[0], latticeX) || !onLattice(corner[1], latticeZ)) continue;
      const box = {
        min: [corner[0], topY - plates * PLATE_LDU, corner[1]] as const,
        max: [
          corner[0] + (option.box.max[0] - option.box.min[0]),
          topY,
          corner[1] + (option.box.max[2] - option.box.min[2]),
        ] as const,
      };
      if (!fits(box)) continue;
      const checkpoint = model.checkpoint();
      const indices = stackAt(
        model,
        pools,
        option,
        corner,
        topY,
        plates,
        pickColor(random, pools),
        unit,
        joinTo,
      );
      if (!model.collidesSince(checkpoint)) return { indices, pivot, box };
      model.rollback(checkpoint);
    }
  }
  return null;
}

export function linkPlateCount(lengthLdu: number): number {
  return lengthLdu / PLATE_LDU - 1;
}
