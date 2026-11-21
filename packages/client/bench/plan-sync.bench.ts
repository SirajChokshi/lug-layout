import { ASSET_FETCHER, PART_BUNDLE_LOADER, type IAssetFetcher } from "@brr/catalog";
import {
  CoverageScratch,
  emptyFacts,
  FACT_OVERLAP_SEGMENT,
  FACT_OVERLAP_SOURCE,
  FACT_ROAD_JOINED,
  MODEL_SEGMENT,
  NO_OVERLAP_PARTNER,
  PlanDelta,
  regionContext,
  TRACK_SEGMENT,
  uncoveredPieces,
  UNDECIDED,
  WRITE_ADD,
  type PlanRegion,
  type PlanShape,
  type TrackChange,
  type TrackOutline,
  type TrackPieceAt,
} from "@brr/domain";
import { CHUNK_LDU, addZeta16, chunkKey, pose16, zeta16 } from "@brr/math";
import type { TrackCatalog } from "@brr/schema/bundle";
import { SCENE_BACKEND, type ISceneBackend, type WorldBox } from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { getHeapSpaceStatistics } from "node:v8";
import { fitAllBox } from "../src/camera/editor-camera.ts";
import { overviewOf } from "../src/camera/overview.ts";
import { mainThreadModules } from "../src/client.module.ts";
import { TrackDrawing } from "../src/edit/track-drawing.ts";
import {
  writeFullRebuild,
  writeModelUpdates,
  writeTrackChange,
  writeTrackLay,
  writeTrackThrow,
  writeViewUpdate,
  type PlanModelSource,
  type PlanViewUpdate,
} from "../src/plan/plan-producer.ts";
import { PlanService, type NewPlan, type TableInput } from "../src/plan/plan-service.ts";
import { RecordingBackend } from "../src/plan/plan-sync.test-support.ts";
import { buildTrackPlan } from "../src/scene/track-plan.ts";
import { ColorTable } from "../src/scene/viewer-scene.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const ROWS = 122_880;
const SIZES: ReadonlyArray<number> = [38, 135, 423, 1920, 15_360, ROWS];
const FLAGGED_SIZES: ReadonlyArray<number> = [1, 1000, ROWS];
const PER_LAYER = 64 * 128;
const BRICK_PITCH_X = 80;
const BRICK_PITCH_Z = 40;
const BRICK_HEIGHT = 24;
const ROAD_LDU = 640;
const ROAD_STROKES: ReadonlyArray<number> = [8, 64];
const ROOM_MM = 2100;
const COVERING_REACH_MM = 1100;
const DEFAULT_REACH_MM = 700;
const FALLBACK_REACH_MM = 100;
const JOINED_ROAD_CELLS = 8;
const MID_TABLE_BRICK = 64 * 64 + 32;
const FLAG_ROOM_DEPTH_MM = 4300;
const FLAG_SHIFT_LDU = 5400;
const TABLE_HEIGHT_MM = 750;
const JIT_WARMUP_PASSES = 2;
const JIT_WARMUP_CYCLES = 1000;
const WARMUP_CYCLES = 200;
const CYCLES = 200;
const COST_WINDOWS = 11;
const REGION_EDITS = 21;
const SETTLE_MS = 50;
const PASSING_LOOP =
  "ldraw:75541-f1, ldraw:74746*2, ldraw:75542-f1.1, ldraw:74747*8, ldraw:74746*6, ldraw:74747*8, /, ldraw:74747, ldraw:74747";
const PASSING_LOOP_STUDS = { x: 60n, z: 20n } as const;
const CIRCLE = "ldraw:74747*16";
const CIRCLE_STUDS = { x: 140n, z: 150n } as const;
const OPEN_STRAIGHT = "ldraw:74746";
const OPEN_STRAIGHT_COUNTS: ReadonlyArray<number> = [1, 100, 1000];
const OPEN_STRAIGHTS_PER_ROW = 32;
const OPEN_STRAIGHT_PITCH = { x: 24n, z: 12n } as const;
const OUTSIDE_STUDS = { x: -120n, z: 20n } as const;
const KEPT_OPEN_STRAIGHTS = 8;
const KEPT_L_CORNER_STUDS = { x: 60n, z: 100n } as const;
const KEPT_L_HEADINGS: ReadonlyArray<number> = [0, 12];
const KEPT_L_ROWS = 3;
const TWO_53 = 2 ** 53;
const FALLBACK_CHUNK_X = (TWO_53 - 512) / CHUNK_LDU;
const FALLBACK_TABLES: ReadonlyArray<number> = [1, 2, 4];
const TYPED_WIDTHS_MM: ReadonlyArray<number> = [2, 24, 240, 2400];
const COUNTED_SPACES: ReadonlySet<string> = new Set([
  "new_space",
  "new_large_object_space",
  "old_space",
  "large_object_space",
]);
const BRICK = { id: "ldraw:3001", label: "Brick 2 x 4" };
const ROAD = { id: "ldraw:44336", label: "Road plate" };
const NONE: ReadonlyArray<PlanModelSource> = [];

function rectShape(halfX: number, halfZ: number): PlanShape {
  const rect = Float64Array.of(-halfX, -halfZ, halfX, halfZ);
  return { footing: rect, occupancy: rect };
}

const BRICK_SHAPE = rectShape(BRICK_PITCH_X / 2, BRICK_PITCH_Z / 2);
const TURNED_BRICK_SHAPE = rectShape(BRICK_PITCH_Z / 2, BRICK_PITCH_X / 2);
const ROAD_SHAPE = rectShape(ROAD_LDU / 2, ROAD_LDU / 2);

interface BenchModel extends PlanModelSource {
  id: number;
}

interface Span {
  readonly bytes: number;
  readonly start: number;
  readonly end: number;
}

interface Window {
  readonly bytes: number;
  readonly ms: number;
  readonly gcs: number;
}

interface Scenario {
  readonly name: string;
  readonly edit: () => void;
  readonly inverse: () => void;
}

interface Built {
  readonly plans: PlanService;
  readonly planId: string | null;
  readonly delta: PlanDelta;
  readonly models: BenchModel[];
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

class Ids {
  private value = 1_000_000;

  fresh(): number {
    return this.value++;
  }
}

class PanelReads {
  mismatches = 0;
  total = 0;
  private plansRef: unknown = null;
  private activeRef: unknown = null;
  private regionRef: unknown = null;
  private issuesRef: unknown = null;
  private issuesAt = -1;

  constructor(
    private readonly plans: PlanService,
    private readonly planId: string | null,
  ) {
    this.plansRef = plans.plans();
    this.activeRef = plans.activePlanId();
    if (planId !== null) {
      this.regionRef = plans.regionView(planId);
      this.issuesRef = plans.issues(planId);
      this.issuesAt = plans.issueVersion(planId);
    }
  }

  readonly read = (): void => {
    const plans = this.plans;
    this.total ^= plans.version() ^ plans.placementCount() ^ plans.sandboxCount();
    if (!Object.is(plans.plans(), this.plansRef)) this.mismatches++;
    if (!Object.is(plans.activePlanId(), this.activeRef)) this.mismatches++;
    const id = this.planId;
    if (id === null) return;
    this.total ^= plans.insideCount(id) ^ plans.issueCount(id) ^ plans.regionView(id).tables.length;
    if (!Object.is(plans.regionView(id), this.regionRef)) this.mismatches++;
    const at = plans.issueVersion(id);
    const issues = plans.issues(id);
    if (at === this.issuesAt) {
      if (!Object.is(issues, this.issuesRef)) this.mismatches++;
    } else {
      this.issuesAt = at;
      this.issuesRef = issues;
    }
  };
}

const collections: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) collections.push(entry.startTime);
});
observer.observe({ entryTypes: ["gc"] });
const collectGarbage: unknown = Reflect.get(globalThis, "gc");
if (typeof collectGarbage !== "function")
  throw new Error("run the plan-sync bench with --expose-gc");
