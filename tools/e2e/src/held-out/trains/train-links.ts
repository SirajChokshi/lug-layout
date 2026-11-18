import { PLATE_LDU, STUD_LDU } from "@brr/math";
import type { Box } from "./part-readings.ts";
import {
  axles,
  bogieWithAxles,
  single,
  wheelFor,
  WIDE,
  type Recipe,
  type RecipeContext,
  type TrainPlan,
} from "./train-recipes.ts";
import {
  carBody,
  linkLengths,
  pick,
  pivotOptions,
  PIVOT_PART_SUFFIX,
  footprint,
  spacerStack,
  placeBlock,
  placeBlockOn,
  pickColor,
  stackWithHoleAt,
  verticalLink,
  type Carrier,
  type HungAxle,
  type PivotOption,
} from "./train-builder.ts";
import type { WheelPart } from "./train-pools.ts";

const FACING_CLEAR_STUDS = 4;
const FAR_CAR_GAP_STUDS = 10;

interface Wagon {
  readonly car: Carrier;
  readonly axles: ReadonlyArray<HungAxle>;
}

function wagon(
  context: RecipeContext,
  wheel: WheelPart,
  startX: number,
  minLength: number,
  unit: string,
  clearFront: number,
  clearRear: number,
  split: number | null = null,
): Wagon | null {
  const car = carBody(context.model, context.pools, context.random, 0, minLength, unit, startX);
  if (!car) return null;
  const low = car.x0 + clearRear * STUD_LDU;
  const high = car.x1 - clearFront * STUD_LDU;
  const middle = split ?? (low + high) / 2;
  if (middle <= low || middle >= high) return null;
  const hung = axles(
    context,
    car,
    car.bottom,
    [
      [low, middle],
      [middle, high],
    ],
    unit,
    [],
    wheel,
  );
  return hung ? { car, axles: hung } : null;
}

function lowestWheel(wagons: ReadonlyArray<Wagon>): number {
  return Math.min(...wagons.flatMap((each) => each.axles.map((axle) => axle.line.y - axle.radius)));
}

function plates(lengthLdu: number): number {
  return lengthLdu / PLATE_LDU - 1;
}

function within(box: Box, x0: number, x1: number): boolean {
  return box.min[0] >= x0 && box.max[0] <= x1;
}

function linkOptions(context: RecipeContext, minimumHoles: number): ReadonlyArray<PivotOption> {
  return pivotOptions(context.pools).filter((option) => option.holes.length >= minimumHoles);
}

function independentCar(context: RecipeContext, startX: number): TrainPlan | null {
  const wheel = wheelFor(context);
  if (!wheel) return null;
  const car = wagon(context, wheel, startX, 8, "independent car", 0, 0);
  return car
    ? single(
        car.axles.map((axle) => axle.line),
        { body: ["independent car"], bogies: [], front: "plain", rear: "plain" },
      )
    : null;
}

