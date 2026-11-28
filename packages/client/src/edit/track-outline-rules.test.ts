import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
  type PartBundle,
} from "@brr/catalog";
import { PlanDelta, emptyFacts, type PlanIssue, type TrackOutline, NO_OWNER } from "@brr/domain";
import { chunkKey, mmFromLdu, pose16, zeta16, type Pose16 } from "@brr/math";
import { SCENE_BACKEND } from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { catalogPieceOf, chainedPoses } from "../connect/track-instances.test-support.ts";
import { writeTrackChange, writeViewUpdate, type PlanModelSource } from "../plan/plan-producer.ts";
import type { IPlanService } from "../plan/plan-service.ts";
import { RecordingBackend } from "../plan/plan-sync.test-support.ts";
import { ColorTable } from "../scene/viewer-scene.ts";
import { PLAN_SERVICE } from "../tokens.ts";
import { TrackDrawing } from "./track-drawing.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const STRAIGHT = "ldraw:74746";
const CURVE = "ldraw:74747";
const PLASTIC_STRAIGHT = "ldraw:53401";
const BRICK_HEIGHT_LDU = 24;
const ROOM_MM = 8000;
const SEAM_LDU = 2000;
const SEAM_STUDS = BigInt(SEAM_LDU / 20);
const EAST = 0;
const NORTH = 4;
const SOUTH_EAST = 14;
const OUTLINE_RULES: ReadonlySet<string> = new Set(["trackSeam", "trackOffTable", "fit", "seam"]);

interface LduTable {
  readonly name: string;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

let bundle: PartBundle;

beforeAll(async () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  bundle = await container
    .get(PART_BUNDLE_LOADER)
    .load("standard", (part) => part.role === "track");
});

function studPose(x: bigint, z: bigint, heading: number): Pose16 {
  return pose16(zeta16([x, 0n, 0n, 0n, z, 0n, 0n, 0n]), heading);
}

function planOf(
  tables: ReadonlyArray<LduTable>,
  overhangMm: number,
): { readonly plans: IPlanService; readonly planId: string } {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(SCENE_BACKEND).toConstantValue(new RecordingBackend());
  const plans = container.get(PLAN_SERVICE);
  const planId = plans.createPlan({
    name: "Room",
    roomWidthMm: ROOM_MM,
    roomDepthMm: ROOM_MM,
    originChunkX: 0,
    originChunkZ: 0,
  });
  plans.updatePlan(planId, { maxReachMm: ROOM_MM, maxOverhangMm: overhangMm });
  for (const table of tables) {
    plans.addTable(planId, {
      name: table.name,
      rect: {
        x: mmFromLdu(table.minX),
        z: mmFromLdu(table.minZ),
        width: mmFromLdu(table.maxX - table.minX),
        depth: mmFromLdu(table.maxZ - table.minZ),
      },
      heightMm: 750,
    });
  }
  return { plans, planId };
}

function laidIn(
  tables: ReadonlyArray<LduTable>,
  start: Pose16,
  partIds: ReadonlyArray<string>,
  overhangMm = 0,
): { readonly plans: IPlanService; readonly planId: string; readonly drawing: TrackDrawing } {
  const { plans, planId } = planOf(tables, overhangMm);
  const drawing = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  const change = {
    lift: [],
    lay: chainedPoses(bundle, start, partIds).map(([partId, pose], index) => ({
      index,
      piece: bundle.trackCatalog.pieces.indexOf(catalogPieceOf(bundle, partId)),
      pose,
      yPlates: 0,
      rise: 0,
      layer: 0,
      owner: NO_OWNER,
    })),
  };
  drawing.applyTrack(change);
  const delta = new PlanDelta();
  writeTrackChange(delta, drawing, change);
  plans.apply(delta);
  return { plans, planId, drawing };
}

