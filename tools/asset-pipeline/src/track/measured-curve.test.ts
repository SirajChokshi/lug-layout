import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LdrawLibrary } from "../ldraw/library.ts";
import { buildMeasuredCurve, type MeasuredCurveSource } from "./track-catalog.ts";

const LDU_PER_STUD = 20;
const BED_HALF_WIDTH = 79.75;
const BED_TOP = -8;
const RAIL_TOP = -24;
const RAIL_HALF_SPACING = 50;
const RAIL_HALF_WIDTH = 3;
const SEGMENT_RADIANS = Math.PI / 180;
const CLEARANCE = 0.25;
const DECIMALS = 6;

type Point = readonly [number, number, number];

interface CurveSpec {
  readonly radiusLdu: number;
  readonly turnDegrees: number;
}

function text(value: number): string {
  const rounded = Number(value.toFixed(DECIMALS));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function quad(points: ReadonlyArray<Point>): string {
  return `4 16 ${points.map((point) => point.map(text).join(" ")).join(" ")}`;
}

function curveFile({ radiusLdu, turnDegrees }: CurveSpec): string {
  const centre = -radiusLdu;
  const halfTurn = (turnDegrees * Math.PI) / 360;
  const at = (radius: number, angle: number, y: number): Point => [
    centre + radius * Math.cos(angle),
    y,
    radius * Math.sin(angle),
  ];
  const endAngle = (radius: number): number => halfTurn - Math.asin(CLEARANCE / radius);
  const steps = Math.ceil((2 * halfTurn) / SEGMENT_RADIANS);
  const angle = (radius: number, step: number): number =>
    -endAngle(radius) + (2 * endAngle(radius) * step) / steps;
  const sweep = (inner: number, outer: number, bottom: number, top: number): string[] => {
    const lines: string[] = [];
    for (let k = 0; k < steps; k++) {
      const [a0, a1] = [angle(inner, k), angle(inner, k + 1)];
      const [b0, b1] = [angle(outer, k), angle(outer, k + 1)];
      lines.push(
        quad([at(inner, a0, top), at(inner, a1, top), at(outer, b1, top), at(outer, b0, top)]),
        quad([
          at(inner, a0, bottom),
          at(outer, b0, bottom),
          at(outer, b1, bottom),
          at(inner, a1, bottom),
        ]),
        quad([
          at(inner, a0, bottom),
          at(inner, a1, bottom),
          at(inner, a1, top),
          at(inner, a0, top),
        ]),
        quad([
          at(outer, b0, bottom),
          at(outer, b0, top),
          at(outer, b1, top),
          at(outer, b1, bottom),
        ]),
      );
    }
    for (const sign of [-1, 1]) {
      const [a, b] = [sign * endAngle(inner), sign * endAngle(outer)];
      lines.push(
        quad([at(inner, a, bottom), at(inner, a, top), at(outer, b, top), at(outer, b, bottom)]),
      );
    }
    return lines;
  };
  const rails = [-RAIL_HALF_SPACING, RAIL_HALF_SPACING].flatMap((offset) =>
    sweep(
      radiusLdu + offset - RAIL_HALF_WIDTH,
      radiusLdu + offset + RAIL_HALF_WIDTH,
      BED_TOP,
      RAIL_TOP,
    ),
  );
  return [
    "0 Test Curve",
    "0 Name: TestCurve.dat",
    "0 Author: measured-curve.test.ts",
    "0 !LDRAW_ORG Unofficial_Part",
    ...sweep(radiusLdu - BED_HALF_WIDTH, radiusLdu + BED_HALF_WIDTH, 0, BED_TOP),
    ...rails,
    "",
  ].join("\n");
}

function measured(spec: CurveSpec) {
  const root = mkdtempSync(join(tmpdir(), "measured-curve-"));
  mkdirSync(join(root, "parts"));
  writeFileSync(join(root, "parts", "TestCurve.dat"), curveFile(spec));
  const source: MeasuredCurveSource = {
    id: "thirdparty-test",
    namespace: "test",
    vendor: "Test Vendor",
    library: new LdrawLibrary([root]),
    parts: ["TestCurve"],
  };
  return buildMeasuredCurve(source, "TestCurve");
}

describe("a curve measured from its own mesh", () => {
  it("is derived as an exact arc of its whole-stud radius and the ζ₁₆ step its end faces turn, unverified, with the clearance its faces keep from the radial joint planes recorded", () => {
    const { piece, report } = measured({ radiusLdu: 56 * LDU_PER_STUD, turnDegrees: 22.5 });

    expect(report.offered).toBe(true);
    expect(report.radiusStuds).toBe(56);
    expect(report.endFaceOffsetsLdu?.map((offset) => Number(offset.toFixed(3)))).toEqual([
      CLEARANCE,
      CLEARANCE,
    ]);
    expect(piece).toMatchObject({
      id: "test:TestCurve",
      title: "Test Vendor Curve R56",
      kind: "curve",
      system: "thirdparty-test",
      status: "unverified",
      thirdParty: { source: "thirdparty-test", vendor: "Test Vendor" },
      connectors: [
        { coefficients: ["0", "0", "0", "0", "0", "0", "0", "0"], heading: 8 },
        { coefficients: ["0", "0", "0", "0", "56", "-56", "0", "0"], heading: 1 },
      ],
    });
    expect(piece?.routes[0]?.segments).toEqual([
      {
        kind: "arc",
        radiusLdu: expect.closeTo(1120, 6),
        sweepRadians: expect.closeTo(Math.PI / 8, 9),
      },
    ]);
  });

  it("is reported, not offered, when it turns an 11.25° step, which needs N = 32", () => {
    const { piece, report } = measured({ radiusLdu: 88 * LDU_PER_STUD, turnDegrees: 11.25 });

    expect(piece).toBeNull();
    expect(report).toMatchObject({ offered: false, radiusStuds: 88 });
    expect(report.reason).toContain("needs N = 32");
  });

  it("is reported, not offered, when its centreline radius is no whole number of studs", () => {
    const { piece, report } = measured({ radiusLdu: 56.5 * LDU_PER_STUD, turnDegrees: 22.5 });

    expect(piece).toBeNull();
    expect(report.offered).toBe(false);
    expect(report.reason).toContain("no whole number of studs");
  });
});
