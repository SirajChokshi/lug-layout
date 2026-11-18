import type { HungAxle } from "./axles.ts";
import { carBody } from "./car-bodies.ts";
import type { Box } from "./part-readings.ts";
import {
  type PivotOption,
  type PlacedStack,
  linkLengths,
  linkPlateCount,
  pivotOptions,
  stackWithHoleAt,
  verticalLink,
} from "./pivot-stacks.ts";
import {
  type Carrier,
  PIVOT_PART_SUFFIX,
  footprint,
  pickColor,
  placeBlock,
  placeBlockOn,
  spacerStack,
} from "./placement.ts";
import type { TrainPlan } from "./train-plan.ts";
import type { WheelPart } from "./train-pools.ts";
import {
  type Recipe,
  type RecipeContext,
  WIDE,
  axles,
  bogieWithAxles,
  single,
  wheelFor,
} from "./train-recipes.ts";
import { PLATE_LDU, STUD_LDU } from "@brr/math";

const FACING_CLEAR_STUDS = 4;
const FAR_CAR_GAP_STUDS = 10;
const LINK_INSIDE_SUPPORT_SPAN = "a link between bodies with a pivot inside a body's support span";

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

export function lowestWheel(wagons: ReadonlyArray<Wagon>): number {
  return Math.min(
    ...wagons.flatMap((each) => each.axles.map((axle) => axle.wheelset.y - axle.radius)),
  );
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
        car.axles.map((axle) => axle.wheelset),
        { body: ["independent car"], bogies: [], front: "plain", rear: "plain" },
      )
    : null;
}

type Pivot = readonly [number, number];

function carStack(
  context: RecipeContext,
  car: Carrier,
  pivot: Pivot,
  top: number,
  plates: number,
  unit: string,
): PlacedStack | null {
  return stackWithHoleAt(
    context.model,
    context.pools,
    context.random,
    linkOptions(context, 1),
    pivot,
    top,
    plates,
    car.x0,
    car.z0,
    (box) => within(box, car.x0, car.x1),
    unit,
    car.index,
  );
}

function deckedEnds(
  context: RecipeContext,
  pivots: readonly [Pivot, Pivot],
  top: number,
  plates: number,
  lattice: Carrier,
  deck: "above" | "below",
  unit: string,
): readonly [PlacedStack, PlacedStack] | null {
  const { model, pools, random } = context;
  const options = linkOptions(context, 1);
  const place = (pivot: Pivot): PlacedStack | null =>
    stackWithHoleAt(
      model,
      pools,
      random,
      options,
      pivot,
      top,
      plates,
      lattice.x0,
      lattice.z0,
      () => true,
      unit,
      null,
    );
  const first = place(pivots[0]);
  const second = first ? place(pivots[1]) : null;
  if (!first || !second) return null;
  const spanStuds = (second.box.max[0] - first.box.min[0]) / STUD_LDU;
  const acrossStuds =
    Math.max(first.box.max[2] - first.box.min[2], second.box.max[2] - second.box.min[2]) / STUD_LDU;
  const plate = random.choice(
    pools.plates.flatMap((candidate) =>
      [0, 1].flatMap((turns) => {
        const [x, z] = footprint(candidate, turns);
        return x >= spanStuds && x <= spanStuds + 2 && z >= acrossStuds && z <= acrossStuds + 2
          ? [{ candidate, turns }]
          : [];
      }),
    ),
  );
  if (!plate) return null;
  const corner = [first.box.min[0], Math.min(first.box.min[2], second.box.min[2])] as const;
  const color = pickColor(random, pools);
  if (deck === "below") {
    placeBlock(
      model,
      pools,
      plate.candidate,
      plate.turns,
      corner,
      top - plates * PLATE_LDU,
      color,
      unit,
    );
  } else {
    placeBlockOn(model, pools, plate.candidate, plate.turns, corner, top, color, unit);
  }
  return [first, second];
}

function pinBoth(
  context: RecipeContext,
  pivots: readonly [Pivot, Pivot],
  bottom: number,
  top: number,
  members: readonly [ReadonlyArray<number>, ReadonlyArray<number>],
  unit: string,
): boolean {
  return pivots.every(
    (pivot, k) =>
      verticalLink(
        context.model,
        context.pools,
        context.random,
        pivot,
        bottom,
        top,
        members[k] ?? [],
        `${unit} ${k === 0 ? "front" : "rear"}${PIVOT_PART_SUFFIX}`,
      ) !== null,
  );
}

