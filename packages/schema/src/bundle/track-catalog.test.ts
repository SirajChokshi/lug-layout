import { pose16, pose16Equals, ZETA16_ORDER, zeta16 } from "@brr/math";
import { describe, expect, it } from "vitest";
import { decode } from "../decode/index.ts";
import { BundleIndex, TrackCatalog } from "./index.ts";

const straight53401 = {
  id: "ldraw:53401",
  part: "ldraw:53401",
  title: "Train Track 6 Studs Wide Straight",
  kind: "straight",
  system: "lego-plastic",
  joinClass: "lego-train",
  status: "certified",
  connectors: [
    {
      coefficients: ["0", "0", "0", "0", "0", "0", "0", "0"],
      heading: 8,
      status: "certified",
      residualLdu: 0,
      rail: 0,
      railResidualLdu: 0,
    },
    {
      coefficients: ["16", "0", "0", "0", "0", "0", "0", "0"],
      heading: 0,
      status: "certified",
      residualLdu: 0,
      rail: 0,
      railResidualLdu: 0,
    },
  ],
  routes: [{ from: 0, to: 1, lengthLdu: 320, segments: [{ kind: "straight", lengthLdu: 320 }] }],
  partFrame: { xLdu: 160, zLdu: 0, headingHalfSteps: 0 },
};

function catalogWith(piece: unknown): unknown {
  return { n: ZETA16_ORDER, pieces: [piece] };
}

describe("TrackCatalog", () => {
  it("turns connector coefficients into exact poses", () => {
    const decoded = decode(TrackCatalog, catalogWith(straight53401));
    if (!decoded.ok) throw new Error(JSON.stringify(decoded.issues));
    const [first, second] = decoded.value.pieces[0]?.connectors ?? [];
    const far = pose16(zeta16([16n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), 0);
    expect(second !== undefined && pose16Equals(second.pose, far)).toBe(true);
    expect(first?.pose.heading).toBe(8);
  });

  it("refuses a route that joins a connector to itself", () => {
    const loop = { ...straight53401, routes: [{ ...straight53401.routes[0], to: 0 }] };
    expect(decode(TrackCatalog, catalogWith(loop))).toEqual({
      ok: false,
      issues: [
        {
          path: "$.pieces.0",
          message: "every route must join two different connectors of its piece",
        },
      ],
    });
  });

  it("refuses a coefficient that is not an integer", () => {
    const [connector] = straight53401.connectors;
    const fractional = {
      ...straight53401,
      connectors: [{ ...connector, coefficients: ["0.5", "0", "0", "0", "0", "0", "0", "0"] }],
    };
    const decoded = decode(TrackCatalog, catalogWith(fractional));
    expect(decoded.ok ? [] : decoded.issues.map((issue) => issue.path)).toEqual([
      "$.pieces.0.connectors.0.coefficients.0",
    ]);
  });
});

const SOURCE = { kind: "github-mirror", repo: "ldraw", commit: "0", root: "" };
const ZERO_HASH = "0".repeat(64);
const RAIL = {
  railPart: "rail",
  railHeads: [
    { from: "-53.1", to: "-46.9" },
    { from: "46.9", to: "53.1" },
  ],
};

function indexWith(rail: number | null, rails: ReadonlyArray<typeof RAIL> | null): unknown {
  return {
    bundleVersion: "0123456789abcdef",
    unit: "LDU",
    upAxis: "+Y",
    lod: "standard",
    source: SOURCE,
    studPrimitives: [],
    colors: [],
    models: [],
    catalogParts: [],
    modified: "modified from LDraw",
    disclaimer: "not affiliated",
    inputs: { ldraw: SOURCE, omr: SOURCE, lockSha256: ZERO_HASH, paletteSha256: ZERO_HASH },
    trackCatalog: catalogWith({
      ...straight53401,
      connectors: straight53401.connectors.map((connector) => ({
        ...connector,
        rail,
        railResidualLdu: rail === null ? null : 0,
      })),
    }),
    trackShapes: [],
    tablePlane: { part: "table", depthBelowTopLdu: 8 },
    compiler: rails === null ? null : { file: "compile.wasm", unofficialAllowlist: [], rails },
    connectors: { file: "connectors.json" },
    connectivity: { file: "connectivity.json" },
    crosswalk: { file: "crosswalk.json" },
    partTable: { file: "parts.json" },
    creditTable: { file: "credits.json" },
    thumbnails: [],
  };
}

describe("BundleIndex", () => {
  it("accepts track connectors that name one of the compiler's rails or none", () => {
    expect(decode(BundleIndex, indexWith(0, [RAIL])).ok).toBe(true);
    expect(decode(BundleIndex, indexWith(null, null)).ok).toBe(true);
  });

  it("refuses a track connector naming a rail the compiler's rails[] lacks", () => {
    const refused = [indexWith(1, [RAIL]), indexWith(0, null)].map((index) => {
      const decoded = decode(BundleIndex, index);
      return decoded.ok ? [] : decoded.issues.map((issue) => issue.message);
    });
    expect(refused).toEqual([
      ["a track connector names a rail the compiler's rails[] lacks"],
      ["a track connector names a rail the compiler's rails[] lacks"],
    ]);
  });
});