const collect = collectGarbage as () => void;

function heapBytes(): number {
  let bytes = 0;
  for (const space of getHeapSpaceStatistics()) {
    if (COUNTED_SPACES.has(space.space_name)) bytes += space.space_used_size;
  }
  return bytes;
}

function gcsBetween(start: number, end: number): number {
  let count = 0;
  for (const at of collections) if (at >= start && at <= end) count++;
  return count;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

async function quiet(): Promise<void> {
  collect();
  await settle();
}

function percentile(values: ReadonlyArray<number>, p: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

function brick(i: number, id: number, shiftZ: number): BenchModel {
  const layer = Math.floor(i / PER_LAYER);
  const inLayer = i % PER_LAYER;
  const x = (layer % 2) * (BRICK_PITCH_X / 2) + (inLayer % 64) * BRICK_PITCH_X + BRICK_PITCH_X / 2;
  const z = Math.floor(inLayer / 64) * BRICK_PITCH_Z + BRICK_PITCH_Z / 2 + shiftZ;
  const y = layer * BRICK_HEIGHT;
  return {
    id,
    handle: {
      chunkKey: chunkKey(Math.floor(x / CHUNK_LDU), Math.floor(z / CHUNK_LDU)),
      slot: i,
      x,
      z,
    },
    placeable: BRICK,
    shape: BRICK_SHAPE,
    facts: emptyFacts(),
    box: {
      minX: x - BRICK_PITCH_X / 2,
      minY: y,
      minZ: z - BRICK_PITCH_Z / 2,
      maxX: x + BRICK_PITCH_X / 2,
      maxY: y + BRICK_HEIGHT,
      maxZ: z + BRICK_PITCH_Z / 2,
    },
  };
}

function turned(model: BenchModel, id: number): BenchModel {
  const { x, z } = model.handle;
  return {
    ...model,
    id,
    shape: TURNED_BRICK_SHAPE,
    facts: emptyFacts(),
    box: {
      ...model.box,
      minX: x - BRICK_PITCH_Z / 2,
      minZ: z - BRICK_PITCH_X / 2,
      maxX: x + BRICK_PITCH_Z / 2,
      maxZ: z + BRICK_PITCH_X / 2,
    },
  };
}

function road(k: number, id: number): BenchModel {
  const x = (k % 8) * ROAD_LDU + ROAD_LDU / 2;
  const z = Math.floor(k / 8) * ROAD_LDU + ROAD_LDU / 2;
  return {
    id,
    handle: {
      chunkKey: chunkKey(Math.floor(x / CHUNK_LDU), Math.floor(z / CHUNK_LDU)),
      slot: k,
      x,
      z,
    },
    placeable: ROAD,
    shape: ROAD_SHAPE,
    facts: emptyFacts(),
    box: {
      minX: x - ROAD_LDU / 2,
      minY: 0,
      minZ: z - ROAD_LDU / 2,
      maxX: x + ROAD_LDU / 2,
      maxY: 8,
      maxZ: z + ROAD_LDU / 2,
    },
  };
}

function bricks(count: number, flagged: number, ids: Ids): BenchModel[] {
  const models: BenchModel[] = [];
  for (let i = 0; i < count; i++)
    models.push(brick(i, ids.fresh(), i < flagged ? FLAG_SHIFT_LDU : 0));
  return models;
}

function tableRegion(depthMm: number): NewPlan {
  return {
    name: "Plan 1",
    roomWidthMm: ROOM_MM,
    roomDepthMm: depthMm,
    originChunkX: 0,
    originChunkZ: 0,
  };
}

const LOOP_TABLE_DEPTH_MM = 1120;
const CIRCLE_SEAM_X_MM = 1120;
const CIRCLE_TABLES_FAR_MM = 1920;
const OUTLINE_TABLES: ReadonlyArray<TableInput> = [
  {
    name: "Under the loop",
    rect: { x: 0, z: 0, width: ROOM_MM, depth: LOOP_TABLE_DEPTH_MM },
    heightMm: TABLE_HEIGHT_MM,
  },
  {
    name: "West of the seam",
    rect: {
      x: 0,
      z: LOOP_TABLE_DEPTH_MM,
      width: CIRCLE_SEAM_X_MM,
      depth: CIRCLE_TABLES_FAR_MM - LOOP_TABLE_DEPTH_MM,
    },
    heightMm: TABLE_HEIGHT_MM,
  },
  {
    name: "East of the seam",
    rect: {
      x: CIRCLE_SEAM_X_MM,
      z: LOOP_TABLE_DEPTH_MM,
      width: ROOM_MM - CIRCLE_SEAM_X_MM,
      depth: CIRCLE_TABLES_FAR_MM - LOOP_TABLE_DEPTH_MM,
    },
    heightMm: TABLE_HEIGHT_MM,
  },
];
const LOOP_STRAIGHT = 1;
const CIRCLE_SECOND_CURVE = 15;
const HALF_WIDTH_LDU = 80;
const TAB_LDU = 9;

interface OutlineQuery {
  readonly outline: TrackOutline;
  readonly rect: Float64Array;
  readonly meets: boolean;
}

const fullTable: TableInput = {
  name: "Table 1",
  rect: { x: 0, z: 0, width: ROOM_MM, depth: ROOM_MM },
  heightMm: TABLE_HEIGHT_MM,
};

function build(
  models: BenchModel[],
  track: TrackDrawing | null,
  region: NewPlan | null,
  backend: ISceneBackend = new RecordingBackend(),
): Built {
  const plans = new PlanService(backend);
  const delta = new PlanDelta();
  writeFullRebuild(delta, models, track);
  plans.apply(delta);
  if (region === null) return { plans, planId: null, delta, models };
  const planId = plans.createPlan(region);
  plans.addTable(planId, fullTable);
  plans.updatePlan(planId, { maxReachMm: COVERING_REACH_MM });
  return { plans, planId, delta, models };
}

function applyView(built: Built, view: PlanViewUpdate): void {
  writeViewUpdate(built.delta, view);
  built.plans.apply(built.delta);
}

function applyUpdate(built: Built, models: ReadonlyArray<PlanModelSource>): void {
  built.delta.reset();
  writeModelUpdates(built.delta, models, models.length);
  built.plans.apply(built.delta);
}

function viewScenarios(built: Built, ids: Ids): Scenario[] {
  const placedLast = brick(ROWS, ids.fresh(), 0);
  const one: PlanModelSource[] = [placedLast];
  const placeView = { added: one, removed: NONE };
  const unplaceView = { added: NONE, removed: one };
  const middle: PlanModelSource[] = [placedLast];
  const removeView = { added: NONE, removed: middle };
  const restoreView = { added: middle, removed: NONE };
  let next = Math.floor(built.models.length / 2);
  const before = built.models[next] ?? placedLast;
  const after = turned(before, ids.fresh());
  const fromBefore: PlanModelSource[] = [before];
  const toAfter: PlanModelSource[] = [after];
  const rotateView = { removed: fromBefore, added: toAfter };
  const rotateBackView = { removed: toAfter, added: fromBefore };
  const factTarget = built.models[Math.floor(built.models.length / 3)] ?? placedLast;
  const factUpdate: PlanModelSource[] = [factTarget];
  return [
    {
      name: "place",
      edit: () => {
        placedLast.id = ids.fresh();
        applyView(built, placeView);
      },
      inverse: () => applyView(built, unplaceView),
    },
    {
      name: "remove (a mid-list row)",
      edit: () => {
        const target = built.models[next] ?? placedLast;
        next = (next + 1) % built.models.length;
        middle[0] = target;
        applyView(built, removeView);
      },
      inverse: () => {
        const target = middle[0];
        if (target) (target as BenchModel).id = ids.fresh();
        applyView(built, restoreView);
      },
    },
    {
      name: "rotate",
      edit: () => {
        after.id = ids.fresh();
        applyView(built, rotateView);
      },
      inverse: () => {
        before.id = ids.fresh();
        applyView(built, rotateBackView);
      },
    },
    {
      name: "fact update (a mid-list model row rewritten, facts unchanged)",
      edit: () => applyUpdate(built, factUpdate),
      inverse: () => applyUpdate(built, factUpdate),
    },
    {
      name: `fact update (a mid-list model row's joined road cells, 0 ↔ ${JOINED_ROAD_CELLS})`,
      edit: () => {
        factTarget.facts[FACT_ROAD_JOINED] = JOINED_ROAD_CELLS;
        applyUpdate(built, factUpdate);
      },
      inverse: () => {
        factTarget.facts[FACT_ROAD_JOINED] = 0;
        applyUpdate(built, factUpdate);
      },
    },
    {
      name: "undo (of a place: the tail row leaves)",
      edit: () => applyView(built, unplaceView),
      inverse: () => {
        placedLast.id = ids.fresh();
        applyView(built, placeView);
      },
    },
    {
      name: "redo (of a place: a row joins the tail)",
      edit: () => {
        placedLast.id = ids.fresh();
        applyView(built, placeView);
      },
      inverse: () => applyView(built, unplaceView),
    },
    ...ROAD_STROKES.map((length): Scenario => {
      const plates: BenchModel[] = [];
      for (let k = 0; k < length; k++) plates.push(road(k, ids.fresh()));
      const stroke = { added: plates, removed: NONE };
      const unstroke = { added: NONE, removed: plates };
      return {
        name: `road stroke of ${length} plates`,
        edit: () => {
          for (let k = 0; k < plates.length; k++) {
            const plate = plates[k];
            if (plate) plate.id = ids.fresh();
          }
          applyView(built, stroke);
        },
        inverse: () => applyView(built, unstroke),
      };
    }),
  ];
}

function needsUndoState(scenario: Scenario): boolean {
  return scenario.name.startsWith("undo");
}

function windowOf(cycles: number, scenario: Scenario, work: boolean): Span {
  const before = heapBytes();
  const start = performance.now();
  for (let c = 0; c < cycles; c++) {
    if (!work) continue;
    scenario.edit();
    scenario.inverse();
  }
  const end = performance.now();
  return { bytes: heapBytes() - before, start, end };
}

async function counted(span: Span): Promise<Window> {
  await settle();
  return { bytes: span.bytes, ms: span.end - span.start, gcs: gcsBetween(span.start, span.end) };
}

interface ProbeRow {
  readonly variant: string;
  readonly scenario: string;
  readonly times: Float64Array;
  readonly beyond: number;
  readonly gcs: number;
  readonly mismatches: number;
  readonly endSandbox: number;
  readonly endIssues: number;
}

interface ShortRow {
  readonly variant: string;
  readonly scenario: string;
  readonly beyond: number;
  readonly gcs: number;
  readonly mismatches: number;
}

async function shortProbe(
  variant: string,
  scenario: Scenario,
  reads: PanelReads,
): Promise<ShortRow> {
  const mismatchesBefore = reads.mismatches;
  warm(scenario, WARMUP_CYCLES);
  if (needsUndoState(scenario)) scenario.inverse();
  await quiet();
  const control = windowOf(CYCLES, scenario, false);
  await quiet();
  const measured = await counted(windowOf(CYCLES, scenario, true));
  if (needsUndoState(scenario)) scenario.edit();
  return {
    variant,
    scenario: scenario.name,
    beyond: measured.bytes - control.bytes,
    gcs: measured.gcs,
    mismatches: reads.mismatches - mismatchesBefore,
  };
}

function shortTable(rows: ReadonlyArray<ShortRow>): string[] {
  return [
    "| Variant | Edit | Bytes beyond the skipped loop | GCs in the window | Reference mismatches |",
    "|---|---|---|---|---|",
    ...rows.map(
      (r) => `| ${r.variant} | ${r.scenario} | ${r.beyond} | ${r.gcs} | ${r.mismatches} |`,
    ),
  ];
}

function warm(scenario: Scenario, cycles: number): void {
  if (needsUndoState(scenario)) scenario.inverse();
  windowOf(cycles, scenario, true);
  windowOf(cycles, scenario, false);
  if (needsUndoState(scenario)) scenario.edit();
}

async function probe(
  variant: string,
  built: Built,
  scenario: Scenario,
  reads: PanelReads,
): Promise<ProbeRow> {
  warm(scenario, WARMUP_CYCLES);
  if (needsUndoState(scenario)) scenario.inverse();
  const mismatchesBefore = reads.mismatches;
  await quiet();
  const control = windowOf(CYCLES, scenario, false);
  await quiet();
  const measured = await counted(windowOf(CYCLES, scenario, true));
  const times = new Float64Array(CYCLES);
  for (let c = 0; c < CYCLES; c++) {
    const start = performance.now();
    scenario.edit();
    times[c] = performance.now() - start;
    scenario.inverse();
  }
  if (needsUndoState(scenario)) scenario.edit();
  return {
    variant,
    scenario: scenario.name,
    times,
    beyond: measured.bytes - control.bytes,
    gcs: measured.gcs,
    mismatches: reads.mismatches - mismatchesBefore,
    endSandbox: built.plans.sandboxCount(),
    endIssues: built.planId === null ? 0 : built.plans.issueCount(built.planId),
  };
}

interface LoadedTrack {
  readonly drawing: TrackDrawing;
  readonly catalog: TrackCatalog;
}

async function loadTrack(): Promise<LoadedTrack> {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  container.rebind(SCENE_BACKEND).toConstantValue(new RecordingBackend());
  const bundle = await container
    .get(PART_BUNDLE_LOADER)
    .load("standard", (part) => part.role === "track");
  return {
    drawing: new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle)),
    catalog: bundle.trackCatalog,
  };
}

