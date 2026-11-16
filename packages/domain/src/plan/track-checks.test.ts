import { readFileSync } from "node:fs";
import { conjugateZeta16, pose16, zeta16 } from "@brr/math";
import { describe, expect, it } from "vitest";
import { TrackGraph } from "../track/track-graph.ts";
import { TrackLayout, type TrackPieceSpec } from "../track/track-layout.ts";
import type { PlanRegion } from "./plan-region.ts";
import { checkPlan } from "./plan-rules.ts";
import { trackFootprints, trackIssues, type TrackPieceInfo } from "./track-checks.ts";

interface GeometryTrack {
  readonly part: string;
  readonly relative: ReadonlyArray<{
    readonly fieldCertified: boolean;
    readonly coefficients: ReadonlyArray<string> | null;
    readonly headingSteps: number;
  }>;
}

const GEOMETRY = new URL("../../../../docs/verified-facts/geometry.json", import.meta.url);

function yUpSpec(part: string): TrackPieceSpec {
  const geometry = JSON.parse(readFileSync(GEOMETRY, "utf8")) as {
    readonly trackEnds: ReadonlyArray<GeometryTrack>;
  };
  const track = geometry.trackEnds.find((t) => t.part === part);
  if (!track) throw new Error(`${part} is not in geometry.json`);
  return {
    connectors: track.relative.map((end) => {
      if (!end.coefficients) throw new Error(`${part} end has no coefficients`);
      return pose16(
        conjugateZeta16(zeta16(end.coefficients.map((c) => BigInt(c)))),
        -end.headingSteps,
      );
    }),
    routes: [{ from: 0, to: 1 }],
  };
}

const STRAIGHT = 0;
const CURVE = 1;
const PIECES = [yUpSpec("74746"), yUpSpec("74747")];

function info(id: string, title: string, status: TrackPieceInfo["status"]): TrackPieceInfo {
  return {
    id,
    title,
    part: id,
    ldrawColor: 72,
    status,
    frameXLdu: 160,
    frameZLdu: 0,
    frameHalfSteps: 0,
    boundsMinX: -160,
    boundsMaxX: 160,
    boundsMinZ: -80,
    boundsMaxZ: 80,
  };
}

const CERTIFIED = [
  info("ldraw:74746", "straight", "certified"),
  info("ldraw:74747", "R40 curve", "certified"),
];
const UNVERIFIED_CURVE = [
  info("ldraw:74746", "straight", "certified"),
  info("ldraw:53400", "R40 curve", "unverified"),
];

const REGION: PlanRegion = {
  id: "plan",
  name: "Room",
  originChunkX: 0,
  originChunkZ: 0,
  footprint: {
    roomWidthMm: 3000,
    roomDepthMm: 3000,
    tables: [
      { id: "t", name: "Table", rect: { x: 0, z: 0, width: 2000, depth: 2000 }, heightMm: 750 },
    ],
    obstacles: [],
  },
  maxOverhangMm: 0,
};

function at(xStuds: bigint, zStuds: bigint, heading = 0) {
  return pose16(zeta16([xStuds, 0n, 0n, 0n, zStuds, 0n, 0n, 0n]), heading);
}

function issuesFor(layout: TrackLayout, pieces: ReadonlyArray<TrackPieceInfo>) {
  const track = { layout, graph: new TrackGraph(layout), pieces };
  return trackIssues(REGION, checkPlan(REGION, []), track, trackFootprints(track));
}

describe("track joins in a plan", () => {
  it("passes a closed loop of sixteen R40 curves and warns once when the curve is unverified", () => {
    const layout = new TrackLayout(PIECES);
    layout.place(CURVE, at(125n, 60n), 0);
    for (let i = 0; i < 15; i++) layout.attach(CURVE, 0, { placement: i, connector: 1 });
    expect(issuesFor(layout, CERTIFIED)).toEqual([]);
    const warned = issuesFor(layout, UNVERIFIED_CURVE);
    expect(warned.map((i) => [i.rule, i.severity, i.trackPieces?.length])).toEqual([
      ["trackUnverified", "warning", 16],
    ]);
    expect(warned[0]?.message).toContain("16 × 53400 R40 curve: unverified connector poses");
    expect(warned[0]?.message).toContain("16 of these pieces have joins");
  });

  it("reports both ends of a lone straight as open", () => {
    const layout = new TrackLayout(PIECES);
    layout.place(STRAIGHT, at(100n, 100n), 0);
    expect(issuesFor(layout, CERTIFIED).map((i) => [i.rule, i.trackPieces])).toEqual([
      ["trackOpenEnd", [0]],
      ["trackOpenEnd", [0]],
    ]);
  });

  it("refuses two straights laid head to head over each other instead of joined", () => {
    const layout = new TrackLayout(PIECES);
    layout.place(STRAIGHT, at(100n, 100n), 0);
    layout.place(STRAIGHT, at(116n, 100n, 8), 0);
    const issues = issuesFor(layout, CERTIFIED);
    expect(issues.map((i) => [i.rule, i.trackPieces])).toEqual([
      ["trackJoin", [0, 1]],
      ["trackJoin", [0, 1]],
    ]);
    expect(issues[0]?.message).toContain("180° off a straight join");
  });

  it("flags a straight that hangs off the table edge by its rotated footprint", () => {
    const layout = new TrackLayout(PIECES);
    layout.place(CURVE, at(100n, 100n), 0);
    layout.attach(STRAIGHT, 0, { placement: 0, connector: 1 });
    layout.place(STRAIGHT, at(240n, 20n), 0);
    const fit = issuesFor(layout, CERTIFIED).filter((i) => i.rule === "trackFit");
    expect(fit.map((i) => i.trackPieces)).toEqual([[2]]);
    expect(fit[0]?.message).toMatch(/hangs \d+ mm past the table edge/u);
  });
});
