import { describe, expect, it } from "vitest";
import { formatExactRational, type ExactRational } from "@brr/math";
import type { PartRolling, UnreadBand, UnreadRollingBands } from "@brr/schema/bundle";
import { MODEL_ROOT, type PartInstances } from "../connect/submodel-frames.ts";
import { measuredRail, type MeasuredRail } from "./measured-rail.ts";
import { PartRollingTable } from "./part-rolling.ts";
import { WheelsetDetector, type DetectedWheelset } from "./wheelset-detector.ts";

const NINE_VOLT: MeasuredRail = measuredRail([
  { from: "-53.625", to: "-47.375" },
  { from: "47.375", to: "53.625" },
]);
const PLASTIC: MeasuredRail = measuredRail([
  { from: "-53.1", to: "-46.9" },
  { from: "46.9", to: "53.1" },
]);
const RAILS = [NINE_VOLT, PLASTIC];
const NARROW: MeasuredRail = measuredRail([
  { from: "-34", to: "-30" },
  { from: "30", to: "34" },
]);

type Matrix = ReadonlyArray<number>;

interface Band {
  readonly from: number;
  readonly to: number;
  readonly radius: number;
  readonly outerRadius?: number;
}

const IDENTITY: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function at(x: number, y: number, z: number, base: Matrix = IDENTITY): number[] {
  return [
    base[0] ?? 1,
    base[1] ?? 0,
    base[2] ?? 0,
    x,
    base[4] ?? 0,
    base[5] ?? 1,
    base[6] ?? 0,
    y,
    base[8] ?? 0,
    base[9] ?? 0,
    base[10] ?? 1,
    z,
  ];
}

function sixteenths(ldu: number): number {
  const value = ldu * 16;
  if (!Number.isInteger(value)) throw new Error(`${ldu} LDU is not on the sixteenth grid`);
  return value;
}

function rolling(bands: ReadonlyArray<Band>, unread: ReadonlyArray<UnreadBand> = []): PartRolling {
  return {
    stepsPerLdu: 16,
    surfaces: bands.map((band) => ({
      source: "measured",
      axis: 2,
      at: [0, 0],
      from: sixteenths(band.from),
      to: sixteenths(band.to),
      radii: [sixteenths(band.radius), sixteenths(band.outerRadius ?? band.radius)],
    })),
    unread: [...unread],
  };
}

function mirrored(bands: ReadonlyArray<Band>): Band[] {
  return bands.flatMap((band) => [
    band,
    {
      from: -band.to,
      to: -band.from,
      radius: band.outerRadius ?? band.radius,
      outerRadius: band.radius,
    },
  ]);
}

interface Placed {
  readonly part: number;
  readonly matrix: Matrix;
  readonly submodel?: number;
}

function model(
  placed: ReadonlyArray<Placed>,
  submodels: ReadonlyArray<readonly [number, Matrix]> = [],
): PartInstances {
  const world: Matrix[] = [];
  for (const [parent, local] of submodels) world.push(then(world[parent] ?? IDENTITY, local));
  return {
    count: placed.length,
    partIndex: Uint32Array.from(placed, (p) => p.part),
    matrices: Float64Array.from(
      placed.flatMap((p) =>
        p.submodel === undefined ? [...p.matrix] : then(world[p.submodel] ?? IDENTITY, p.matrix),
      ),
    ),
    submodels: {
      count: submodels.length,
      parent: Int32Array.from(submodels, ([parent]) => parent),
      matrices: Float64Array.from(world.flat()),
      ofPart: Int32Array.from(placed, (p) => p.submodel ?? MODEL_ROOT),
    },
  };
}

function then(outer: Matrix, inner: Matrix): number[] {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let k = 0; k < 4; k++) {
      let sum = k === 3 ? (outer[r * 4 + 3] ?? 0) : 0;
      for (let j = 0; j < 3; j++) sum += (outer[r * 4 + j] ?? 0) * (inner[j * 4 + k] ?? 0);
      out.push(sum);
    }
  }
  return out;
}

