import { pose16, pose16Equals, ZETA16_ORDER, zeta16 } from "@brr/math";
import { describe, expect, it } from "vitest";
import { decode } from "../decode/index.ts";
import { TrackCatalog } from "./index.ts";

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
    },
    {
      coefficients: ["16", "0", "0", "0", "0", "0", "0", "0"],
      heading: 0,
      status: "certified",
      residualLdu: 0,
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
