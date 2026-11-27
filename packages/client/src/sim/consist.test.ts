import type {
  ModelRunningGear,
  ModelVehicle,
  VehicleCoupling,
  VehicleWheelset,
} from "@brr/schema/bundle";
import { describe, expect, it } from "vitest";
import { BOX_FLOATS } from "../edit/local-box.ts";
import { plannedConsist, railTopOn } from "./consist.ts";

const SEVEN = { numerator: "7", denominator: "1" };
const FIFTEEN_HALVES = { numerator: "15", denominator: "2" };
const HALF_LENGTH_LDU = 50;
const AXLE_OFFSET_LDU = 30;
const AXLE_HEIGHT_LDU = 7;
const SECOND_RAIL = 1;

function axle(x: number, height = AXLE_HEIGHT_LDU): VehicleWheelset {
  return {
    members: [{ instance: 0, surface: 0 }],
    rail: 0,
    frame: -1,
    dimension: 2,
    trackCentre: 0,
    contactRadii: [SEVEN, SEVEN],
    rollingRadius: SEVEN,
    rollingRadiusOnRail: [SEVEN, FIFTEEN_HALVES],
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

function ends(gear: ModelRunningGear, boxes: Float64Array, reversed = false) {
  return plannedConsist(gear, boxes, reversed).map(({ vehicle, spec }) => ({
    vehicle,
    front: spec.geometry?.frontCoupler,
    rear: spec.geometry?.rearCoupler,
    lengthLdu: spec.lengthLdu,
  }));
}

describe("A model's vehicles as one consist in travel order", () => {
  it("couples two vehicles at their link's baked pivot and ends them at their own part bounds, mirrored when reversed", () => {
    const gear = pair([link([0, 30, 0])]);
    const boxes = bounds([100, -100]);
    expect({ ahead: ends(gear, boxes), reversed: ends(gear, boxes, true) }).toEqual({
      ahead: [
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
      reversed: [
        {
          vehicle: 1,
          front: { xLdu: 50, zLdu: 0, mount: "body" },
          rear: { xLdu: -100, zLdu: 0, mount: "body" },
          lengthLdu: 150,
        },
        {
          vehicle: 0,
          front: { xLdu: 100, zLdu: 0, mount: "body" },
          rear: { xLdu: -50, zLdu: 0, mount: "body" },
          lengthLdu: 150,
        },
      ],
    });
  });

  it("ends both vehicles at their part bounds when their link has no shared pivot or they have no link", () => {
    const apart = [
      {
        vehicle: 0,
        front: { xLdu: 50, zLdu: 0, mount: "body" },
        rear: { xLdu: -50, zLdu: 0, mount: "body" },
        lengthLdu: 100,
      },
      {
        vehicle: 1,
        front: { xLdu: 50, zLdu: 0, mount: "body" },
        rear: { xLdu: -50, zLdu: 0, mount: "body" },
        lengthLdu: 100,
      },
    ];
    const boxes = bounds([100, -100]);
    expect({ unpivoted: ends(pair([link(null)]), boxes), unlinked: ends(pair([]), boxes) }).toEqual(
      { unpivoted: apart, unlinked: apart },
    );
  });

  it("mounts an end on the bogie that holds the part reaching furthest that way", () => {
    const trucked: ModelVehicle = {
      ...wagon(100, 0),
      guides: [
        { kind: "bogiePivot", position: AXLE_OFFSET_LDU, bogie: 0, wheelset: null },
        { kind: "fixedAxle", position: -AXLE_OFFSET_LDU, bogie: null, wheelset: 1 },
      ],
      bogies: [{ instances: [1], pivot: [130, 20, 0], wheelsets: [0] }],
      fixedAxles: [1],
    };
    const gear = { ...pair([]), vehicles: [trucked] };
    expect(ends(gear, bounds([100, 140]))).toEqual([
      {
        vehicle: 0,
        front: { xLdu: 90, zLdu: 0, mount: "frontBogie" },
        rear: { xLdu: -50, zLdu: 0, mount: "body" },
        lengthLdu: 140,
      },
    ]);
  });

  it("stands a vehicle's rail top at its lowest seated axle less that wheelset's rolling radius on the laid rail, and nowhere on a rail a seated wheelset doesn't meet", () => {
    const vehicle: ModelVehicle = {
      ...wagon(100, 0),
      wheelsets: [axle(130), axle(70, 6.5)],
    };
    const offRail: ModelVehicle = {
      ...vehicle,
      wheelsets: [
        vehicle.wheelsets[0] as VehicleWheelset,
        { ...axle(70), rollingRadiusOnRail: [SEVEN, null] },
      ],
    };
    expect({
      recorded: railTopOn(vehicle, 0),
      second: railTopOn(vehicle, SECOND_RAIL),
      offRail: railTopOn(offRail, SECOND_RAIL),
    }).toEqual({ recorded: -0.5, second: -1, offRail: null });
  });
});