export const stackedDrawbars: Recipe = (context) => {
  const { model, pools, random } = context;
  const wheel = wheelFor(context);
  if (!wheel) return null;
  const a = wagon(context, wheel, -12 * STUD_LDU, 8, "car A", FACING_CLEAR_STUDS, 0);
  if (!a) return null;
  const gap = 2 + random.int(2);
  const b = wagon(context, wheel, a.car.x1 + gap * STUD_LDU, 8, "car B", 0, FACING_CLEAR_STUDS);
  if (!b) return null;
  const length = pick(
    random,
    linkLengths(pools).filter((each) => plates(each) >= 3 && -each > lowestWheel([a, b])),
  );
  if (length === null) return null;
  const upperPlates = 1 + random.int(plates(length) - 2);
  const lowerPlates = plates(length) - 1 - upperPlates;
  const pivot = [a.car.x1 + STUD_LDU * (1 + random.int(gap - 1)), 0] as const;
  const options = linkOptions(context, 1);
  const upper = stackWithHoleAt(
    model,
    pools,
    random,
    options,
    pivot,
    0,
    upperPlates,
    b.car.x0,
    b.car.z0,
    (box) => box.min[0] >= a.car.x1 && box.max[0] >= b.car.x0 + STUD_LDU && box.max[0] <= b.car.x1,
    "car B",
    b.car.index,
  );
  if (!upper) return null;
  const lowerTop = -(upperPlates + 1) * PLATE_LDU;
  const lower = stackWithHoleAt(
    model,
    pools,
    random,
    options,
    pivot,
    lowerTop,
    lowerPlates,
    a.car.x0,
    a.car.z0,
    (box) => box.min[0] <= a.car.x1 - STUD_LDU && box.min[0] >= a.car.x0 && box.max[0] <= b.car.x0,
    "car A",
    null,
  );
  if (!lower) return null;
  const under = (a.car.x1 - lower.box.min[0]) / STUD_LDU;
  const across = (lower.box.max[2] - lower.box.min[2]) / STUD_LDU;
  const spacers = spacerStack(pools, under, across, upperPlates + 1);
  if (!spacers) return null;
  let top = 0;
  for (const spacer of spacers) {
    placeBlock(
      model,
      pools,
      spacer.block,
      spacer.turns,
      [lower.box.min[0], lower.box.min[2]],
      top,
      pickColor(random, pools),
      "car A",
    );
    top -= spacer.block.heightPlates * PLATE_LDU;
  }
  const link = verticalLink(
    model,
    pools,
    random,
    pivot,
    -length,
    0,
    [...upper.indices, ...lower.indices],
    `drawbar${PIVOT_PART_SUFFIX}`,
  );
  if (link === null || model.collidesSince(0)) return null;
  return {
    lines: [...a.axles, ...b.axles].map((axle) => axle.line),
    vehicles: [
      { body: ["car A"], bogies: [], front: "unasserted", rear: "plain" },
      { body: ["car B"], bogies: [], front: "plain", rear: "unasserted" },
    ],
    attachments: [],
    couplings: [{ vehicles: [0, 1], via: [], pivots: [pivot] }],
    unresolved: [],
  };
};

export const separateDrawbar: Recipe = (context) => {
  const { model, pools, random } = context;
  const wheel = wheelFor(context);
  if (!wheel) return null;
  const a = wagon(context, wheel, -16 * STUD_LDU, 8, "car A", FACING_CLEAR_STUDS, 0);
  if (!a) return null;
  const gap = 2 + random.int(3);
  const b = wagon(context, wheel, a.car.x1 + gap * STUD_LDU, 8, "car B", 0, FACING_CLEAR_STUDS);
  if (!b) return null;
  const pivotA = [a.car.x1 - STUD_LDU, 0] as const;
  const pivotB = [b.car.x0 + STUD_LDU, 0] as const;
  const length = pick(
    random,
    linkLengths(pools).filter(
      (each) => plates(each) >= 3 && -(each + PLATE_LDU) > lowestWheel([a, b]),
    ),
  );
  if (length === null) return null;
  const drawbarPlates = 1 + random.int(plates(length) - 2);
  const bodyPlates = plates(length) - 1 - drawbarPlates;
  const options = linkOptions(context, 1);
  const stackA = stackWithHoleAt(
    model,
    pools,
    random,
    options,
    pivotA,
    0,
    bodyPlates,
    a.car.x0,
    a.car.z0,
    (box) => within(box, a.car.x0, a.car.x1),
    "car A",
    a.car.index,
  );
  const stackB = stackA
    ? stackWithHoleAt(
        model,
        pools,
        random,
        options,
        pivotB,
        0,
        bodyPlates,
        b.car.x0,
        b.car.z0,
        (box) => within(box, b.car.x0, b.car.x1),
        "car B",
        b.car.index,
      )
    : null;
  if (!stackA || !stackB) return null;
  const drawbarTop = -(bodyPlates + 1) * PLATE_LDU;
  const endA = stackWithHoleAt(
    model,
    pools,
    random,
    options,
    pivotA,
    drawbarTop,
    drawbarPlates,
    a.car.x0,
    a.car.z0,
    () => true,
    "drawbar",
    null,
  );
  const endB = endA
    ? stackWithHoleAt(
        model,
        pools,
        random,
        options,
        pivotB,
        drawbarTop,
        drawbarPlates,
        a.car.x0,
        a.car.z0,
        () => true,
        "drawbar",
        null,
      )
    : null;
  if (!endA || !endB) return null;
  const spanStuds = (endB.box.max[0] - endA.box.min[0]) / STUD_LDU;
  const acrossStuds =
    Math.max(endA.box.max[2] - endA.box.min[2], endB.box.max[2] - endB.box.min[2]) / STUD_LDU;
  const deck = pick(
    random,
    pools.plates.flatMap((plate) =>
      [0, 1].flatMap((turns) => {
        const [x, z] = footprint(plate, turns);
        return x >= spanStuds && x <= spanStuds + 2 && z >= acrossStuds && z <= acrossStuds + 2
          ? [{ plate, turns }]
          : [];
      }),
    ),
  );
  if (!deck) return null;
  placeBlock(
    model,
    pools,
    deck.plate,
    deck.turns,
    [endA.box.min[0], Math.min(endA.box.min[2], endB.box.min[2])],
    -length,
    pickColor(random, pools),
    "drawbar",
  );
  const links = [
    verticalLink(
      model,
      pools,
      random,
      pivotA,
      -length,
      0,
      [...stackA.indices, ...endA.indices],
      `drawbar front${PIVOT_PART_SUFFIX}`,
    ),
    verticalLink(
      model,
      pools,
      random,
      pivotB,
      -length,
      0,
      [...stackB.indices, ...endB.indices],
      `drawbar rear${PIVOT_PART_SUFFIX}`,
    ),
  ];
  if (links.some((link) => link === null) || model.collidesSince(0)) return null;
  return {
    lines: [...a.axles, ...b.axles].map((axle) => axle.line),
    vehicles: [
      { body: ["car A"], bogies: [], front: "unasserted", rear: "plain" },
      { body: ["car B"], bogies: [], front: "plain", rear: "unasserted" },
    ],
    attachments: [],
    couplings: [{ vehicles: [0, 1], via: ["drawbar"], pivots: [pivotA, pivotB] }],
    unresolved: [],
  };
};

