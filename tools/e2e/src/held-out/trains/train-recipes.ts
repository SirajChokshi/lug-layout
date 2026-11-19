import { type AxleMode, type HungAxle, hangAxle, hangSplitAxle, positiveSeats } from "./axles.ts";
import { type HungBogie, hangBogie } from "./bogies.ts";
import { carBody } from "./car-bodies.ts";
import { type EndVariant, buildEnd } from "./end-features.ts";
import { hangHinge } from "./hinges.ts";
import { VERTICAL } from "./part-geometry.ts";
import { pivotOptions, pivotPartAxles, stackAt, verticalLink } from "./pivot-stacks.ts";
import {
  type Carrier,
  PIVOT_PART_SUFFIX,
  type RailHeadBands,
  onLattice,
  pickColor,
  placeAlong,
  pointOnLine,
} from "./placement.ts";
import { mountPinBogie, mountRunningGear } from "./running-gear-mounts.ts";
import type { TrainModel } from "./train-model.ts";
import type { EndPlan, PlannedWheelset, TrainPlan, VehiclePlan } from "./train-plan.ts";
import type { TrainPools, WheelPart } from "./train-pools.ts";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import type { SeededRandom } from "../generator.ts";

export interface RecipeContext {
  readonly model: TrainModel;
  readonly pools: TrainPools;
  readonly random: SeededRandom;
  readonly rails: ReadonlyArray<RailHeadBands>;
  readonly rail: RailHeadBands;
  readonly seats: Map<string, number>;
}

export type Recipe = (context: RecipeContext) => TrainPlan | null;

const END_VARIANTS: ReadonlyArray<EndVariant | "plain"> = [
  "plain",
  "pin",
  "pin and buffer",
  "pin and outer pin",
  "off-axis pin",
];
export const WIDE = 1e9;
const TURNTABLE_TRIES = 6;

export function wheelFor(context: RecipeContext): WheelPart | null {
  for (const wheel of context.random.shuffled(context.pools.wheels)) {
    const key = `${wheel.reading.reference} ${context.rail.part}`;
    let seats = context.seats.get(key);
    if (seats === undefined) {
      seats = positiveSeats(wheel, context.rail).length;
      context.seats.set(key, seats);
    }
    if (seats > 0) return wheel;
  }
  return null;
}

export function axles(
  context: RecipeContext,
  carrier: Carrier,
  bodyBottom: number,
  ranges: ReadonlyArray<readonly [number, number]>,
  unit: string,
  modes: ReadonlyArray<AxleMode>,
  wheel: WheelPart,
): ReadonlyArray<HungAxle> | null {
  const out: HungAxle[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    const mode = modes[i] ?? "positive";
    if (!range) return null;
    const hung = hangAxle(context.model, context.pools, context.random, {
      carrier,
      bodyBottom,
      xRange: range,
      wheel,
      rail: context.rail,
      rails: context.rails,
      mode,
      sides: mode === "one head band" ? [1] : [1, -1],
      lateralRange: [carrier.z0, carrier.z1],
      unit,
    });
    if (!hung) return null;
    out.push(hung);
  }
  return out;
}