function planLaid(
  { drawing, catalog }: LoadedTrack,
  plan: string,
  at: { readonly x: bigint; readonly z: bigint },
): TrackChange {
  const { layout } = buildTrackPlan(plan, catalog);
  const shift = zeta16([at.x, 0n, 0n, 0n, at.z, 0n, 0n, 0n]);
  const first = drawing.pieceCount;
  return {
    lift: [],
    lay: Array.from({ length: layout.count }, (_, p) => {
      const pose = layout.pose(p);
      return {
        index: first + p,
        piece: layout.piece(p),
        pose: pose16(addZeta16(pose.position, shift), pose.heading),
        yPlates: 0,
      };
    }),
  };
}

async function threeBackend(): Promise<ISceneBackend> {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  return container.get(SCENE_BACKEND);
}

interface TrackDeltas {
  readonly lay: PlanDelta;
  readonly unlay: PlanDelta;
  readonly openLay: PlanDelta;
  readonly openUnlay: PlanDelta;
  readonly throwOver: PlanDelta;
  readonly throwBack: PlanDelta;
}

function layTrack(track: LoadedTrack): TrackDeltas {
  const { drawing } = track;
  drawing.applyTrack(planLaid(track, PASSING_LOOP, PASSING_LOOP_STUDS));
  const straight = track.catalog.pieces.findIndex((piece) => piece.id === OPEN_STRAIGHT);
  const outside = drawing.pieceChange(
    straight,
    pose16(zeta16([OUTSIDE_STUDS.x, 0n, 0n, 0n, OUTSIDE_STUDS.z, 0n, 0n, 0n]), 0),
  );
  drawing.applyTrack(outside);
  const openLay = new PlanDelta();
  writeTrackLay(openLay, drawing, outside.lay.length);
  const lift: TrackChange = { lift: outside.lay, lay: [] };
  drawing.applyTrack(lift);
  const openUnlay = new PlanDelta();
  writeTrackChange(openUnlay, drawing, lift);
  const circle = planLaid(track, CIRCLE, CIRCLE_STUDS);
  drawing.applyTrack(circle);
  const laid = circle.lay.length;
  if (drawing.openEnds().length !== 0) throw new Error("the bench's track has open ends");
  const lay = new PlanDelta();
  writeTrackLay(lay, drawing, laid);
  const unlay = new PlanDelta();
  unlay.reset();
  for (let p = drawing.pieceCount - laid; p < drawing.pieceCount; p++)
    unlay.remove(TRACK_SEGMENT, p);
  const lever = drawing.switchLevers()[0];
  const over = lever ? drawing.switchThrow(lever.placement) : null;
  if (!lever || !over) throw new Error("no switch to throw");
  drawing.applyTrack(over.change);
  const throwOver = new PlanDelta();
  writeTrackThrow(throwOver, drawing, lever.placement);
  const back = drawing.switchThrow(lever.placement);
  if (!back) throw new Error("the switch did not throw back");
  drawing.applyTrack(back.change);
  const throwBack = new PlanDelta();
  writeTrackThrow(throwBack, drawing, lever.placement);
  return { lay, unlay, openLay, openUnlay, throwOver, throwBack };
}

