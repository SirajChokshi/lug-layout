import { describe, expect, it } from "vitest";
import type {
  ModelVehicle,
  PartRolling,
  UnreadBand,
  UnresolvedRunningGear,
} from "@brr/schema/bundle";
import {
  AXIS_NEG_X,
  AXIS_NEG_Y,
  AXIS_NEG_Z,
  AXIS_POS_X,
  AXIS_POS_Y,
  AXIS_POS_Z,
  ConnectorTable,
  GENDER_FEMALE,
  GENDER_MALE,
  SOURCE_SHADOW,
  STATUS_VERIFIED,
} from "../connect/connector-table.ts";
import { SnapMating } from "../connect/mating.ts";
import {
  CAP_FAR,
  CAP_ROOT,
  SECTION_AXLE,
  SECTION_ROUND,
  SnapShapes,
} from "../connect/snap-shapes.ts";
import { MODEL_ROOT, type PartInstances } from "../connect/submodel-frames.ts";
import { MATE_PASS_MODEL, MatePairs } from "../connect/mate-pairs.ts";
import { BogieDetector } from "./bogie-detector.ts";
import { measuredRail } from "./measured-rail.ts";
import { PartRollingTable } from "./part-rolling.ts";
import { RunningGearDetector, type ExposedConnectors } from "./running-gear-detector.ts";
import { WheelsetDetector } from "./wheelset-detector.ts";

const shapes = new SnapShapes();
const mating = new SnapMating(shapes);
const PIN = shapes.intern(CAP_ROOT, false, [SECTION_ROUND], [4], [8]);
const HOLE = shapes.intern(CAP_FAR, false, [SECTION_ROUND], [4], [8]);
const AXLE = shapes.intern(CAP_ROOT, false, [SECTION_AXLE], [4], [8]);
const AXLE_HOLE = shapes.intern(CAP_FAR, false, [SECTION_AXLE], [4], [8]);
const STUD = shapes.intern(CAP_ROOT, false, [SECTION_ROUND], [6], [4]);
const FACE = shapes.intern(CAP_ROOT, false, [SECTION_ROUND], [4], [0]);
const FACE_RECEIVER = shapes.intern(CAP_FAR, false, [SECTION_ROUND], [4], [0]);

const detector = new RunningGearDetector(
  new WheelsetDetector([
    measuredRail([
      { from: "-53.625", to: "-47.375" },
      { from: "47.375", to: "53.625" },
    ]),
  ]),
  new BogieDetector(mating),
);

type Vec = readonly [number, number, number];

interface ConnectorSpec {
  readonly at: Vec;
  readonly axis: number;
  readonly gender: number;
  readonly shape?: number;
}

function shapeOf(spec: ConnectorSpec): number {
  return spec.shape ?? (spec.gender === GENDER_MALE ? PIN : HOLE);
}

function connectors(specs: ReadonlyArray<ConnectorSpec>): ConnectorTable {
  return new ConnectorTable(
    Uint16Array.from(specs, shapeOf),
    Uint8Array.from(specs, (s) => s.gender),
    Uint8Array.from(specs, () => SOURCE_SHADOW),
    Uint8Array.from(specs, () => STATUS_VERIFIED),
    Int32Array.from(specs.flatMap((s) => s.at.map(sixteenths))),
    Int8Array.from(specs, (s) => s.axis),
    new Float64Array(specs.length * 3),
    new Uint16Array(specs.length),
    new Float64Array(specs.length * 3),
    [],
  );
}

function sixteenths(ldu: number): number {
  return ldu * 16;
}

function wheels(
  bands: ReadonlyArray<readonly [number, number]>,
  unread: UnreadBand[] = [],
  radius = 7,
): PartRolling {
  return {
    stepsPerLdu: 16,
    surfaces: bands.map(([from, to]) => ({
      source: "measured" as const,
      axis: 2 as const,
      at: [0, 0] as [number, number],
      from: sixteenths(from),
      to: sixteenths(to),
      radii: [sixteenths(radius), sixteenths(radius)] as [number, number],
    })),
    unread,
  };
}

const WHEEL_PAIR = wheels([
  [44, 54],
  [-54, -44],
]);
const AXLE_MALE: ConnectorSpec = { at: [0, 0, 0], axis: AXIS_POS_Z, gender: GENDER_MALE };

interface Part {
  readonly connectors: ReadonlyArray<ConnectorSpec>;
  readonly rolling?: PartRolling;
}

interface Placement {
  readonly part: string;
  readonly at: Vec;
  readonly submodel?: number;
}

interface MateSpec {
  readonly male: readonly [number, number];
  readonly female: readonly [number, number];
}

interface Scenario {
  readonly parts: Readonly<Record<string, Part>>;
  readonly placed: ReadonlyArray<Placement>;
  readonly mates: ReadonlyArray<MateSpec>;
  readonly exposed?: ReadonlyArray<readonly [number, number]>;
  readonly submodels?: ReadonlyArray<Vec>;
}