export function bogieWithAxles(
  context: RecipeContext,
  carrier: Carrier,
  pivotRange: readonly [number, number],
  count: 1 | 2,
  unitBody: string,
  unitBogie: string,
  join: "pivot" | "rigid" | "two pivots",
  wheel: WheelPart,
  axleSide: "around" | "behind" = "around",
  cap = false,
  pivotZ = 0,
  roomFor: 1 | 2 = count,
  extraStuds = 0,
): { readonly hung: HungBogie; readonly axles: ReadonlyArray<HungAxle> } | null {
  const lengthStuds =
    (roomFor === 2 ? Math.ceil((4 * wheel.radius) / STUD_LDU) + 1 : 2) + extraStuds;
  const hung = hangBogie(context.model, context.pools, context.random, {
    body: carrier,
    pivotRange,
    unitBody,
    unitBogie,
    join,
    lengthStuds,
    cap,
    pivotZ,
  });
  if (!hung) return null;
  const firstPivot = Math.min(...hung.pivots.map((pivot) => pivot[0]));
  const lastPivot = Math.max(...hung.pivots.map((pivot) => pivot[0]));
  const behindMiddle = (hung.bogie.x0 + firstPivot) / 2;
  const ranges: ReadonlyArray<readonly [number, number]> =
    count === 1
      ? [[-WIDE, WIDE]]
      : axleSide === "behind"
        ? [
            [-WIDE, behindMiddle],
            [behindMiddle, firstPivot],
          ]
        : [
            [-WIDE, firstPivot],
            [lastPivot, WIDE],
          ];
  const hungAxles = axles(context, hung.bogie, carrier.bottom, ranges, unitBogie, [], wheel);
  return hungAxles ? { hung, axles: hungAxles } : null;
}

function ends(
  context: RecipeContext,
  carrier: Carrier,
  unit: string,
): { readonly front: EndPlan; readonly rear: EndPlan } | null {
  const plans: EndPlan[] = [];
  for (const end of [1, -1] as const) {
    const variant = context.random.choice(END_VARIANTS) ?? "plain";
    if (variant === "plain") {
      plans.push("plain");
      continue;
    }
    const feature = buildEnd(
      context.model,
      context.pools,
      context.random,
      carrier,
      end,
      variant,
      unit,
    );
    if (!feature) return null;
    plans.push(feature);
  }
  return { front: plans[0] ?? "plain", rear: plans[1] ?? "plain" };
}

function third(carrier: Carrier, part: 0 | 1 | 2): readonly [number, number] {
  const step = (carrier.x1 - carrier.x0) / 3;
  return [carrier.x0 + step * part, carrier.x0 + step * (part + 1)];
}

function half(carrier: Carrier, part: 0 | 1): readonly [number, number] {
  const middle = (carrier.x0 + carrier.x1) / 2;
  return part === 0 ? [carrier.x0, middle] : [middle, carrier.x1];
}

const axleCar: Recipe = (context) => {
  const wheel = wheelFor(context);
  const car = carBody(context.model, context.pools, context.random, 0, 8, "car");
  if (!wheel || !car) return null;
  const hung = axles(context, car, car.bottom, [half(car, 0), half(car, 1)], "car", [], wheel);
  const plan = hung ? ends(context, car, "car") : null;
  if (!hung || !plan) return null;
  return single(
    hung.map((axle) => axle.wheelset),
    { body: ["car"], bogies: [], ...plan },
  );
};

export function single(wheelsets: ReadonlyArray<PlannedWheelset>, vehicle: VehiclePlan): TrainPlan {
  return {
    wheelsets,
    vehicles: [vehicle],
    attachments: [],
    couplingsInModel: [],
    unresolvedRunningGear: [],
  };
}

function bogieCar(axlesPerBogie: 1 | 2, capFront: boolean): Recipe {
  return (context) => {
    const wheel = wheelFor(context);
    const car = carBody(context.model, context.pools, context.random, 0, 24, "car");
    if (!wheel || !car) return null;
    const front = bogieWithAxles(
      context,
      car,
      third(car, 2),
      axlesPerBogie,
      "car",
      "front bogie",
      "pivot",
      wheel,
      "around",
      capFront,
    );
    const rear = front
      ? bogieWithAxles(
          context,
          car,
          third(car, 0),
          axlesPerBogie,
          "car",
          "rear bogie",
          "pivot",
          wheel,
        )
      : null;
    const plan = rear ? ends(context, car, "car") : null;
    if (!front || !rear || !plan) return null;
    return single(
      [...front.axles, ...rear.axles].map((axle) => axle.wheelset),
      {
        body: ["car"],
        bogies: [
          { unit: "front bogie", pivot: front.hung.pivots[0] ?? [0, 0] },
          { unit: "rear bogie", pivot: rear.hung.pivots[0] ?? [0, 0] },
        ],
        ...plan,
      },
    );
  };
}

