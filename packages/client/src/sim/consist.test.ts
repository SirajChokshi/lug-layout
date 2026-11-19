import type {
  ModelRunningGear,
  ModelVehicle,
  VehicleCoupling,
  VehicleWheelset,
} from "@brr/schema/bundle";
import { describe, expect, it } from "vitest";
import { BOX_FLOATS } from "../edit/local-box.ts";
import { plannedConsists } from "./consist.ts";

const SIX = { numerator: "6", denominator: "1" };
const SEVEN = { numerator: "7", denominator: "1" };
const EIGHT = { numerator: "8", denominator: "1" };
const HALF_LENGTH_LDU = 50;
const AXLE_OFFSET_LDU = 30;
const AXLE_HEIGHT_LDU = 7;

function axle(x: number, height = AXLE_HEIGHT_LDU): VehicleWheelset {
  return {
    members: [{ instance: 0, surface: 0 }],
    rail: 0,
    frame: -1,
    dimension: 2,
    trackCentre: 0,
    contactRadii: [SEVEN, SEVEN],
    rollingRadius: SEVEN,
    rollingRadiusOnRail: [SEVEN],
    seated: true,
    axisLine: [
      [x, height, -50],
      [x, height, 50],
    ],
  };
}

function wagon(x: number, instance: number): ModelVehicle {
  return {
    origin: [x, 0],
    yaw: 0,
    guides: [
      { kind: "fixedAxle", position: AXLE_OFFSET_LDU, bogie: null, wheelset: 0 },
      { kind: "fixedAxle", position: -AXLE_OFFSET_LDU, bogie: null, wheelset: 1 },
    ],
    body: [instance],
    bogies: [],
    fixedAxles: [0, 1],
    wheelsets: [axle(x + AXLE_OFFSET_LDU), axle(x - AXLE_OFFSET_LDU)],
    frontEndCandidates: [],
    rearEndCandidates: [],
  };
}

function bounds(centres: ReadonlyArray<number>): Float64Array {
  const boxes = new Float64Array(centres.length * BOX_FLOATS);
  centres.forEach((x, i) => {
    boxes.set([x - HALF_LENGTH_LDU, 0, -20, x + HALF_LENGTH_LDU, 30, 20], i * BOX_FLOATS);
  });
  return boxes;
}

function pair(couplings: VehicleCoupling[]): ModelRunningGear {
  return {
    vehicles: [wagon(100, 0), wagon(-100, 1)],
    vehicleCouplings: couplings,
    unresolvedRunningGear: [],
    unreadRollingBands: { instance: [], band: [], reason: [] },
  };
}

function link(pivot: VehicleCoupling["pivot"]): VehicleCoupling {
  return {
    vehicles: [0, 1],
    mates: [{ male: { instance: 1, connector: 0 }, female: { instance: 0, connector: 0 } }],
    pivot,
  };
}

function ends(gear: ModelRunningGear) {
  return plannedConsists(gear, bounds([100, -100])).map((consist) =>
    consist.map(({ vehicle, spec }) => ({
      vehicle,
      front: spec.geometry?.frontCoupler,
      rear: spec.geometry?.rearCoupler,
      lengthLdu: spec.lengthLdu,
    })),
  );
}

describe("Planned consists until E12 (owner, option 1)", () => {
  it("couples two vehicles at their link's baked pivot and ends them at their own part bounds", () => {
    expect(ends(pair([link([0, 30, 0])]))).toEqual([
      [
        {
          vehicle: 0,
          front: { xLdu: 50, zLdu: 0, mount: "body" },
          rear: { xLdu: -100, zLdu: 0, mount: "body" },
          lengthLdu: 150,
        },
        {
          vehicle: 1,
          front: { xLdu: 100, zLdu: 0, mount: "body" },
          rear: { xLdu: -50, zLdu: 0, mount: "body" },
          lengthLdu: 150,
        },
      ],
    ]);
  });

  it("runs vehicles as separate consists when their link has no shared pivot or they have no link", () => {
    const apart = [
      [
        {
          vehicle: 0,
          front: { xLdu: 50, zLdu: 0, mount: "body" },
          rear: { xLdu: -50, zLdu: 0, mount: "body" },
          lengthLdu: 100,
        },
      ],
      [
        {
          vehicle: 1,
          front: { xLdu: 50, zLdu: 0, mount: "body" },
          rear: { xLdu: -50, zLdu: 0, mount: "body" },
          lengthLdu: 100,
        },
      ],
    ];
    expect(ends(pair([link(null)]))).toEqual(apart);
    expect(ends(pair([]))).toEqual(apart);
  });

  it("packs each guide's first wheelset in row order: its transformed axle height and recorded rolling radius", () => {
    const coned: VehicleWheelset = { ...axle(140), contactRadii: [SIX, EIGHT] };
    const trucked: ModelVehicle = {
      ...wagon(100, 0),
      guides: [
        { kind: "bogiePivot", position: AXLE_OFFSET_LDU, bogie: 0, wheelset: null },
        { kind: "fixedAxle", position: -AXLE_OFFSET_LDU, bogie: null, wheelset: 2 },
      ],
      bogies: [{ instances: [1], pivot: [130, 20, 0], wheelsets: [1, 0] }],
      fixedAxles: [2],
      wheelsets: [coned, axle(120, 7.25), axle(70, 6.5)],
    };
    const gear = { ...pair([]), vehicles: [trucked] };
    const first = plannedConsists(gear, bounds([100, 130]))[0]?.[0];
    expect(first?.spec.guideWheelsets).toEqual({
      front: { axleYLdu: AXLE_HEIGHT_LDU, rollingRadius: SEVEN },
      rear: { axleYLdu: 6.5, rollingRadius: SEVEN },
    });
  });
});