function translated(offset: Vec, at: Vec): Vec {
  return [offset[0] + at[0], offset[1] + at[1], offset[2] + at[2]];
}

function run(scenario: Scenario) {
  const frames = scenario.submodels ?? [];
  const frameAt = (submodel: number | undefined): Vec =>
    submodel === undefined ? [0, 0, 0] : (frames[submodel] ?? [0, 0, 0]);
  const names = Object.keys(scenario.parts);
  const parts = names.map((name) => scenario.parts[name]);
  const specOf = (instance: number, connector: number): ConnectorSpec | undefined =>
    parts[names.indexOf(scenario.placed[instance]?.part ?? "")]?.connectors[connector];
  const instances: PartInstances = {
    count: scenario.placed.length,
    partIndex: Uint32Array.from(scenario.placed, (p) => names.indexOf(p.part)),
    matrices: Float64Array.from(
      scenario.placed.flatMap((p) => {
        const [x, y, z] = translated(frameAt(p.submodel), p.at);
        return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
      }),
    ),
    submodels: {
      count: frames.length,
      parent: Int32Array.from(frames, () => MODEL_ROOT),
      matrices: Float64Array.from(
        frames.flatMap(([x, y, z]) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z]),
      ),
      ofPart: Int32Array.from(scenario.placed, (p) => p.submodel ?? MODEL_ROOT),
    },
  };
  const mates = scenario.mates;
  const engaged = (m: MateSpec): number => {
    const male = specOf(...m.male);
    const female = specOf(...m.female);
    if (!male || !female) throw new Error("a mate names a connector the scenario lacks");
    const offset = mating.offsets(shapeOf(male), shapeOf(female))[0];
    if (offset === undefined) throw new Error("a scenario mate does not engage");
    return offset;
  };
  const graph = new MatePairs(
    Uint32Array.from(mates, (m) => m.male[0]),
    Uint32Array.from(mates, (m) => m.female[0]),
    Uint32Array.from(mates, (m) => m.male[1]),
    Uint32Array.from(mates, (m) => m.female[1]),
    Uint8Array.from(mates, () => MATE_PASS_MODEL),
    Int8Array.from(mates, (m) => specOf(...m.male)?.axis ?? 0),
    Int32Array.from(mates, engaged),
  );
  const open = scenario.exposed ?? [];
  const exposed: ExposedConnectors = {
    count: open.length,
    instance: Uint32Array.from(open, ([i]) => i),
    connector: Uint32Array.from(open, ([, c]) => c),
    axis: Int8Array.from(open, ([i, c]) => specOf(i, c)?.axis ?? 0),
    origin: Int32Array.from(
      open.flatMap(([i, c]) => {
        const placement = scenario.placed[i];
        const at = placement ? translated(frameAt(placement.submodel), placement.at) : [0, 0, 0];
        const local = specOf(i, c)?.at ?? [0, 0, 0];
        return [0, 1, 2].map((d) => sixteenths((at[d] ?? 0) + (local[d] ?? 0)));
      }),
    ),
    reach: Float32Array.from(open, ([i, c]) => {
      const spec = specOf(i, c);
      return spec ? shapes.length(shapeOf(spec)) : 0;
    }),
  };
  return detector.detect({
    instances,
    rolling: parts.map((part) =>
      part?.rolling ? PartRollingTable.fromRolling(part.rolling) : null,
    ),
    connectors: parts.map((part) => (part ? connectors(part.connectors) : null)),
    mates: graph,
    exposed,
  });
}

function reportedLink(report: UnresolvedRunningGear) {
  return {
    reason: report.reason,
    instances: report.instances,
    mates: report.mates.map((m) => [
      m.male.instance,
      m.male.connector,
      m.female.instance,
      m.female.connector,
    ]),
  };
}

function outline(vehicle: ModelVehicle) {
  return {
    guides: vehicle.guides.map((g) => [g.kind, g.position, g.bogie, g.wheelset]),
    body: vehicle.body,
    bogies: vehicle.bogies.map((b) => ({
      instances: b.instances,
      pivot: b.pivot,
      wheelsets: b.wheelsets,
    })),
    fixedAxles: vehicle.fixedAxles,
    wheelsets: vehicle.wheelsets.map((w) => ({
      members: w.members.map((m) => [m.instance, m.surface]),
      rail: w.rail,
      trackCentre: w.trackCentre,
      rollingRadius: w.rollingRadius,
      rollingRadiusOnRail: w.rollingRadiusOnRail,
      seated: w.seated,
    })),
  };
}

const SEVEN = { numerator: "7", denominator: "1" };