function holePairs(
  options: ReadonlyArray<PivotOption>,
  accept: (spread: number, option: PivotOption, first: readonly [number, number]) => boolean,
): ReadonlyArray<{
  readonly option: PivotOption;
  readonly first: readonly [number, number];
  readonly spread: number;
}> {
  return options.flatMap((option) =>
    option.holes.flatMap((first) =>
      option.holes.flatMap((second) => {
        const spread = second[0] - first[0];
        return second[1] === first[1] && spread > 0 && accept(spread, option, first)
          ? [{ option, first, spread }]
          : [];
      }),
    ),
  );
}

export const jacobsTwoAxis: Recipe = (context) => {
  const { model, pools, random } = context;
  const wheel = wheelFor(context);
  if (!wheel) return null;
  const room = 2 * STUD_LDU;
  const pair = pick(
    random,
    holePairs(linkOptions(context, 2), (spread, option, first) => {
      const length = option.box.max[0] - option.box.min[0];
      return spread === 2 * STUD_LDU && first[0] >= room && length - first[0] - spread >= room;
    }),
  );
  if (!pair) return null;
  const clearance = Math.ceil(
    (pair.option.box.max[0] - pair.option.box.min[0] + 2 * wheel.radius) / STUD_LDU,
  );
  const a = wagon(context, wheel, -24 * STUD_LDU, clearance + 10, "car A", clearance, 0);
  if (!a) return null;
  const pivotA = [a.car.x1 - STUD_LDU, 0] as const;
  const pivotB = [pivotA[0] + pair.spread, 0] as const;
  const b = wagon(context, wheel, a.car.x1, clearance + 10, "car B", 0, clearance);
  if (!b) return null;
  const length = pick(
    random,
    linkLengths(pools).filter((each) => plates(each) >= 3),
  );
  if (length === null) return null;
  const bogiePlates = 1 + random.int(plates(length) - 2);
  const bodyPlates = plates(length) - 1 - bogiePlates;
  const options = linkOptions(context, 1);
  const stackA = stackWithHoleAt(
    model,
    pools,
    random,
    options,
    pivotA,
    0,
    bodyPlates,
    a.car.x0,
    a.car.z0,
    (box) => within(box, a.car.x0, a.car.x1),
    "car A",
    a.car.index,
  );
  const stackB = stackA
    ? stackWithHoleAt(
        model,
        pools,
        random,
        options,
        pivotB,
        0,
        bodyPlates,
        b.car.x0,
        b.car.z0,
        (box) => within(box, b.car.x0, b.car.x1),
        "car B",
        b.car.index,
      )
    : null;
  if (!stackA || !stackB) return null;
  const bogieTop = -(bodyPlates + 1) * PLATE_LDU;
  const truck = stackWithHoleAt(
    model,
    pools,
    random,
    [pair.option],
    pivotA,
    bogieTop,
    bogiePlates,
    pivotA[0] - pair.first[0],
    -pair.first[1],
    (box) => Math.abs(box.min[0] + pair.first[0] - pivotA[0]) < 1e-6,
    "shared bogie",
    null,
  );
  const truckIndex = truck?.indices.at(-1);
  if (!truck || truckIndex === undefined) return null;
  const carrier: Carrier = {
    index: truckIndex,
    unit: "shared bogie",
    bottom: -length,
    top: bogieTop,
    x0: truck.box.min[0],
    z0: truck.box.min[2],
    x1: truck.box.max[0],
    z1: truck.box.max[2],
  };
  const truckAxles = axles(
    context,
    carrier,
    0,
    [
      [-WIDE, pivotA[0]],
      [pivotB[0], WIDE],
    ],
    "shared bogie",
    [],
    wheel,
  );
  const links = [
    verticalLink(
      model,
      pools,
      random,
      pivotA,
      -length,
      0,
      [...stackA.indices, ...truck.indices],
      `shared bogie front${PIVOT_PART_SUFFIX}`,
    ),
    verticalLink(
      model,
      pools,
      random,
      pivotB,
      -length,
      0,
      [...stackB.indices, ...truck.indices],
      `shared bogie rear${PIVOT_PART_SUFFIX}`,
    ),
  ];
  if (!truckAxles || links.some((link) => link === null) || model.collidesSince(0)) return null;
  const other = independentCar(context, b.car.x1 + FAR_CAR_GAP_STUDS * STUD_LDU);
  if (!other) return null;
  return {
    lines: [...a.axles, ...b.axles, ...truckAxles].map((axle) => axle.line).concat(other.lines),
    vehicles: other.vehicles,
    attachments: [],
    couplings: [],
    unresolved: [
      {
        units: ["car A", "car B", "shared bogie"],
        reason: "a link between bodies with a pivot inside a body's support span",
      },
    ],
  };
};

