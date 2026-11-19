import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CERTIFIED_RESIDUAL_LIMIT_LDU,
  exactRational,
  exactRationalFromDecimal,
  parseExactDecimal,
} from "@brr/math";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUNDLE_DATA_FILES } from "../bundle-data.ts";
import { LdrawLibrary } from "../ldraw/library.ts";
import { readPalette } from "../palette.ts";
import { measuredRails } from "../verify/geometry-report.ts";
import {
  closedHalfLap,
  exactRailHeads,
  identifyRail,
  type MeasuredRailHeads,
} from "@brr/schema/bundle";
import { buildTrackCatalog, buildTrackPiece, type TrackCatalogReport } from "./track-catalog.ts";
import { loadTrackEndMarkers } from "./track-ends.ts";

const root = mkdtempSync(join(tmpdir(), "track-catalog-"));
mkdirSync(join(root, "parts", "s"), { recursive: true });
mkdirSync(join(root, "p"), { recursive: true });
writeFileSync(
  join(root, "parts", "s", "custom-end-sleeper.dat"),
  [
    "0 ~Custom End Sleeper",
    "0 Name: s\\custom-end-sleeper.dat",
    "4 16 -10 -8 -1 10 -8 -1 10 -8 1 -10 -8 1",
  ].join("\r\n"),
);
writeFileSync(
  join(root, "p", "head.dat"),
  ["0 Head top", "4 16 -1 0 -1 1 0 -1 1 0 1 -1 0 1"].join("\n"),
);

function writeStraightTrack(
  name: string,
  entrySleeperHalfWidth: number,
  exitSleeperHalfWidth: number,
  headCentres: ReadonlyArray<number>,
): void {
  writeFileSync(
    join(root, "parts", `${name}.dat`),
    [
      `0 Custom 9V Straight with end sleepers ${2 * entrySleeperHalfWidth} and ${2 * exitSleeperHalfWidth} LDU wide`,
      `0 Name: ${name}.dat`,
      "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
      `1 16 160 0 0 1 0 0 0 1 0 0 0 ${exitSleeperHalfWidth} s/custom-end-sleeper.dat`,
      `1 16 -160 0 0 -1 0 0 0 1 0 0 0 -${entrySleeperHalfWidth} s/custom-end-sleeper.dat`,
      ...headCentres.map((z) => `1 16 0 -16 ${z} 160 0 0 0 1 0 0 0 3 head.dat`),
      "4 16 -160 8 -160 160 8 -160 160 8 160 -160 8 160",
    ].join("\r\n"),
  );
}

function writeHalfLapTrack(name: string): void {
  writeFileSync(
    join(root, "parts", `${name}.dat`),
    [
      "0 Custom 9V Straight whose rail heads half-lap past both end faces",
      `0 Name: ${name}.dat`,
      "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
      "1 16 160 0 0 1 0 0 0 1 0 0 0 70 s/custom-end-sleeper.dat",
      "1 16 -160 0 0 -1 0 0 0 1 0 0 0 -70 s/custom-end-sleeper.dat",
      "1 16 0 -16 -51 150 0 0 0 1 0 0 0 3 head.dat",
      "1 16 0 -16 51 150 0 0 0 1 0 0 0 3 head.dat",
      "1 16 -158 -16 -49.5 8 0 0 0 1 0 0 0 1.5 head.dat",
      "1 16 -158 -16 52.5 8 0 0 0 1 0 0 0 1.5 head.dat",
      "1 16 158 -16 49.5 8 0 0 0 1 0 0 0 1.5 head.dat",
      "1 16 158 -16 -52.5 8 0 0 0 1 0 0 0 1.5 head.dat",
      "4 16 -160 8 -160 160 8 -160 160 8 160 -160 8 160",
    ].join("\r\n"),
  );
}

writeStraightTrack("custom-wide-track", 140, 140, [-120, 120]);
const ARC_RADIUS_LDU = 800;
const ARC_HALF_TURN_DEGREES = 11.25;
const FACE_SLIVER_DEGREES = 0.01;
const ARC_SEGMENTS = 16;
const ARC_DIGITS = 6;
const END_SLEEPER_HALF_WIDTH = 70;
const OFF_ARC_LDU = 0.002;
const RADIANS_PER_DEGREE = Math.PI / 180;

function onArc(radius: number, degrees: number) {
  return {
    x: radius * Math.sin(degrees * RADIANS_PER_DEGREE),
    z: radius * Math.cos(degrees * RADIANS_PER_DEGREE) - ARC_RADIUS_LDU,
  };
}

function fixed(value: number): string {
  return value.toFixed(ARC_DIGITS);
}

function headQuad(inner: number, outer: number, from: number, to: number): string {
  const corners = [onArc(inner, from), onArc(outer, from), onArc(outer, to), onArc(inner, to)];
  return `4 16 ${corners.map(({ x, z }) => `${fixed(x)} -16 ${fixed(z)}`).join(" ")}`;
}