interface ProbeVariant {
  readonly variant: string;
  readonly built: Built;
  readonly reads: PanelReads;
  readonly scenarios: ReadonlyArray<Scenario>;
  readonly endRows: number;
  readonly endIssues: number | null;
}

async function keptRowsVariant(): Promise<ProbeVariant> {
  const loaded = await loadTrack();
  const { drawing: kept, catalog } = loaded;
  const straight = catalog.pieces.findIndex((piece) => piece.id === OPEN_STRAIGHT);
  kept.applyTrack({
    lift: [],
    lay: Array.from({ length: KEPT_OPEN_STRAIGHTS }, (_, slot) => openStraight(straight, slot)),
  });
  for (const heading of KEPT_L_HEADINGS) {
    kept.applyTrack(
      kept.pieceChange(
        straight,
        pose16(
          zeta16([KEPT_L_CORNER_STUDS.x, 0n, 0n, 0n, KEPT_L_CORNER_STUDS.z, 0n, 0n, 0n]),
          heading,
        ),
      ),
    );
  }
  const built = build([], kept, tableRegion(ROOM_MM));
  const outside = kept.pieceChange(
    straight,
    pose16(zeta16([OUTSIDE_STUDS.x, 0n, 0n, 0n, OUTSIDE_STUDS.z, 0n, 0n, 0n]), 0),
  );
  kept.applyTrack(outside);
  const lay = new PlanDelta();
  writeTrackLay(lay, kept, outside.lay.length);
  const lift: TrackChange = { lift: outside.lay, lay: [] };
  kept.applyTrack(lift);
  const unlay = new PlanDelta();
  writeTrackChange(unlay, kept, lift);
  const reads = new PanelReads(built.plans, built.planId);
  built.plans.subscribe(reads.read);
  return {
    variant: `one region keeping the rows of its ${KEPT_OPEN_STRAIGHTS} open straights and an L of two straights meeting without joining`,
    built,
    reads,
    scenarios: [
      {
        name: "track lay of a straight with both ends open outside the region, the apply part",
        edit: () => built.plans.apply(lay),
        inverse: () => built.plans.apply(unlay),
      },
    ],
    endRows: KEPT_OPEN_STRAIGHTS + KEPT_L_HEADINGS.length,
    endIssues: 2 * KEPT_OPEN_STRAIGHTS + KEPT_L_ROWS,
  };
}

function laidOutline(track: TrackDrawing, piece: number): TrackOutline {
  const delta = new PlanDelta();
  track.writeFootprint(piece, delta, WRITE_ADD);
  const outline = delta.outline[0];
  if (!outline) throw new Error(`laid piece ${piece} has no plan outline`);
  return outline;
}

function outlineQueries(track: TrackDrawing): ReadonlyArray<OutlineQuery> {
  const curve = laidOutline(track, track.pieceCount - CIRCLE_SECOND_CURVE);
  const middle = (curve.minX + curve.maxX) / 2;
  const straight = laidOutline(track, LOOP_STRAIGHT);
  const { box } = track.footprintAt(LOOP_STRAIGHT);
  const queries: OutlineQuery[] = [
    {
      outline: curve,
      rect: Float64Array.of(curve.minX, curve.minZ, curve.maxX, curve.maxZ),
      meets: true,
    },
    {
      outline: curve,
      rect: Float64Array.of(curve.maxX, curve.minZ, curve.maxX + 10, curve.maxZ),
      meets: false,
    },
    {
      outline: curve,
      rect: Float64Array.of(middle - 1, curve.minZ, middle + 1, curve.maxZ),
      meets: true,
    },
    {
      outline: curve,
      rect: Float64Array.of(curve.minX - 10, curve.minZ, curve.minX, curve.maxZ),
      meets: false,
    },
    {
      outline: straight,
      rect: Float64Array.of(box.minX, box.minZ - 10, box.maxX, box.minZ),
      meets: false,
    },
    {
      outline: straight,
      rect: Float64Array.of(box.minX, box.minZ - 10, box.maxX, box.minZ + 1),
      meets: true,
    },
    {
      outline: straight,
      rect: Float64Array.of(box.maxX, box.minZ, box.maxX + 10, box.maxZ),
      meets: false,
    },
    {
      outline: straight,
      rect: Float64Array.of(box.maxX - 1, box.minZ, box.maxX + 10, box.maxZ),
      meets: true,
    },
  ];
  if (box.maxZ - box.minZ !== 2 * HALF_WIDTH_LDU || box.maxX - box.minX !== 320 + 2 * TAB_LDU) {
    throw new Error("the loop's second piece isn't a 9V straight at a quarter-turn heading");
  }
  for (const { outline, rect, meets } of queries) {
    if (outline.meetsOpenRect(rect, 0) !== meets) {
      throw new Error(`an outline query of the bench didn't give ${meets}`);
    }
  }
  return queries;
}

let outlineHits = 0;

function outlineScenario(name: string, queries: ReadonlyArray<OutlineQuery>): Scenario {
  return {
    name,
    edit: () => {
      for (let q = 0; q < queries.length; q++) {
        const query = queries[q];
        if (!query) continue;
        if (query.outline.meetsOpenRect(query.rect, 0)) outlineHits++;
      }
    },
    inverse: () => {
      outlineHits = 0;
    },
  };
}