export const spanBolster: Recipe = (context) => {
  const { model, pools, random } = context;
  const wheel = wheelFor(context);
  if (!wheel) return null;
  const a = wagon(context, wheel, -24 * STUD_LDU, 10, "car A", 0, 0);
  if (!a) return null;
  const frontA = Math.max(...a.axles.map((axle) => axle.line.x));
  const rearA = Math.min(...a.axles.map((axle) => axle.line.x));
  const pivotA = [frontA - STUD_LDU, 0] as const;
  if (pivotA[0] <= rearA) return null;
  const startB = a.car.x1 + STUD_LDU;
  const reachB = 4 + random.int(4);
  const pivotB = [startB + reachB * STUD_LDU, 0] as const;
  const b = wagon(context, wheel, startB, reachB + 6, "car B", 0, 0, pivotB[0]);
  if (!b || a.car.top !== b.car.top) return null;
  const length = pick(
    random,
    linkLengths(pools).filter((each) => plates(each) >= 3),
  );
  if (length === null) return null;
  const beamPlates = 1 + random.int(plates(length) - 2);
  const roofPlates = plates(length) - 1 - beamPlates;
  const roof = a.car.top;
  const options = linkOptions(context, 1);
  const roofA = stackWithHoleAt(
    model,
    pools,
    random,
    options,
    pivotA,
    roof + roofPlates * PLATE_LDU,
    roofPlates,
    a.car.x0,
    a.car.z0,
    (box) => within(box, a.car.x0, a.car.x1),
    "car A",
    a.car.index,
  );
  const roofB = roofA
    ? stackWithHoleAt(
        model,
        pools,
        random,
        options,
        pivotB,
        roof + roofPlates * PLATE_LDU,
        roofPlates,
        b.car.x0,
        b.car.z0,
        (box) => within(box, b.car.x0, b.car.x1),
        "car B",
        b.car.index,
      )
    : null;
  if (!roofA || !roofB) return null;
  const beamTop = roof + length;
  const endA = stackWithHoleAt(
    model,
    pools,
    random,
    options,
    pivotA,
    beamTop,
    beamPlates,
    a.car.x0,
    a.car.z0,
    () => true,
    "bolster",
    null,
  );
  const endB = endA
    ? stackWithHoleAt(
        model,
        pools,
        random,
        options,
        pivotB,
        beamTop,
        beamPlates,
        a.car.x0,
        a.car.z0,
        () => true,
        "bolster",
        null,
      )
    : null;
  if (!endA || !endB) return null;
  const spanStuds = (endB.box.max[0] - endA.box.min[0]) / STUD_LDU;
  const acrossStuds =
    Math.max(endA.box.max[2] - endA.box.min[2], endB.box.max[2] - endB.box.min[2]) / STUD_LDU;
  const deck = pick(
    random,
    pools.plates.flatMap((plate) =>
      [0, 1].flatMap((turns) => {
        const [x, z] = footprint(plate, turns);
        return x >= spanStuds && x <= spanStuds + 2 && z >= acrossStuds && z <= acrossStuds + 2
          ? [{ plate, turns }]
          : [];
      }),
    ),
  );
  if (!deck) return null;
  placeBlockOn(
    model,
    pools,
    deck.plate,
    deck.turns,
    [endA.box.min[0], Math.min(endA.box.min[2], endB.box.min[2])],
    beamTop,
    pickColor(random, pools),
    "bolster",
  );
  const links = [
    verticalLink(
      model,
      pools,
      random,
      pivotA,
      roof,
      beamTop,
      [...roofA.indices, ...endA.indices],
      `bolster front${PIVOT_PART_SUFFIX}`,
    ),
    verticalLink(
      model,
      pools,
      random,
      pivotB,
      roof,
      beamTop,
      [...roofB.indices, ...endB.indices],
      `bolster rear${PIVOT_PART_SUFFIX}`,
    ),
  ];
  if (links.some((link) => link === null) || model.collidesSince(0)) return null;
  const other = independentCar(context, b.car.x1 + FAR_CAR_GAP_STUDS * STUD_LDU);
  if (!other) return null;
  return {
    lines: [...a.axles, ...b.axles].map((axle) => axle.line).concat(other.lines),
    vehicles: other.vehicles,
    attachments: [],
    couplings: [],
    unresolved: [
      {
        units: ["car A", "car B", "bolster"],
        reason: "a link between bodies with a pivot inside a body's support span",
      },
    ],
  };
};