function wheelset(instance: number, seated = true) {
  return {
    members: [
      [instance, 0],
      [instance, 1],
    ],
    rail: 0,
    trackCentre: 0,
    rollingRadius: SEVEN,
    rollingRadiusOnRail: [SEVEN],
    seated,
  };
}

const FRAME: Part = {
  connectors: [
    { at: [0, 10, 0], axis: AXIS_POS_Y, gender: GENDER_FEMALE },
    { at: [-20, -13, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
    { at: [20, -13, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
  ],
};
const BODY: Part = {
  connectors: [
    { at: [60, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
    { at: [-60, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
    { at: [60, -23, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
    { at: [-60, -23, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
    { at: [100, 0, 0], axis: AXIS_POS_X, gender: GENDER_MALE },
    { at: [-100, 0, 0], axis: AXIS_NEG_X, gender: GENDER_MALE },
    { at: [96, 0, 0], axis: AXIS_NEG_X, gender: GENDER_FEMALE },
    { at: [100, 0, 8], axis: AXIS_POS_Z, gender: GENDER_MALE },
    { at: [106, 0, 0], axis: AXIS_POS_X, gender: GENDER_MALE, shape: STUD },
    { at: [0, -23, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
  ],
};
const PARTS: Readonly<Record<string, Part>> = {
  wheels: { connectors: [AXLE_MALE], rolling: WHEEL_PAIR },
  frame: FRAME,
  body: BODY,
};

function bogie(first: number, x: number): { placed: Placement[]; mates: MateSpec[] } {
  return {
    placed: [
      { part: "frame", at: [x, 20, 0] },
      { part: "wheels", at: [x - 20, 7, 0] },
      { part: "wheels", at: [x + 20, 7, 0] },
    ],
    mates: [
      { male: [first + 1, 0], female: [first, 1] },
      { male: [first + 2, 0], female: [first, 2] },
    ],
  };
}

function bogieCar(): Scenario {
  const front = bogie(1, 60);
  const rear = bogie(4, -60);
  return {
    parts: PARTS,
    placed: [{ part: "body", at: [0, 30, 0] }, ...front.placed, ...rear.placed],
    mates: [
      ...front.mates,
      ...rear.mates,
      { male: [0, 0], female: [1, 0] },
      { male: [0, 1], female: [4, 0] },
    ],
  };
}

function wagons(secondX: number): Placement[] {
  return [
    { part: "wagon", at: [0, 30, 0] },
    { part: "wheels", at: [-30, 7, 0] },
    { part: "wheels", at: [30, 7, 0] },
    { part: "wagon", at: [secondX, 30, 0] },
    { part: "wheels", at: [secondX - 30, 7, 0] },
    { part: "wheels", at: [secondX + 30, 7, 0] },
  ];
}

function twoPinTruck(): Scenario {
  const twoPins: Part = {
    connectors: [
      { at: [-10, 10, 0], axis: AXIS_POS_Y, gender: GENDER_FEMALE },
      { at: [10, 10, 0], axis: AXIS_POS_Y, gender: GENDER_FEMALE },
      { at: [-20, -13, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
      { at: [20, -13, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
    ],
  };
  const driverBody: Part = {
    connectors: [
      { at: [50, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
      { at: [70, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
      { at: [-60, -23, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
    ],
  };
  return {
    parts: { ...PARTS, frame: twoPins, body: driverBody },
    placed: [
      { part: "body", at: [0, 30, 0] },
      { part: "frame", at: [60, 20, 0] },
      { part: "wheels", at: [40, 7, 0] },
      { part: "wheels", at: [80, 7, 0] },
      { part: "wheels", at: [-60, 7, 0] },
    ],
    mates: [
      { male: [2, 0], female: [1, 2] },
      { male: [3, 0], female: [1, 3] },
      { male: [4, 0], female: [0, 2] },
      { male: [0, 0], female: [1, 0] },
      { male: [0, 1], female: [1, 1] },
    ],
  };
}

function pinAndBushCar(): Scenario {
  const pin: Part = {
    connectors: [
      { at: [0, -4, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
      { at: [0, 4, 0], axis: AXIS_POS_Y, gender: GENDER_MALE },
      { at: [0, 8, 0], axis: AXIS_POS_Y, gender: GENDER_MALE },
    ],
  };
  const bush: Part = { connectors: [{ at: [0, 0, 0], axis: AXIS_NEG_Y, gender: GENDER_FEMALE }] };
  const holedBody: Part = {
    connectors: [
      { at: [60, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_FEMALE },
      { at: [-60, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
    ],
  };
  const car = bogieCar();
  return {
    ...car,
    parts: { ...PARTS, body: holedBody, pin, bush },
    placed: [...car.placed, { part: "pin", at: [60, 25, 0] }, { part: "bush", at: [60, 33, 0] }],
    mates: [
      ...car.mates.filter((m) => !(m.male[0] === 0 && m.male[1] === 0)),
      { male: [7, 0], female: [1, 0] },
      { male: [7, 1], female: [0, 0] },
      { male: [7, 2], female: [8, 0] },
    ],
  };
}

function sharedBogie(): Scenario {
  const shortBody: Part = {
    connectors: [{ at: [0, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE }],
  };
  const shared = bogie(2, 0);
  return {
    parts: { ...PARTS, body: shortBody },
    placed: [{ part: "body", at: [0, 30, 0] }, { part: "body", at: [0, 30, 0] }, ...shared.placed],
    mates: [...shared.mates, { male: [0, 0], female: [2, 0] }, { male: [1, 0], female: [2, 0] }],
  };
}

const WAGON: Part = {
  connectors: [
    { at: [-30, -23, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
    { at: [30, -23, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
    { at: [50, 0, 0], axis: AXIS_POS_Y, gender: GENDER_FEMALE },
    { at: [-50, 0, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
  ],
};
const DRAWBAR: Part = {
  connectors: [
    { at: [-25, 0, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
    { at: [25, 0, 0], axis: AXIS_POS_Y, gender: GENDER_FEMALE },
  ],
};
const WAGON_AXLES: ReadonlyArray<MateSpec> = [
  { male: [1, 0], female: [0, 0] },
  { male: [2, 0], female: [0, 1] },
  { male: [4, 0], female: [3, 0] },
  { male: [5, 0], female: [3, 1] },
];

function stackedDrawbarWagons(): Scenario {
  return {
    parts: { ...PARTS, wagon: WAGON },
    placed: wagons(100),
    mates: [...WAGON_AXLES, { male: [3, 3], female: [0, 2] }],
  };
}

function drawbarPieceWagons(): Scenario {
  return {
    parts: { ...PARTS, wagon: WAGON, drawbar: DRAWBAR },
    placed: [...wagons(150), { part: "drawbar", at: [75, 30, 0] }],
    mates: [...WAGON_AXLES, { male: [6, 0], female: [0, 2] }, { male: [3, 3], female: [6, 1] }],
  };
}

function jacobsPair(): Scenario {
  const jacobsFrame: Part = {
    connectors: [
      { at: [-10, 10, 0], axis: AXIS_POS_Y, gender: GENDER_FEMALE },
      { at: [10, 10, 0], axis: AXIS_POS_Y, gender: GENDER_FEMALE },
      { at: [-20, -13, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
      { at: [20, -13, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
    ],
  };
  const carBody: Part = {
    connectors: [
      { at: [-60, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
      { at: [70, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
    ],
  };
  const otherBody: Part = {
    connectors: [
      { at: [60, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
      { at: [-70, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
    ],
  };
  const front = bogie(3, -150);
  const rear = bogie(6, 150);
  return {
    parts: { ...PARTS, jacobs: jacobsFrame, carA: carBody, carB: otherBody },
    placed: [
      { part: "carA", at: [-90, 30, 0] },
      { part: "carB", at: [90, 30, 0] },
      { part: "jacobs", at: [0, 20, 0] },
      ...front.placed,
      ...rear.placed,
      { part: "wheels", at: [-20, 7, 0] },
      { part: "wheels", at: [20, 7, 0] },
    ],
    mates: [
      ...front.mates,
      ...rear.mates,
      { male: [9, 0], female: [2, 2] },
      { male: [10, 0], female: [2, 3] },
      { male: [0, 0], female: [3, 0] },
      { male: [1, 0], female: [6, 0] },
      { male: [0, 1], female: [2, 0] },
      { male: [1, 1], female: [2, 1] },
    ],
  };
}

function spanBolsters(): Scenario {
  const bolster: Part = {
    connectors: [
      { at: [-60, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
      { at: [60, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
      { at: [0, 10, 0], axis: AXIS_POS_Y, gender: GENDER_FEMALE },
    ],
  };
  const spanBody: Part = {
    connectors: [
      { at: [-150, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
      { at: [150, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
    ],
  };
  const bogies = [bogie(3, -210), bogie(6, -90), bogie(9, 90), bogie(12, 210)];
  return {
    parts: { ...PARTS, bolster, span: spanBody },
    placed: [
      { part: "span", at: [0, 50, 0] },
      { part: "bolster", at: [-150, 30, 0] },
      { part: "bolster", at: [150, 30, 0] },
      ...bogies.flatMap((b) => b.placed),
    ],
    mates: [
      ...bogies.flatMap((b) => b.mates),
      { male: [1, 0], female: [3, 0] },
      { male: [1, 1], female: [6, 0] },
      { male: [2, 0], female: [9, 0] },
      { male: [2, 1], female: [12, 0] },
      { male: [0, 0], female: [1, 2] },
      { male: [0, 1], female: [2, 2] },
    ],
  };
}

function withEveryMateDoubled(scenario: Scenario): Scenario {
  return { ...scenario, mates: scenario.mates.flatMap((mate) => [mate, mate]) };
}

describe("RunningGearDetector", () => {
  it("reads joints, never rows: doubling every mate row leaves every outcome unchanged", () => {
    const scenarios = [
      bogieCar(),
      twoPinTruck(),
      pinAndBushCar(),
      stackedDrawbarWagons(),
      drawbarPieceWagons(),
      sharedBogie(),
      jacobsPair(),
      spanBolsters(),
    ];
    expect(scenarios.map((scenario) => run(withEveryMateDoubled(scenario)))).toEqual(
      scenarios.map(run),
    );
  });

  it("reads a car on two pivoting bogies as one vehicle with two bogie guides", () => {
    const gear = run(bogieCar());
    expect(gear.unresolvedRunningGear).toEqual([]);
    expect(gear.vehicleCouplings).toEqual([]);
    expect(gear.vehicles.map(outline)).toEqual([
      {
        guides: [
          ["bogiePivot", 60, 0, null],
          ["bogiePivot", -60, 1, null],
        ],
        body: [0],
        bogies: [
          { instances: [1, 2, 3], pivot: [60, 20, 0], wheelsets: [0, 1] },
          { instances: [4, 5, 6], pivot: [-60, 20, 0], wheelsets: [2, 3] },
        ],
        fixedAxles: [],
        wheelsets: [2, 3, 5, 6].map((instance) => wheelset(instance)),
      },
    ]);
  });

  it("reads fixed drivers with one bogie as mixed guides, the bogie being what carries from below", () => {
    const front = bogie(1, 60);
    const gear = run({
      parts: PARTS,
      placed: [
        { part: "body", at: [0, 30, 0] },
        ...front.placed,
        { part: "wheels", at: [-60, 7, 0] },
      ],
      mates: [...front.mates, { male: [0, 0], female: [1, 0] }, { male: [4, 0], female: [0, 3] }],
    });
    expect(gear.vehicles.map(outline)).toEqual([
      {
        guides: [
          ["bogiePivot", 60, 0, null],
          ["fixedAxle", -60, null, 2],
        ],
        body: [0, 4],
        bogies: [{ instances: [1, 2, 3], pivot: [60, 20, 0], wheelsets: [0, 1] }],
        fixedAxles: [2],
        wheelsets: [2, 3, 4].map((instance) => wheelset(instance)),
      },
    ]);
  });

  it("reads fixed drivers on two bogies as one vehicle with two bogie guides, never unresolved", () => {
    const car = bogieCar();
    const gear = run({
      ...car,
      placed: [...car.placed, { part: "wheels", at: [0, 7, 0] }],
      mates: [...car.mates, { male: [7, 0], female: [0, 9] }],
    });
    expect(gear.unresolvedRunningGear).toEqual([]);
    expect(gear.vehicles.map((v) => [v.guides.map((g) => g.kind), v.fixedAxles, v.body])).toEqual([
      [["bogiePivot", "bogiePivot"], [4], [0, 7]],
    ]);
  });

  it("never peels a wheeled sub-assembly whose pivot connectors point down", () => {
    const upsideDown: Part = {
      connectors: [
        { at: [0, 10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
        { at: [-20, -13, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
        { at: [20, -13, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
      ],
    };
    const roof: Part = { connectors: [{ at: [0, 0, 0], axis: AXIS_POS_Y, gender: GENDER_FEMALE }] };
    const gear = run({
      parts: { ...PARTS, frame: upsideDown, roof },
      placed: [...bogie(0, 0).placed, { part: "roof", at: [0, 40, 0] }],
      mates: [...bogie(0, 0).mates, { male: [0, 0], female: [3, 0] }],
    });
    expect(gear.vehicles.map((v) => [v.bogies.length, v.fixedAxles.length, v.body])).toEqual([
      [0, 2, [0, 1, 2, 3]],
    ]);
  });

  it("locks a truck held by two pins on distinct axis lines to its body, so its axles are fixed", () => {
    const gear = run(twoPinTruck());
    expect(gear.unresolvedRunningGear).toEqual([]);
    expect(gear.vehicles.map((v) => [v.bogies.length, v.fixedAxles.length, v.body])).toEqual([
      [0, 3, [0, 1, 2, 3, 4]],
    ]);
  });

  it("contracts a separate pivot pin with a bush stacked on it, so the bogie reads as with a moulded pin", () => {
    const gear = run(pinAndBushCar());
    expect(gear.unresolvedRunningGear).toEqual([]);
    expect(gear.vehicles.map((v) => [v.guides.map((g) => g.kind), v.bogies.length])).toEqual([
      [["bogiePivot", "bogiePivot"], 2],
    ]);
    const held = gear.vehicles.flatMap((v) => [...v.body, ...v.bogies.flatMap((b) => b.instances)]);
    expect(held.toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("peels a single-axle pony truck pivoted ahead of its axle on a radius arm", () => {
    const ponyArm: Part = {
      connectors: [
        { at: [-30, 10, 0], axis: AXIS_POS_Y, gender: GENDER_FEMALE },
        { at: [0, -13, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
      ],
    };
    const loco: Part = {
      connectors: [
        { at: [60, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
        { at: [20, -23, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
        { at: [-40, -23, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
      ],
    };
    const gear = run({
      parts: { ...PARTS, frame: ponyArm, body: loco },
      placed: [
        { part: "body", at: [0, 30, 0] },
        { part: "frame", at: [90, 20, 0] },
        { part: "wheels", at: [90, 7, 0] },
        { part: "wheels", at: [20, 7, 0] },
        { part: "wheels", at: [-40, 7, 0] },
      ],
      mates: [
        { male: [2, 0], female: [1, 1] },
        { male: [3, 0], female: [0, 1] },
        { male: [4, 0], female: [0, 2] },
        { male: [0, 0], female: [1, 0] },
      ],
    });
    expect(
      gear.vehicles.map((v) => [v.guides.map((g) => [g.kind, g.position]), v.bogies.length]),
    ).toEqual([
      [
        [
          ["bogiePivot", 50],
          ["fixedAxle", -50],
        ],
        1,
      ],
    ]);
  });

  it("couples two wagons through stacked drawbars at their shared pivot, and through a separate drawbar piece with no shared pivot", () => {
    const stacked = run(stackedDrawbarWagons());
    expect(stacked.vehicles).toHaveLength(2);
    expect(stacked.vehicleCouplings).toEqual([
      {
        vehicles: [0, 1],
        mates: [{ male: { instance: 3, connector: 3 }, female: { instance: 0, connector: 2 } }],
        pivot: [50, 30, 0],
      },
    ]);
    const piece = run(drawbarPieceWagons());
    expect(piece.vehicles.map((v) => v.body)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
    expect(piece.vehicleCouplings.map((c) => [c.vehicles, c.mates.length, c.pivot])).toEqual([
      [[0, 1], 2, null],
    ]);
  });

  it("couples two wagons whose coupling faces only touch, since face contact is free about the vertical", () => {
    const facedWagon: Part = {
      connectors: [
        { at: [-30, -23, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
        { at: [30, -23, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE },
        { at: [50, 0, 0], axis: AXIS_POS_X, gender: GENDER_MALE, shape: FACE },
        { at: [-50, 0, 0], axis: AXIS_NEG_X, gender: GENDER_FEMALE, shape: FACE_RECEIVER },
      ],
    };
    const gear = run({
      parts: { ...PARTS, wagon: facedWagon },
      placed: wagons(100),
      mates: [
        { male: [1, 0], female: [0, 0] },
        { male: [2, 0], female: [0, 1] },
        { male: [4, 0], female: [3, 0] },
        { male: [5, 0], female: [3, 1] },
        { male: [0, 2], female: [3, 3] },
      ],
    });
    expect(gear.vehicles.map((v) => v.body)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
    expect(gear.vehicleCouplings.map((c) => c.vehicles)).toEqual([[0, 1]]);
  });

  it("reports a bogie carrying two bodies on one line, naming its wheelsets and pivot mates", () => {
    const gear = run(sharedBogie());
    expect(gear.vehicles).toEqual([]);
    expect(
      gear.unresolvedRunningGear.map((r) => ({
        reason: r.reason,
        instances: r.instances,
        wheelsets: r.wheelsets.map((w) => w.members.map((m) => m.instance)),
        mates: r.mates.map((m) => [m.male.instance, m.female.instance]),
      })),
    ).toEqual([
      {
        reason: "sharedBogie",
        instances: [0, 1, 2, 3, 4],
        wheelsets: [
          [3, 3],
          [4, 4],
        ],
        mates: [
          [0, 2],
          [1, 2],
        ],
      },
    ]);
  });

  it("reports a body on a single bogie, with the unread band rows on its instances", () => {
    const unreadBody: Part = {
      connectors: [{ at: [0, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE }],
      rolling: wheels([], [{ reason: "faceted", axis: 2 }]),
    };
    const single = bogie(1, 0);
    const gear = run({
      parts: { ...PARTS, body: unreadBody },
      placed: [{ part: "body", at: [0, 30, 0] }, ...single.placed],
      mates: [...single.mates, { male: [0, 0], female: [1, 0] }],
    });
    expect(gear.unreadRollingBands).toEqual({ instance: [0], band: [0], reason: ["faceted"] });
    expect(
      gear.unresolvedRunningGear.map((r) => [
        r.reason,
        r.instances,
        r.wheelsets.length,
        r.unreadRows,
      ]),
    ).toEqual([["fewerThanTwoGuides", [0, 1, 2, 3], 2, [0]]]);
  });

  it("reports links whose pivot lies inside a support span: a Jacobs bogie and span bolsters", () => {
    const jacobs = run(jacobsPair());
    expect(jacobs.vehicles).toEqual([]);
    expect(jacobs.unresolvedRunningGear.map(reportedLink)).toEqual([
      { reason: "pivotInsideSupportSpan", instances: [0, 2, 9, 10], mates: [[0, 1, 2, 0]] },
      { reason: "pivotInsideSupportSpan", instances: [1, 2, 9, 10], mates: [[1, 1, 2, 1]] },
    ]);
    const span = run(spanBolsters());
    expect(span.vehicles).toEqual([]);
    expect(span.unresolvedRunningGear.map(reportedLink)).toEqual([
      {
        reason: "pivotInsideSupportSpan",
        instances: [0, 1, 2],
        mates: [
          [0, 0, 1, 2],
          [0, 1, 2, 2],
        ],
      },
    ]);
  });

  it("reports a wheelset split across a pivot, including the known-limit body-side sleeve", () => {
    const shortBody: Part = {
      connectors: [
        { at: [0, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE },
        { at: [-20, -23, 0], axis: AXIS_NEG_Z, gender: GENDER_FEMALE, shape: AXLE_HOLE },
      ],
    };
    const lockedAxle: ConnectorSpec = { ...AXLE_MALE, shape: AXLE };
    const near: Part = { connectors: [AXLE_MALE], rolling: wheels([[44, 54]]) };
    const sleeve: Part = { connectors: [lockedAxle], rolling: wheels([[-54, -44]]) };
    const gear = run({
      parts: { ...PARTS, body: shortBody, near, sleeve },
      placed: [
        { part: "body", at: [0, 30, 0] },
        { part: "frame", at: [0, 20, 0] },
        { part: "near", at: [-20, 7, 0] },
        { part: "sleeve", at: [-20, 7, 0] },
      ],
      mates: [
        { male: [2, 0], female: [1, 1] },
        { male: [3, 0], female: [0, 1] },
        { male: [0, 0], female: [1, 0] },
      ],
    });
    expect(
      gear.unresolvedRunningGear.map((r) => [r.reason, r.instances, r.wheelsets.length]),
    ).toEqual([["wheelsetSpansPivot", [0, 1, 2, 3], 1]]);
  });

  it("keeps a bogie intact under a horizontal finger hinge, and reads a vertical one on the body as an attachment", () => {
    const hingedFrame: Part = {
      connectors: [
        ...FRAME.connectors,
        { at: [30, 0, 0], axis: AXIS_POS_Z, gender: GENDER_FEMALE },
      ],
    };
    const casing: Part = { connectors: [{ at: [0, 0, 0], axis: AXIS_NEG_Z, gender: GENDER_MALE }] };
    const hingedBody: Part = {
      connectors: [
        ...BODY.connectors,
        { at: [0, 20, 30], axis: AXIS_POS_Y, gender: GENDER_FEMALE },
      ],
    };
    const door: Part = { connectors: [{ at: [0, 0, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE }] };
    const car = bogieCar();
    const gear = run({
      parts: { ...PARTS, frame: hingedFrame, body: hingedBody, casing, door },
      placed: [
        ...car.placed,
        { part: "casing", at: [90, 20, 0] },
        { part: "door", at: [0, 50, 30] },
      ],
      mates: [...car.mates, { male: [7, 0], female: [1, 3] }, { male: [8, 0], female: [0, 10] }],
    });
    expect(gear.unresolvedRunningGear).toEqual([]);
    expect(gear.vehicles.map((v) => [v.body, v.bogies.map((b) => b.instances)])).toEqual([
      [
        [0, 8],
        [
          [1, 2, 3, 7],
          [4, 5, 6],
        ],
      ],
    ]);
  });

  it("unseats co-linear round bands on the body above the support plane, between the pivots and outermost alike", () => {
    for (const x of [0, 150]) {
      const raised: Part = {
        connectors: [{ at: [-x, -93, 0], axis: AXIS_POS_Z, gender: GENDER_MALE }],
        rolling: WHEEL_PAIR,
      };
      const car = bogieCar();
      const gear = run({
        ...car,
        parts: { ...PARTS, raised },
        placed: [...car.placed, { part: "raised", at: [x, 100, 0] }],
        mates: [...car.mates, { male: [7, 0], female: [0, 9] }],
      });
      expect(gear.unresolvedRunningGear).toEqual([]);
      expect(gear.vehicles.map(outline)).toEqual([
        {
          guides: [
            ["bogiePivot", 60, 0, null],
            ["bogiePivot", -60, 1, null],
          ],
          body: [0, 7],
          bogies: [
            { instances: [1, 2, 3], pivot: [60, 20, 0], wheelsets: [0, 1] },
            { instances: [4, 5, 6], pivot: [-60, 20, 0], wheelsets: [2, 3] },
          ],
          fixedAxles: [],
          wheelsets: [...[2, 3, 5, 6].map((instance) => wheelset(instance)), wheelset(7, false)],
        },
      ]);
    }
  });

  it("seats wheelsets of different radii whose rail tops are exactly level", () => {
    const small: Part = {
      connectors: [AXLE_MALE],
      rolling: wheels(
        [
          [44, 54],
          [-54, -44],
        ],
        [],
        5,
      ),
    };
    const car = bogieCar();
    const gear = run({
      ...car,
      parts: { ...PARTS, small },
      placed: car.placed.map((placement, index) =>
        index === 5 || index === 6
          ? { part: "small", at: [placement.at[0], 5, placement.at[2]] as const }
          : placement,
      ),
    });
    expect(gear.unresolvedRunningGear).toEqual([]);
    expect(
      gear.vehicles.map((vehicle) => ({
        bogies: vehicle.bogies.map((carried) => carried.wheelsets),
        seated: vehicle.wheelsets.map((recorded) => recorded.seated),
        radii: vehicle.wheelsets.map((recorded) => recorded.rollingRadius.numerator),
      })),
    ).toEqual([
      {
        bogies: [
          [0, 1],
          [2, 3],
        ],
        seated: [true, true, true, true],
        radii: ["7", "7", "5", "5"],
      },
    ]);
  });

  it("leaves a raised decorative truck an attachment once the support plane unseats its wheelsets", () => {
    const carrier: Part = {
      connectors: [...BODY.connectors, { at: [0, -10, 0], axis: AXIS_NEG_Y, gender: GENDER_MALE }],
    };
    const car = bogieCar();
    const decorative = bogie(7, 0);
    const gear = run({
      parts: { ...PARTS, body: carrier },
      placed: [
        ...car.placed,
        { part: "frame", at: [0, 25, 0] },
        { part: "wheels", at: [-20, 12, 0] },
        { part: "wheels", at: [20, 12, 0] },
      ],
      mates: [...car.mates, ...decorative.mates, { male: [0, 10], female: [7, 0] }],
    });
    expect(gear.unresolvedRunningGear).toEqual([]);
    expect(gear.vehicles.map(outline)).toEqual([
      {
        guides: [
          ["bogiePivot", 60, 0, null],
          ["bogiePivot", -60, 1, null],
        ],
        body: [0, 7, 8, 9],
        bogies: [
          { instances: [1, 2, 3], pivot: [60, 20, 0], wheelsets: [0, 1] },
          { instances: [4, 5, 6], pivot: [-60, 20, 0], wheelsets: [2, 3] },
        ],
        fixedAxles: [],
        wheelsets: [
          ...[2, 3, 5, 6].map((instance) => wheelset(instance)),
          wheelset(8, false),
          wheelset(9, false),
        ],
      },
    ]);
  });

  it("reports a vehicle whose bogies' axle heights don't identify in their lowest common frame", () => {
    const front = bogie(1, 60);
    const rear = bogie(4, -60);
    const gear = run({
      parts: PARTS,
      submodels: [
        [0, 0.3, 0],
        [0, 0, 0],
      ],
      placed: [
        { part: "body", at: [0, 30, 0] },
        ...front.placed.map((placement) => ({ ...placement, submodel: 0 })),
        ...rear.placed.map((placement) => ({ ...placement, submodel: 1 })),
      ],
      mates: [
        ...front.mates,
        ...rear.mates,
        { male: [0, 0], female: [1, 0] },
        { male: [0, 1], female: [4, 0] },
      ],
    });
    expect(gear.vehicles).toEqual([]);
    expect(
      gear.unresolvedRunningGear.map((r) => ({
        reason: r.reason,
        instances: r.instances,
        wheelsets: r.wheelsets.map((w) => w.members.map((m) => m.instance)),
      })),
    ).toEqual([
      {
        reason: "supportPlaneUnidentified",
        instances: [0, 1, 2, 3, 4, 5, 6],
        wheelsets: [
          [5, 5],
          [2, 2],
        ],
      },
    ]);
  });

  it("orders end candidates by tip and leaves out inward and off-axis connectors", () => {
    const gear = run({
      ...bogieCar(),
      exposed: [4, 5, 6, 7, 8].map((connector) => [0, connector] as const),
    });
    expect(gear.vehicles[0]?.frontEndCandidates).toEqual([
      { instance: 0, connector: 8 },
      { instance: 0, connector: 4 },
    ]);
    expect(gear.vehicles[0]?.rearEndCandidates).toEqual([{ instance: 0, connector: 5 }]);
  });
});