function outlineVariant(track: TrackDrawing, deltas: TrackDeltas): ProbeVariant {
  const plans = new PlanService(new RecordingBackend());
  const delta = new PlanDelta();
  writeFullRebuild(delta, [], track);
  plans.apply(delta);
  const planId = plans.createPlan(tableRegion(ROOM_MM));
  for (const table of OUTLINE_TABLES) plans.addTable(planId, table);
  plans.updatePlan(planId, { maxReachMm: COVERING_REACH_MM });
  const built: Built = { plans, planId, delta, models: [] };
  const reads = new PanelReads(plans, planId);
  plans.subscribe(reads.read);
  const queries = outlineQueries(track);
  return {
    variant: "one region of three tables, two meeting at a seam through two joints of the circle",
    built,
    reads,
    scenarios: [
      ...trackScenarios(built, deltas),
      outlineScenario(
        "TrackOutline.meetsOpenRect, four rectangles against a curve at a 22.5° step: certified floats",
        queries.slice(0, 4),
      ),
      outlineScenario(
        "TrackOutline.meetsOpenRect, four rectangles flush with or 1 LDU over a straight's edges: exact integers",
        queries.slice(4),
      ),
    ],
    endRows: track.pieceCount - deltas.unlay.removalCount,
    endIssues: 0,
  };
}

function trackScenarios(built: Built, deltas: TrackDeltas): Scenario[] {
  built.plans.apply(deltas.unlay);
  return [
    {
      name: "switch throw, the apply part",
      edit: () => built.plans.apply(deltas.throwOver),
      inverse: () => built.plans.apply(deltas.throwBack),
    },
    {
      name: "track lay of a closed R40 circle, the apply part",
      edit: () => built.plans.apply(deltas.lay),
      inverse: () => built.plans.apply(deltas.unlay),
    },
    {
      name: "track lay of a straight with both ends open outside every region, the apply part",
      edit: () => built.plans.apply(deltas.openLay),
      inverse: () => built.plans.apply(deltas.openUnlay),
    },
  ];
}

async function measure(
  windows: number,
  run: () => void,
  after: () => void = () => {},
): Promise<Window[]> {
  const measured: Window[] = [];
  for (let w = 0; w < windows; w++) {
    await quiet();
    const before = heapBytes();
    const start = performance.now();
    run();
    const end = performance.now();
    measured.push(await counted({ bytes: heapBytes() - before, start, end }));
    after();
  }
  return measured;
}

function summary(windows: ReadonlyArray<Window>): string {
  const times = windows.map((w) => w.ms);
  const clean = windows.filter((w) => w.gcs === 0).map((w) => w.bytes);
  const bytes =
    clean.length > 0 ? Math.round(percentile(clean, 0.5)).toLocaleString("en-US") : "n/a";
  return `${percentile(times, 0.5).toFixed(3)} | ${percentile(times, 0.95).toFixed(3)} | ${Math.max(...times).toFixed(3)} | ${bytes} | ${clean.length} of ${windows.length}`;
}

const COST_HEADER =
  "| p50 ms | p95 ms | worst ms | bytes, median of GC-free windows | GC-free windows |";

async function flaggedCosts(ids: Ids, lines: string[]): Promise<void> {
  lines.push(
    "",
    `### Flag-changing clicks, ${ROWS.toLocaleString("en-US")} rows, one region (${ROOM_MM} × ${FLAG_ROOM_DEPTH_MM} mm) with one ${ROOM_MM} × ${ROOM_MM} mm table; flagged rows sit in the room but off the table`,
    "",
    `| Flagged rows | Work ${COST_HEADER}`,
    "|---|---|---|---|---|---|---|",
  );
  const three = await threeBackend();
  for (const flagged of FLAGGED_SIZES) {
    const built = build(bricks(ROWS, flagged, ids), null, tableRegion(FLAG_ROOM_DEPTH_MM));
    const planId = built.planId ?? "";
    const extra = brick(0, ids.fresh(), FLAG_SHIFT_LDU);
    const one: PlanModelSource[] = [extra];
    const add = { added: one, removed: NONE };
    const drop = { added: NONE, removed: one };
    const click = (): void => {
      extra.id = ids.fresh();
      applyView(built, add);
    };
    const unclick = (): void => applyView(built, drop);
    click();
    unclick();
    if (built.plans.issueCount(planId) !== flagged) {
      throw new Error(`expected ${flagged} issues, found ${built.plans.issueCount(planId)}`);
    }
    lines.push(
      `| ${flagged.toLocaleString("en-US")} | a click that flags one more row, null backend | ${summary(await measure(COST_WINDOWS, click, unclick))} |`,
    );
    click();
    lines.push(
      `| ${flagged.toLocaleString("en-US")} | cold issues() after that click | ${summary(
        await measure(
          COST_WINDOWS,
          () => void built.plans.issues(planId),
          () => {
            unclick();
            click();
          },
        ),
      )} |`,
    );
    lines.push(
      `| ${flagged.toLocaleString("en-US")} | removing that flagged row, null backend | ${summary(await measure(COST_WINDOWS, unclick, click))} |`,
    );
    const turnedExtra = turned(extra, ids.fresh());
    const before: PlanModelSource[] = [extra];
    const after: PlanModelSource[] = [turnedExtra];
    const rotate = (): void => {
      turnedExtra.id = ids.fresh();
      applyView(built, { removed: before, added: after });
    };
    const rotateBack = (): void => {
      extra.id = ids.fresh();
      applyView(built, { removed: after, added: before });
    };
    lines.push(
      `| ${flagged.toLocaleString("en-US")} | rotating that flagged row, null backend | ${summary(await measure(COST_WINDOWS, rotate, rotateBack))} |`,
    );
    unclick();
    const target = built.models[Math.floor(ROWS / 2)] ?? extra;
    const partner = built.models[ROWS - 1] ?? extra;
    const updated: PlanModelSource[] = [target];
    const flagByUpdate = (): void => {
      target.facts[FACT_OVERLAP_SEGMENT] = MODEL_SEGMENT;
      target.facts[FACT_OVERLAP_SOURCE] = partner.id;
      applyUpdate(built, updated);
    };
    const clearByUpdate = (): void => {
      target.facts[FACT_OVERLAP_SEGMENT] = NO_OVERLAP_PARTNER;
      target.facts[FACT_OVERLAP_SOURCE] = NO_OVERLAP_PARTNER;
      applyUpdate(built, updated);
    };
    flagByUpdate();
    if (built.plans.issueCount(planId) !== flagged + 1) {
      throw new Error(`a flagging update left ${built.plans.issueCount(planId)} issues`);
    }
    clearByUpdate();
    lines.push(
      `| ${flagged.toLocaleString("en-US")} | a fact update that newly flags a mid-list row (an overlap partner), null backend | ${summary(await measure(COST_WINDOWS, flagByUpdate, clearByUpdate))} |`,
    );
    const boxes: WorldBox[] = [];
    for (let i = 0; i <= flagged; i++) boxes.push({ ...(built.models[i]?.box ?? extra.box) });
    lines.push(
      `| ${flagged.toLocaleString("en-US")} | render's setIssueBoxes, LineSegments rebuild, ${(flagged + 1).toLocaleString("en-US")} boxes | ${summary(
        await measure(
          COST_WINDOWS,
          () => three.setIssueBoxes(boxes),
          () => three.setIssueBoxes([]),
        ),
      )} |`,
    );
  }
}

async function readerCosts(ids: Ids, lines: string[]): Promise<void> {
  lines.push(
    "",
    "### Cold readers and the minimap's per-version overview, one region with one table covering the dense layout",
    "",
    `| Rows | Work ${COST_HEADER}`,
    "|---|---|---|---|---|---|---|",
  );
  for (const size of SIZES) {
    const built = build(bricks(size, 0, ids), null, tableRegion(ROOM_MM));
    const label = size.toLocaleString("en-US");
    lines.push(
      `| ${label} | materialize() | ${summary(await measure(COST_WINDOWS, () => void built.plans.materialize()))} |`,
    );
    lines.push(
      `| ${label} | JSON.stringify(materialize()), as #plan-state | ${summary(
        await measure(COST_WINDOWS, () => void JSON.stringify(built.plans.materialize())),
      )} |`,
    );
    lines.push(
      `| ${label} | overviewOf(plans), the minimap's work on each version | ${summary(
        await measure(COST_WINDOWS, () => void overviewOf(built.plans)),
      )} |`,
    );
    lines.push(
      `| ${label} | fitAllBox(plans), the camera's fitAll | ${summary(
        await measure(COST_WINDOWS, () => void fitAllBox(built.plans)),
      )} |`,
    );
  }
}