function outlineRows(plan: { plans: IPlanService; planId: string }): ReadonlyArray<string> {
  return plan.plans
    .issues(plan.planId)
    .filter((issue: PlanIssue) => OUTLINE_RULES.has(issue.rule))
    .map((issue) => `${issue.rule}: ${issue.message}`);
}

const WEST_TABLE: LduTable = { name: "A", minX: 0, minZ: 0, maxX: SEAM_LDU, maxZ: 2000 };
const EAST_TABLE: LduTable = { name: "B", minX: SEAM_LDU, minZ: 0, maxX: 4000, maxZ: 2000 };
const ABUTTING = [WEST_TABLE, EAST_TABLE];
const ACROSS_THE_SEAM = 'between tables "A" and "B"; a seam must fall between placements.';

function across(label: string): string {
  return `trackSeam: ${label} stands across the seam ${ACROSS_THE_SEAM}`;
}

describe("track across the seam between two abutting tables, from each piece's outline and its exact ends", () => {
  it("two 9V straights joined exactly on the seam: their joiner tabs bridge it and neither is across it", () => {
    const plan = laidIn(ABUTTING, studPose(SEAM_STUDS - 16n, 50n, EAST), [STRAIGHT, STRAIGHT]);
    expect(plan.drawing.footprintAt(0).box.maxX).toBeGreaterThan(SEAM_LDU);
    expect(plan.drawing.footprintAt(1).box.minX).toBeLessThan(SEAM_LDU);
    expect(outlineRows(plan)).toEqual([]);
  });

  it("a 9V straight whose body spans the seam is across it", () => {
    const plan = laidIn(ABUTTING, studPose(SEAM_STUDS - 8n, 50n, EAST), [STRAIGHT]);
    expect(outlineRows(plan)).toEqual([across("Train Track 9V Straight #1")]);
  });

  it("a 9V curve starting on the seam and facing back across it is excused; one starting a stud short spans it", () => {
    const onSeam = laidIn(ABUTTING, studPose(SEAM_STUDS, 50n, EAST), [CURVE]);
    const short = laidIn(ABUTTING, studPose(SEAM_STUDS - 1n, 50n, EAST), [CURVE]);
    expect(onSeam.drawing.footprintAt(0).box.minX).toBeLessThan(SEAM_LDU);
    expect([outlineRows(onSeam), outlineRows(short)]).toEqual([
      [],
      [across("Train Track 9V Curved #1")],
    ]);
  });

  it("a 9V curve whose end sits on the seam but faces along it is across it", () => {
    const plan = laidIn(ABUTTING, studPose(SEAM_STUDS, 20n, NORTH), [CURVE]);
    expect(outlineRows(plan)).toEqual([across("Train Track 9V Curved #1")]);
  });

  it("a 9V straight joined to a curve exactly on the seam: neither is across it", () => {
    const plan = laidIn(ABUTTING, studPose(SEAM_STUDS - 16n, 50n, EAST), [STRAIGHT, CURVE]);
    expect(outlineRows(plan)).toEqual([]);
  });
});

function offTable(limitMm: number): string {
  return `trackOffTable: Train Track 9V Straight #1 overhangs the tables: part of its outline is more than ${limitMm} mm past the edge of every table.`;
}