function writeArcTrack(name: string, farEndOffArcLdu: number): void {
  const c = Math.cos(ARC_HALF_TURN_DEGREES * RADIANS_PER_DEGREE);
  const s = Math.sin(ARC_HALF_TURN_DEGREES * RADIANS_PER_DEGREE);
  const near = onArc(ARC_RADIUS_LDU, -ARC_HALF_TURN_DEGREES);
  const far = onArc(ARC_RADIUS_LDU, ARC_HALF_TURN_DEGREES);
  const inside = ARC_HALF_TURN_DEGREES - FACE_SLIVER_DEGREES;
  const angles = [
    -ARC_HALF_TURN_DEGREES - FACE_SLIVER_DEGREES,
    ...Array.from(
      { length: ARC_SEGMENTS + 1 },
      (_, k) => -inside + (2 * inside * k) / ARC_SEGMENTS,
    ),
    ARC_HALF_TURN_DEGREES + FACE_SLIVER_DEGREES,
  ];
  const heads = [
    [ARC_RADIUS_LDU - 54, ARC_RADIUS_LDU - 48],
    [ARC_RADIUS_LDU + 48, ARC_RADIUS_LDU + 54],
  ].flatMap(([inner = 0, outer = 0]) =>
    angles.slice(1).map((to, k) => headQuad(inner, outer, angles[k] ?? to, to)),
  );
  const w = END_SLEEPER_HALF_WIDTH;
  writeFileSync(
    join(root, "parts", `${name}.dat`),
    [
      "0 Custom 9V Curve whose rail heads follow an arc",
      `0 Name: ${name}.dat`,
      "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
      `0 !HELP The rotation point is at 0/0/-${ARC_RADIUS_LDU}`,
      `1 16 ${fixed(far.x + farEndOffArcLdu * c)} 0 ${fixed(far.z - farEndOffArcLdu * s)} ${fixed(c)} 0 ${fixed(w * s)} 0 1 0 ${fixed(-s)} 0 ${fixed(w * c)} s/custom-end-sleeper.dat`,
      `1 16 ${fixed(near.x)} 0 ${fixed(near.z)} ${fixed(-c)} 0 ${fixed(w * s)} 0 1 0 ${fixed(-s)} 0 ${fixed(-w * c)} s/custom-end-sleeper.dat`,
      ...heads,
      "4 16 -200 8 -100 200 8 -100 200 8 100 -200 8 100",
    ].join("\r\n"),
  );
}

writeHalfLapTrack("custom-half-lap-track");
writeArcTrack("custom-arc-track", 0);
writeArcTrack("custom-off-arc-track", OFF_ARC_LDU);
writeStraightTrack("custom-narrow-track", 40, 40, [-70, -30, 30, 70]);
writeStraightTrack("custom-mixed-sleeper-track", 40, 140, [-70, -30, 30, 70]);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("track pieces", () => {
  const library = new LdrawLibrary([root]);
  const markers = [{ file: "s/custom-end-sleeper.dat", outwardSign: 1 as const }];

  function halfSpacings(part: string) {
    return buildTrackPiece(library, part, markers, []).checks.connectors.map(
      (connector) => connector.railHalfSpacingLdu,
    );
  }

  it("read a wide track's rails inside its own end sleepers", () => {
    expect(halfSpacings("custom-wide-track")).toEqual([
      { numerator: "120", denominator: "1" },
      { numerator: "120", denominator: "1" },
    ]);
  });

  it("read only a narrow track's own rails when other rail heads lie beyond its end sleepers", () => {
    expect(halfSpacings("custom-narrow-track")).toEqual([
      { numerator: "30", denominator: "1" },
      { numerator: "30", denominator: "1" },
    ]);
  });

  it("clip each end to the end sleeper placed at that end", () => {
    expect(halfSpacings("custom-mixed-sleeper-track")).toEqual([
      { numerator: "30", denominator: "1" },
      null,
    ]);
  });
});

const SYNTHETIC_RAIL: MeasuredRailHeads = {
  railHeads: [
    { from: "-54", to: "-48" },
    { from: "48", to: "54" },
  ],
};

const SYNTHETIC_RAILS = exactRailHeads([SYNTHETIC_RAIL]);

function band(from: bigint, to: bigint) {
  return { from: exactRational(from, 1n), to: exactRational(to, 1n) };
}

function decimalBand(from: string, to: string) {
  return {
    from: exactRationalFromDecimal(parseExactDecimal(from)),
    to: exactRationalFromDecimal(parseExactDecimal(to)),
  };
}

function shiftedNearRail(from: string, to: string): MeasuredRailHeads {
  return { railHeads: [{ from, to }, ...SYNTHETIC_RAIL.railHeads.slice(1)] };
}