function fallbackRegion(tables: number): PlanRegion {
  return {
    id: "fallback",
    name: "Fallback",
    originChunkX: FALLBACK_CHUNK_X,
    originChunkZ: 0,
    footprint: {
      roomWidthMm: ROOM_MM,
      roomDepthMm: ROOM_MM,
      tables: Array.from({ length: tables }, (_, k) => ({
        id: `t${k}`,
        name: `Table ${k + 1}`,
        rect: { x: 200 * k, z: 0, width: 100, depth: 100 },
        heightMm: TABLE_HEIGHT_MM,
      })),
      obstacles: [],
    },
    maxOverhangMm: 1,
    maxReachMm: FALLBACK_REACH_MM,
  };
}

async function fallbackCosts(ids: Ids, lines: string[]): Promise<void> {
  lines.push(
    "",
    `### One fallback decision through PlanService.apply: a one-row add whose table edges sit next to 2^53, overhang 1 mm and reach ${FALLBACK_REACH_MM} mm, so no grown edge or reach strip certifies`,
    "",
    `| Tables | Fallbacks per add | ${COST_HEADER.slice(2)}`,
    "|---|---|---|---|---|---|---|",
  );
  const scratch = new CoverageScratch();
  for (const tables of FALLBACK_TABLES) {
    const region = fallbackRegion(tables);
    const plans = new PlanService(new RecordingBackend());
    const planId = plans.createPlan({
      name: region.name,
      roomWidthMm: ROOM_MM,
      roomDepthMm: ROOM_MM,
      originChunkX: region.originChunkX,
      originChunkZ: 0,
    });
    for (const table of region.footprint.tables) plans.addTable(planId, table);
    plans.updatePlan(planId, {
      maxOverhangMm: region.maxOverhangMm,
      maxReachMm: region.maxReachMm,
    });
    const origin = FALLBACK_CHUNK_X * CHUNK_LDU;
    const model: BenchModel = {
      id: ids.fresh(),
      handle: { chunkKey: 0, slot: 0, x: origin + 15, z: 15 },
      placeable: BRICK,
      shape: null,
      facts: emptyFacts(),
      box: { minX: origin + 10, minY: 0, minZ: 10, maxX: origin + 20, maxY: 24, maxZ: 20 },
    };
    const box = Float64Array.of(
      model.box.minX,
      0,
      model.box.minZ,
      model.box.maxX,
      24,
      model.box.maxZ,
    );
    const fallbacks =
      uncoveredPieces(regionContext(region).coverage, box, 0, scratch) === UNDECIDED ? 1 : 0;
    const delta = new PlanDelta();
    const one: PlanModelSource[] = [model];
    const add = (): void => {
      model.id = ids.fresh();
      writeViewUpdate(delta, { added: one, removed: NONE });
      plans.apply(delta);
    };
    const drop = (): void => {
      writeViewUpdate(delta, { added: NONE, removed: one });
      plans.apply(delta);
    };
    add();
    drop();
    lines.push(`| ${tables} | ${fallbacks} | ${summary(await measure(COST_WINDOWS, add, drop))} |`);
  }
}

async function footprintCosts(drawing: TrackDrawing, lines: string[]): Promise<void> {
  const delta = new PlanDelta();
  const writes = 100;
  const write = (): void => {
    delta.reset();
    for (let k = 0; k < writes; k++) drawing.writeFootprint(k % drawing.pieceCount, delta, 0);
  };
  write();
  const windows = await measure(COST_WINDOWS, write);
  const clean = windows.filter((w) => w.gcs === 0).map((w) => w.bytes / writes);
  const times = windows.map((w) => (w.ms / writes) * 1000);
  lines.push(
    "",
    "### TrackDrawing.writeFootprint, per piece (its geometry temporaries)",
    "",
    "| Pieces per window | µs per piece, p50 | bytes per piece, median of GC-free windows | GC-free windows |",
    "|---|---|---|---|",
    `| ${writes} | ${percentile(times, 0.5).toFixed(2)} | ${clean.length > 0 ? Math.round(percentile(clean, 0.5)) : "n/a"} | ${clean.length} of ${windows.length} |`,
  );
}

function openStraight(straight: number, slot: number): TrackPieceAt {
  const x = BigInt(slot % OPEN_STRAIGHTS_PER_ROW) * OPEN_STRAIGHT_PITCH.x;
  const z = BigInt(Math.floor(slot / OPEN_STRAIGHTS_PER_ROW)) * OPEN_STRAIGHT_PITCH.z;
  return {
    index: slot,
    piece: straight,
    pose: pose16(zeta16([x + 4n, 0n, 0n, 0n, z + 8n, 0n, 0n, 0n]), 0),
    yPlates: 0,
  };
}

async function trackIssueCosts(lines: string[]): Promise<void> {
  lines.push(
    "",
    "### Track issue rows, per track edit, against separate straights with both ends open",
    "",
    "| Open straights | Open ends in the region | writeIssues µs, p50 | writeIssues bytes, median of GC-free windows | lay one more and read issues(), p50 / p95 / worst ms | its bytes | GC-free windows |",
    "|---|---|---|---|---|---|---|",
  );
  for (const count of OPEN_STRAIGHT_COUNTS) {
    const loaded = await loadTrack();
    const { drawing: open } = loaded;
    const straight = loaded.catalog.pieces.findIndex((piece) => piece.id === OPEN_STRAIGHT);
    open.applyTrack({
      lift: [],
      lay: Array.from({ length: count }, (_, slot) => openStraight(straight, slot)),
    });
    const plans = new PlanService(new RecordingBackend());
    const rowsOfStraights = Math.ceil((count + 1) / OPEN_STRAIGHTS_PER_ROW) + 1;
    const studMm = 8;
    const widthMm = Number(OPEN_STRAIGHT_PITCH.x) * (OPEN_STRAIGHTS_PER_ROW + 1) * studMm;
    const depthMm = Number(OPEN_STRAIGHT_PITCH.z) * rowsOfStraights * studMm;
    const planId = plans.createPlan({
      name: "Open track",
      roomWidthMm: widthMm,
      roomDepthMm: depthMm,
      originChunkX: 0,
      originChunkZ: 0,
    });
    plans.updatePlan(planId, { maxReachMm: depthMm });
    plans.addTable(planId, {
      name: "Table",
      rect: { x: 0, z: 0, width: widthMm, depth: depthMm },
      heightMm: TABLE_HEIGHT_MM,
    });
    const full = new PlanDelta();
    writeFullRebuild(full, [], open);
    plans.apply(full);
    const writes = 20;
    const scratch = new PlanDelta();
    const write = (): void => {
      for (let k = 0; k < writes; k++) {
        scratch.reset();
        open.writeIssues(scratch);
      }
    };
    write();
    const written = await measure(COST_WINDOWS, write);
    const writtenClean = written.filter((w) => w.gcs === 0).map((w) => w.bytes / writes);
    const extra: TrackChange = { lift: [], lay: [openStraight(straight, count)] };
    open.applyTrack(extra);
    const layDelta = new PlanDelta();
    writeTrackLay(layDelta, open, 1);
    const lift: TrackChange = { lift: extra.lay, lay: [] };
    open.applyTrack(lift);
    const unlayDelta = new PlanDelta();
    writeTrackChange(unlayDelta, open, lift);
    const layAndRead = (): void => {
      plans.apply(layDelta);
      plans.issues(planId);
    };
    const unlay = (): void => {
      plans.apply(unlayDelta);
      plans.issues(planId);
    };
    layAndRead();
    unlay();
    const laid = await measure(COST_WINDOWS, layAndRead, unlay);
    const laidTimes = laid.map((w) => w.ms);
    const laidClean = laid.filter((w) => w.gcs === 0).map((w) => w.bytes);
    const ends = plans.issueCount(planId);
    if (ends !== 2 * count) throw new Error(`${count} open straights gave ${ends} rows`);
    lines.push(
      `| ${count} | ${ends} | ${(
        percentile(
          written.map((w) => w.ms / writes),
          0.5,
        ) * 1000
      ).toFixed(
        1,
      )} | ${writtenClean.length > 0 ? Math.round(percentile(writtenClean, 0.5)).toLocaleString("en-US") : "n/a"} | ${percentile(laidTimes, 0.5).toFixed(3)} / ${percentile(laidTimes, 0.95).toFixed(3)} / ${Math.max(...laidTimes).toFixed(3)} | ${laidClean.length > 0 ? Math.round(percentile(laidClean, 0.5)).toLocaleString("en-US") : "n/a"} | ${laidClean.length} of ${laid.length} |`,
    );
  }
}