const COUPLER_GAP_PLATES = [1, 2, 3, 4] as const;
const COUPLER_ROOM_STUDS = 2;

function hangCoupler(
  context: RecipeContext,
  bogie: { readonly hung: HungBogie; readonly axles: ReadonlyArray<HungAxle> },
  unit: string,
): boolean {
  const { model, pools, random } = context;
  const frame = bogie.hung.bogie;
  const outerAxle = Math.max(...bogie.axles.map((axle) => axle.wheelset.x));
  const holes = random.shuffled(bogie.hung.holes.filter(([x]) => x > outerAxle));
  const holders = random.shuffled(pivotOptions(pools).filter((option) => option.holes.length > 0));
  for (const [x, z] of holes) {
    for (const holder of holders) {
      const [hole] = holder.holes;
      if (!hole) continue;
      const corner = [x - hole[0], z - hole[1]] as const;
      if (!onLattice(corner[0], frame.x0) || !onLattice(corner[1], frame.z0)) continue;
      for (const gap of COUPLER_GAP_PLATES) {
        const checkpoint = model.checkpoint();
        const top = frame.bottom - gap * PLATE_LDU;
        const placed = stackAt(
          model,
          pools,
          holder,
          corner,
          top,
          1,
          pickColor(random, pools),
          unit,
          null,
        );
        const link = verticalLink(
          model,
          pools,
          random,
          [x, z],
          top - PLATE_LDU,
          frame.top,
          [...placed, ...bogie.hung.bogieIndices],
          unit,
        );
        if (link !== null && !model.collidesSince(checkpoint)) return true;
        model.rollback(checkpoint);
      }
    }
  }
  return false;
}

const truckMountedCoupler: Recipe = (context) => {
  const wheel = wheelFor(context);
  const car = carBody(context.model, context.pools, context.random, 0, 24, "car");
  if (!wheel || !car) return null;
  const front = bogieWithAxles(
    context,
    car,
    third(car, 2),
    2,
    "car",
    "front bogie",
    "pivot",
    wheel,
    "around",
    false,
    0,
    2,
    COUPLER_ROOM_STUDS,
  );
  const rear = front
    ? bogieWithAxles(context, car, third(car, 0), 2, "car", "rear bogie", "pivot", wheel)
    : null;
  if (!front || !rear || !hangCoupler(context, front, "front bogie")) return null;
  return single(
    [...front.axles, ...rear.axles].map((axle) => axle.wheelset),
    {
      body: ["car"],
      bogies: [
        { unit: "front bogie", pivot: front.hung.pivots[0] ?? [0, 0] },
        { unit: "rear bogie", pivot: rear.hung.pivots[0] ?? [0, 0] },
      ],
      front: "unasserted",
      rear: "unasserted",
    },
  );
};