function poseCertified(connector: { status: string; residualLdu: number }): boolean {
  return connector.status === "certified" && connector.residualLdu <= CERTIFIED_RESIDUAL_LIMIT_LDU;
}

describe("track connector rails", () => {
  const library = new LdrawLibrary([root]);
  const markers = [{ file: "s/custom-end-sleeper.dat", outwardSign: 1 as const }];
  const certified = { status: "certified" as const, residualLdu: 0 };

  function connectorRails(rails: ReadonlyArray<MeasuredRailHeads>, part = "custom-half-lap-track") {
    return buildTrackPiece(library, part, markers, rails).piece.connectors.map(
      ({ rail, railResidualLdu }) => ({ rail, railResidualLdu }),
    );
  }

  it("identify a half-lapped face only once the end's half-turn closes each head", () => {
    const face = [band(-51n, -48n), band(51n, 54n)] as const;
    expect(identifyRail(certified, face, SYNTHETIC_RAILS)).toEqual({ outcome: "no matching rail" });
    expect(identifyRail(certified, closedHalfLap(face), SYNTHETIC_RAILS)).toEqual({
      outcome: "identified",
      rail: 0,
      railResidualLdu: 0,
    });
    expect(connectorRails([SYNTHETIC_RAIL])).toEqual([
      { rail: 0, railResidualLdu: 0 },
      { rail: 0, railResidualLdu: 0 },
    ]);
  });

  it("leave an end null when it lies just over 0.0005 from every rail, and identify it at 0.0005", () => {
    expect(
      connectorRails([
        shiftedNearRail("-54.0005001", "-48"),
        shiftedNearRail("-53.9994999", "-48"),
        shiftedNearRail("-54", "-48.0005001"),
        shiftedNearRail("-54", "-47.9994999"),
      ]),
    ).toEqual([
      { rail: null, railResidualLdu: null },
      { rail: null, railResidualLdu: null },
    ]);
    const [atLimit] = connectorRails([shiftedNearRail("-54.0005", "-48")]);
    expect(atLimit?.rail).toBe(0);
    expect(atLimit?.railResidualLdu).toBeLessThanOrEqual(CERTIFIED_RESIDUAL_LIMIT_LDU);
  });

  it("close a seam whose gap is exactly 0.0005, and not one just over", () => {
    const atLimit = closedHalfLap([decimalBand("-51", "-48"), decimalBand("51.0005", "54")]);
    const justOver = closedHalfLap([decimalBand("-51", "-48"), decimalBand("51.0005001", "54")]);
    expect(identifyRail(certified, atLimit, SYNTHETIC_RAILS)).toEqual({
      outcome: "identified",
      rail: 0,
      railResidualLdu: 0,
    });
    expect(justOver).toBeNull();
  });

  function railsOf(part: string) {
    const { piece, checks } = buildTrackPiece(library, part, markers, [SYNTHETIC_RAIL]);
    return {
      status: piece.status,
      overResidual: piece.connectors.map(
        (connector) => connector.residualLdu > CERTIFIED_RESIDUAL_LIMIT_LDU,
      ),
      rails: piece.connectors.map(({ rail }) => rail),
      reasons: checks.connectors.map(({ rail }) => rail),
    };
  }

  it("report every end of a piece with one over-residual end as pose not certified, though each end identifies on the arc", () => {
    expect([railsOf("custom-arc-track"), railsOf("custom-off-arc-track")]).toEqual([
      {
        status: "certified",
        overResidual: [false, false],
        rails: [0, 0],
        reasons: ["identified", "identified"],
      },
      {
        status: "unverified",
        overResidual: [false, true],
        rails: [null, null],
        reasons: ["pose not certified", "pose not certified"],
      },
    ]);
  });

  it("leave a face null when its closure doesn't merge into two heads", () => {
    const face = [band(-51n, -48n), band(52n, 54n)] as const;
    expect(closedHalfLap(face)).toBeNull();
    expect(identifyRail(certified, closedHalfLap(face), SYNTHETIC_RAILS)).toEqual({
      outcome: "no matching rail",
    });
  });

  it("refuse a rail matched by more than one entry", () => {
    expect(connectorRails([SYNTHETIC_RAIL, SYNTHETIC_RAIL])).toEqual([
      { rail: null, railResidualLdu: null },
      { rail: null, railResidualLdu: null },
    ]);
  });

  it("never identify a rail on a connector whose pose is not certified", () => {
    const face = closedHalfLap([band(-51n, -48n), band(51n, 54n)]);
    const smallResidual = CERTIFIED_RESIDUAL_LIMIT_LDU / 5;
    expect(
      identifyRail({ status: "unverified", residualLdu: smallResidual }, face, SYNTHETIC_RAILS),
    ).toEqual({ outcome: "pose not certified" });
    expect(
      identifyRail(
        { status: "certified", residualLdu: 2 * CERTIFIED_RESIDUAL_LIMIT_LDU },
        face,
        SYNTHETIC_RAILS,
      ),
    ).toEqual({ outcome: "pose not certified" });
  });
});