function stackedDrawbars(sharedBogie: boolean): Recipe {
  return (context) => {
    const { model, pools, random } = context;
    const wheel = wheelFor(context);
    if (!wheel) return null;
    const clear = sharedBogie
      ? Math.ceil((2 * wheel.radius) / STUD_LDU) + FACING_CLEAR_STUDS
      : FACING_CLEAR_STUDS;
    const a = wagon(context, wheel, -12 * STUD_LDU, clear + 8, "car A", clear, 0);
    if (!a) return null;
    const gap = 2 + random.int(2);
    const b = wagon(context, wheel, a.car.x1 + gap * STUD_LDU, clear + 8, "car B", 0, clear);
    if (!b) return null;
    const stacks = sharedBogie ? 3 : 2;
    const linkPlatesOf = (each: number): number => linkPlateCount(each) - (stacks - 2);
    const length = random.choice(
      linkLengths(pools).filter(
        (each) => linkPlatesOf(each) >= stacks && (sharedBogie || -each > lowestWheel([a, b])),
      ),
    );
    if (length === null) return null;
    const linkPlates = linkPlatesOf(length);
    const lowerPlates = 1;
    const upperPlates = sharedBogie ? 1 + random.int(linkPlates - 2) : linkPlates - lowerPlates;
    const bogiePlates = linkPlates - upperPlates - lowerPlates;
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
      (box) =>
        box.min[0] >= a.car.x1 && box.max[0] >= b.car.x0 + STUD_LDU && box.max[0] <= b.car.x1,
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
      (box) =>
        box.min[0] <= a.car.x1 - STUD_LDU && box.min[0] >= a.car.x0 && box.max[0] <= b.car.x0,
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
    const bogie = sharedBogie
      ? sharedBogieUnder(
          context,
          wheel,
          pivot,
          lowerTop - (lowerPlates + 1) * PLATE_LDU,
          bogiePlates,
        )
      : null;
    if (sharedBogie && !bogie) return null;
    const link = verticalLink(
      model,
      pools,
      random,
      pivot,
      -length,
      0,
      [...upper.indices, ...lower.indices, ...(bogie?.stack.indices ?? [])],
      `drawbar${PIVOT_PART_SUFFIX}`,
    );
    if (link === null || model.collidesSince(0)) return null;
    const wheelsets = [...a.axles, ...b.axles, ...(bogie?.axles ?? [])].map(
      (axle) => axle.wheelset,
    );
    if (!bogie) {
      return {
        wheelsets,
        vehicles: [
          { body: ["car A"], bogies: [], front: "unasserted", rear: "plain" },
          { body: ["car B"], bogies: [], front: "plain", rear: "unasserted" },
        ],
        attachments: [],
        couplingsInModel: [{ vehicles: [0, 1], via: [], pivots: [pivot] }],
        unresolvedRunningGear: [],
      };
    }
    const other = independentCar(context, b.car.x1 + FAR_CAR_GAP_STUDS * STUD_LDU);
    if (!other) return null;
    return {
      wheelsets: wheelsets.concat(other.wheelsets),
      vehicles: other.vehicles,
      attachments: [],
      couplingsInModel: [],
      unresolvedRunningGear: [
        {
          units: ["car A", "car B", "shared bogie"],
          reason: "a bogie carrying more than one body on one axis line",
        },
      ],
    };
  };
}

function sharedBogieUnder(
  context: RecipeContext,
  wheel: WheelPart,
  pivot: Pivot,
  top: number,
  plates: number,
): { readonly stack: PlacedStack; readonly axles: ReadonlyArray<HungAxle> } | null {
  const stack = stackWithHoleAt(
    context.model,
    context.pools,
    context.random,
    linkOptions(context, 1).filter(
      (option) => option.box.max[0] - option.box.min[0] >= 4 * wheel.radius + STUD_LDU,
    ),
    pivot,
    top,
    plates,
    pivot[0],
    pivot[1],
    () => true,
    "shared bogie",
    null,
  );
  const index = stack?.indices.at(-1);
  if (!stack || index === undefined) return null;
  const carrier: Carrier = {
    index,
    unit: "shared bogie",
    bottom: top - plates * PLATE_LDU,
    top,
    x0: stack.box.min[0],
    z0: stack.box.min[2],
    x1: stack.box.max[0],
    z1: stack.box.max[2],
  };
  const hung = axles(
    context,
    carrier,
    0,
    [
      [-WIDE, pivot[0]],
      [pivot[0], WIDE],
    ],
    "shared bogie",
    [],
    wheel,
  );
  return hung ? { stack, axles: hung } : null;
}

