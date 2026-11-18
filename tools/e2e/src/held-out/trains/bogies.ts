import { type SeededRandom } from "../generator.ts";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import { type Block, VERTICAL } from "./part-geometry.ts";
import type { Box } from "./part-readings.ts";
import {
  type Carrier,
  LATERAL,
  MAX_PIVOT_PLATES,
  PIVOT_PART_SUFFIX,
  PLAIN_AXLE_LDU,
  TRAVEL,
  UP,
  footprint,
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
  return pools.pivots.flatMap((block) =>
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

export interface BogieRequest {
  readonly body: Carrier;
  readonly pivotRange: readonly [number, number];
  readonly unitBody: string;
  readonly unitBogie: string;
  readonly join: "pivot" | "rigid" | "two pivots";
  readonly lengthStuds: number;
  readonly cap: boolean;
  readonly pivotZ: number;
}

export interface HungBogie {
  readonly bogie: Carrier;
  readonly pivots: ReadonlyArray<readonly [number, number]>;
  readonly bodyIndices: ReadonlyArray<number>;
  readonly bogieIndices: ReadonlyArray<number>;
  readonly pivotAxles: ReadonlyArray<number>;
}

export function hangBogie(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  request: BogieRequest,
): HungBogie | null {
  const { body } = request;
  const axleLengths = pivotAxles(pools).map((axle) => axle.span.to - axle.span.from);
  const options = pivotOptions(pools);
  const bogieOptions = options.filter((option) => {
    const [length] = footprint(option.block, option.turns);
    return (
      length >= request.lengthStuds &&
      option.holes.length >= (request.join === "two pivots" ? 2 : 1)
    );
  });
  const ordered = random
    .shuffled(bogieOptions)
    .toSorted((a, b) => footprint(a.block, a.turns)[0] - footprint(b.block, b.turns)[0]);
  for (const bogieOption of ordered) {
    const holes =
      request.join === "two pivots"
        ? pickTwo(random, bogieOption.holes)
        : [random.choice(bogieOption.holes)];
    if (holes.some((hole) => hole === null)) continue;
    const firstHole = holes[0];
    if (!firstHole) continue;
    const zCorner = request.pivotZ - firstHole[1];
    if (!onLattice(zCorner, body.z0)) continue;
    const xCorners: number[] = [];
    const [length, width] = footprint(bogieOption.block, bogieOption.turns);
    for (let x = body.x0; x <= body.x1; x += STUD_LDU) {
      const pivotX = x + firstHole[0];
      if (pivotX < request.pivotRange[0] || pivotX > request.pivotRange[1]) continue;
      if (x < body.x0 || x + length * STUD_LDU > body.x1) continue;
      xCorners.push(x);
    }
    const xCorner = random.choice(xCorners);
    if (xCorner === null || zCorner < body.z0 || zCorner + width * STUD_LDU > body.z1) continue;
    const pivots = holes.flatMap((hole) =>
      hole ? [[xCorner + hole[0], zCorner + hole[1]] as const] : [],
    );
    const bodyOptions = options.filter((option) => option.holes.length > 0);
    const color = pickColor(random, pools);
    const checkpoint = model.checkpoint();
    if (request.join === "rigid") {
      if (!onLattice(xCorner, body.x0) || !onLattice(zCorner, body.z0)) continue;
      const placed = clearStackUnder(
        model,
        pools,
        random,
        body,
        bodyOptions,
        pivots[0] ?? [0, 0],
        1,
        request.unitBody,
      );
      if (!placed) continue;
      const bogieIndices = stackAt(
        model,
        pools,
        bogieOption,
        [xCorner, zCorner],
        placed.bottom,
        1,
        color,
        request.unitBogie,
        placed.indices.at(-1) ?? null,
      );
      const rigid = finishBogie(
        bogieOption,
        xCorner,
        zCorner,
        placed.bottom - PLATE_LDU,
        pivots,
        placed.indices,
        bogieIndices,
        [],
        request.unitBogie,
      );
      if (rigid && !model.collidesSince(checkpoint)) return rigid;
      model.rollback(checkpoint);
      continue;
    }
    const total = random.choice(axleLengths);
    const axle = pivotAxles(pools).find(
      (candidate) => candidate.span.to - candidate.span.from === total,
    );
    if (total === null || !axle) return null;
    const gapPlates = request.cap ? 2 : 1;
    const plates = total / PLATE_LDU - gapPlates;
    if (plates < 2) continue;
    const bodyPlates = 1 + random.int(plates - 1);
    const bogiePlates = plates - bodyPlates;
    const bodyIndices: number[] = [];
    for (const pivot of pivots) {
      const placed = clearStackUnder(
        model,
        pools,
        random,
        body,
        bodyOptions,
        pivot,
        bodyPlates,
        request.unitBody,
      );
      if (!placed) break;
      bodyIndices.push(...placed.indices);
    }
    if (bodyIndices.length !== pivots.length * bodyPlates) {
      model.rollback(checkpoint);
      continue;
    }
    const bogieTop = body.bottom - (bodyPlates + gapPlates) * PLATE_LDU;
    const bogieIndices = stackAt(
      model,
      pools,
      bogieOption,
      [xCorner, zCorner],
      bogieTop,
      bogiePlates,
      color,
      request.unitBogie,
      null,
    );
    const bogieBottom = bogieTop - bogiePlates * PLATE_LDU;
    const pivotPins = pivots.map((pivot) => {
      const index = placeAlong(
        model,
        axle,
        { axis: axle.span.axis, sign: 1 },
        pointOnLine(axle.span.axis, axle.span.at, axle.span.from),
        UP,
        [pivot[0], bogieBottom, pivot[1]],
        pickColor(random, pools),
        `${request.unitBogie}${PIVOT_PART_SUFFIX}`,
      );
      for (const member of [...bodyIndices, ...bogieIndices]) model.join(index, member);
      if (request.cap) {
        const bush = capOn(
          model,
          pools,
          random,
          pivot,
          body.bottom - bodyPlates * PLATE_LDU,
          `${request.unitBogie}${PIVOT_PART_SUFFIX}`,
        );
        if (bush !== null) model.join(bush, index);
      }
      return index;
    });
    const pivoted = finishBogie(
      bogieOption,
      xCorner,
      zCorner,
      bogieBottom,
      pivots,
      bodyIndices,
      bogieIndices,
      pivotPins,
      request.unitBogie,
    );
    if (pivoted && !model.collidesSince(checkpoint)) return pivoted;
    model.rollback(checkpoint);
  }
  return null;
}

function capOn(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  pivot: readonly [number, number],
  ceiling: number,
  unit: string,
): number | null {
  const bushes = pools.wheels.filter(
    (wheel) => wheel.hole.kind === "cross" && wheel.lateral[1] - wheel.lateral[0] <= PLATE_LDU,
  );
  const bush = random.choice(bushes);
  if (!bush) return null;
  return placeAlong(
    model,
    bush,
    { axis: bush.hole.axis, sign: 1 },
    pointOnLine(bush.hole.axis, bush.hole.at, bush.lateral[1]),
    UP,
    [pivot[0], ceiling, pivot[1]],
    pickColor(random, pools),
    unit,
  );
}

function pickTwo(
  random: SeededRandom,
  items: ReadonlyArray<readonly [number, number]>,
): ReadonlyArray<readonly [number, number] | null> {
  const order = items.toSorted((a, b) => a[0] - b[0]);
  const first = order[random.int(Math.max(1, Math.floor(order.length / 3)))] ?? null;
  const last =
    order[order.length - 1 - random.int(Math.max(1, Math.floor(order.length / 3)))] ?? null;
  return first === last ? [first, null] : [first, last];
}

export function pivotAxles(pools: TrainPools): ReadonlyArray<AxlePart> {
  return pools.axles.filter((axle) => {
    const plates = (axle.span.to - axle.span.from) / PLATE_LDU - 1;
    const { min, max } = axle.reading.bounds;
    const plain =
      max[axle.span.axis] - axle.span.to <= PLAIN_AXLE_LDU &&
      axle.span.from - min[axle.span.axis] <= PLAIN_AXLE_LDU;
    return plain && Number.isInteger(plates) && plates >= 2 && plates <= MAX_PIVOT_PLATES;
  });
}

function finishBogie(
  option: PivotOption,
  xCorner: number,
  zCorner: number,
  bottom: number,
  pivots: ReadonlyArray<readonly [number, number]>,
  bodyIndices: ReadonlyArray<number>,
  bogieIndices: ReadonlyArray<number>,
  pivotPins: ReadonlyArray<number>,
  unit: string,
): HungBogie | null {
  const index = bogieIndices.at(-1);
  if (index === undefined) return null;
  const [length, width] = footprint(option.block, option.turns);
  return {
    bogie: {
      index,
      unit,
      bottom,
      top: bottom + bogieIndices.length * PLATE_LDU,
      x0: xCorner,
      z0: zCorner,
      x1: xCorner + length * STUD_LDU,
      z1: zCorner + width * STUD_LDU,
    },
    pivots,
    bodyIndices,
    bogieIndices,
    pivotAxles: pivotPins,
  };
}

function clearStackUnder(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  body: Carrier,
  options: ReadonlyArray<PivotOption>,
  pivot: readonly [number, number],
  plates: number,
  unit: string,
): { readonly indices: ReadonlyArray<number>; readonly bottom: number } | null {
  for (const option of random.shuffled(options)) {
    const checkpoint = model.checkpoint();
    const placed = pivotStackUnder(model, pools, random, body, option, pivot, plates, unit);
    if (placed && !model.collidesSince(checkpoint)) return placed;
    model.rollback(checkpoint);
  }
  return null;
}

function pivotStackUnder(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  body: Carrier,
  option: PivotOption,
  pivot: readonly [number, number],
  plates: number,
  unit: string,
): { readonly indices: ReadonlyArray<number>; readonly bottom: number } | null {
  const [length, width] = footprint(option.block, option.turns);
  for (const hole of random.shuffled(option.holes)) {
    const corner = [pivot[0] - hole[0], pivot[1] - hole[1]] as const;
    if (!onLattice(corner[0], body.x0) || !onLattice(corner[1], body.z0)) continue;
    if (corner[0] < body.x0 || corner[0] + length * STUD_LDU > body.x1) continue;
    if (corner[1] < body.z0 || corner[1] + width * STUD_LDU > body.z1) continue;
    const indices = stackAt(
      model,
      pools,
      option,
      corner,
      body.bottom,
      plates,
      pickColor(random, pools),
      unit,
      body.index,
    );
    return { indices, bottom: body.bottom - plates * PLATE_LDU };
  }
  return null;
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
    pivotAxles(pools).filter(
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
  return [...new Set(pivotAxles(pools).map((axle) => axle.span.to - axle.span.from))].toSorted(
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