const OFFICIAL_CATALOG_TIMEOUT_MS = 180_000;

describe("official track connector rails", () => {
  const library = new LdrawLibrary([
    fileURLToPath(new URL("../../../../.cache/ldraw-audit", import.meta.url)),
  ]);
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  let full: TrackCatalogReport;
  let alone: ReadonlyArray<TrackCatalogReport>;

  beforeAll(async () => {
    const palette = await readPalette(join(repoRoot, BUNDLE_DATA_FILES.palette));
    const parts = palette.parts.filter((part) => part.role === "track").map((part) => part.id);
    const markers = loadTrackEndMarkers();
    const rails = measuredRails(library);
    full = buildTrackCatalog(library, parts, markers, rails);
    alone = rails.map((rail) => buildTrackCatalog(library, parts, markers, [rail]));
  }, OFFICIAL_CATALOG_TIMEOUT_MS);

  function connectors() {
    return full.pieces.flatMap((piece, p) =>
      piece.connectors.map((connector, index) => ({
        piece,
        connector,
        name: `${piece.id} connector ${index}`,
        alone: alone.map((report) => report.pieces[p]?.connectors[index]?.rail ?? null),
      })),
    );
  }

  it("identify every certified straight, curve and switch connector by exactly one rail within 0.0005", () => {
    const certified = connectors().filter(
      ({ piece, connector }) => piece.kind !== "crossing" && poseCertified(connector),
    );
    expect(certified.length).toBeGreaterThan(0);
    expect(
      certified
        .filter(
          ({ connector }) =>
            connector.rail === null ||
            connector.railResidualLdu === null ||
            connector.railResidualLdu > CERTIFIED_RESIDUAL_LIMIT_LDU,
        )
        .map(({ name }) => name),
    ).toEqual([]);
    expect(
      certified
        .filter(({ connector, alone: aloneRails }) =>
          aloneRails.some((rail, k) => (rail !== null) !== (k === connector.rail)),
        )
        .map(({ name }) => name),
    ).toEqual([]);
  });

  it("identify every end of every switch, through and diverging", () => {
    const switches = connectors().filter(({ piece }) => piece.kind === "switch");
    expect(switches.length).toBeGreaterThan(0);
    expect(
      switches.filter(({ connector }) => connector.rail === null).map(({ name }) => name),
    ).toEqual([]);
  });

  it("report every end of a piece holding an over-residual end as pose not certified", () => {
    const overResidualPieces = full.pieces.filter((piece) =>
      piece.connectors.some((connector) => connector.residualLdu > CERTIFIED_RESIDUAL_LIMIT_LDU),
    );
    expect(overResidualPieces.length).toBeGreaterThan(0);
    const ends = overResidualPieces.flatMap((piece) =>
      piece.connectors.map((connector, index) => ({
        connector: `${piece.id} connector ${index}`,
        rail: connector.rail,
      })),
    );
    const reasonOf = (connector: string) =>
      full.connectorsWithoutRail.find((entry) => entry.connector === connector)?.reason ??
      "identified";
    expect(
      ends.map(({ connector, rail }) => ({ connector, rail, reason: reasonOf(connector) })),
    ).toEqual(
      ends.map(({ connector }) => ({ connector, rail: null, reason: "pose not certified" })),
    );
  });

  it("report a crossing whose rails match no measured rail", () => {
    const crossing = connectors().filter(({ piece }) => piece.kind === "crossing");
    expect(crossing.length).toBeGreaterThan(0);
    expect(
      crossing.filter(({ connector }) => connector.rail !== null).map(({ name }) => name),
    ).toEqual([]);
    expect(full.connectorsWithoutRail).toEqual(
      expect.arrayContaining(
        crossing.map(({ name }) => ({ connector: name, reason: "no matching rail" })),
      ),
    );
  });

  it("report every connector whose pose is not certified, and identify no rail on it", () => {
    const uncertified = connectors().filter(({ connector }) => !poseCertified(connector));
    expect(
      uncertified.some(({ connector }) => connector.residualLdu > CERTIFIED_RESIDUAL_LIMIT_LDU),
    ).toBe(true);
    expect(
      uncertified.filter(({ connector }) => connector.rail !== null).map(({ name }) => name),
    ).toEqual([]);
    expect(full.connectorsWithoutRail).toEqual(
      expect.arrayContaining(
        uncertified.map(({ name }) => ({ connector: name, reason: "pose not certified" })),
      ),
    );
  });
});
