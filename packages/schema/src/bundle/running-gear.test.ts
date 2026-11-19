import { describe, expect, it } from "vitest";
import { decode } from "../decode/index.ts";
import { ModelFile, ModelVehicle, UnreadRollingBands, unreadRollingBandsFit } from "./index.ts";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const SEVEN = { numerator: "7", denominator: "1" };
const TREAD = { source: "measured", axis: 2, at: [0, 0], from: 704, to: 864, radii: [112, 112] };

function wheelset(surface = 0, seated = true) {
  return {
    members: [{ instance: 0, surface }],
    rail: 0,
    frame: -1,
    dimension: 2,
    trackCentre: 0,
    contactRadii: [SEVEN, SEVEN],
    rollingRadius: SEVEN,
    rollingRadiusOnRail: [SEVEN, null],
    seated,
    axisLine: [
      [0, 7, -50.5],
      [0, 7, 50.5],
    ],
  };
}

function vehicle(overrides: Record<string, unknown> = {}) {
  return {
    origin: [0, 0],
    yaw: 0,
    guides: [
      { kind: "fixedAxle", position: 30, bogie: null, wheelset: 0 },
      { kind: "fixedAxle", position: -30, bogie: null, wheelset: 1 },
    ],
    body: [0],
    bogies: [],
    fixedAxles: [0, 1],
    wheelsets: [wheelset(), wheelset()],
    frontEndCandidates: [],
    rearEndCandidates: [],
    ...overrides,
  };
}

function modelFile(overrides: Record<string, unknown> = {}) {
  return {
    name: "custom",
    file: "custom.json",
    source: "custom.ldr",
    retrieved: "2026-11-18",
    sha256: "0".repeat(64),
    sections: [],
    inlinePartsResolvedToOfficial: [],
    parts: ["ldraw:wheel"],
    shapes: [
      {
        id: "ldraw:wheel",
        title: "wheel",
        role: "model",
        file: "wheel.glb",
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        studs: [],
        rolling: { stepsPerLdu: 16, surfaces: [TREAD], unread: [{ reason: "faceted", axis: 2 }] },
      },
    ],
    lattice: null,
    vehicles: [],
    vehicleCouplings: [],
    unresolvedRunningGear: [],
    unreadRollingBands: { instance: [0], band: [0], reason: ["faceted"] },
    cover: { studs: 0, coveredStuds: 0, keptOpenBelow: 0, visibleBits: [], cells: null },
    instances: { part: [0], color: [16], matrix: IDENTITY },
    partTransforms: IDENTITY,
    submodels: { parent: [], matrices: [], ofPart: [-1] },
    ...overrides,
  };
}

function unresolved(unreadRows: ReadonlyArray<number>) {
  return { reason: "fewerThanTwoGuides", instances: [0], wheelsets: [], mates: [], unreadRows };
}

function columns(reason: ReadonlyArray<string>, band: ReadonlyArray<number> = reason.map(() => 0)) {
  return { instance: reason.map(() => 0), band, reason };
}

function decodes(overrides: Record<string, unknown>): boolean {
  return decode(ModelFile, modelFile(overrides)).ok;
}

function accepted(overrides: Record<string, unknown>): boolean {
  return decode(ModelVehicle, vehicle(overrides)).ok;
}

describe("unread rolling bands", () => {
  it("index the part's unread bands for bake reasons and its surfaces for direction and across", () => {
    const rolling = [{ surfaces: 1, unread: 2 }, null];
    const fits = (instance: number, band: number, reason: "faceted" | "direction" | "across") =>
      unreadRollingBandsFit(
        { instance: [instance], band: [band], reason: [reason] },
        [0, 1],
        rolling,
      );
    expect(fits(0, 1, "faceted")).toBe(true);
    expect(fits(0, 0, "across")).toBe(true);
    expect(fits(0, 2, "faceted")).toBe(false);
    expect(fits(0, 1, "direction")).toBe(false);
    expect(fits(1, 0, "faceted")).toBe(false);
    expect(fits(2, 0, "faceted")).toBe(false);
  });

  it("are three columns of one length, with every bake reason and the two model reasons", () => {
    const reasons = [
      "unoriented",
      "centre",
      "radius",
      "width",
      "faceted",
      "partial",
      "facing",
      "irregular",
      "direction",
      "across",
    ];
    expect(decode(UnreadRollingBands, columns(reasons)).ok).toBe(true);
    expect(decode(UnreadRollingBands, columns(["faceted"], [0, 1])).ok).toBe(false);
    expect(decode(UnreadRollingBands, columns(["wobbly"])).ok).toBe(false);
  });
});

describe("running gear on a model file", () => {
  it("accepts a vehicle, a coupling and an unresolved report that name what the model has", () => {
    const file = modelFile({
      vehicles: [vehicle(), vehicle()],
      vehicleCouplings: [
        {
          vehicles: [0, 1],
          mates: [{ male: { instance: 0, connector: 0 }, female: { instance: 0, connector: 1 } }],
          pivot: [50, 30, 0],
        },
      ],
      unresolvedRunningGear: [unresolved([0])],
    });
    expect(decode(ModelFile, file).ok).toBe(true);
  });

  it("refuses rows, reports, couplings and vehicles that name what the model lacks", () => {
    expect(decodes({ unreadRollingBands: { instance: [0], band: [1], reason: ["faceted"] } })).toBe(
      false,
    );
    expect(decodes({ unresolvedRunningGear: [unresolved([1])] })).toBe(false);
    expect(decodes({ unresolvedRunningGear: [{ ...unresolved([]), instances: [3] }] })).toBe(false);
    expect(
      decodes({
        vehicles: [vehicle()],
        vehicleCouplings: [
          {
            vehicles: [0, 0],
            mates: [{ male: { instance: 0, connector: 0 }, female: { instance: 0, connector: 1 } }],
            pivot: null,
          },
        ],
      }),
    ).toBe(false);
    expect(decodes({ vehicles: [vehicle({ body: [4] })] })).toBe(false);
  });
});

describe("ModelVehicle", () => {
  it("refuses guides and axles that name a bogie, a wheelset the vehicle lacks or an unseated wheelset", () => {
    expect(accepted({})).toBe(true);
    expect(
      accepted({
        guides: [
          { kind: "bogiePivot", position: 30, bogie: 0, wheelset: null },
          { kind: "fixedAxle", position: -30, bogie: null, wheelset: 1 },
        ],
      }),
    ).toBe(false);
    expect(
      accepted({
        guides: [
          { kind: "fixedAxle", position: 30, bogie: null, wheelset: null },
          { kind: "fixedAxle", position: -30, bogie: null, wheelset: 1 },
        ],
      }),
    ).toBe(false);
    expect(accepted({ fixedAxles: [0, 2] })).toBe(false);
    expect(accepted({ wheelsets: [wheelset(), wheelset(0, false)] })).toBe(false);
    const withUnseated = { wheelsets: [wheelset(), wheelset(), wheelset(0, false)] };
    expect(
      accepted({
        ...withUnseated,
        bogies: [{ instances: [0], pivot: [0, 0, 0], wheelsets: [2] }],
      }),
    ).toBe(false);
    expect(
      accepted({
        ...withUnseated,
        guides: [
          { kind: "fixedAxle", position: 30, bogie: null, wheelset: 0 },
          { kind: "fixedAxle", position: -30, bogie: null, wheelset: 2 },
        ],
      }),
    ).toBe(false);
    expect(
      accepted({ fixedAxles: [0, 1], wheelsets: [wheelset(), wheelset(), wheelset(0, false)] }),
    ).toBe(true);
  });
});