function productionReads(plans: PlanService): void {
  const active = plans.activePlanId();
  plans.version();
  plans.plans();
  plans.sandboxCount();
  plans.placementCount();
  if (active !== null) {
    plans.insideCount(active);
    plans.issues(active);
    plans.regionView(active);
  }
  overviewOf(plans);
}

interface RegionEdit {
  readonly name: string;
  readonly run: () => void;
  readonly after?: () => void;
  readonly prepare?: () => void;
  readonly cleanup?: () => void;
}

async function regionEditCosts(ids: Ids, lines: string[]): Promise<void> {
  const built = build(bricks(ROWS, 0, ids), null, tableRegion(ROOM_MM));
  const plans = built.plans;
  const planId = built.planId ?? "";
  const tableId = plans.plans()[0]?.footprint.tables[0]?.id ?? "";
  let width = ROOM_MM;
  let height = TABLE_HEIGHT_MM;
  let spareTable = "";
  let sparePlan = "";
  const addSpareTable = (): void => {
    spareTable = plans.addTable(planId, { ...fullTable, name: "Table 2" });
  };
  const removeSpareTable = (): void => plans.removeTable(planId, spareTable);
  const addSparePlan = (): void => {
    sparePlan = plans.createPlan(tableRegion(ROOM_MM));
  };
  const removeSparePlan = (): void => {
    plans.removePlan(sparePlan);
    plans.activatePlan(planId);
  };
  const edits: ReadonlyArray<RegionEdit> = [
    {
      name: "room width, 2100 ↔ 2101 mm",
      run: () => {
        width = width === ROOM_MM ? ROOM_MM + 1 : ROOM_MM;
        plans.updatePlan(planId, { roomWidthMm: width });
      },
    },
    {
      name: "table height, 750 ↔ 751 mm",
      run: () => {
        height = height === TABLE_HEIGHT_MM ? TABLE_HEIGHT_MM + 1 : TABLE_HEIGHT_MM;
        plans.updateTable(planId, tableId, { heightMm: height });
      },
    },
    { name: "add a table", run: addSpareTable, after: removeSpareTable },
    {
      name: "remove a table",
      prepare: addSpareTable,
      run: removeSpareTable,
      after: addSpareTable,
      cleanup: removeSpareTable,
    },
    { name: "create a plan", run: addSparePlan, after: removeSparePlan },
    {
      name: "remove a plan",
      prepare: () => {
        addSparePlan();
        plans.activatePlan(planId);
      },
      run: () => plans.removePlan(sparePlan),
      after: () => {
        addSparePlan();
        plans.activatePlan(planId);
      },
      cleanup: removeSparePlan,
    },
    {
      name: `reach limit, ${COVERING_REACH_MM} → ${DEFAULT_REACH_MM} mm (at ${DEFAULT_REACH_MM} mm the rows in the table's middle band take the end-disk test)`,
      run: () => plans.updatePlan(planId, { maxReachMm: DEFAULT_REACH_MM }),
      after: () => plans.updatePlan(planId, { maxReachMm: COVERING_REACH_MM }),
    },
    {
      name: "name only",
      run: () => {
        width = width === ROOM_MM ? ROOM_MM + 1 : ROOM_MM;
        plans.updatePlan(planId, { name: width === ROOM_MM ? "Plan 1" : "Plan one" });
      },
    },
  ];
  lines.push(
    "",
    `### Region edits at ${ROWS.toLocaleString("en-US")} rows, one region with one table, ${REGION_EDITS} edits each (§6's target: 50 ms at p95)`,
    "",
    `| Edit | Path ${COST_HEADER}`,
    "|---|---|---|---|---|---|---|",
  );
  for (const edit of edits) {
    edit.prepare?.();
    edit.run();
    edit.after?.();
    lines.push(
      `| ${edit.name} | plan path | ${summary(await measure(REGION_EDITS, edit.run, edit.after))} |`,
    );
    lines.push(
      `| ${edit.name} | plus the panel's reads and the minimap's overviewOf | ${summary(
        await measure(
          REGION_EDITS,
          () => {
            edit.run();
            productionReads(plans);
          },
          edit.after,
        ),
      )} |`,
    );
    edit.cleanup?.();
  }
  if (plans.plans().length !== 1 || plans.plans()[0]?.footprint.tables.length !== 1) {
    throw new Error("the region edits left extra plans or tables");
  }
  const burst = (): void => {
    for (const typed of TYPED_WIDTHS_MM) plans.updatePlan(planId, { roomWidthMm: typed });
  };
  const restore = (): void => plans.updatePlan(planId, { roomWidthMm: ROOM_MM });
  burst();
  restore();
  lines.push(
    `| typing a width, four commits (2, 24, 240, 2400 mm), the whole burst | plan path | ${summary(await measure(REGION_EDITS, burst, restore))} |`,
  );
  plans.updatePlan(planId, { maxReachMm: DEFAULT_REACH_MM });
  const middle = brick(MID_TABLE_BRICK, ids.fresh(), 0);
  const one: PlanModelSource[] = [middle];
  const add = { added: one, removed: NONE };
  const drop = { added: NONE, removed: one };
  const click = (): void => {
    middle.id = ids.fresh();
    applyView(built, add);
  };
  const unclick = (): void => applyView(built, drop);
  click();
  unclick();
  lines.push(
    `| a click adding one brick mid-table at ${DEFAULT_REACH_MM} mm reach, so its row takes the end-disk test | plan path | ${summary(await measure(COST_WINDOWS, click, unclick))} |`,
  );
  plans.updatePlan(planId, { maxReachMm: COVERING_REACH_MM });
  lines.push(
    `| typing a width, four commits, the whole burst | plus the panel's reads and the minimap's overviewOf per commit | ${summary(
      await measure(
        REGION_EDITS,
        () => {
          for (const typed of TYPED_WIDTHS_MM) {
            plans.updatePlan(planId, { roomWidthMm: typed });
            productionReads(plans);
          }
        },
        restore,
      ),
    )} |`,
  );
}

interface Footprint {
  readonly heap: number;
  readonly buffers: number;
}

async function footprint(): Promise<Footprint> {
  await quiet();
  return { heap: heapBytes(), buffers: process.memoryUsage().arrayBuffers };
}