function detect(placed: PartInstances, parts: ReadonlyArray<PartRolling>) {
  return new WheelsetDetector(RAILS).detect(
    placed,
    parts.map((part) => PartRollingTable.fromRolling(part)),
  );
}

function rows(columns: UnreadRollingBands): Array<[number, number, string]> {
  return columns.instance.map((instance, n) => [
    instance,
    columns.band[n] ?? -1,
    columns.reason[n] ?? "",
  ]);
}

function radius(value: ExactRational): string {
  const { numerator, denominator } = formatExactRational(value);
  return denominator === "1" ? numerator : `${numerator}/${denominator}`;
}

function summary(wheelset: DetectedWheelset) {
  return {
    members: Array.from(wheelset.memberInstances, (instance, n) => [
      instance,
      wheelset.memberSurfaces[n],
    ]),
    rail: wheelset.rail,
    trackCentre: wheelset.trackCentre,
    contactRadii: wheelset.contactRadii.map(radius),
    rollingRadius: radius(wheelset.rollingRadius),
    rollingRadiusOnRail: wheelset.rollingRadiusOnRail.map((onRail) =>
      onRail ? radius(onRail) : null,
    ),
  };
}

const TREAD: Band = { from: 44, to: 54, radius: 7 };
const FLANGE: Band = { from: 42, to: 44, radius: 8.75 };
const WHEEL_PAIR = rolling(mirrored([TREAD, FLANGE]));
const SPANNING_BAR: Band = { from: -60, to: 60, radius: 3 };