function locomotive(bogies: 1 | 2, ponyTruck: boolean): Recipe {
  return (context) => {
    const wheel = wheelFor(context);
    const car = carBody(
      context.model,
      context.pools,
      context.random,
      0,
      bogies === 2 ? 32 : 20,
      "locomotive",
    );
    if (!wheel || !car) return null;
    const front = bogieWithAxles(
      context,
      car,
      third(car, 2),
      ponyTruck ? 1 : 2,
      "locomotive",
      "front bogie",
      "pivot",
      wheel,
    );
    if (!front) return null;
    const rear =
      bogies === 2
        ? bogieWithAxles(context, car, third(car, 0), 2, "locomotive", "rear bogie", "pivot", wheel)
        : null;
    if (bogies === 2 && !rear) return null;
    const frontStart = Math.min(
      ...front.axles.map((axle) => axle.occupied[0]),
      front.hung.bogie.x0,
    );
    const rearEnd = rear
      ? Math.max(...rear.axles.map((axle) => axle.occupied[1]), rear.hung.bogie.x1)
      : car.x0;
    const count = 1 + context.random.int(2);
    const span = (frontStart - rearEnd) / count;
    const ranges = Array.from(
      { length: count },
      (_, i) => [rearEnd + span * i, rearEnd + span * (i + 1)] as const,
    );
    const drivers = axles(context, car, car.bottom, ranges, "locomotive", [], wheel);
    const plan = drivers ? ends(context, car, "locomotive") : null;
    if (!drivers || !plan) return null;
    return single(
      [...drivers, ...front.axles, ...(rear?.axles ?? [])].map((axle) => axle.wheelset),
      {
        body: ["locomotive"],
        bogies: [
          { unit: "front bogie", pivot: front.hung.pivots[0] ?? [0, 0] },
          ...(rear ? [{ unit: "rear bogie", pivot: rear.hung.pivots[0] ?? [0, 0] }] : []),
        ],
        ...plan,
      },
    );
  };
}

function runningGearCar(explode: boolean): Recipe {
  return (context) => {
    const candidates = context.pools.running.filter(
      (part) => part.topStuds.length > 0 && (!explode || part.constituents !== null),
    );
    const part = context.random.choice(candidates);
    const car = carBody(context.model, context.pools, context.random, 0, 12, "car");
    if (!part || !car) return null;
    const first = mountRunningGear(
      context.model,
      context.pools,
      context.random,
      car,
      part,
      half(car, 1),
      context.rails,
      explode,
      "car",
    );
    if (!first) return null;
    const second = mountRunningGear(
      context.model,
      context.pools,
      context.random,
      car,
      part,
      [car.x0, first.occupied[0]],
      context.rails,
      explode,
      "car",
    );
    if (!second) return null;
    return single([...first.wheelsets, ...second.wheelsets], {
      body: ["car"],
      bogies: [],
      front: "unasserted",
      rear: "unasserted",
    });
  };
}

const motorBogieCar: Recipe = (context) => {
  const motors = context.pools.running.filter(
    (part) => part.pivotPin !== null && part.axes.length >= 2,
  );
  const motor = context.random.choice(motors);
  const wheel = wheelFor(context);
  const car = carBody(context.model, context.pools, context.random, 0, 16, "car");
  if (!motor || !wheel || !car) return null;
  const front = mountPinBogie(
    context.model,
    context.pools,
    context.random,
    car,
    motor,
    third(car, 2),
    context.rails,
    "car",
    "motor bogie",
  );
  if (!front?.pivot) return null;
  const rear = bogieWithAxles(context, car, third(car, 0), 2, "car", "rear bogie", "pivot", wheel);
  if (!rear) return null;
  return single([...front.wheelsets, ...rear.axles.map((axle) => axle.wheelset)], {
    body: ["car"],
    bogies: [
      { unit: "motor bogie", pivot: front.pivot },
      { unit: "rear bogie", pivot: rear.hung.pivots[0] ?? [0, 0] },
    ],
    front: "unasserted",
    rear: "plain",
  });
};

const singleBogieBody: Recipe = (context) => {
  const wheel = wheelFor(context);
  const car = carBody(context.model, context.pools, context.random, 0, 10, "car");
  if (!wheel || !car) return null;
  const bogie = bogieWithAxles(context, car, half(car, 1), 2, "car", "bogie", "pivot", wheel);
  if (!bogie) return null;
  return {
    wheelsets: bogie.axles.map((axle) => axle.wheelset),
    vehicles: [],
    attachments: [],
    couplingsInModel: [],
    unresolvedRunningGear: [{ units: ["car", "bogie"], reason: "fewer than two guides" }],
  };
};

