import { type SeededRandom } from "../generator.ts";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import {
  type PivotOption,
  pivotOptions,
  pivotPartAxles,
  stackAt,
  stackWithHoleAt,
} from "./pivot-stacks.ts";
import {
  type Carrier,
  PIVOT_PART_SUFFIX,
  UP,
  footprint,
  onLattice,
  pickColor,
  placeAlong,
  pointOnLine,
} from "./placement.ts";
import type { TrainModel } from "./train-model.ts";
import type { TrainPools } from "./train-pools.ts";
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
  readonly holes: ReadonlyArray<readonly [number, number]>;
  readonly bodyIndices: ReadonlyArray<number>;
  readonly bogieIndices: ReadonlyArray<number>;
  readonly pivotParts: ReadonlyArray<number>;
}

export function hangBogie(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  request: BogieRequest,
): HungBogie | null {
  const { body } = request;
  const axleLengths = pivotPartAxles(pools).map((axle) => axle.span.to - axle.span.from);
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
      const placed = stackUnderBody(
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
    const axle = pivotPartAxles(pools).find(
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
      const placed = stackUnderBody(
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
    const pivotParts = pivots.map((pivot) => {
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
      pivotParts,
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

function finishBogie(
  option: PivotOption,
  xCorner: number,
  zCorner: number,
  bottom: number,
  pivots: ReadonlyArray<readonly [number, number]>,
  bodyIndices: ReadonlyArray<number>,
  bogieIndices: ReadonlyArray<number>,
  pivotParts: ReadonlyArray<number>,
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
    holes: option.holes.map(([x, z]) => [xCorner + x, zCorner + z] as const),
    bodyIndices,
    bogieIndices,
    pivotParts,
  };
}

function stackUnderBody(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  body: Carrier,
  options: ReadonlyArray<PivotOption>,
  pivot: readonly [number, number],
  plates: number,
  unit: string,
): { readonly indices: ReadonlyArray<number>; readonly bottom: number } | null {
  const stack = stackWithHoleAt(
    model,
    pools,
    random,
    options,
    pivot,
    body.bottom,
    plates,
    body.x0,
    body.z0,
    (box) =>
      box.min[0] >= body.x0 &&
      box.max[0] <= body.x1 &&
      box.min[2] >= body.z0 &&
      box.max[2] <= body.z1,
    unit,
    body.index,
  );
  return stack ? { indices: stack.indices, bottom: body.bottom - plates * PLATE_LDU } : null;
}