describe("WheelsetDetector", () => {
  it("records a wheel pair centred in its lateral play; its flanges touch a head band only at other centres, so they give no radius", () => {
    const { wheelsets, unreadRollingBands } = detect(model([{ part: 0, matrix: at(40, 7, 0) }]), [
      WHEEL_PAIR,
    ]);
    expect(rows(unreadRollingBands)).toEqual([]);
    expect(wheelsets.map(summary)).toEqual([
      {
        members: [
          [0, 0],
          [0, 1],
          [0, 2],
          [0, 3],
        ],
        rail: 0,
        trackCentre: 0,
        contactRadii: ["7", "7"],
        rollingRadius: "7",
        rollingRadiusOnRail: ["7", "7"],
      },
    ]);
  });

  it("finds no wheelset when the wheels miss every rail's heads or meet only one of them", () => {
    const wide = rolling(mirrored([{ from: 62, to: 70, radius: 7 }]));
    const oneSide = rolling([TREAD, { from: -20, to: -12, radius: 7 }]);
    expect(detect(model([{ part: 0, matrix: at(0, 7, 0) }]), [wide]).wheelsets).toEqual([]);
    expect(detect(model([{ part: 0, matrix: at(0, 7, 0) }]), [oneSide]).wheelsets).toEqual([]);
  });

  it("never makes a round surface spanning both head bands a member: alone it gives no wheelset, and two wheels beside it keep theirs", () => {
    const bar = rolling([SPANNING_BAR]);
    const alone = detect(model([{ part: 0, matrix: at(40, 7, 0) }]), [bar]);
    const { wheelsets } = detect(
      model([
        { part: 0, matrix: at(40, 7, 0) },
        { part: 1, matrix: at(40, 7, 0) },
      ]),
      [WHEEL_PAIR, bar],
    );
    expect({
      alone: alone.wheelsets,
      members: wheelsets.map((w) => Array.from(w.memberInstances)),
    }).toEqual({ alone: [], members: [[0, 0, 0, 0]] });
  });

  it("records a null rolling radius on a rail whose head bands the group meets only through a spanning surface", () => {
    const { wheelsets } = new WheelsetDetector([NINE_VOLT, NARROW]).detect(
      model([
        { part: 0, matrix: at(40, 7, 0) },
        { part: 1, matrix: at(40, 7, 0) },
      ]),
      [
        PartRollingTable.fromRolling(WHEEL_PAIR),
        PartRollingTable.fromRolling(rolling([SPANNING_BAR])),
      ],
    );
    expect(wheelsets.map(summary)).toEqual([
      {
        members: [
          [0, 0],
          [0, 1],
          [0, 2],
          [0, 3],
        ],
        rail: 0,
        trackCentre: 0,
        contactRadii: ["7", "7"],
        rollingRadius: "7",
        rollingRadiusOnRail: ["7", null],
      },
    ]);
  });

  it("keeps a co-linear hub that touches no head band out of the members", () => {
    const hub = rolling([{ from: -10, to: 10, radius: 3 }]);
    const { wheelsets } = detect(
      model([
        { part: 0, matrix: at(40, 7, 0) },
        { part: 1, matrix: at(40, 7, 0) },
      ]),
      [WHEEL_PAIR, hub],
    );
    expect(wheelsets.map((w) => Array.from(w.memberInstances))).toEqual([[0, 0, 0, 0]]);
  });

  it("leaves out a flange that meets a head band only at an endpoint, and reads the radius from the tread", () => {
    const part = rolling([
      { from: 47.375, to: 53.625, radius: 7 },
      { from: 53.625, to: 55, radius: 9 },
      { from: -60, to: -53.5625, radius: 7 },
    ]);
    const [wheelset] = detect(model([{ part: 0, matrix: at(0, 7, 0) }]), [part]).wheelsets;
    expect(wheelset && summary(wheelset)).toEqual({
      members: [
        [0, 0],
        [0, 2],
      ],
      rail: 0,
      trackCentre: -50,
      contactRadii: ["7", "7"],
      rollingRadius: "7",
      rollingRadiusOnRail: ["7", "7"],
    });
  });

  it("reads coned treads at the centre nearest the middle of the lateral play", () => {
    const coned = rolling(mirrored([{ from: 44, to: 56, radius: 8, outerRadius: 6.5 }]));
    const [wheelset] = detect(model([{ part: 0, matrix: at(0, 8, 0) }]), [coned]).wheelsets;
    expect(wheelset && summary(wheelset)).toEqual({
      members: [
        [0, 0],
        [0, 1],
      ],
      rail: 0,
      trackCentre: 0,
      contactRadii: ["485/64", "485/64"],
      rollingRadius: "485/64",
      rollingRadiusOnRail: ["485/64", "611/80"],
    });
  });

  it("records the lower of two centres equally near the middle of the feasible hull", () => {
    const part = rolling([
      { from: 44, to: 53.625, radius: 7 },
      { from: -53.6875, to: -40, radius: 7 },
    ]);
    const [wheelset] = detect(model([{ part: 0, matrix: at(0, 7, 0) }]), [part]).wheelsets;
    expect(wheelset?.trackCentre).toBe(-1);
  });

  it("records a null rolling radius on a rail the wheels miss, and the first rail they meet", () => {
    const { wheelsets } = new WheelsetDetector([NARROW, NINE_VOLT]).detect(
      model([{ part: 0, matrix: at(40, 7, 0) }]),
      [PartRollingTable.fromRolling(WHEEL_PAIR)],
    );
    expect(wheelsets.map(summary)).toEqual([
      {
        members: [
          [0, 0],
          [0, 1],
          [0, 2],
          [0, 3],
        ],
        rail: 1,
        trackCentre: 0,
        contactRadii: ["7", "7"],
        rollingRadius: "7",
        rollingRadiusOnRail: [null, "7"],
      },
    ]);
  });

  it("reads each rail on its own surfaces when two rails meet different treads with different radii", () => {
    const stepped = rolling(
      mirrored([
        { from: 29, to: 35, radius: 5 },
        { from: 46, to: 55, radius: 7 },
      ]),
    );
    const { wheelsets } = new WheelsetDetector([NARROW, NINE_VOLT]).detect(
      model([{ part: 0, matrix: at(40, 7, 0) }]),
      [PartRollingTable.fromRolling(stepped)],
    );
    expect(wheelsets.map(summary)).toEqual([
      {
        members: [
          [0, 0],
          [0, 1],
        ],
        rail: 0,
        trackCentre: 0,
        contactRadii: ["5", "5"],
        rollingRadius: "5",
        rollingRadiusOnRail: ["5", "7"],
      },
    ]);
  });

  it("records the first rail when both seat, and ignores a band that only meets the other rail's heads", () => {
    const treads = rolling([
      { from: 40, to: 47.4375, radius: 7 },
      { from: -47.4375, to: -40, radius: 7 },
    ]);
    const plasticOnly = rolling([{ from: 46.9375, to: 47.3125, radius: 7 }]);
    const [wheelset] = detect(
      model([
        { part: 0, matrix: at(0, 7, 0) },
        { part: 1, matrix: at(0, 7, 0) },
      ]),
      [treads, plasticOnly],
    ).wheelsets;
    expect(wheelset && summary(wheelset)).toEqual({
      members: [
        [0, 0],
        [0, 1],
      ],
      rail: 0,
      trackCentre: 0,
      contactRadii: ["7", "7"],
      rollingRadius: "7",
      rollingRadiusOnRail: ["7", "7"],
    });
  });

  it("joins three or more co-linear surfaces across instances into one wheelset", () => {
    const left = rolling([
      { from: -54, to: -44, radius: 7 },
      { from: -44, to: -42, radius: 8.75 },
    ]);
    const right = rolling([{ from: 44, to: 54, radius: 7 }]);
    const { wheelsets } = detect(
      model([
        { part: 0, matrix: at(20, 7, 0) },
        { part: 1, matrix: at(20, 7, 0) },
      ]),
      [left, right],
    );
    expect(wheelsets.map(summary)).toEqual([
      {
        members: [
          [0, 0],
          [0, 1],
          [1, 0],
        ],
        rail: 0,
        trackCentre: 0,
        contactRadii: ["7", "7"],
        rollingRadius: "7",
        rollingRadiusOnRail: ["7", "7"],
      },
    ]);
  });

  it("keeps wheel pairs in different sub-models apart, each exact only in its own sub-model", () => {
    const left = rolling([TREAD]);
    const right = rolling([{ from: -54, to: -44, radius: 7 }]);
    const dusty: Matrix = at(0.11, -62.3333, 0.07);
    const { wheelsets, unreadRollingBands } = detect(
      model(
        [
          { part: 0, matrix: at(90, 63, 0), submodel: 0 },
          { part: 1, matrix: at(90, 63, 0), submodel: 0 },
          { part: 0, matrix: at(-90, 63, 0), submodel: 1 },
          { part: 1, matrix: at(-90, 63, 0), submodel: 1 },
        ],
        [
          [MODEL_ROOT, dusty],
          [MODEL_ROOT, at(0, 0, 0)],
        ],
      ),
      [left, right],
    );
    expect(rows(unreadRollingBands)).toEqual([]);
    expect(wheelsets.map((w) => Array.from(w.memberInstances).toSorted())).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("records the track centre in its members' own lowest common frame, not one a co-linear hub pulls outward", () => {
    const hub = rolling([{ from: -10, to: 10, radius: 3 }]);
    const { wheelsets } = detect(
      model(
        [
          { part: 0, matrix: at(0, 7, 0), submodel: 0 },
          { part: 1, matrix: IDENTITY, submodel: 1 },
        ],
        [
          [MODEL_ROOT, at(90, 0, 0.07)],
          [MODEL_ROOT, at(90, 7, 0)],
        ],
      ),
      [WHEEL_PAIR, hub],
    );
    expect(
      wheelsets.map((w) => ({
        frame: w.frame,
        trackCentre: w.trackCentre,
        members: Array.from(w.memberInstances),
      })),
    ).toEqual([{ frame: 0, trackCentre: 0, members: [0, 0, 0, 0] }]);
  });

  it("pairs surfaces only in their own lowest common frame, never on an outer frame's chance alignment", () => {
    const left = rolling([TREAD]);
    const right = rolling([{ from: -54, to: -44, radius: 7 }]);
    const halves = (outerY: number, secondY: number) =>
      detect(
        model(
          [
            { part: 0, matrix: IDENTITY, submodel: 1 },
            { part: 1, matrix: IDENTITY, submodel: 2 },
          ],
          [
            [MODEL_ROOT, at(0, outerY, 0)],
            [0, at(40, 7, 0)],
            [0, at(40, secondY, 0)],
          ],
        ),
        [left, right],
      ).wheelsets.map((w) => Array.from(w.memberInstances));
    expect(halves(0, 7)).toEqual([[0, 1]]);
    expect(halves(-0.0004, 7.0008)).toEqual([]);
  });

  it("reports a surface whose axle misses the grid in its own frame, and a wheel turned off the axes", () => {
    const quarterSine = Math.SQRT1_2;
    const turned: Matrix = [
      quarterSine,
      0,
      quarterSine,
      0,
      0,
      1,
      0,
      0,
      -quarterSine,
      0,
      quarterSine,
      0,
    ];
    const { wheelsets, unreadRollingBands } = detect(
      model([
        { part: 0, matrix: at(0, 7.002, 0) },
        { part: 0, matrix: at(40, 7, 0, turned) },
      ]),
      [WHEEL_PAIR],
    );
    expect(wheelsets).toEqual([]);
    expect(rows(unreadRollingBands)).toEqual([
      ...[0, 1, 2, 3].map((band) => [0, band, "across"]),
      ...[0, 1, 2, 3].map((band) => [1, band, "direction"]),
    ]);
  });

  it("keeps every horizontal unread band as a row, beside a wheelset or on a train whose treads all went unread", () => {
    const technicBeam = rolling([], [{ reason: "irregular", axis: 2, at: [0, 0] }]);
    const unreadTreads = rolling(
      [],
      [
        { reason: "faceted", axis: 2, from: sixteenths(44), to: sixteenths(54) },
        { reason: "faceted", axis: 2, from: sixteenths(-54), to: sixteenths(-44) },
      ],
    );
    const beside = detect(
      model([
        { part: 0, matrix: at(40, 7, 0) },
        { part: 1, matrix: at(0, 40, 0) },
      ]),
      [WHEEL_PAIR, technicBeam],
    );
    expect(beside.wheelsets).toHaveLength(1);
    expect(rows(beside.unreadRollingBands)).toEqual([[1, 0, "irregular"]]);
    const unreadTrain = detect(
      model([
        { part: 0, matrix: at(40, 7, 0) },
        { part: 0, matrix: at(-40, 7, 0) },
      ]),
      [unreadTreads],
    );
    expect(unreadTrain.wheelsets).toEqual([]);
    expect(rows(unreadTrain.unreadRollingBands)).toEqual([
      [0, 0, "faceted"],
      [0, 1, "faceted"],
      [1, 0, "faceted"],
      [1, 1, "faceted"],
    ]);
  });

  it("lists bake-unread bands that are horizontal, unoriented or off the model axes, never vertical ones", () => {
    const part = rolling(
      [],
      [{ reason: "faceted", axis: 2 }, { reason: "irregular", axis: 1 }, { reason: "unoriented" }],
    );
    const quarterSine = Math.SQRT1_2;
    const tilted: Matrix = [
      1,
      0,
      0,
      0,
      0,
      quarterSine,
      -quarterSine,
      0,
      0,
      quarterSine,
      quarterSine,
      0,
    ];
    const { unreadRollingBands } = detect(
      model([
        { part: 0, matrix: at(0, 0, 0) },
        { part: 0, matrix: at(0, 0, 0, tilted) },
      ]),
      [part],
    );
    expect(rows(unreadRollingBands)).toEqual([
      [0, 0, "faceted"],
      [0, 2, "unoriented"],
      [1, 0, "faceted"],
      [1, 1, "irregular"],
      [1, 2, "unoriented"],
    ]);
  });
});