function negativeAxleCar(modes: ReadonlyArray<AxleMode>): Recipe {
  return (context) => {
    const wheel = wheelFor(context);
    const car = carBody(context.model, context.pools, context.random, 0, 12, "car");
    if (!wheel || !car) return null;
    const step = (car.x1 - car.x0) / modes.length;
    const ranges = modes.map((_, i) => [car.x0 + step * i, car.x0 + step * (i + 1)] as const);
    const hung = axles(context, car, car.bottom, ranges, "car", modes, wheel);
    if (!hung) return null;
    const positives = modes.filter((mode) => mode === "positive").length;
    return {
      wheelsets: hung.map((axle) => axle.wheelset),
      vehicles:
        positives >= 2 ? [{ body: ["car"], bogies: [], front: "plain", rear: "plain" }] : [],
      attachments: [],
      couplingsInModel: [],
      unresolvedRunningGear: [],
    };
  };
}

function lockedTruck(join: "rigid" | "two pivots"): Recipe {
  return (context) => {
    const wheel = wheelFor(context);
    const car = carBody(context.model, context.pools, context.random, 0, 24, "car");
    if (!wheel || !car) return null;
    const truck = bogieWithAxles(context, car, third(car, 2), 2, "car", "truck", join, wheel);
    const rear = truck
      ? bogieWithAxles(context, car, third(car, 0), 2, "car", "rear bogie", "pivot", wheel)
      : null;
    if (!truck || !rear) return null;
    return single(
      [...truck.axles, ...rear.axles].map((axle) => axle.wheelset),
      {
        body: ["car", "truck"],
        bogies: [{ unit: "rear bogie", pivot: rear.hung.pivots[0] ?? [0, 0] }],
        front: "plain",
        rear: "plain",
      },
    );
  };
}

const hingedBogieCar: Recipe = (context) => {
  const wheel = wheelFor(context);
  const car = carBody(context.model, context.pools, context.random, 0, 24, "car");
  if (!wheel || !car) return null;
  const front = bogieWithAxles(
    context,
    car,
    third(car, 2),
    2,
    "car",
    "front bogie",
    "pivot",
    wheel,
  );
  const hinged =
    front !== null && hangHinge(context.model, context.pools, context.random, front.hung.bogie);
  const rear = hinged
    ? bogieWithAxles(context, car, third(car, 0), 2, "car", "rear bogie", "pivot", wheel)
    : null;
  if (!front || !rear) return null;
  return single(
    [...front.axles, ...rear.axles].map((axle) => axle.wheelset),
    {
      body: ["car"],
      bogies: [
        { unit: "front bogie", pivot: front.hung.pivots[0] ?? [0, 0] },
        { unit: "rear bogie", pivot: rear.hung.pivots[0] ?? [0, 0] },
      ],
      front: "plain",
      rear: "plain",
    },
  );
};

const roofTurntable: Recipe = (context) => {
  const base = axleCar(context);
  if (!base) return null;
  const { model, pools, random } = context;
  const baseBox = model.box(0);
  const top = baseBox.max[VERTICAL];
  for (let attempt = 0; attempt < TURNTABLE_TRIES; attempt++) {
    const option = random.choice(pivotOptions(pools));
    const axle = random.choice(pivotPartAxles(pools));
    const hole = option ? random.choice(option.holes) : null;
    if (!option || !axle || !hole) return null;
    const [length, width] = [
      option.box.max[0] - option.box.min[0],
      option.box.max[2] - option.box.min[2],
    ];
    const corner = [
      baseBox.min[0] +
        STUD_LDU * Math.floor((baseBox.max[0] - baseBox.min[0] - length) / 2 / STUD_LDU),
      baseBox.min[2] +
        STUD_LDU * Math.floor((baseBox.max[2] - baseBox.min[2] - width) / 2 / STUD_LDU),
    ] as const;
    const plates = (axle.span.to - axle.span.from) / PLATE_LDU - 1;
    const lower = 1 + random.int(plates - 1);
    const checkpoint = model.checkpoint();
    const color = pickColor(random, pools);
    const lowerStack = stackAt(
      model,
      pools,
      option,
      corner,
      top + lower * PLATE_LDU,
      lower,
      color,
      "car",
      0,
    );
    const upperTop = top + (plates + 1) * PLATE_LDU;
    const upperStack = stackAt(
      model,
      pools,
      option,
      corner,
      upperTop,
      plates - lower,
      color,
      "turntable",
      null,
    );
    const pivot = [corner[0] + hole[0], corner[1] + hole[1]] as const;
    const pin = placeAlong(
      model,
      axle,
      { axis: axle.span.axis, sign: 1 },
      pointOnLine(axle.span.axis, axle.span.at, axle.span.from),
      { axis: VERTICAL, sign: 1 },
      [pivot[0], top, pivot[1]],
      pickColor(random, pools),
      `turntable${PIVOT_PART_SUFFIX}`,
    );
    for (const member of [...lowerStack, ...upperStack]) model.join(pin, member);
    if (!model.collidesSince(checkpoint)) {
      return { ...base, attachments: ["turntable"] };
    }
    model.rollback(checkpoint);
  }
  return null;
};