function perRow(label: string, from: Footprint, to: Footprint): string {
  const heap = (to.heap - from.heap) / ROWS;
  const buffers = (to.buffers - from.buffers) / ROWS;
  return `| ${label} | ${heap.toFixed(1)} | ${buffers.toFixed(1)} | ${(heap + buffers).toFixed(1)} |`;
}

async function memoryPerRow(ids: Ids, lines: string[]): Promise<void> {
  const models = bricks(ROWS, 0, ids);
  const empty = await footprint();
  const delta = new PlanDelta();
  writeFullRebuild(delta, models, null);
  const withDelta = await footprint();
  const plans = new PlanService(new RecordingBackend());
  plans.apply(delta);
  const planId = plans.createPlan(tableRegion(ROOM_MM));
  plans.addTable(planId, fullTable);
  plans.updatePlan(planId, { maxReachMm: COVERING_REACH_MM });
  const withPlans = await footprint();
  lines.push(
    "",
    `### Memory per row at ${ROWS.toLocaleString("en-US")} rows (the model objects existed before; typed arrays at the capacity they grew to)`,
    "",
    "| Holder | JS heap, bytes per row | ArrayBuffers, bytes per row | Total, bytes per row |",
    "|---|---|---|---|",
    perRow(
      "PlanService: rows, id table, evaluation and one region with one table",
      withDelta,
      withPlans,
    ),
    perRow(
      "a load's full-rebuild PlanDelta, which the editor drops after the load",
      empty,
      withDelta,
    ),
    perRow("both", empty, withPlans),
  );
  if (plans.placementCount() !== ROWS) throw new Error("memory build lost rows");
}

function probeTable(rows: ReadonlyArray<ProbeRow>): string[] {
  return [
    "| Variant | Edit | p50 µs | p95 µs | worst µs | Bytes beyond the skipped loop | GCs in the window | Reference mismatches | Sandbox after | Issues after |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => {
      const times = Array.from(r.times);
      return `| ${r.variant} | ${r.scenario} | ${(percentile(times, 0.5) * 1000).toFixed(1)} | ${(percentile(times, 0.95) * 1000).toFixed(1)} | ${(Math.max(...times) * 1000).toFixed(1)} | ${r.beyond} | ${r.gcs} | ${r.mismatches} | ${r.endSandbox.toLocaleString("en-US")} | ${r.endIssues} |`;
    }),
  ];
}

const mode = process.argv[2] ?? "all";
const ids = new Ids();
const track = await loadTrack();
const { drawing } = track;
const trackDeltas = layTrack(track);
const lines: string[] = [
  `cpu: ${cpus()[0]?.model ?? "unknown"} x${cpus().length}, node ${process.version}, mode ${mode}`,
  `bytes summed over ${[...COUNTED_SPACES].join(", ")}; times include any GC in the window, bytes come only from GC-free windows`,
];
let failed = false;
if (mode === "all" || mode === "probe") {
  const rows: ProbeRow[] = [];
  const variants: ProbeVariant[] = [false, true].map((withRegion) => {
    const built = build(bricks(ROWS, 0, ids), drawing, withRegion ? tableRegion(ROOM_MM) : null);
    const reads = new PanelReads(built.plans, built.planId);
    built.plans.subscribe(reads.read);
    return {
      variant: withRegion ? "one region and table" : "no regions",
      built,
      reads,
      scenarios: [...viewScenarios(built, ids), ...trackScenarios(built, trackDeltas)],
      endRows: ROWS + drawing.pieceCount - trackDeltas.unlay.removalCount,
      endIssues: withRegion ? 0 : null,
    };
  });
  variants.push(await keptRowsVariant(), outlineVariant(drawing, trackDeltas));
  const shortRows: ShortRow[] = [];
  for (const { variant, reads, scenarios } of variants) {
    for (const scenario of scenarios) shortRows.push(await shortProbe(variant, scenario, reads));
  }
  for (let pass = 0; pass < JIT_WARMUP_PASSES; pass++) {
    for (const { scenarios } of variants) {
      for (const scenario of scenarios) warm(scenario, JIT_WARMUP_CYCLES);
    }
  }
  const endIssues = new Map<string, number | null>();
  for (const { variant, built, reads, scenarios, endRows, endIssues: issues } of variants) {
    for (const scenario of scenarios) rows.push(await probe(variant, built, scenario, reads));
    if (built.plans.placementCount() !== endRows) {
      throw new Error(`the probe ended with ${built.plans.placementCount()} rows`);
    }
    endIssues.set(variant, issues);
  }
  lines.push(
    "",
    `### Allocation probe, short protocol (published, not gated): each edit's first ${WARMUP_CYCLES} warm-up cycles straight after the rows are built, before any JIT warm-up`,
    "",
    ...shortTable(shortRows),
  );
  for (const row of shortRows) if (row.mismatches !== 0) failed = true;
  lines.push(
    "",
    `### Allocation probe, JIT protocol (the gate), the plan path at ${ROWS.toLocaleString("en-US")} dense bricks plus ${drawing.pieceCount} track pieces with no open end: a passing loop with two switches and an R40 circle; and a region holding ${KEPT_OPEN_STRAIGHTS} separate open straights and an L of two straights meeting without joining, whose ${2 * KEPT_OPEN_STRAIGHTS + KEPT_L_ROWS} rows (one with two owners) must stay as they are while a straight is laid and lifted outside it; and the same track in a region of three tables whose seam passes through two joints of the circle facing across it, so laying the circle runs the outline rows, the off-table cut and the exact joint test, beside direct calls of the outline predicate on a 22.5° curve (certified floats) and on a straight with rectangles flush to its edges (exact integers)`,
    "",
    `Each edit is the real producer (writeViewUpdate, or a delta filled by writeTrackLay and writeTrackThrow before the window) plus PlanService.apply plus one subscribed listener making the production reader path's reads: what PlanPanel reads on each version (version(), plans(), activePlanId(), sandboxCount(), and for the active region insideCount(), issues() and regionView().tables) and the minimap legend's placementCount(), plus issueCount() and issueVersion(), checking with Object.is that each reference is unchanged unless its own version bumped. The two TrackOutline rows time the predicate calls themselves, with no apply and so no reads. First every edit of every variant runs ${JIT_WARMUP_PASSES} passes of ${JIT_WARMUP_CYCLES} cycles of edit plus inverse through the same window loop, so V8 has optimized the plan path and the loop; then each edit runs another ${WARMUP_CYCLES} warm-up cycles; then, after gc() and ${SETTLE_MS} ms, ${CYCLES} cycles with the work skipped and ${CYCLES} with it; times are the edit alone over another ${CYCLES} cycles.`,
    "",
    ...probeTable(rows),
  );
  for (const row of rows) {
    const expected = endIssues.get(row.variant) ?? null;
    const regionDirty = expected !== null && (row.endSandbox !== 0 || row.endIssues !== expected);
    if (row.beyond !== 0 || row.gcs !== 0 || row.mismatches !== 0 || regionDirty) failed = true;
  }
}
if (mode === "all" || mode === "costs") {
  await flaggedCosts(ids, lines);
  await readerCosts(ids, lines);
  await fallbackCosts(ids, lines);
  await footprintCosts(drawing, lines);
  await trackIssueCosts(lines);
  await regionEditCosts(ids, lines);
  await memoryPerRow(ids, lines);
}
observer.disconnect();
process.stdout.write(`${lines.join("\n")}\n`);
if (failed) {
  process.stderr.write(
    "the plan path allocated, collected, changed a stable reference, or left region rows dirty\n",
  );
  process.exitCode = 1;
}