const separateDrawbar: Recipe = (context) => {
  const { model, pools, random } = context;
  const wheel = wheelFor(context);
  if (!wheel) return null;
  const a = wagon(context, wheel, -16 * STUD_LDU, 8, "car A", FACING_CLEAR_STUDS, 0);
  if (!a) return null;
  const gap = 2 + random.int(3);
  const b = wagon(context, wheel, a.car.x1 + gap * STUD_LDU, 8, "car B", 0, FACING_CLEAR_STUDS);
  if (!b) return null;
  const pivots = [
    [a.car.x1 - STUD_LDU, 0],
    [b.car.x0 + STUD_LDU, 0],
  ] as const;
  const length = random.choice(
    linkLengths(pools).filter(
      (each) => linkPlateCount(each) >= 2 && -(each + PLATE_LDU) > lowestWheel([a, b]),
    ),
  );
  if (length === null) return null;
  const drawbarPlates = 1 + random.int(linkPlateCount(length) - 1);
  const bodyPlates = linkPlateCount(length) - drawbarPlates;
  const stackA = carStack(context, a.car, pivots[0], 0, bodyPlates, "car A");
  const stackB = stackA ? carStack(context, b.car, pivots[1], 0, bodyPlates, "car B") : null;
  if (!stackA || !stackB) return null;
  const ends = deckedEnds(
    context,
    pivots,
    -(bodyPlates + 1) * PLATE_LDU,
    drawbarPlates,
    a.car,
    "below",
    "drawbar",
  );
  if (!ends) return null;
  const members = [
    [...stackA.indices, ...ends[0].indices],
    [...stackB.indices, ...ends[1].indices],
  ] as const;
  if (!pinBoth(context, pivots, -length, 0, members, "drawbar") || model.collidesSince(0))
    return null;
  return {
    wheelsets: [...a.axles, ...b.axles].map((axle) => axle.wheelset),
    vehicles: [
      { body: ["car A"], bogies: [], front: "unasserted", rear: "plain" },
      { body: ["car B"], bogies: [], front: "plain", rear: "unasserted" },
    ],
    attachments: [],
    couplingsInModel: [{ vehicles: [0, 1], via: ["drawbar"], pivots }],
    unresolvedRunningGear: [],
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

const jacobsTwoAxis: Recipe = (context) => {
  const { model, pools, random } = context;
  const wheel = wheelFor(context);
  if (!wheel) return null;
  const room = 2 * STUD_LDU;
  const pair = random.choice(
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
  const pivots = [
    [a.car.x1 - STUD_LDU, 0],
    [a.car.x1 - STUD_LDU + pair.spread, 0],
  ] as const;
  const b = wagon(context, wheel, a.car.x1, clearance + 10, "car B", 0, clearance);
  if (!b) return null;
  const length = random.choice(linkLengths(pools).filter((each) => linkPlateCount(each) >= 2));
  if (length === null) return null;
  const bogiePlates = 1 + random.int(linkPlateCount(length) - 1);
  const bodyPlates = linkPlateCount(length) - bogiePlates;
  const stackA = carStack(context, a.car, pivots[0], 0, bodyPlates, "car A");
  const stackB = stackA ? carStack(context, b.car, pivots[1], 0, bodyPlates, "car B") : null;
  if (!stackA || !stackB) return null;
  const bogieTop = -(bodyPlates + 1) * PLATE_LDU;
  const truck = stackWithHoleAt(
    model,
    pools,
    random,
    [pair.option],
    pivots[0],
    bogieTop,
    bogiePlates,
    pivots[0][0] - pair.first[0],
    -pair.first[1],
    (box) => Math.abs(box.min[0] + pair.first[0] - pivots[0][0]) < 1e-6,
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
      [-WIDE, pivots[0][0]],
      [pivots[1][0], WIDE],
    ],
    "shared bogie",
    [],
    wheel,
  );
  const members = [
    [...stackA.indices, ...truck.indices],
    [...stackB.indices, ...truck.indices],
  ] as const;
  if (!truckAxles || !pinBoth(context, pivots, -length, 0, members, "shared bogie")) return null;
  if (model.collidesSince(0)) return null;
  const other = independentCar(context, b.car.x1 + FAR_CAR_GAP_STUDS * STUD_LDU);
  if (!other) return null;
  return {
    wheelsets: [...a.axles, ...b.axles, ...truckAxles]
      .map((axle) => axle.wheelset)
      .concat(other.wheelsets),
    vehicles: other.vehicles,
    attachments: [],
    couplingsInModel: [],
    unresolvedRunningGear: [
      { units: ["car A", "car B", "shared bogie"], reason: LINK_INSIDE_SUPPORT_SPAN },
    ],
  };
};

const spanBolster: Recipe = (context) => {
  const { model, pools, random } = context;
  const wheel = wheelFor(context);
  if (!wheel) return null;
  const a = wagon(context, wheel, -24 * STUD_LDU, 10, "car A", 0, 0);
  if (!a) return null;
  const frontA = Math.max(...a.axles.map((axle) => axle.wheelset.x));
  const rearA = Math.min(...a.axles.map((axle) => axle.wheelset.x));
  const startB = a.car.x1 + STUD_LDU;
  const reachB = 4 + random.int(4);
  const pivots = [
    [frontA - STUD_LDU, 0],
    [startB + reachB * STUD_LDU, 0],
  ] as const;
  if (pivots[0][0] <= rearA) return null;
  const b = wagon(context, wheel, startB, reachB + 6, "car B", 0, 0, pivots[1][0]);
  if (!b || a.car.top !== b.car.top) return null;
  const length = random.choice(linkLengths(pools).filter((each) => linkPlateCount(each) >= 2));
  if (length === null) return null;
  const beamPlates = 1 + random.int(linkPlateCount(length) - 1);
  const roofPlates = linkPlateCount(length) - beamPlates;
  const roof = a.car.top;
  const roofA = carStack(
    context,
    a.car,
    pivots[0],
    roof + roofPlates * PLATE_LDU,
    roofPlates,
    "car A",
  );
  const roofB = roofA
    ? carStack(context, b.car, pivots[1], roof + roofPlates * PLATE_LDU, roofPlates, "car B")
    : null;
  if (!roofA || !roofB) return null;
  const beamTop = roof + length;
  const ends = deckedEnds(context, pivots, beamTop, beamPlates, a.car, "above", "bolster");
  if (!ends) return null;
  const members = [
    [...roofA.indices, ...ends[0].indices],
    [...roofB.indices, ...ends[1].indices],
  ] as const;
  if (!pinBoth(context, pivots, roof, beamTop, members, "bolster") || model.collidesSince(0))
    return null;
  const other = independentCar(context, b.car.x1 + FAR_CAR_GAP_STUDS * STUD_LDU);
  if (!other) return null;
  return {
    wheelsets: [...a.axles, ...b.axles].map((axle) => axle.wheelset).concat(other.wheelsets),
    vehicles: other.vehicles,
    attachments: [],
    couplingsInModel: [],
    unresolvedRunningGear: [
      { units: ["car A", "car B", "bolster"], reason: LINK_INSIDE_SUPPORT_SPAN },
    ],
  };
};

const pivotOutsideWheelbase: Recipe = (context) => {
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
    wheelsets: [...fixed, ...truck.axles].map((axle) => axle.wheelset),
    vehicles: [
      { body: ["car"], bogies: [], front: "plain", rear: "unasserted" },
      { body: ["trailing truck"], bogies: [], front: "unasserted", rear: "unasserted" },
    ],
    attachments: [],
    couplingsInModel: [{ vehicles: [0, 1], via: [], pivots: truck.hung.pivots }],
    unresolvedRunningGear: [],
  };
};

export const LINK_RECIPES: ReadonlyArray<readonly [string, Recipe]> = [
  ["stacked drawbars", stackedDrawbars(false)],
  ["one-axis shared bogie", stackedDrawbars(true)],
  ["separate drawbar piece", separateDrawbar],
  ["two-axis shared bogie", jacobsTwoAxis],
  ["span bolster", spanBolster],
  ["truck pivoted outside its wheelbase", pivotOutsideWheelbase],
];