describe("track off the table, from each laid piece's outline and the plan's overhang limit", () => {
  const z = 1000;
  const flush: LduTable = { name: "Table", minX: 0, minZ: 0, maxX: 4000, maxZ: z + 80 };
  const twoMillimetresShort: LduTable = { ...flush, maxZ: z + 75 };
  const straight = (table: LduTable, overhangMm = 0) =>
    laidIn([table], studPose(50n, BigInt(z / 20), EAST), [STRAIGHT], overhangMm);

  it("a straight whose outline is flush with the table's edge stands on it; 2 mm over the edge, it overhangs unless the limit allows 2 mm", () => {
    expect([
      outlineRows(straight(flush)),
      outlineRows(straight(twoMillimetresShort)),
      outlineRows(straight(twoMillimetresShort, 2)),
      outlineRows(straight(twoMillimetresShort, 1)),
    ]).toEqual([[], [offTable(0)], [], [offTable(1)]]);
  });

  it("a straight entirely beyond the table says so", () => {
    const plan = laidIn([flush], studPose(250n, 50n, EAST), [STRAIGHT]);
    expect(outlineRows(plan)).toEqual([`${offTable(0)} It is entirely off the tables.`]);
  });

  it("a straight at a diagonal heading over the inside corner of an L of two tables stands on them, though its footprint box reaches into the notch, and crosses their seam", () => {
    const lower: LduTable = { name: "A", minX: 0, minZ: 0, maxX: 2000, maxZ: 1000 };
    const upper: LduTable = { name: "B", minX: 0, minZ: 1000, maxX: 1000, maxZ: 2000 };
    const plan = laidIn([lower, upper], studPose(39n, 51n, SOUTH_EAST), [STRAIGHT]);
    const { box } = plan.drawing.footprintAt(0);
    expect([box.maxX > 1000, box.maxZ > 1000]).toEqual([true, true]);
    expect(outlineRows(plan)).toEqual([across("Train Track 9V Straight #1")]);
  });
});

interface UserModel {
  readonly label: string;
  readonly start: Pose16;
  readonly track: ReadonlyArray<string>;
  readonly body?: LduTable;
  readonly footing?: LduTable;
}

function carriedIn(
  tables: ReadonlyArray<LduTable>,
  model: UserModel,
  overhangMm = 0,
): {
  readonly plans: IPlanService;
  readonly planId: string;
  readonly outlines: ReadonlyArray<TrackOutline>;
} {
  const plan = planOf(tables, overhangMm);
  const drawing = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  const outlines = chainedPoses(bundle, model.start, model.track).map(([partId, pose]) =>
    drawing.outlineAt(bundle.trackCatalog.pieces.indexOf(catalogPieceOf(bundle, partId)), pose),
  );
  const { body, footing } = model;
  const rects = [...outlines, ...(body ? [body] : [])];
  const source: PlanModelSource = {
    id: 1,
    handle: { chunkKey: chunkKey(0, 0), slot: 0, x: 0, z: 0 },
    placeable: { id: `user:${model.label}`, label: model.label },
    box: {
      minX: Math.min(...rects.map((rect) => rect.minX)),
      minY: 0,
      minZ: Math.min(...rects.map((rect) => rect.minZ)),
      maxX: Math.max(...rects.map((rect) => rect.maxX)),
      maxY: BRICK_HEIGHT_LDU,
      maxZ: Math.max(...rects.map((rect) => rect.maxZ)),
    },
    shape: footing
      ? {
          footing: Float64Array.of(footing.minX, footing.minZ, footing.maxX, footing.maxZ),
          occupancy: Float64Array.of(footing.minX, footing.minZ, footing.maxX, footing.maxZ),
        }
      : null,
    carried: {
      outlines,
      bodyBox: body
        ? Float64Array.of(body.minX, 0, body.minZ, body.maxX, BRICK_HEIGHT_LDU, body.maxZ)
        : null,
    },
    facts: emptyFacts(),
  };
  const delta = new PlanDelta();
  writeViewUpdate(delta, { added: [source], removed: [] });
  plan.plans.apply(delta);
  return { ...plan, outlines };
}

function carriedAcross(): string {
  return `trackSeam: Track carried by my-run.ldr at 0, 0 stands across the seam ${ACROSS_THE_SEAM}`;
}

function onTheSeam(track: ReadonlyArray<string>): Pose16 {
  return studPose(SEAM_STUDS - 16n * BigInt(track.length), 50n, EAST);
}

function wallAt(minX: number): LduTable {
  return { name: "wall", minX, minZ: 980, maxX: minX + 20, maxZ: 1000 };
}

