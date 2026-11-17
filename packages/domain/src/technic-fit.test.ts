import { describe, expect, it } from "vitest";
import {
  SignedPermutation,
  TECHNIC_HOLE,
  TECHNIC_SHAFT,
  TechnicSetBuilder,
  placeTechnic,
  technicItemsOverlap,
  type TechnicFeature,
  type TechnicSet,
} from "./technic-fit.ts";

const Z = 2;
const HOLE_AT = [0, -10] as const;
const BRICK_1X2_BOX = [-20, -24, -10, 20, 0, 10];
const COUNTERBORE = 128;
const BORE = 96;
const HOLE_RADII = [
  COUNTERBORE,
  COUNTERBORE,
  ...Array.from({ length: 16 }, () => BORE),
  COUNTERBORE,
  COUNTERBORE,
];
const FRICTION_HALF = [
  128, 128, 100, 100, 100, 100, 101, 96, 97, 96, 97, 96, 96, 101, 100, 100, 100, 100, 104, 104,
];
const AXLE_RADIUS = BORE;

function hole(at: readonly [number, number] = HOLE_AT): TechnicSet {
  const builder = new TechnicSetBuilder();
  builder.addItem(TECHNIC_HOLE, BRICK_1X2_BOX, [
    { axis: Z, at, from: -10, radii: HOLE_RADII, pin: null },
  ]);
  return builder.build();
}

function frictionPin(centreZ: number, lift = 0): TechnicSet {
  const at = [HOLE_AT[0], HOLE_AT[1] + lift] as const;
  const halves: TechnicFeature[] = [
    {
      axis: Z,
      at,
      from: centreZ,
      radii: FRICTION_HALF,
      pin: { origin: centreZ, direction: 1 },
    },
    {
      axis: Z,
      at,
      from: centreZ - 20,
      radii: FRICTION_HALF.toReversed(),
      pin: { origin: centreZ, direction: -1 },
    },
  ];
  const builder = new TechnicSetBuilder();
  builder.addItem(TECHNIC_SHAFT, [-8, at[1] - 8, centreZ - 20, 8, at[1] + 8, centreZ + 20], halves);
  return builder.build();
}

function axle(fromZ: number, length: number, radius: number, lift = 0): TechnicSet {
  const at = [HOLE_AT[0], HOLE_AT[1] + lift] as const;
  const radii = Array.from({ length }, () => radius);
  const reach = radius / 16;
  const builder = new TechnicSetBuilder();
  builder.addItem(
    TECHNIC_SHAFT,
    [-reach, at[1] - reach, fromZ, reach, at[1] + reach, fromZ + length],
    [{ axis: Z, at, from: fromZ, radii, pin: null }],
  );
  return builder.build();
}

function overlaps(a: TechnicSet, b: TechnicSet): boolean {
  return technicItemsOverlap(a, 0, b, 0);
}

describe("technicItemsOverlap", () => {
  it("lets an axle through a Technic hole only on the hole's own axis and within its radius everywhere", () => {
    expect({
      through: overlaps(axle(-40, 80, AXLE_RADIUS), hole()),
      onePlateUp: overlaps(axle(-40, 80, AXLE_RADIUS, 8), hole()),
      oneStudAside: overlaps(axle(-40, 80, AXLE_RADIUS), hole([20, -10])),
      sixteenthTooThick: overlaps(axle(-40, 80, AXLE_RADIUS + 1), hole()),
      besideTheBrick: overlaps(axle(10, 30, AXLE_RADIUS), hole()),
    }).toEqual({
      through: false,
      onePlateUp: true,
      oneStudAside: true,
      sixteenthTooThick: true,
      besideTheBrick: false,
    });
  });

  it("takes a friction pin half as a declared connector only when it enters at a hole end, inward, no longer than the hole", () => {
    const longHalf = new TechnicSetBuilder();
    longHalf.addItem(
      TECHNIC_SHAFT,
      [-8, -18, -10, 8, -2, 14],
      [
        {
          axis: Z,
          at: HOLE_AT,
          from: -10,
          radii: [...FRICTION_HALF, 96, 96, 96, 96],
          pin: { origin: -10, direction: 1 },
        },
      ],
    );
    expect({
      atNearEnd: overlaps(frictionPin(-10), hole()),
      atFarEnd: overlaps(frictionPin(10), hole()),
      oneLduIn: overlaps(frictionPin(-9), hole()),
      onePlateUp: overlaps(frictionPin(-10, 8), hole()),
      longerThanTheHole: overlaps(longHalf.build(), hole()),
      twoPins: overlaps(frictionPin(-10), frictionPin(-10)),
      twoBricks: overlaps(hole(), hole()),
    }).toEqual({
      atNearEnd: false,
      atFarEnd: false,
      oneLduIn: true,
      onePlateUp: true,
      longerThanTheHole: true,
      twoPins: true,
      twoBricks: true,
    });
  });

  it("gives the same verdict either way round and in every quarter turn and lattice translation", () => {
    const cases = [
      [axle(-40, 80, AXLE_RADIUS), hole()],
      [axle(-40, 80, AXLE_RADIUS, 8), hole()],
      [frictionPin(-10), hole()],
      [frictionPin(-9), hole()],
      [frictionPin(10), hole()],
    ] as const;
    const expected = cases.map(([a, b]) => overlaps(a, b));
    for (let rot = 0; rot < 4; rot++) {
      const cos = [1, 0, -1, 0][rot] ?? 1;
      const sin = [0, 1, 0, -1][rot] ?? 0;
      const turn = SignedPermutation.quarterTurn(cos, sin, 640 * rot - 20, 8 * rot, -340);
      const turned = cases.map(([a, b]) => overlaps(placeTechnic(a, turn), placeTechnic(b, turn)));
      const swapped = cases.map(([a, b]) => overlaps(placeTechnic(b, turn), placeTechnic(a, turn)));
      expect({ rot, turned, swapped }).toEqual({ rot, turned: expected, swapped: expected });
    }
  });
});