const splitAcrossPivot: Recipe = (context) => {
  const wheel = wheelFor(context);
  const car = carBody(context.model, context.pools, context.random, 0, 24, "car");
  if (!wheel || !car) return null;
  const front = bogieWithAxles(
    context,
    car,
    third(car, 2),
    1,
    "car",
    "front bogie",
    "pivot",
    wheel,
    "around",
    false,
    -STUD_LDU,
    2,
  );
  if (!front) return null;
  if (front.hung.bogie.z1 - front.hung.bogie.z0 > 2 * STUD_LDU) return null;
  const pivotX = front.hung.pivots[0]?.[0] ?? 0;
  const normal = front.axles[0];
  if (!normal || normal.wheelset.x < pivotX) return null;
  const split = hangSplitAxle(context.model, context.pools, context.random, {
    bogie: front.hung.bogie,
    body: car,
    xRange: [-WIDE, Math.min(pivotX, normal.occupied[0])],
    wheel,
    rail: context.rail,
  });
  const rear = split
    ? bogieWithAxles(context, car, third(car, 0), 2, "car", "rear bogie", "pivot", wheel)
    : null;
  if (!split || !rear) return null;
  return single(
    [normal, split, ...rear.axles].map((axle) => axle.wheelset),
    {
      body: ["car"],
      bogies: [
        { unit: "front bogie", pivot: front.hung.pivots[0] ?? [0, 0] },
        { unit: "rear bogie", pivot: rear.hung.pivots[0] ?? [0, 0] },
      ],
      front: "plain",
      rear: "plain",
    },
  );
};

export const CAR_RECIPES: ReadonlyArray<readonly [string, Recipe]> = [
  ["axle car", axleCar],
  ["bogie car", bogieCar(2, false)],
  ["single-axle bogie car", bogieCar(1, false)],
  ["locomotive with one bogie", locomotive(1, false)],
  ["locomotive with two bogies", locomotive(2, false)],
  ["locomotive with a pony truck", locomotive(1, true)],
  ["one-piece running-gear part", runningGearCar(false)],
  ["running-gear part in separate pieces", runningGearCar(true)],
  ["motor bogie, two axles in one part", motorBogieCar],
  ["car on a single bogie", singleBogieBody],
  ["roof turntable", roofTurntable],
  ["horizontal hinge on a bogie", hingedBogieCar],
  ["bush capping a pivot", bogieCar(2, true)],
  ["truck-mounted coupler", truckMountedCoupler],
  ["co-linear wheels split across a pivot", splitAcrossPivot],
  ["gauge miss", negativeAxleCar(["gauge miss", "gauge miss"])],
  ["one head band", negativeAxleCar(["positive", "one head band", "positive"])],
  ["two-pivot truck", lockedTruck("two pivots")],
  ["rigid truck", lockedTruck("rigid")],
];