describe("a model's own track, judged by its exact outlines like laid track", () => {
  it.each([
    ["two 9V straights", [STRAIGHT, STRAIGHT]],
    ["two plastic straights", [PLASTIC_STRAIGHT, PLASTIC_STRAIGHT]],
  ])(
    "a user's run of %s whose end sits exactly on the seam, facing across it, isn't across it",
    (_, track) => {
      const plan = carriedIn(ABUTTING, { label: "my-run.ldr", start: onTheSeam(track), track });
      expect(plan.outlines.at(-1)?.maxX).toBeGreaterThan(SEAM_LDU);
      expect(outlineRows(plan)).toEqual([]);
    },
  );

  it("a 9V curve the model carries, starting on the seam and facing back across it, isn't across it", () => {
    const plan = carriedIn(ABUTTING, {
      label: "my-run.ldr",
      start: studPose(SEAM_STUDS, 50n, EAST),
      track: [CURVE],
    });
    expect(outlineRows(plan)).toEqual([]);
  });

  it("a user's run whose body spans the seam is across it", () => {
    const plan = carriedIn(ABUTTING, {
      label: "my-run.ldr",
      start: studPose(SEAM_STUDS - 24n, 50n, EAST),
      track: [STRAIGHT, STRAIGHT],
    });
    expect(outlineRows(plan)).toEqual([carriedAcross()]);
  });

  it("a wall standing past the run's end, in the cell its joiner reaches into, is judged by its own footing", () => {
    const run = { label: "my-run.ldr", start: onTheSeam([STRAIGHT]), track: [STRAIGHT] };
    const astride = wallAt(SEAM_LDU - 10);
    const beyond = wallAt(SEAM_LDU);
    const besideTheJoiner = carriedIn(ABUTTING, { ...run, body: beyond, footing: beyond });
    const [straight] = besideTheJoiner.outlines;
    expect(
      straight?.meetsOpenRect(
        Float64Array.of(beyond.minX, beyond.minZ, beyond.maxX, beyond.maxZ),
        0,
      ),
    ).toBe(true);
    expect([
      outlineRows(carriedIn(ABUTTING, { ...run, body: astride, footing: astride })),
      outlineRows(besideTheJoiner),
    ]).toEqual([[`seam: my-run.ldr at 0, 0 stands across the seam ${ACROSS_THE_SEAM}`], []]);
  });

  it("the model's own track over a table edge overhangs by its outline, and the rest of the model by its own box", () => {
    const table: LduTable = { name: "Table", minX: 0, minZ: 0, maxX: 4000, maxZ: 1075 };
    const brick: LduTable = { name: "brick", minX: 1000, minZ: 0, maxX: 1080, maxZ: 40 };
    const plan = carriedIn([table], {
      label: "my-run.ldr",
      start: studPose(50n, 50n, EAST),
      track: [STRAIGHT],
      body: brick,
      footing: brick,
    });
    expect(outlineRows(plan)).toEqual([
      "trackOffTable: Track carried by my-run.ldr at 0, 0 overhangs the tables: part of its outline is more than 0 mm past the edge of every table.",
    ]);
  });

  it("a diagonal straight the model carries over the inside corner of an L stands on the tables, though the model's box reaches into the notch", () => {
    const lower: LduTable = { name: "A", minX: 0, minZ: 0, maxX: 2000, maxZ: 1000 };
    const upper: LduTable = { name: "B", minX: 0, minZ: 1000, maxX: 1000, maxZ: 2000 };
    const plan = carriedIn([lower, upper], {
      label: "my-run.ldr",
      start: studPose(39n, 51n, SOUTH_EAST),
      track: [STRAIGHT],
    });
    const [straight] = plan.outlines;
    expect([(straight?.maxX ?? 0) > 1000, (straight?.maxZ ?? 0) > 1000]).toEqual([true, true]);
    expect(outlineRows(plan)).toEqual([
      'trackSeam: Track carried by my-run.ldr at 0, 0 stands across the seam between tables "A" and "B"; a seam must fall between placements.',
    ]);
  });
});