export const pivotOutsideWheelbase: Recipe = (context) => {
  const wheel = wheelFor(context);
  const car = carBody(context.model, context.pools, context.random, 0, 24, "car");
  if (!wheel || !car) return null;
  const middle = (car.x0 + car.x1) / 2;
  const fixed = axles(
    context,
    car,
    car.bottom,
    [
      [middle, (middle + car.x1) / 2],
      [(middle + car.x1) / 2, car.x1],
    ],
    "car",
    [],
    wheel,
  );
  if (!fixed) return null;
  const rearAxle = Math.min(...fixed.map((axle) => axle.occupied[0]));
  const truck = bogieWithAxles(
    context,
    car,
    [car.x0 + 4 * STUD_LDU, Math.min(middle, rearAxle)],
    2,
    "car",
    "trailing truck",
    "pivot",
    wheel,
    "behind",
  );
  if (!truck) return null;
  return {
    lines: [...fixed, ...truck.axles].map((axle) => axle.line),
    vehicles: [
      { body: ["car"], bogies: [], front: "plain", rear: "unasserted" },
      { body: ["trailing truck"], bogies: [], front: "unasserted", rear: "unasserted" },
    ],
    attachments: [],
    couplings: [{ vehicles: [0, 1], via: [], pivots: truck.hung.pivots }],
    unresolved: [],
  };
};

export const LINK_RECIPES: ReadonlyArray<readonly [string, Recipe]> = [
  ["stacked drawbars", stackedDrawbars],
  ["separate drawbar piece", separateDrawbar],
  ["two-axis shared bogie", jacobsTwoAxis],
  ["span bolster", spanBolster],
  ["truck pivoted outside its wheelbase", pivotOutsideWheelbase],
];
