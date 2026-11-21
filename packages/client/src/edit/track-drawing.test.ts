import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
  type PartAsset,
} from "@brr/catalog";
import {
  ConnectorTable,
  EditHistory,
  PlanDelta,
  WORLD_TRACK_FRAME,
  World,
  levelCrossings,
  layMoves,
  runMoves,
  solveClosure,
  type TrackSegment,
} from "@brr/domain";
import {
  addZeta16,
  lduFromMm,
  PLATE_LDU,
  pose16,
  STUD_LDU,
  zeta16,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";
import type { TrackShape } from "@brr/schema/bundle";
import {
  INSTANCE_MATRIX_FLOATS,
  SCENE_BACKEND,
  type BufferMemory,
  type ISceneBackend,
  type RebaseEvent,
  type WorldBox,
} from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { beforeAll, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { writeFullRebuild, writeTrackChange, writeTrackLay } from "../plan/plan-producer.ts";
import type { IPlanService } from "../plan/plan-service.ts";
import { ColorTable } from "../scene/viewer-scene.ts";
import { PLAN_SERVICE, SNAP_SHAPES } from "../tokens.ts";
import { fixtureModel, fixtureModelChecks } from "./fixture-model.test-support.ts";
import { partPlaceable, type Placeable } from "./placeable.ts";
import { PlacedChunks, type PlacedModel } from "./placed-chunks.ts";
import {
  TrackDrawing,
  type ClosureState,
  type TrackBlockView,
  type TrackDragView,
  type TrackEndView,
  type TrackFootprint,
  type TrackRefusal,
  type TrackRouteView,
} from "./track-drawing.ts";
import { carrierAtOrigin } from "./track-carrier.test-support.ts";
import {
  EVERY_MODEL,
  cellKey,
  seatsPending,
  studSeats,
  trackObstacles,
  type TrackObstacles,
} from "./track-obstacles.ts";
import type { ExtensionTurn } from "./track-extension.ts";
import type { SupportBandAt } from "./track-bands.ts";
import { heightText } from "./size-labels.ts";
import { TrackSupport, antiStudsOf } from "./track-support.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const NO_TRACK_PARTS = (): ReadonlySet<number> => new Set();
const MM_PER_LDU = 1 / lduFromMm(1);
const SHRINK_MM = 2;
const RENDER_FLOAT_LDU = 1e-3;
const SWEEP_TIMEOUT_MS = 60_000;
const CLOSURE_SEARCH_TIMEOUT_MS = 30_000;

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

class PlanOnlyBackend implements ISceneBackend {
  async init(): Promise<never> {
    throw new Error("not used");
  }
  setPalette(): void {}
  addParts(): void {}
  setPartMeshes(): void {}
  setFarStuds(): void {}
  setFarModelMesh(): void {}
  setColors(): void {}
  setChunk(): void {}
  deleteChunk(): void {}
  setNeededMeshListener(): void {}
  setGhost(): void {}
  placeGhost(): void {}
  setGhostVerdict(): void {}
  setSelectionBoxes(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setGround(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  deleteVehicle(): void {}
  setIssueBoxes(): void {}
  setGuides(): void {}
  projectToNdc(): void {}
  rayThrough(): void {}
  setView(): void {}
  resize(): void {}
  renderFrame(): void {}
  needsFrame(): boolean {
    return true;
  }
  async waitForGpu(): Promise<void> {}
  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return [];
  }
  bufferMemory(): BufferMemory {
    return { vertexIndexBytes: 0, otherBytes: 0 };
  }
  forceTier(): void {}
  setFarModel(): void {}
}

interface Extent {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

function emptyExtent(): Extent {
  return {
    minX: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  };
}

function grow(extent: Extent, x: number, z: number): void {
  extent.minX = Math.min(extent.minX, x);
  extent.maxX = Math.max(extent.maxX, x);
  extent.minZ = Math.min(extent.minZ, z);
  extent.maxZ = Math.max(extent.maxZ, z);
}

function commitDrag(layout: TrackDrawing) {
  const outcome = layout.endDrag();
  layout.applyTrack(outcome.change);
  return {
    laid: outcome.change.lay.length,
    joined: outcome.goal !== null && layout.joinsAt(outcome.goal),
    refusal: outcome.refusal,
    blocked: outcome.blocked,
    withheld: outcome.withheld,
  };
}

function layPiece(layout: TrackDrawing, catalogIndex: number, placement: Pose16): void {
  layout.applyTrack(layout.pieceChange(catalogIndex, placement, 0));
}

const container = new Container();
let drawing: TrackDrawing;
let footprints: ReadonlyArray<TrackFootprint>;
let rendered: Extent;
let ovalStrokes: ReadonlyArray<DrawnStroke>;

type StudPoint = readonly [number, number];

interface DrawnStroke {
  readonly points: ReadonlyArray<StudPoint>;
  readonly view: TrackDragView | null;
  readonly ghost: ReturnType<TrackDrawing["ghost"]>;
  readonly commit: ReturnType<typeof commitDrag>;
  readonly laid: ReadonlyArray<TrackRouteView>;
}

const POINT_SPACING_STUDS = 1;
const HAND_WOBBLE_STUDS = 1.5;
const HAND_WAVELENGTHS_STUDS = [23, 61] as const;

function linePoints(from: StudPoint, to: StudPoint): StudPoint[] {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const steps = Math.max(1, Math.ceil(length / POINT_SPACING_STUDS));
  return Array.from({ length: steps + 1 }, (_v, i): StudPoint => {
    const t = i / steps;
    return [from[0] + t * (to[0] - from[0]), from[1] + t * (to[1] - from[1])];
  });
}

function arcPoints(centre: StudPoint, radius: number, fromDeg: number, toDeg: number): StudPoint[] {
  const sweep = ((toDeg - fromDeg) * Math.PI) / 180;
  const steps = Math.max(1, Math.ceil((Math.abs(sweep) * radius) / POINT_SPACING_STUDS));
  return Array.from({ length: steps + 1 }, (_v, i): StudPoint => {
    const angle = (fromDeg * Math.PI) / 180 + (sweep * i) / steps;
    return [centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)];
  });
}

function chained(...parts: ReadonlyArray<ReadonlyArray<StudPoint>>): StudPoint[] {
  return parts.flatMap((part, i) => (i === 0 ? part : part.slice(1)));
}

function byHand(points: ReadonlyArray<StudPoint>, phase: number): StudPoint[] {
  let travelled = 0;
  const arcs = points.map((point, i) => {
    const previous = points[i - 1];
    if (previous) travelled += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    return travelled;
  });
  return points.map((point, i): StudPoint => {
    const previous = points[Math.max(0, i - 1)] ?? point;
    const next = points[Math.min(points.length - 1, i + 1)] ?? point;
    const length = Math.hypot(next[0] - previous[0], next[1] - previous[1]) || 1;
    const s = arcs[i] ?? 0;
    const taper = Math.min(1, s / 8, (travelled - s) / 8);
    const offset =
      HAND_WOBBLE_STUDS *
      taper *
      HAND_WAVELENGTHS_STUDS.reduce(
        (sum, wavelength) => sum + Math.sin((2 * Math.PI * s) / wavelength + phase) / 2,
        0,
      );
    const nx = -(next[1] - previous[1]) / length;
    const nz = (next[0] - previous[0]) / length;
    return [point[0] + offset * nx, point[1] + offset * nz];
  });
}

function drawStroke(layout: TrackDrawing, points: ReadonlyArray<StudPoint>): DrawnStroke {
  const [first, ...rest] = points;
  if (!first) throw new Error("a stroke has at least one point");
  const before = layout.routes().length;
  layout.beginDrag(
    first[0] * STUD_LDU,
    first[1] * STUD_LDU,
    Math.round(first[0]) * STUD_LDU,
    Math.round(first[1]) * STUD_LDU,
  );
  for (const [x, z] of rest) layout.moveDrag(x * STUD_LDU, z * STUD_LDU);
  const view = layout.dragView();
  const ghost = layout.ghost();
  const commit = commitDrag(layout);
  return { points, view, ghost, commit, laid: layout.routes().slice(before) };
}

function distanceToStroke(
  points: ReadonlyArray<StudPoint>,
  xStuds: number,
  zStuds: number,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1] ?? [0, 0];
    const [bx, bz] = points[i] ?? [0, 0];
    const length2 = (bx - ax) ** 2 + (bz - az) ** 2;
    const t =
      length2 === 0
        ? 0
        : Math.min(
            1,
            Math.max(0, ((xStuds - ax) * (bx - ax) + (zStuds - az) * (bz - az)) / length2),
          );
    best = Math.min(best, Math.hypot(xStuds - (ax + t * (bx - ax)), zStuds - (az + t * (bz - az))));
  }
  return best;
}

function sameSpot(a: TrackEndView, b: TrackEndView): boolean {
  return Math.abs(a.xLdu - b.xLdu) < COINCIDENT_LDU && Math.abs(a.zLdu - b.zLdu) < COINCIDENT_LDU;
}

function runEnd(laid: ReadonlyArray<TrackRouteView>): TrackEndView | null {
  const last = laid.at(-1);
  if (!last) return null;
  const previous = laid.at(-2);
  if (!previous) return last.to;
  const joinsPrevious = (end: TrackEndView) =>
    sameSpot(end, previous.from) || sameSpot(end, previous.to);
  return joinsPrevious(last.from) ? last.to : last.from;
}

function furthestFromStroke(stroke: DrawnStroke): number {
  const free = runEnd(stroke.laid);
  let worst = 0;
  for (const route of stroke.laid) {
    for (const end of [route.from, route.to]) {
      if (free && end === free) continue;
      const away = distanceToStroke(stroke.points, end.xLdu / STUD_LDU, end.zLdu / STUD_LDU);
      worst = Math.max(worst, away);
    }
  }
  return worst;
}

function openEndNearest(layout: TrackDrawing, [x, z]: StudPoint): StudPoint {
  const end = layout
    .openEnds()
    .reduce<TrackEndView | null>(
      (best, e) =>
        best &&
        Math.hypot(best.xLdu / STUD_LDU - x, best.zLdu / STUD_LDU - z) <=
          Math.hypot(e.xLdu / STUD_LDU - x, e.zLdu / STUD_LDU - z)
          ? best
          : e,
      null,
    );
  if (!end) throw new Error("the layout has no open end");
  return [end.xLdu / STUD_LDU, end.zLdu / STUD_LDU];
}

function handDrawnOval(layout: TrackDrawing, at: StudPoint): ReadonlyArray<DrawnStroke> {
  const [x, z] = at;
  const out = drawStroke(
    layout,
    byHand(
      chained(
        linePoints([x, z], [x + 64, z]),
        arcPoints([x + 64, z + 40], 40, -90, 90),
        linePoints([x + 64, z + 80], [x, z + 80]),
      ),
      0.4,
    ),
  );
  const from = openEndNearest(layout, [x, z + 80]);
  const back = drawStroke(
    layout,
    byHand(chained([from], arcPoints([x, z + 40], 40, 90, 270), [[x, z]]), 1.9),
  );
  return [out, back];
}

beforeAll(async () => {
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  container.rebind(SCENE_BACKEND).toConstantValue(new PlanOnlyBackend());
  const bundle = await container
    .get(PART_BUNDLE_LOADER)
    .load("standard", (part) => part.role === "track");
  drawing = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  ovalStrokes = handDrawnOval(drawing, [180, 190]);
  footprints = Array.from({ length: drawing.pieceCount }, (_, p) => drawing.footprintAt(p));
  rendered = emptyExtent();
  for (const key of new Set(footprints.map((f) => f.key.chunkKey))) {
    const chunk = drawing.chunkInstances(key);
    if (!chunk) continue;
    for (let i = 0; i < chunk.count; i++) {
      const positions = bundle.parts[chunk.partIndex[i] ?? 0]?.mesh.positions ?? new Float32Array();
      const m = chunk.matrices.subarray(i * INSTANCE_MATRIX_FLOATS);
      for (let v = 0; v < positions.length; v += 3) {
        const px = positions[v] ?? 0;
        const py = positions[v + 1] ?? 0;
        const pz = positions[v + 2] ?? 0;
        const x = (m[0] ?? 0) * px + (m[1] ?? 0) * py + (m[2] ?? 0) * pz + (m[3] ?? 0);
        const z = (m[8] ?? 0) * px + (m[9] ?? 0) * py + (m[10] ?? 0) * pz + (m[11] ?? 0);
        grow(rendered, chunk.originX + x, chunk.originZ + z);
      }
    }
  }
});

function unionOf(boxes: ReadonlyArray<WorldBox>): Extent {
  const extent = emptyExtent();
  for (const box of boxes) {
    grow(extent, box.minX, box.minZ);
    grow(extent, box.maxX, box.maxZ);
  }
  return extent;
}

function offTableIssues(table: { x: number; z: number; width: number; depth: number }): number {
  const plans = container.get(PLAN_SERVICE);
  const planId = plans.createPlan({
    name: "Tight table",
    roomWidthMm: 4000,
    roomDepthMm: 3000,
    originChunkX: 0,
    originChunkZ: 0,
  });
  plans.addTable(planId, { name: "Table", rect: table, heightMm: 750 });
  const delta = new PlanDelta();
  writeFullRebuild(delta, [], drawing);
  plans.apply(delta);
  const issues = plans.issues(planId);
  plans.removePlan(planId);
  return issues.filter((issue) => issue.rule === "trackOffTable").length;
}

it("closes an oval drawn by hand in two strokes, every piece within half a straight of the stroke", () => {
  const halfStraight = Number(drawing.kit.straightStuds) / 2;
  expect(ovalStrokes.map((stroke) => stroke.commit.blocked)).toEqual([null, null]);
  expect(ovalStrokes.map((stroke) => stroke.commit.joined)).toEqual([false, true]);
  expect(drawing.openEnds()).toHaveLength(0);
  expect(drawing.joinedPairs()).toBe(drawing.pieceCount);
  for (const stroke of ovalStrokes) {
    expect(furthestFromStroke(stroke)).toBeLessThanOrEqual(halfStraight);
  }
});

it("gives the plan the same extent as the rendered geometry of the laid pieces", () => {
  const union = unionOf(footprints.map((f) => f.box));
  expect(union.minX).toBeCloseTo(rendered.minX, -Math.log10(RENDER_FLOAT_LDU));
  expect(union.minZ).toBeCloseTo(rendered.minZ, -Math.log10(RENDER_FLOAT_LDU));
  expect(union.maxX).toBeCloseTo(rendered.maxX, -Math.log10(RENDER_FLOAT_LDU));
  expect(union.maxZ).toBeCloseTo(rendered.maxZ, -Math.log10(RENDER_FLOAT_LDU));
});

it("fits a table cut to the oval's geometry and overhangs one cut two millimetres shorter", () => {
  const x = Math.floor(rendered.minX * MM_PER_LDU);
  const z = Math.floor(rendered.minZ * MM_PER_LDU);
  const width = Math.ceil(rendered.maxX * MM_PER_LDU) - x;
  const depth = Math.ceil(rendered.maxZ * MM_PER_LDU) - z;
  expect(offTableIssues({ x, z, width, depth })).toBe(0);
  expect(offTableIssues({ x, z, width: width - SHRINK_MM, depth })).toBeGreaterThan(0);
  expect(offTableIssues({ x: x + SHRINK_MM, z, width: width - SHRINK_MM, depth })).toBeGreaterThan(
    0,
  );
});

it("marks a drag target as joining only when the closure solver finds an exact join", async () => {
  const bundle = await container
    .get(PART_BUNDLE_LOADER)
    .load("standard", (part) => part.role === "track");
  const layout = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  const lay = (from: readonly [number, number], to: readonly [number, number]): void => {
    layout.beginDrag(
      from[0] * STUD_LDU,
      from[1] * STUD_LDU,
      from[0] * STUD_LDU,
      from[1] * STUD_LDU,
    );
    layout.moveDrag(to[0] * STUD_LDU, to[1] * STUD_LDU);
    commitDrag(layout);
  };
  const aim = (from: readonly [number, number], to: readonly [number, number]) => {
    layout.beginDrag(
      from[0] * STUD_LDU,
      from[1] * STUD_LDU,
      from[0] * STUD_LDU,
      from[1] * STUD_LDU,
    );
    layout.moveDrag(to[0] * STUD_LDU, to[1] * STUD_LDU);
    const target = layout.dragTarget();
    const closure = layout.dragView()?.closure ?? null;
    layout.cancelDrag();
    return { target, closure };
  };
  lay([0, 0], [48, 0]);
  lay([51, 2], [99, 2]);
  lay([163, 2], [211, 2]);

  const refused = aim([51, 2], [48, 0]);
  expect(refused.closure).toBe("impossible");
  expect(refused.target).toEqual({ end: expect.any(Number), joins: false });

  const exact = aim([99, 2], [163, 2]);
  expect(exact.closure).toBe("exact");
  expect(exact.target).toEqual({ end: expect.any(Number), joins: true });
});

function latticePose(x: number, z: number, heading = 0) {
  return pose16(zeta16([BigInt(x), 0n, 0n, 0n, BigInt(z), 0n, 0n, 0n]), heading);
}

const DRAG_DIRECTIONS = 48;
const DRAG_STUDS = 150;
const QUARTER_TURN_STEPS = 4;

it("starts a run drawn on open ground on the studs, facing a quarter turn, at any drag angle", async () => {
  const bundle = await container
    .get(PART_BUNDLE_LOADER)
    .load("standard", (part) => part.role === "track");
  const offGrid: string[] = [];
  for (let i = 0; i < DRAG_DIRECTIONS; i++) {
    const angle = ((i + 0.25) * 2 * Math.PI) / DRAG_DIRECTIONS;
    const run = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
    run.beginDrag(0, 0, 0, 0);
    run.moveDrag(Math.cos(angle) * DRAG_STUDS * STUD_LDU, Math.sin(angle) * DRAG_STUDS * STUD_LDU);
    expect(commitDrag(run).laid).toBeGreaterThan(0);
    const start = run.openEnds().find((end) => end.xLdu === 0 && end.zLdu === 0);
    if (start?.heading === undefined || start.heading % QUARTER_TURN_STEPS !== 0) {
      offGrid.push(`${((angle * 180) / Math.PI).toFixed(1)}°: ${JSON.stringify(start)}`);
    }
  }
  expect(offGrid).toEqual([]);
});

const BASEPLATE_STUD_PHASE_LDU = STUD_LDU / 2;

function onStudGrid(ldu: number): boolean {
  return (((ldu - BASEPLATE_STUD_PHASE_LDU) % STUD_LDU) + STUD_LDU) % STUD_LDU === 0;
}

it(
  "puts the studs of straights, switches and the crossing exactly on the baseplate's stud grid, near the origin and a million studs out",
  async () => {
    const bundle = await container
      .get(PART_BUNDLE_LOADER)
      .load("standard", (part) => part.role === "track");
    const yard = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
    const nowhere = 1e12;
    const seated = yard.pieceParts().filter((part) => part.piece.kind !== "curve");
    expect(new Set(seated.map((part) => part.piece.kind))).toEqual(
      new Set(["straight", "switch", "crossing"]),
    );
    for (const part of seated) {
      part.def.connectors.forEach((_end, held) => {
        for (const [x, z] of [
          [0, 0],
          [7, -3],
          [1_000_003, -999_999],
        ] as const) {
          for (let heading = 0; heading < 16; heading += QUARTER_TURN_STEPS) {
            const free = latticePose(x, z, heading);
            const snap = yard.snapPiece(part.catalogIndex, held, nowhere, nowhere, free);
            expect(snap.end).toBeNull();
            layPiece(yard, part.catalogIndex, snap.placement);
          }
        }
      });
    }
    const offGrid: string[] = [];
    let checked = 0;
    for (const key of yard.chunkKeys()) {
      const chunk = yard.chunkInstances(key);
      if (!chunk) continue;
      for (let i = 0; i < chunk.count; i++) {
        const part = bundle.parts[chunk.partIndex[i] ?? 0];
        if (!part) continue;
        const m = chunk.matrices.subarray(i * INSTANCE_MATRIX_FLOATS);
        for (let s = 0; s < part.studPrimitiveIndex.length; s++) {
          const stud = part.studMatrices.subarray(s * INSTANCE_MATRIX_FLOATS);
          const px = stud[3] ?? 0;
          const pz = stud[11] ?? 0;
          if (!onStudGrid(px) || !onStudGrid(pz)) continue;
          const x = chunk.originX + (m[0] ?? 0) * px + (m[2] ?? 0) * pz + (m[3] ?? 0);
          const z = chunk.originZ + (m[8] ?? 0) * px + (m[10] ?? 0) * pz + (m[11] ?? 0);
          checked++;
          if (!onStudGrid(x) || !onStudGrid(z)) offGrid.push(`${part.id} stud at ${x}, ${z}`);
        }
      }
    }
    expect(offGrid.slice(0, 5)).toEqual([]);
    expect(checked).toBeGreaterThan(seated.length * 100);
  },
  SWEEP_TIMEOUT_MS,
);

it("lays a passing siding from the real 9V switches that closes exactly and keeps every join when thrown", async () => {
  const bundle = await container
    .get(PART_BUNDLE_LOADER)
    .load("standard", (part) => part.role === "track");
  const siding = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  const index = (id: string): number => {
    const part = siding.pieceParts().find((p) => p.piece.id === id);
    if (!part) throw new Error(`${id} is not placeable`);
    return part.catalogIndex;
  };
  const right = index("ldraw:75541-f1");
  const left = siding.pieceSet.mirrored(right);
  const curve = index("ldraw:74747");
  if (left === null) throw new Error("the right switch has no mirror");
  const snapAt = (piece: number, connector: number, end: { xLdu: number; zLdu: number }) => {
    const snap = siding.snapPiece(piece, connector, end.xLdu, end.zLdu, latticePose(0, 0));
    expect(snap.end).not.toBeNull();
    layPiece(siding, piece, snap.placement);
  };
  const openEndNear = (xStuds: number, zStuds: number) => {
    const end = siding
      .openEnds()
      .find((e) => Math.hypot(e.xLdu / STUD_LDU - xStuds, e.zLdu / STUD_LDU - zStuds) < 1);
    if (!end) throw new Error(`no open end near ${xStuds}, ${zStuds} studs`);
    return end;
  };

  layPiece(siding, right, latticePose(0, 0));
  snapAt(curve, 1, openEndNear(32.69, 12.96));
  const draw = (from: readonly [number, number], to: readonly [number, number]) => {
    siding.beginDrag(
      from[0] * STUD_LDU,
      from[1] * STUD_LDU,
      from[0] * STUD_LDU,
      from[1] * STUD_LDU,
    );
    siding.moveDrag(to[0] * STUD_LDU, to[1] * STUD_LDU);
    return commitDrag(siding);
  };
  draw([32, 0], [80, 0]);
  snapAt(left, 1, openEndNear(80, 0));
  snapAt(curve, 0, openEndNear(79.31, 12.96));
  expect(draw([48, 16], [64, 16]).joined).toBe(true);

  expect(siding.pieceCount).toBe(8);
  expect(siding.joinedPairs()).toBe(8);
  expect(siding.openEnds()).toHaveLength(2);
  expect(siding.gaps()).toHaveLength(0);

  for (const lever of siding.switchLevers()) {
    const thrown = siding.switchThrow(lever.placement);
    if (thrown) siding.applyTrack(thrown.change);
  }
  expect(siding.switchLevers().map((s) => s.lever)).toEqual(["branching", "branching"]);
  expect(siding.joinedPairs()).toBe(8);
  expect(siding.openEnds()).toHaveLength(2);

  const reopened = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  expect(reopened.restore(siding.records()).ok).toBe(true);
  expect(reopened.switchLevers().map((s) => s.lever)).toEqual(["branching", "branching"]);
  expect(reopened.joinedPairs()).toBe(8);
  expect(reopened.openEnds()).toHaveLength(2);
});

const RASTER_CELL_LDU = 2;
const RASTER_KEY_STRIDE = 2 ** 24;
const RASTER_KEY_OFFSET = 2 ** 23;
const COINCIDENT_LDU = 1e-6;
const AREA_EPSILON = 1e-9;
const FULL_TURN_CURVES = 16;

type Run = ReadonlyArray<TrackSegment>;
type Rect = readonly [number, number, number, number];

function piecesIn(run: Run): number {
  return run.reduce((sum, s) => sum + (s.kind === "straight" ? s.count : s.curves), 0);
}

function studPose(x: number, z: number, heading: number): Pose16 {
  return pose16(zeta16([BigInt(x), 0n, 0n, 0n, BigInt(z), 0n, 0n, 0n]), heading);
}

async function trackAndRoadBundle() {
  return container
    .get(PART_BUNDLE_LOADER)
    .load("standard", (part) => part.role === "track" || part.role === "road");
}

function layRun(layout: TrackDrawing, start: Pose16, run: Run): Pose16 {
  const moves = runMoves(layout.kit, { segments: run, pieces: piecesIn(run) });
  const { placed, end } = layMoves(start, moves);
  for (const piece of placed) {
    const part = layout.kitParts().find((k) => k.def.id === piece.piece.id);
    if (!part) throw new Error(`${piece.piece.id} is not in the drawing kit`);
    layPiece(layout, part.catalogIndex, piece.placement);
  }
  return end;
}

function rasterKey(ix: number, iz: number): number {
  return (ix + RASTER_KEY_OFFSET) * RASTER_KEY_STRIDE + (iz + RASTER_KEY_OFFSET);
}

function rasterTriangles(
  positions: Float32Array,
  m: Float32Array,
  originX: number,
  originZ: number,
  cells: Set<number>,
): void {
  const xs = [0, 0, 0];
  const zs = [0, 0, 0];
  for (let t = 0; t + 8 < positions.length; t += 9) {
    for (let v = 0; v < 3; v++) {
      const px = positions[t + 3 * v] ?? 0;
      const py = positions[t + 3 * v + 1] ?? 0;
      const pz = positions[t + 3 * v + 2] ?? 0;
      xs[v] = originX + (m[0] ?? 0) * px + (m[1] ?? 0) * py + (m[2] ?? 0) * pz + (m[3] ?? 0);
      zs[v] = originZ + (m[8] ?? 0) * px + (m[9] ?? 0) * py + (m[10] ?? 0) * pz + (m[11] ?? 0);
    }
    const [ax = 0, bx = 0, cx = 0] = xs;
    const [az = 0, bz = 0, cz = 0] = zs;
    const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    if (Math.abs(area) < AREA_EPSILON) continue;
    const sign = Math.sign(area);
    const edge = (x0: number, z0: number, x1: number, z1: number, x: number, z: number) =>
      sign * ((x1 - x0) * (z - z0) - (z1 - z0) * (x - x0));
    const ix0 = Math.ceil(Math.min(ax, bx, cx) / RASTER_CELL_LDU - 0.5);
    const ix1 = Math.floor(Math.max(ax, bx, cx) / RASTER_CELL_LDU - 0.5);
    const iz0 = Math.ceil(Math.min(az, bz, cz) / RASTER_CELL_LDU - 0.5);
    const iz1 = Math.floor(Math.max(az, bz, cz) / RASTER_CELL_LDU - 0.5);
    for (let ix = ix0; ix <= ix1; ix++) {
      const x = (ix + 0.5) * RASTER_CELL_LDU;
      for (let iz = iz0; iz <= iz1; iz++) {
        const z = (iz + 0.5) * RASTER_CELL_LDU;
        if (
          edge(ax, az, bx, bz, x, z) > AREA_EPSILON &&
          edge(bx, bz, cx, cz, x, z) > AREA_EPSILON &&
          edge(cx, cz, ax, az, x, z) > AREA_EPSILON
        ) {
          cells.add(rasterKey(ix, iz));
        }
      }
    }
  }
}

function laidFootprints(layout: TrackDrawing, parts: ReadonlyArray<PartAsset>): Set<number>[] {
  const cells = Array.from({ length: layout.pieceCount }, () => new Set<number>());
  const byChunk = new Map<number, number[]>();
  for (let p = 0; p < layout.pieceCount; p++) {
    const footprint = layout.footprintAt(p);
    const slots = byChunk.get(footprint.key.chunkKey) ?? [];
    slots.push(footprint.key.slot);
    byChunk.set(footprint.key.chunkKey, slots);
  }
  for (const [key, slots] of byChunk) {
    const chunk = layout.chunkInstances(key);
    if (!chunk) throw new Error(`chunk ${key} has footprints but no instances`);
    slots.sort((a, b) => a - b);
    slots.forEach((slot, i) => {
      const positions = parts[chunk.partIndex[i] ?? 0]?.mesh.positions ?? new Float32Array();
      const m = chunk.matrices.subarray(i * INSTANCE_MATRIX_FLOATS);
      rasterTriangles(positions, m, chunk.originX, chunk.originZ, cells[slot] ?? new Set());
    });
  }
  return cells;
}

function pieceEnds(layout: TrackDrawing): ReadonlyArray<ReadonlyArray<TrackEndView>> {
  const routes = layout.routes();
  const refs = Array.from({ length: layout.pieceCount }, (_, p) => layout.footprintAt(p).ref);
  let next = 0;
  return refs.map((ref) => {
    const part = layout.pieceParts().find((p) => p.piece.id === ref);
    const count = part?.piece.routes.length ?? 0;
    const own = routes.slice(next, next + count).flatMap((r) => [r.from, r.to]);
    next += count;
    return own;
  });
}

function joined(ends: ReadonlyArray<ReadonlyArray<TrackEndView>>, a: number, b: number): boolean {
  return (ends[a] ?? []).some((p) =>
    (ends[b] ?? []).some(
      (q) =>
        Math.abs(p.xLdu - q.xLdu) < COINCIDENT_LDU && Math.abs(p.zLdu - q.zLdu) < COINCIDENT_LDU,
    ),
  );
}

function crossings(
  layout: TrackDrawing,
  parts: ReadonlyArray<PartAsset>,
  rects: ReadonlyArray<Rect> = [],
): ReadonlyArray<string> {
  const cells = laidFootprints(layout, parts);
  const ends = pieceEnds(layout);
  const found: string[] = [];
  for (let a = 0; a < cells.length; a++) {
    for (let b = a + 1; b < cells.length; b++) {
      if (joined(ends, a, b)) continue;
      const other = cells[b] ?? new Set<number>();
      for (const key of cells[a] ?? []) {
        if (other.has(key)) {
          found.push(`piece ${a} crosses piece ${b}`);
          break;
        }
      }
    }
    rects.forEach(([minX, minZ, maxX, maxZ], r) => {
      for (const key of cells[a] ?? []) {
        const x = (Math.floor(key / RASTER_KEY_STRIDE) - RASTER_KEY_OFFSET + 0.5) * RASTER_CELL_LDU;
        const z = ((key % RASTER_KEY_STRIDE) - RASTER_KEY_OFFSET + 0.5) * RASTER_CELL_LDU;
        if (x > minX && x < maxX && z > minZ && z < maxZ) {
          found.push(`piece ${a} runs over plate ${r}`);
          break;
        }
      }
    });
  }
  return found;
}

function plateRect(parts: ReadonlyArray<PartAsset>, id: string, xStuds: number, zStuds: number) {
  const plate = parts.find((part) => part.id === id);
  if (!plate) throw new Error(`${id} is not in the bundle`);
  const x = xStuds * STUD_LDU;
  const z = zStuds * STUD_LDU;
  return [
    x + plate.boundsMin[0],
    z + plate.boundsMin[2],
    x + plate.boundsMax[0],
    z + plate.boundsMax[2],
  ] as const;
}

function plateObstacles(...rects: ReadonlyArray<Rect>): TrackObstacles {
  return {
    rects: Float64Array.from(rects.flat()),
    owners: new Int32Array(rects.length),
    unseated: new Uint8Array(rects.length),
    outlines: [],
    outlineOwners: new Int32Array(0),
    labels: ["Road plate"],
    seats: new Set(),
  };
}

function endAt(layout: TrackDrawing, xStuds: number, zStuds: number): TrackEndView {
  const end = layout
    .openEnds()
    .find(
      (e) => Math.abs(e.xLdu - xStuds * STUD_LDU) < 1 && Math.abs(e.zLdu - zStuds * STUD_LDU) < 1,
    );
  if (!end) throw new Error(`no open end at ${xStuds}, ${zStuds} studs`);
  return end;
}

function closeFrom(layout: TrackDrawing, from: TrackEndView, to: TrackEndView) {
  layout.beginDrag(from.xLdu, from.zLdu, from.xLdu, from.zLdu);
  layout.moveDrag(to.xLdu, to.zLdu);
  const view = layout.dragView();
  const target = layout.dragTarget();
  const ghost = layout.ghost();
  const commit = commitDrag(layout);
  return { view, target, ghost, commit };
}

function latticeEndPose(end: TrackEndView): Pose16 {
  return studPose(Math.round(end.xLdu / STUD_LDU), Math.round(end.zLdu / STUD_LDU), end.heading);
}

function unobstructedFewest(layout: TrackDrawing, from: TrackEndView, to: TrackEndView): number {
  const result = solveClosure(layout.kit, latticeEndPose(from), latticeEndPose(to));
  if (result.kind !== "exact") throw new Error(`no unobstructed closure: ${result.kind}`);
  return result.run.pieces;
}

const BALLOON: Run = [
  { kind: "straight", count: 5 },
  { kind: "turn", sign: 1, curves: 4 },
  { kind: "straight", count: 4 },
  { kind: "turn", sign: 1, curves: 8 },
  { kind: "turn", sign: -1, curves: 4 },
];

it(
  "closes a loop whose ends sit too close for a half circle without looping back over itself or the user's track",
  async () => {
    const bundle = await trackAndRoadBundle();
    const layout = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
    const sides: Run = [{ kind: "straight", count: 6 }];
    let end = layRun(layout, studPose(0, 0, 0), sides);
    end = layRun(layout, end, BALLOON);
    layRun(layout, end, sides);
    expect(crossings(layout, bundle.parts)).toEqual([]);
    const top = endAt(layout, 0, 64);
    const bottom = endAt(layout, 0, 0);
    const before = layout.pieceCount;

    const { view, target, commit } = closeFrom(layout, top, bottom);

    expect(view?.closure).toBe("exact");
    expect(target?.joins).toBe(true);
    expect(commit.joined).toBe(true);
    expect(layout.openEnds()).toHaveLength(0);
    expect(layout.joinedPairs()).toBe(layout.pieceCount);
    expect(crossings(layout, bundle.parts)).toEqual([]);
    expect(layout.pieceCount - before).toBe(unobstructedFewest(layout, top, bottom));
  },
  CLOSURE_SEARCH_TIMEOUT_MS,
);

it("routes a closure around a road plate in its way with no extra loop", async () => {
  const bundle = await trackAndRoadBundle();
  const layout = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  layRun(layout, studPose(0, 0, 0), [
    { kind: "straight", count: 4 },
    { kind: "turn", sign: 1, curves: 8 },
    { kind: "straight", count: 4 },
  ]);
  const plate = plateRect(bundle.parts, "ldraw:69958", -40, 40);
  layout.setBands(everyBand(plateObstacles(plate)));
  const top = endAt(layout, 0, 80);
  const bottom = endAt(layout, 0, 0);
  const fewest = unobstructedFewest(layout, top, bottom);
  const before = layout.pieceCount;

  const { view, commit } = closeFrom(layout, top, bottom);

  expect(view?.closure).toBe("exact");
  expect(commit.joined).toBe(true);
  expect(layout.openEnds()).toHaveLength(0);
  expect(crossings(layout, bundle.parts, [plate])).toEqual([]);
  expect(layout.pieceCount - before).toBeGreaterThan(fewest);
  expect(layout.pieceCount - before).toBeLessThan(fewest + FULL_TURN_CURVES);
});

it("suggests nothing and lays nothing when a road plate leaves no room to reach the open end", async () => {
  const bundle = await trackAndRoadBundle();
  const layout = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  const straights: Run = [{ kind: "straight", count: 3 }];
  layRun(layout, studPose(0, 0, 0), straights);
  layRun(layout, studPose(128, 0, 0), straights);
  layout.setBands(everyBand(plateObstacles(plateRect(bundle.parts, "ldraw:44336p04", 112, 0))));
  const before = layout.pieceCount;

  const { view, target, ghost, commit } = closeFrom(
    layout,
    endAt(layout, 48, 0),
    endAt(layout, 128, 0),
  );

  expect(view?.closure).toBe("blocked");
  expect(target?.joins).toBe(false);
  expect(ghost).toBeNull();
  expect(commit).toMatchObject({ laid: 0, refusal: "blocked" });
  expect(layout.pieceCount).toBe(before);
});

function focusEnd(layout: TrackDrawing, end: TrackEndView): void {
  layout.extension.focusOn(layout.endNear(end.xLdu, end.zLdu, null));
}

function focusAt(layout: TrackDrawing, pose: Pose16): void {
  const { x, z } = zeta16ToStuds(pose.position);
  layout.extension.focusOn(layout.endNear(x * STUD_LDU, z * STUD_LDU, null));
}

function extend(layout: TrackDrawing, turn: ExtensionTurn | null): boolean {
  if (turn !== null && !layout.extension.choose(turn)) throw new Error(`no ${turn} to lay`);
  const plan = layout.extensionPlan();
  if (!plan) throw new Error("no open end to extend");
  layout.applyTrack(plan.change);
  layout.extension.laid(plan.run, plan.end);
  layout.extension.focusOn(null);
  return plan.goal !== null && layout.joinsAt(plan.goal);
}

it("extends an open end one previewed piece at a time and closes the loop through the join it suggests", async () => {
  const bundle = await trackAndRoadBundle();
  const layout = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  const sides = 4;
  layRun(layout, studPose(0, 0, 0), [{ kind: "straight", count: sides }]);
  focusEnd(layout, endAt(layout, sides * 16, 0));
  const turns: ReadonlyArray<ExtensionTurn> = [
    ...Array<ExtensionTurn>(HALF_TURN_CURVES).fill("left"),
    ...Array<ExtensionTurn>(sides).fill("straight"),
    ...Array<ExtensionTurn>(HALF_TURN_CURVES / 2).fill("left"),
  ];

  const afterEach = turns.map((turn) => {
    extend(layout, turn);
    return [layout.pieceCount, layout.joinedPairs(), layout.openEnds().length];
  });
  const suggested = layout.extension.view();
  const laid = layout.openEnds().filter((end) => end.xLdu !== 0 || end.zLdu !== 0);

  expect(afterEach).toEqual(turns.map((_, i) => [sides + i + 1, sides + i, 2]));
  expect(laid.map((end) => Math.sign(end.zLdu))).toEqual([-1]);
  expect(suggested?.continuing).toBe(true);
  expect(suggested?.choices[suggested.index]).toEqual({
    kind: "join",
    straights: 0,
    curves: HALF_TURN_CURVES / 2,
    joinsEnd: true,
    blocked: null,
  });
  expect(extend(layout, null)).toBe(true);
  expect(layout.openEnds()).toHaveLength(0);
  expect(layout.joinedPairs()).toBe(layout.pieceCount);
  expect(layout.extension.view()).toBeNull();
});

function singlesAt(layout: TrackDrawing, xStuds: number, zStuds: number) {
  focusEnd(layout, endAt(layout, xStuds, zStuds));
  const view = layout.extension.view();
  if (!view) throw new Error("the open end offers nothing");
  return view.choices
    .filter((choice) => choice.kind !== "join")
    .map((choice) => [choice.kind, choice.blocked?.kind ?? null]);
}

it("offers each single piece that would run into an obstacle as blocked, and none of them as a lay", async () => {
  const bundle = await trackAndRoadBundle();
  const clear = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  const walled = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  for (const layout of [clear, walled]) {
    layRun(layout, studPose(56, 0, 0), [{ kind: "straight", count: 2 }]);
  }
  walled.setBands(everyBand(plateObstacles(plateRect(bundle.parts, ROAD_BASEPLATE_32, 112, 0))));
  expect(singlesAt(clear, 88, 0)).toEqual([
    ["straight", null],
    ["left", null],
    ["right", null],
  ]);
  expect(singlesAt(walled, 88, 0)).toEqual([
    ["straight", "model"],
    ["left", "model"],
    ["right", "model"],
  ]);
  expect(walled.extensionPlan()?.run.choice.blocked).toMatchObject({ kind: "model" });
});

it.each<
  [
    string,
    ReadonlyArray<readonly [number, number]>,
    (parts: ReadonlyArray<PartAsset>) => Rect | null,
    TrackRefusal,
    number,
  ]
>([
  [
    "one stud off a facing end",
    [
      [0, 0],
      [51, 2],
    ],
    () => null,
    "impossible",
    Math.hypot(3, 2),
  ],
  [
    "a road plate in the way",
    [
      [0, 0],
      [128, 0],
    ],
    (parts) => plateRect(parts, ROAD_BASEPLATE_32, 112, 0),
    "blocked",
    80,
  ],
])(
  "names why the open end ahead can't be joined when it is %s, and suggests a single piece instead",
  async (_, starts, obstacle, refusal, studs) => {
    const bundle = await trackAndRoadBundle();
    const layout = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
    for (const [x, z] of starts)
      layRun(layout, studPose(x, z, 0), [{ kind: "straight", count: 3 }]);
    const rect = obstacle(bundle.parts);
    if (rect) layout.setBands(everyBand(plateObstacles(rect)));
    focusEnd(layout, endAt(layout, 48, 0));

    const view = layout.extension.view();

    expect(view?.unjoined?.refusal).toBe(refusal);
    expect(view?.unjoined?.studs).toBeCloseTo(studs, 6);
    expect(view?.choices[view.index]?.kind).toBe("straight");
    expect(view?.choices.some((choice) => choice.kind === "join" && choice.curves === 0)).toBe(
      false,
    );
  },
);

const RIGHT_SWITCH = "ldraw:75541-f1";
const NINE_VOLT_CURVE = "ldraw:74747";
const NINE_VOLT_STRAIGHT = "ldraw:74746";
const PLASTIC_STRAIGHT = "ldraw:53401";
const SWITCH_ENTRY = 0;
const CURVE_REVERSED = 1;
const LADDER_RUNGS = 3;
const ROAD_PLATE_16 = "ldraw:69958";
const ROAD_BASEPLATE_32 = "ldraw:44336p04";
const CLEARANCE_MARGIN_LDU = 4;
const SWEEP_STEPS = 16;
const HALF_TURN_CURVES = 8;

function placeableIndex(layout: TrackDrawing, id: string): number {
  const part = layout.pieceParts().find((p) => p.piece.id === id);
  if (!part) throw new Error(`${id} is not placeable`);
  return part.catalogIndex;
}

function snapOnto(layout: TrackDrawing, id: string, connector: number, end: TrackEndView): void {
  const piece = placeableIndex(layout, id);
  const snap = layout.snapPiece(piece, connector, end.xLdu, end.zLdu, studPose(0, 0, 0));
  if (snap.end === null) throw new Error(`${id} did not snap onto the open end`);
  layPiece(layout, piece, snap.placement);
}

function sameEnd(a: TrackEndView, b: TrackEndView): boolean {
  return Math.abs(a.xLdu - b.xLdu) < COINCIDENT_LDU && Math.abs(a.zLdu - b.zLdu) < COINCIDENT_LDU;
}

function newEndsAfter(layout: TrackDrawing, before: ReadonlyArray<TrackEndView>) {
  return layout.openEnds().filter((e) => !before.some((b) => sameEnd(b, e)));
}

function addRung(layout: TrackDrawing, entry: TrackEndView) {
  const before = layout.openEnds().filter((e) => !sameEnd(e, entry));
  snapOnto(layout, RIGHT_SWITCH, SWITCH_ENTRY, entry);
  const switchEnds = newEndsAfter(layout, before);
  const straight = switchEnds.find((e) => Math.abs(e.zLdu - entry.zLdu) < COINCIDENT_LDU);
  const diverging = switchEnds.find((e) => straight === undefined || !sameEnd(e, straight));
  if (!straight || !diverging) throw new Error("the switch has no straight and diverging end");
  const withStraight = [...before, straight];
  snapOnto(layout, NINE_VOLT_CURVE, CURVE_REVERSED, diverging);
  const [parallel] = newEndsAfter(layout, withStraight);
  if (!parallel || parallel.heading !== entry.heading) {
    throw new Error("a reversed curve after the switch's diverging route runs parallel");
  }
  return { straight, parallel };
}

function buildLadder(layout: TrackDrawing, rungs: number): ReadonlyArray<TrackEndView> {
  layPiece(layout, placeableIndex(layout, RIGHT_SWITCH), studPose(0, 0, 0));
  const west = endAt(layout, 0, 0);
  const first = layout.openEnds().filter((e) => !sameEnd(e, west));
  const straight = first.find((e) => Math.abs(e.zLdu) < COINCIDENT_LDU);
  const diverging = first.find((e) => straight === undefined || !sameEnd(e, straight));
  if (!straight || !diverging) throw new Error("the switch has no straight and diverging end");
  snapOnto(layout, NINE_VOLT_CURVE, CURVE_REVERSED, diverging);
  const [firstParallel] = newEndsAfter(layout, [west, straight]);
  if (!firstParallel) throw new Error("the reversed curve left no open end");
  const tracks: TrackEndView[] = [straight];
  let current = firstParallel;
  for (let rung = 1; rung < rungs; rung++) {
    const next = addRung(layout, current);
    tracks.push(next.straight);
    current = next.parallel;
  }
  tracks.push(current);
  return tracks;
}

function straightHalfWidthLdu(bundle: { trackShapes: ReadonlyArray<TrackShape> }): number {
  const shape = bundle.trackShapes.find((s) => s.piece === NINE_VOLT_STRAIGHT);
  if (!shape) throw new Error("the bundle has no straight track shape");
  return Math.max(-(shape.footprints[1] ?? 0), shape.footprints[3] ?? 0);
}

function closesWithFewest(layout: TrackDrawing, from: TrackEndView, to: TrackEndView): void {
  const fewest = unobstructedFewest(layout, from, to);
  const before = layout.pieceCount;
  const { view, commit } = closeFrom(layout, from, to);
  expect(view?.closure).toBe("exact");
  expect(commit.joined).toBe(true);
  expect(layout.pieceCount - before).toBe(fewest);
}

function studsOf(ldu: number): number {
  return Math.round(ldu / STUD_LDU);
}

it(
  "closes every track of a 9V switch ladder alongside the switches and curves of its neighbours",
  async () => {
    const bundle = await trackAndRoadBundle();
    const layout = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
    const tracks = buildLadder(layout, LADDER_RUNGS);
    const straightStuds = Number(layout.kit.straightStuds);
    const farX = Math.max(...tracks.map((t) => studsOf(t.xLdu))) + 4 * straightStuds;
    for (const track of tracks) {
      layRun(layout, studPose(farX, studsOf(track.zLdu), 0), [{ kind: "straight", count: 3 }]);
    }
    expect(crossings(layout, bundle.parts)).toEqual([]);

    for (const track of tracks) {
      closesWithFewest(layout, track, endAt(layout, farX, studsOf(track.zLdu)));
    }
    expect(crossings(layout, bundle.parts)).toEqual([]);
  },
  CLOSURE_SEARCH_TIMEOUT_MS,
);

it("closes gaps in parallel straights laid at the switch's parallel spacing", async () => {
  const bundle = await trackAndRoadBundle();
  const probe = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  const [main, siding] = buildLadder(probe, 1);
  if (!main || !siding) throw new Error("one rung gives two tracks");
  const spacing = studsOf(siding.zLdu - main.zLdu);
  const layout = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  const straightStuds = Number(layout.kit.straightStuds);
  const gapStart = 3 * straightStuds;
  const gapEnd = 7 * straightStuds;
  layRun(layout, studPose(0, 0, 0), [{ kind: "straight", count: 10 }]);
  for (const z of [spacing, -spacing]) {
    layRun(layout, studPose(0, z, 0), [{ kind: "straight", count: 3 }]);
    layRun(layout, studPose(gapEnd, z, 0), [{ kind: "straight", count: 3 }]);
  }
  for (const z of [spacing, -spacing]) {
    closesWithFewest(layout, endAt(layout, gapStart, z), endAt(layout, gapEnd, z));
  }
  expect(crossings(layout, bundle.parts)).toEqual([]);
});

it("closes straights flush along a road plate's edge", async () => {
  const bundle = await trackAndRoadBundle();
  const layout = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  const straightStuds = Number(layout.kit.straightStuds);
  const plate = bundle.parts.find((part) => part.id === ROAD_BASEPLATE_32);
  if (!plate) throw new Error(`${ROAD_BASEPLATE_32} is not in the bundle`);
  const flushStuds = Math.ceil(straightHalfWidthLdu(bundle) / STUD_LDU);
  const centreOffset = flushStuds + plate.boundsMax[2] / STUD_LDU;
  const gapEnd = 6 * straightStuds;
  layRun(layout, studPose(0, 0, 0), [{ kind: "straight", count: 1 }]);
  layRun(layout, studPose(gapEnd, 0, 0), [{ kind: "straight", count: 1 }]);
  const plates = [
    plateRect(bundle.parts, ROAD_BASEPLATE_32, gapEnd / 2, centreOffset),
    plateRect(bundle.parts, ROAD_BASEPLATE_32, gapEnd / 2, -centreOffset),
  ];
  layout.setBands(everyBand(plateObstacles(...plates)));

  closesWithFewest(layout, endAt(layout, straightStuds, 0), endAt(layout, gapEnd, 0));
  expect(crossings(layout, bundle.parts, plates)).toEqual([]);
});

function plateClear(cells: ReadonlyArray<Set<number>>, rect: Rect): boolean {
  const [minX, minZ, maxX, maxZ] = rect;
  for (const piece of cells) {
    for (const key of piece) {
      const x = (Math.floor(key / RASTER_KEY_STRIDE) - RASTER_KEY_OFFSET + 0.5) * RASTER_CELL_LDU;
      const z = ((key % RASTER_KEY_STRIDE) - RASTER_KEY_OFFSET + 0.5) * RASTER_CELL_LDU;
      if (
        x > minX - CLEARANCE_MARGIN_LDU &&
        x < maxX + CLEARANCE_MARGIN_LDU &&
        z > minZ - CLEARANCE_MARGIN_LDU &&
        z < maxZ + CLEARANCE_MARGIN_LDU
      ) {
        return false;
      }
    }
  }
  return true;
}

it(
  "closes a half circle past a road plate set as tight to its outside as the stud grid allows, all the way round",
  async () => {
    const bundle = await trackAndRoadBundle();
    const straightStuds = Number(
      new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle)).kit.straightStuds,
    );
    const sides: Run = [{ kind: "straight", count: 4 }];
    const halfCircle: Run = [{ kind: "turn", sign: 1, curves: HALF_TURN_CURVES }];
    const base = (): TrackDrawing => {
      const layout = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
      layRun(layout, layRun(layout, layRun(layout, studPose(0, 0, 0), sides), halfCircle), sides);
      return layout;
    };
    const shape = base();
    const top = shape.openEnds().reduce((a, b) => (a.zLdu > b.zLdu ? a : b));
    const bottom = shape.openEnds().reduce((a, b) => (a.zLdu < b.zLdu ? a : b));
    const diameter = studsOf(top.zLdu - bottom.zLdu);
    layRun(shape, latticeEndPose(top), halfCircle);
    const cells = laidFootprints(shape, bundle.parts);
    const centreZ = diameter / 2;
    const reach = diameter + straightStuds;
    for (let step = 1; step < SWEEP_STEPS; step++) {
      const angle = Math.PI / 2 + (step * Math.PI) / SWEEP_STEPS;
      let rect: Rect | null = null;
      for (let t = diameter / 2; t <= reach && !rect; t++) {
        const candidate = plateRect(
          bundle.parts,
          ROAD_PLATE_16,
          Math.round(t * Math.cos(angle)),
          Math.round(centreZ + t * Math.sin(angle)),
        );
        if (plateClear(cells, candidate)) rect = candidate;
      }
      if (!rect) throw new Error(`no clear plate position at step ${step}`);
      const layout = base();
      layout.setBands(everyBand(plateObstacles(rect)));
      closesWithFewest(layout, endAt(layout, 0, diameter), endAt(layout, 0, 0));
      expect(crossings(layout, bundle.parts, [rect]), `plate at sweep step ${step}`).toEqual([]);
    }
  },
  SWEEP_TIMEOUT_MS,
);

const GROUND_BASEPLATE = "ldraw:3811";
const DUAL_ROAD_BASEPLATE = "ldraw:30225b";
const ROAD_CONTAINER_MODEL = "road-baseplates";
const BASEPLATE_ROW_MODEL = "baseplate-row";
const NORTH = 12;
const SOUTH = 4;

interface GroundItem {
  readonly placeable: Placeable;
  readonly x: number;
  readonly z: number;
  readonly yPlates?: number;
}

function placeGround(items: ReadonlyArray<GroundItem>): ReadonlyArray<PlacedModel> {
  const history = new EditHistory(new World());
  const placed = new PlacedChunks(new PlanOnlyBackend());
  const refs = items.map((item) => item.placeable);
  const refOf = (refId: number): Placeable => {
    const placeable = refs[refId];
    if (!placeable) throw new Error(`ground ref ${refId} is out of range`);
    return placeable;
  };
  items.forEach((item, refId) => {
    const edit = history.place({
      refId,
      colorId: item.placeable.worldColor,
      x: item.x,
      z: item.z,
      yPlates: item.yPlates ?? 0,
      rot: 0,
    });
    placed.apply(edit, refOf);
  });
  return placed.models();
}

async function loosePart(id: string): Promise<Placeable> {
  const bundle = await container.get(PART_BUNDLE_LOADER).load("standard", (part) => part.id === id);
  const index = bundle.parts.findIndex((part) => part.id === id);
  const part = bundle.parts[index];
  const color = part?.producedColor;
  if (!part || color === undefined) throw new Error(`${id} has no produced colour in the bundle`);
  return partPlaceable(
    part,
    index,
    color,
    String(color),
    bundle.parts,
    new ColorTable(bundle),
    bundle.tablePlane.depthBelowTopLdu,
  );
}

function bandsOver(
  ground: ReadonlyArray<PlacedModel>,
  layout: TrackDrawing,
  pendingSeats: (range: readonly [number, number]) => boolean = (range) =>
    seatsPending(ground, range),
): SupportBandAt {
  return (lowPlates, highPlates) => {
    const [bottom, top] = layout.verticalRange();
    const band = [bottom + lowPlates * PLATE_LDU, top + highPlates * PLATE_LDU] as const;
    return { obstacles: trackObstacles(ground, band, NO_TRACK_PARTS), pending: pendingSeats(band) };
  };
}

function everyBand(obstacles: TrackObstacles): SupportBandAt {
  return () => ({ obstacles, pending: false });
}

async function trackOver(
  ground: ReadonlyArray<PlacedModel>,
  pendingSeats?: (range: readonly [number, number]) => boolean,
): Promise<TrackDrawing> {
  const bundle = await trackAndRoadBundle();
  const layout = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  layout.setBands(bandsOver(ground, layout, pendingSeats));
  return layout;
}

function closureVerdict(
  layout: TrackDrawing,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
): ClosureState {
  const straights: Run = [{ kind: "straight", count: 2 }];
  layRun(layout, studPose(...from), straights);
  layRun(layout, studPose(...to), straights);
  const { view } = closeFrom(layout, endAt(layout, from[0], from[1]), endAt(layout, to[0], to[1]));
  return view?.closure ?? null;
}

it("seats a closure on the studs of a road plate's sidewalk and the baseplate beside it, and keeps it off the roadway", async () => {
  const baseplate = await loosePart(GROUND_BASEPLATE);
  const road = await loosePart(ROAD_BASEPLATE_32);
  const side = baseplate.box.max[0] - baseplate.box.min[0];
  const ground = placeGround([
    { placeable: baseplate, x: 0, z: 0 },
    { placeable: road, x: side, z: 0 },
  ]);
  const seam = side / 2 / STUD_LDU;
  const roadCentre = side / STUD_LDU;
  const reach = side / STUD_LDU;

  const straddling = await trackOver(ground);
  const seamFrom = [seam, -reach, NORTH] as const;
  const seamTo = [seam, reach, SOUTH] as const;
  expect(closureVerdict(straddling, seamFrom, seamTo)).toBe("exact");
  expect(crossings(straddling, (await trackAndRoadBundle()).parts)).toEqual([]);

  const roadway = await trackOver(ground);
  expect(closureVerdict(roadway, [roadCentre, -reach, NORTH], [roadCentre, reach, SOUTH])).toBe(
    "blocked",
  );
});

async function acrossTheRow(
  item: Placeable,
  pendingSeats?: (range: readonly [number, number]) => boolean,
) {
  const ground = placeGround([{ placeable: item, x: 0, z: 0 }]);
  const [placed] = ground;
  if (!placed) throw new Error("nothing was placed");
  const layout = await trackOver(ground, pendingSeats);
  const plateSide = placed.box.maxX - placed.box.minX;
  const x = studsOf((placed.box.minX + placed.box.maxX) / 2);
  const fullPlateZ = studsOf(placed.box.maxZ - plateSide / 2);
  const reach = studsOf(plateSide);
  const straights: Run = [{ kind: "straight", count: 2 }];
  layRun(layout, studPose(x - reach, fullPlateZ, HALF_TURN_CURVES), straights);
  layRun(layout, studPose(x + reach, fullPlateZ, 0), straights);
  const { view, commit } = closeFrom(
    layout,
    endAt(layout, x - reach, fullPlateZ),
    endAt(layout, x + reach, fullPlateZ),
  );
  return {
    closure: view?.closure ?? null,
    refusal: commit.refusal,
    withheld: commit.withheld,
    joined: commit.joined,
    laidSome: commit.laid > 0,
  };
}

it("never seats a join on a model's pending studs: it lays the stroke and withholds only the join, pending studs are no seats at all, and the same join seats once the checked studs land", async () => {
  const { pending, checked } = await fixtureModelChecks(BASEPLATE_ROW_MODEL);
  expect(await acrossTheRow(checked)).toMatchObject({
    closure: "exact",
    joined: true,
    laidSome: true,
  });
  expect(await acrossTheRow(pending)).toEqual({
    closure: "pending",
    refusal: null,
    withheld: "pending",
    joined: false,
    laidSome: true,
  });
  expect(await acrossTheRow(pending, () => false)).toEqual({
    closure: "blocked",
    refusal: null,
    withheld: "unsupported",
    joined: false,
    laidSome: true,
  });
});

it("judges a road plate inside a model by the same geometry as one placed alone", async () => {
  const alone = await loosePart(DUAL_ROAD_BASEPLATE);
  const roadContainer = await fixtureModel(ROAD_CONTAINER_MODEL);
  const plateSide = alone.box.max[0] - alone.box.min[0];
  const verdicts = async (item: Placeable) => {
    const ground = placeGround([{ placeable: item, x: 0, z: 0 }]);
    const [placed] = ground;
    if (!placed) throw new Error("nothing was placed");
    const centreX = studsOf((placed.box.minX + placed.box.maxX) / 2);
    const centreZ = studsOf(placed.box.minZ + plateSide / 2);
    const halfSide = studsOf(plateSide / 2);
    const across = closureVerdict(
      await trackOver(ground),
      [centreX - 2 * halfSide, centreZ, HALF_TURN_CURVES],
      [centreX + 2 * halfSide, centreZ, 0],
    );
    const besideX = studsOf(placed.box.minX) - halfSide / 4;
    const beside = closureVerdict(
      await trackOver(ground),
      [besideX, centreZ - 2 * halfSide, NORTH],
      [besideX, centreZ + 2 * halfSide, SOUTH],
    );
    return { across, beside };
  };

  const loose = await verdicts(alone);
  expect(loose).toEqual({ across: "blocked", beside: "exact" });
  expect(await verdicts(roadContainer)).toEqual(loose);
});

const RANDOM_STROKES = 40;
const STROKE_SEED = 20261120;
const QUARTER_TURN_DEGREES = 90;

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function curveRadiusStuds(layout: TrackDrawing): number {
  const chord = zeta16ToStuds(layout.kit.left.delta);
  return Math.hypot(chord.x, chord.z) / (2 * Math.sin(Math.PI / FULL_TURN_CURVES));
}

function randomStroke(random: () => number, minRadius: number): StudPoint[] {
  let heading = Math.floor(random() * 4) * QUARTER_TURN_DEGREES;
  let at: StudPoint = [0, 0];
  const parts: StudPoint[][] = [[at]];
  const segments = 2 + Math.floor(random() * 3);
  for (let s = 0; s < segments; s++) {
    const radians = (heading * Math.PI) / 180;
    if (random() < 0.4) {
      const length = 16 + random() * 64;
      const to: StudPoint = [
        at[0] + length * Math.cos(radians),
        at[1] + length * Math.sin(radians),
      ];
      parts.push(linePoints(at, to));
      at = to;
      continue;
    }
    const radius = minRadius * (1 + 2 * random());
    const side = random() < 0.5 ? 1 : -1;
    const sweep = side * (30 + random() * 90);
    const centre: StudPoint = [
      at[0] - side * radius * Math.sin(radians),
      at[1] + side * radius * Math.cos(radians),
    ];
    const from = heading - side * QUARTER_TURN_DEGREES;
    const arc = arcPoints(centre, radius, from, from + sweep);
    parts.push(arc);
    at = arc.at(-1) ?? at;
    heading += sweep;
  }
  return chained(...parts);
}

function strokeLengthStuds(points: ReadonlyArray<StudPoint>): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1] ?? [0, 0];
    const [bx, bz] = points[i] ?? [0, 0];
    length += Math.hypot(bx - ax, bz - az);
  }
  return length;
}

function centrelineStuds(routes: ReadonlyArray<TrackRouteView>): number {
  return routes.reduce((sum, { from, to }) => {
    const chord = Math.hypot(to.xLdu - from.xLdu, to.zLdu - from.zLdu) / STUD_LDU;
    const turn = Math.abs(
      Math.atan2(
        Math.sin(to.headingRadians - from.headingRadians - Math.PI),
        Math.cos(to.headingRadians - from.headingRadians - Math.PI),
      ),
    );
    return sum + (turn === 0 ? chord : (chord * turn) / (2 * Math.sin(turn / 2)));
  }, 0);
}

it(
  "lays any drawable stroke along itself: no piece strays half a straight from it, and it lays no more than the stroke's length and one piece",
  async () => {
    const bundle = await trackAndRoadBundle();
    const probe = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
    const halfStraight = Number(probe.kit.straightStuds) / 2;
    const longestPiece = Math.max(...kitPieceLengthsStuds(bundle));
    const random = seeded(STROKE_SEED);
    const faults: string[] = [];
    for (let trial = 0; trial < RANDOM_STROKES; trial++) {
      const points = byHand(randomStroke(random, curveRadiusStuds(probe)), random() * 2 * Math.PI);
      const layout = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
      const stroke = drawStroke(layout, points);
      const length = strokeLengthStuds(points);
      const laidLength = centrelineStuds(stroke.laid);
      if (stroke.commit.laid === 0) faults.push(`stroke ${trial} laid nothing`);
      if (laidLength > length + longestPiece) {
        faults.push(`stroke ${trial} laid ${laidLength.toFixed(1)} of ${length.toFixed(1)} studs`);
      }
      const worst = furthestFromStroke(stroke);
      if (worst > halfStraight) faults.push(`stroke ${trial} strays ${worst.toFixed(1)} studs`);
      const end = runEnd(stroke.laid);
      const [lastX, lastZ] = points.at(-1) ?? [0, 0];
      const reached = end
        ? Math.hypot(end.xLdu / STUD_LDU - lastX, end.zLdu / STUD_LDU - lastZ)
        : Number.POSITIVE_INFINITY;
      if (stroke.commit.blocked === null && reached > longestPiece) {
        faults.push(`stroke ${trial} ends ${reached.toFixed(1)} studs from its last point`);
      }
    }
    expect(faults).toEqual([]);
  },
  SWEEP_TIMEOUT_MS,
);

type TrackBundle = Awaited<ReturnType<typeof trackAndRoadBundle>>;

function kitPieceLengthsStuds(bundle: TrackBundle): ReadonlyArray<number> {
  const probe = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  return probe.kitParts().map((part) => {
    const alone = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
    layPiece(alone, part.catalogIndex, studPose(0, 0, 0));
    return centrelineStuds(alone.routes());
  });
}

const CUSTOM_BRICK = "brick-2x4";
const WALL_X_STUDS = 100;
const WALL_HALF_STUDS = 48;
const BRICK_STEP_STUDS = 4;
const REFUSED_GHOST_COLOR = 4;

interface CrossingCase {
  readonly name: string;
  readonly ground: () => Promise<ReadonlyArray<PlacedModel>>;
  readonly track: (layout: TrackDrawing) => void;
  readonly stroke: (layout: TrackDrawing) => ReadonlyArray<StudPoint>;
  readonly blocked: TrackBlockView;
}

async function brickWall(): Promise<ReadonlyArray<PlacedModel>> {
  const brick = await fixtureModel(CUSTOM_BRICK);
  const items: GroundItem[] = [];
  for (let z = -WALL_HALF_STUDS; z <= WALL_HALF_STUDS; z += BRICK_STEP_STUDS) {
    items.push({ placeable: brick, x: WALL_X_STUDS * STUD_LDU, z: z * STUD_LDU });
  }
  return placeGround(items);
}

function groundRects(models: ReadonlyArray<PlacedModel>): ReadonlyArray<Rect> {
  return models.map((model) => [model.box.minX, model.box.minZ, model.box.maxX, model.box.maxZ]);
}

const CROSSING_CASES: ReadonlyArray<CrossingCase> = [
  {
    name: "track laid across the stroke",
    ground: async () => [],
    track: (layout) =>
      layRun(layout, studPose(WALL_X_STUDS, -WALL_HALF_STUDS, SOUTH), [
        { kind: "straight", count: 6 },
      ]),
    stroke: () => linePoints([0, 0], [2 * WALL_X_STUDS, 0]),
    blocked: { kind: "track" },
  },
  {
    name: "a custom building of 2x4 bricks",
    ground: brickWall,
    track: () => {},
    stroke: () => byHand(linePoints([0, 0], [2 * WALL_X_STUDS, 0]), 0.7),
    blocked: { kind: "model", label: CUSTOM_BRICK, unseated: false },
  },
  {
    name: "the stroke's own run, drawn round past its start",
    ground: async () => [],
    track: () => {},
    stroke: (layout) => {
      const radius = 1.5 * curveRadiusStuds(layout);
      return arcPoints([0, radius], radius, -90, 360);
    },
    blocked: { kind: "run" },
  },
];

it("stops a stroke before the first piece that would cross track, a custom building or itself, names it, and shows that piece red", async () => {
  const bundle = await trackAndRoadBundle();
  const observed = [];
  for (const crossing of CROSSING_CASES) {
    const colors = new ColorTable(bundle);
    const layout = new TrackDrawing(bundle, bundle.parts, colors);
    const ground = await crossing.ground();
    layout.setBands(bandsOver(ground, layout));
    crossing.track(layout);
    const before = layout.pieceCount;
    const { view, ghost, commit } = drawStroke(layout, crossing.stroke(layout));
    const refused = ghost?.instances.colorIndex[commit.laid] ?? -1;
    observed.push({
      name: crossing.name,
      shown: view?.blocked,
      named: commit.blocked,
      laidAsShown: commit.laid === view?.pieces && layout.pieceCount - before === commit.laid,
      laidSome: commit.laid > 0,
      ghostHasTheRefusedPiece: ghost?.instances.count === commit.laid + 1,
      refusedColor: colors.codeAt(refused),
      crossings: crossings(layout, bundle.parts, groundRects(ground)),
    });
  }
  expect(observed).toEqual(
    CROSSING_CASES.map((crossing) => ({
      name: crossing.name,
      shown: crossing.blocked,
      named: crossing.blocked,
      laidAsShown: true,
      laidSome: true,
      ghostHasTheRefusedPiece: true,
      refusedColor: REFUSED_GHOST_COLOR,
      crossings: [],
    })),
  );
});

function eastEnd(layout: TrackDrawing): Pose16 {
  const east = layout.endPoses().find((end) => end.heading === 0);
  if (!east) throw new Error("the carried straight has no end facing east");
  return east;
}

function shifted(pose: Pose16, x: bigint, z: bigint, heading: number): Pose16 {
  return pose16(addZeta16(pose.position, zeta16([x, 0n, 0n, 0n, z, 0n, 0n, 0n])), heading);
}

it("closes onto the open end of track a model carries, and runs no join through carried track of any system", async () => {
  const bundle = await trackAndRoadBundle();
  const carrying = (id: string) => {
    const layout = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
    layout.syncHeld(
      [
        {
          catalogIndex: bundle.trackCatalog.pieces.findIndex((piece) => piece.id === id),
          placement: studPose(0, 0, 0),
          yPlates: 0,
          instance: 0,
          frame: WORLD_TRACK_FRAME,
        },
      ],
      [carrierAtOrigin(1)],
    );
    return layout;
  };
  const joining = carrying(NINE_VOLT_STRAIGHT);
  const gap = layMoves(eastEnd(joining), [joining.kit.straight, joining.kit.straight]).end;
  layRun(joining, gap, [{ kind: "straight", count: 3 }]);
  focusAt(joining, gap);
  const offered = joining.extension.view();
  const closed = extend(joining, null);

  const throughCarried = [NINE_VOLT_STRAIGHT, PLASTIC_STRAIGHT].map((carried) => {
    const across = carrying(carried);
    const east = eastEnd(across);
    const below = shifted(east, -8n, -40n, NORTH);
    layRun(across, below, [{ kind: "straight", count: 2 }]);
    layRun(across, shifted(east, -8n, 40n, SOUTH), [{ kind: "straight", count: 2 }]);
    focusAt(across, below);
    const choices = across.extension.view()?.choices ?? [];
    return {
      carried,
      offered: choices.length > 0,
      joinsThrough: choices.some(
        (choice) =>
          choice.kind === "join" &&
          choice.straights === 5 &&
          choice.curves === 0 &&
          choice.blocked === null,
      ),
    };
  });

  expect(offered?.choices[offered.index]).toEqual({
    kind: "join",
    straights: 2,
    curves: 0,
    joinsEnd: true,
    blocked: null,
  });
  expect(closed).toBe(true);
  expect(joining.openEnds()).toHaveLength(2);
  expect(joining.joinedPairs()).toBe(joining.pieceCount);
  expect(throughCarried).toEqual([
    { carried: NINE_VOLT_STRAIGHT, offered: true, joinsThrough: false },
    { carried: PLASTIC_STRAIGHT, offered: true, joinsThrough: false },
  ]);
});

const TILED_PLAZA = "Tiled plaza";

async function kitSupport(layout: TrackDrawing): Promise<TrackSupport> {
  const loader = container.get(PART_BUNDLE_LOADER);
  const shapes = container.get(SNAP_SHAPES);
  const { parts } = await trackAndRoadBundle();
  const antiStuds = new Map<number, Int32Array>();
  for (const kit of layout.pieceParts()) {
    const part = parts[kit.partIndex];
    if (!part) throw new Error(`kit part index ${kit.partIndex} is not in the bundle`);
    const loaded = await loader.readPartConnectors("standard", part.id);
    if (loaded.kind !== "loaded") throw new Error(`${part.id} has no connector record`);
    const table = ConnectorTable.fromColumns(loaded.connectors, shapes, part.id);
    antiStuds.set(kit.catalogIndex, antiStudsOf(table, part.boundsMin[1]));
  }
  return new TrackSupport(antiStuds);
}

async function roadPlateGround() {
  const road = await loosePart(ROAD_BASEPLATE_32);
  const ground = placeGround([{ placeable: road, x: 0, z: 0 }]);
  const [plate] = ground;
  if (!plate || !road.road) throw new Error("the road plate has no road surface");
  return { ground, plate, surface: road.road };
}

function unsupportedOf(layout: TrackDrawing) {
  return (layout.unsupportedPieces() ?? []).map(({ piece, block }) => ({
    piece,
    on: block?.kind === "model" ? block.label : null,
  }));
}

it("counts a piece unsupported only when no anti-stud has a stud under it: half on a road plate's sidewalk is supported, wholly on its roadway is not", async () => {
  const { ground, plate } = await roadPlateGround();
  const layout = await trackOver(ground);
  layout.setSupport(await kitSupport(layout));
  const seats = studSeats(ground, layout.verticalRange()[0]);
  const centreZ = studsOf((plate.box.minZ + plate.box.maxZ) / 2);
  let roadwayEdge = Math.ceil(plate.box.minX / STUD_LDU);
  while (seats.has(cellKey(roadwayEdge, centreZ))) roadwayEdge++;
  const straight = placeableIndex(layout, NINE_VOLT_STRAIGHT);
  const halfLength = Number(layout.kit.straightStuds) / 2;
  layPiece(layout, straight, studPose(roadwayEdge, centreZ + halfLength, NORTH));
  layPiece(
    layout,
    straight,
    studPose(studsOf((plate.box.minX + plate.box.maxX) / 2), centreZ + halfLength, NORTH),
  );

  expect(unsupportedOf(layout)).toEqual([{ piece: 1, on: plate.placeable.label }]);
});

it("judges raised track by the band at its own height, with no table under it: a carried straight half on a raised road plate's roadway and half over air is unsupported, and so is one wholly over air", async () => {
  const road = await loosePart(ROAD_BASEPLATE_32);
  const raisedPlates = 3;
  const ground = placeGround([{ placeable: road, x: 0, z: 0, yPlates: raisedPlates }]);
  const [plate] = ground;
  if (!plate) throw new Error("the road plate wasn't placed");
  const layout = await trackOver(ground);
  layout.setSupport(await kitSupport(layout));
  const straight = placeableIndex(layout, NINE_VOLT_STRAIGHT);
  const halfLength = Number(layout.kit.straightStuds) / 2;
  const roadwayX = studsOf((plate.box.minX + plate.box.maxX) / 2);
  const plateEdgeZ = studsOf(plate.box.maxZ);
  layout.syncHeld(
    [plateEdgeZ - halfLength, plateEdgeZ + 4 * halfLength].map((z, instance) => ({
      catalogIndex: straight,
      placement: studPose(roadwayX, z, SOUTH),
      yPlates: raisedPlates,
      instance,
      frame: WORLD_TRACK_FRAME,
    })),
    [carrierAtOrigin(2)],
  );

  expect(unsupportedOf(layout)).toEqual([
    { piece: 0, on: plate.placeable.label },
    { piece: 1, on: null },
  ]);
});

it("judges track carried in a run frame at its framed pose: the frame's offset puts one straight across the roadway, which is unsupported, and moves the other off the plate onto bare ground", async () => {
  const { ground, plate } = await roadPlateGround();
  const layout = await trackOver(ground);
  layout.setSupport(await kitSupport(layout));
  const straight = placeableIndex(layout, NINE_VOLT_STRAIGHT);
  const halfLength = Number(layout.kit.straightStuds) / 2;
  const centreZ = studsOf((plate.box.minZ + plate.box.maxZ) / 2);
  const acrossRoadway = studsOf((plate.box.minX + plate.box.maxX) / 2) - halfLength;
  const shiftStuds = studsOf(plate.box.maxX - plate.box.minX) + 4 * halfLength;
  const runFrame = { id: WORLD_TRACK_FRAME.id + 1, xLdu: -shiftStuds * STUD_LDU + 0.3, zLdu: 0 };
  layout.syncHeld(
    [acrossRoadway + shiftStuds, acrossRoadway].map((x, instance) => ({
      catalogIndex: straight,
      placement: studPose(x, centreZ, 0),
      yPlates: 0,
      instance,
      frame: runFrame,
    })),
    [carrierAtOrigin(2)],
  );

  expect(unsupportedOf(layout)).toEqual([{ piece: 0, on: plate.placeable.label }]);
});

const REACH_SEED = 581;
const REACH_LAYOUTS = 160;
const REACH_TILES = 4;
const REACH_PLATES = 9;
const REACH_PIECES = 2;
const REACH_RAISED_PLATES = 3;
const REACH_EDGE_STUDS = 4;
const HEADINGS = 16;
const TILE_STUDS = 32;

interface PieceSpot {
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
}

function pieceSpot(
  ground: ReadonlyArray<PlacedModel>,
  random: () => number,
  spanStuds: number,
): PieceSpot {
  const plate = ground[Math.floor(random() * ground.length)];
  if (!plate || random() < 0.5) {
    return {
      x: Math.floor(random() * spanStuds),
      z: Math.floor(random() * spanStuds),
      yPlates: random() < 0.25 ? REACH_RAISED_PLATES : 0,
    };
  }
  const { box } = plate;
  const across = Math.floor(random() * (2 * REACH_EDGE_STUDS + 1)) - REACH_EDGE_STUDS;
  const minEdge = random() < 0.5;
  const alongX = studsOf(box.minX) + Math.floor(random() * studsOf(box.maxX - box.minX));
  const alongZ = studsOf(box.minZ) + Math.floor(random() * studsOf(box.maxZ - box.minZ));
  const edgeX = studsOf(minEdge ? box.minX : box.maxX) + across;
  const edgeZ = studsOf(minEdge ? box.minZ : box.maxZ) + across;
  const acrossX = random() < 0.5;
  return {
    x: acrossX ? edgeX : alongX,
    z: acrossX ? alongZ : edgeZ,
    yPlates: plate.handle.yPlates,
  };
}

function bandsReaching(ground: ReadonlyArray<PlacedModel>, layout: TrackDrawing): SupportBandAt {
  return (lowPlates, highPlates, reach) => {
    const [bottom, top] = layout.verticalRange();
    const band = [bottom + lowPlates * PLATE_LDU, top + highPlates * PLATE_LDU] as const;
    const reaches = reach === null ? EVERY_MODEL : (model: PlacedModel) => reach.reaches(model.box);
    return {
      obstacles: trackObstacles(ground, band, NO_TRACK_PARTS, reaches),
      pending: seatsPending(ground, band),
    };
  };
}

it(
  "judges support from only the models its track reaches exactly as from the whole layout, over random plates, heights, headings, plate edges and run frames",
  async () => {
    const random = seeded(REACH_SEED);
    const bundle = await trackAndRoadBundle();
    const [road, baseplate] = await Promise.all([
      loosePart(ROAD_BASEPLATE_32),
      loosePart(GROUND_BASEPLATE),
    ]);
    const whole = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
    const near = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
    const support = await kitSupport(whole);
    whole.setSupport(support);
    near.setSupport(support);
    const pieces = [NINE_VOLT_STRAIGHT, NINE_VOLT_CURVE].map((id) => placeableIndex(whole, id));
    const span = REACH_TILES * TILE_STUDS;
    const kinds = new Set<string>();
    for (let l = 0; l < REACH_LAYOUTS; l++) {
      const tiles = Array.from({ length: REACH_TILES * REACH_TILES }, (_, tile) => tile)
        .map((tile) => ({ tile, order: random() }))
        .toSorted((a, b) => a.order - b.order)
        .slice(0, REACH_PLATES);
      const ground = placeGround(
        tiles.map(({ tile }) => ({
          placeable: random() < 0.5 ? road : baseplate,
          x: ((tile % REACH_TILES) * TILE_STUDS + TILE_STUDS / 2) * STUD_LDU,
          z: (Math.floor(tile / REACH_TILES) * TILE_STUDS + TILE_STUDS / 2) * STUD_LDU,
          yPlates: random() < 0.25 ? REACH_RAISED_PLATES : 0,
        })),
      );
      whole.setBands(bandsOver(ground, whole));
      near.setBands(bandsReaching(ground, near));
      const held = Array.from({ length: REACH_PIECES }, (_, instance) => {
        const spot = pieceSpot(ground, random, span);
        return {
          catalogIndex: pieces[Math.floor(random() * pieces.length)] ?? 0,
          placement: studPose(spot.x, spot.z, Math.floor(random() * HEADINGS)),
          yPlates: spot.yPlates,
          instance,
          frame:
            random() < 0.25
              ? { id: WORLD_TRACK_FRAME.id + 1 + instance, xLdu: random() * STUD_LDU, zLdu: 0.3 }
              : WORLD_TRACK_FRAME,
        };
      });
      whole.syncHeld(held, [carrierAtOrigin(held.length)]);
      near.syncHeld(held, [carrierAtOrigin(held.length)]);
      const verdicts = unsupportedOf(whole);
      expect(unsupportedOf(near)).toEqual(verdicts);
      for (const { on } of verdicts) kinds.add(on ?? "over air");
      if (verdicts.length < held.length) kinds.add("supported");
    }
    expect([...kinds].toSorted()).toEqual(["supported", "over air", road.label].toSorted());
  },
  SWEEP_TIMEOUT_MS,
);

it("finds a level crossing only over a road surface's roadway: track on a studless plaza is reported unsupported, but is no crossing and gets no ramp", async () => {
  const { ground, plate, surface } = await roadPlateGround();
  const bundle = await trackAndRoadBundle();
  const layout = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  const range = layout.verticalRange();
  const roadObstacles = trackObstacles(ground, range, NO_TRACK_PARTS);
  const side = plate.box.maxX - plate.box.minX;
  const plaza: Rect = [
    plate.box.maxX + side,
    plate.box.minZ,
    plate.box.maxX + 2 * side,
    plate.box.maxZ,
  ];
  layout.setBands(
    everyBand({
      ...roadObstacles,
      rects: Float64Array.from([...roadObstacles.rects, ...plaza]),
      owners: Int32Array.from([...roadObstacles.owners, roadObstacles.labels.length]),
      unseated: Uint8Array.from([...roadObstacles.unseated, 1]),
      labels: [...roadObstacles.labels, TILED_PLAZA],
    }),
  );
  layout.setSupport(await kitSupport(layout));
  const straight = placeableIndex(layout, NINE_VOLT_STRAIGHT);
  const halfLength = Number(layout.kit.straightStuds) / 2;
  const centreZ = studsOf((plate.box.minZ + plate.box.maxZ) / 2);
  const acrossRoadway = studsOf((plate.box.minX + plate.box.maxX) / 2) - halfLength;
  const acrossPlaza = studsOf((plaza[0] + plaza[2]) / 2) - halfLength;
  layPiece(layout, straight, studPose(acrossRoadway, centreZ, 0));
  layPiece(layout, straight, studPose(acrossPlaza, centreZ, 0));
  const { levelCrossing } = await container.get(PART_BUNDLE_LOADER).loadIndex("standard");
  const railTops = new Map(
    levelCrossing.systems.map((system) => [system.system, system.railTopLdu]),
  );
  const road = { id: 0, x: plate.handle.x, z: plate.handle.z, yLdu: 0, rot: 0, surface };
  const tracks = layout.crossingPieces().map((piece) => ({
    outline: piece.outline,
    bedLdu: piece.bedLdu,
    railTopLdu: railTops.get(piece.system) ?? Number.NaN,
  }));
  const found = levelCrossings([road], tracks, []);

  expect(unsupportedOf(layout)).toEqual([
    { piece: 0, on: plate.placeable.label },
    { piece: 1, on: TILED_PLAZA },
  ]);
  expect(found.map((crossing) => crossing.tracks)).toEqual([[0]]);
});

it("lays the stroke and withholds only the join when no supported closure reaches the end, reports it unsupported, and joins when a supported closure exists, half on studs included", async () => {
  const baseplate = await loosePart(GROUND_BASEPLATE);
  const road = await loosePart(ROAD_BASEPLATE_32);
  const side = baseplate.box.max[0] - baseplate.box.min[0];
  const ground = placeGround([
    { placeable: baseplate, x: 0, z: 0 },
    { placeable: road, x: side, z: 0 },
  ]);
  const seam = side / 2 / STUD_LDU;
  const roadCentre = side / STUD_LDU;
  const reach = side / STUD_LDU;
  const seats = studSeats(ground, 0);
  let roadwayEdge = seam;
  while (seats.has(cellKey(roadwayEdge, 0))) roadwayEdge++;
  const straights: Run = [{ kind: "straight", count: 2 }];
  const across = async (x: number) => {
    const layout = await trackOver(ground);
    layout.setSupport(await kitSupport(layout));
    layRun(layout, studPose(x, -reach, NORTH), straights);
    layRun(layout, studPose(x, reach, SOUTH), straights);
    const before = layout.pieceCount;
    const { view, commit } = closeFrom(layout, endAt(layout, x, -reach), endAt(layout, x, reach));
    return {
      closure: view?.closure ?? null,
      withheld: commit.withheld,
      joined: commit.joined,
      laidSome: commit.laid > 0,
      unsupportedLaid: unsupportedOf(layout).filter(({ piece }) => piece >= before).length > 0,
    };
  };

  expect(await across(seam)).toEqual({
    closure: "exact",
    withheld: null,
    joined: true,
    laidSome: true,
    unsupportedLaid: false,
  });
  expect(await across(roadwayEdge)).toEqual({
    closure: "exact",
    withheld: null,
    joined: true,
    laidSome: true,
    unsupportedLaid: false,
  });
  expect(await across(roadCentre)).toEqual({
    closure: "blocked",
    withheld: "unsupported",
    joined: false,
    laidSome: true,
    unsupportedLaid: true,
  });
});

it("reports unsupported track inside a plan as a plan issue, so the plan isn't Valid", async () => {
  const { ground, plate } = await roadPlateGround();
  const layout = await trackOver(ground);
  layout.setSupport(await kitSupport(layout));
  const centreZ = studsOf((plate.box.minZ + plate.box.maxZ) / 2);
  const straight = placeableIndex(layout, NINE_VOLT_STRAIGHT);
  const halfLength = Number(layout.kit.straightStuds) / 2;
  layPiece(
    layout,
    straight,
    studPose(studsOf((plate.box.minX + plate.box.maxX) / 2) - halfLength, centreZ, 0),
  );
  const plans = container.get(PLAN_SERVICE);
  const planId = plans.createPlan({
    name: "Road table",
    roomWidthMm: 4000,
    roomDepthMm: 3000,
    originChunkX: -1,
    originChunkZ: -1,
  });
  plans.addTable(planId, {
    name: "Table",
    rect: { x: 0, z: 0, width: 4000, depth: 3000 },
    heightMm: 750,
  });
  const delta = new PlanDelta();
  writeFullRebuild(delta, ground, layout);
  plans.apply(delta);
  layout.setBands(bandsOver(ground, layout));
  const unsupported = (layout.unsupportedPieces() ?? []).map(({ piece }) => piece);
  plans.setUnsupported(new Set(unsupported), new Set(), new Set());
  const flagged = plans.issues(planId).filter((issue) => issue.rule === "unsupported");
  plans.setUnsupported(new Set(), new Set(), new Set());
  const cleared = plans.issues(planId).filter((issue) => issue.rule === "unsupported");
  plans.removePlan(planId);

  expect(unsupported).toEqual([0]);
  expect(flagged).toHaveLength(1);
  expect(cleared).toEqual([]);
});

const MY_TRAIN = { heightLdu: 100, model: "my tall train" };
const COLUMN_RECT = Float64Array.of(-STUD_LDU, -STUD_LDU, STUD_LDU, STUD_LDU);

function column(topLdu: number) {
  return (bottomLdu: number, bandTopLdu: number) => {
    const meets = 0 < bandTopLdu && bottomLdu < topLdu;
    return { rects: COLUMN_RECT, floats: meets ? COLUMN_RECT.length : 0 };
  };
}
const ACROSS = 4;

async function bareDrawing(): Promise<TrackDrawing> {
  const bundle = await trackAndRoadBundle();
  const layout = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  layout.setBands(bandsOver([], layout));
  return layout;
}

function layAt(layout: TrackDrawing, pose: Pose16, yPlates: number, rise = 0): number {
  const index = layout.pieceCount;
  const piece = placeableIndex(layout, NINE_VOLT_STRAIGHT);
  layout.applyTrack({ lift: [], lay: [{ index, piece, pose, yPlates, rise }] });
  return index;
}

it("refuses track across laid track only where their heights meet, and reports each crossing lower than the measured train with the plates it needs, from whichever end of the stack it was laid", async () => {
  const layout = await bareDrawing();
  const straight = placeableIndex(layout, NINE_VOLT_STRAIGHT);
  const halfLength = Number(layout.kit.straightStuds) / 2;
  const along = studPose(-halfLength, 0, 0);
  const across = studPose(0, -halfLength, ACROSS);
  layAt(layout, along, 0);
  const [, railTop] = layout.verticalRange();
  const clearPlates = Math.ceil((railTop + MY_TRAIN.heightLdu) / PLATE_LDU);
  const touching = layout.pieceBlock(straight, across, 1);
  const low = layout.pieceBlock(straight, across, clearPlates - 1);
  const bridge = layAt(layout, across, clearPlates - 1);
  const unmeasured = layout.lowClearances();
  layout.setTallestTrain(MY_TRAIN);
  const reported = layout.lowClearances();
  const below = await bareDrawing();
  below.setTallestTrain(MY_TRAIN);
  layAt(below, across, clearPlates - 1);
  layAt(below, along, 0);
  const clear = await bareDrawing();
  clear.setTallestTrain(MY_TRAIN);
  layAt(clear, along, 0);
  layAt(clear, across, clearPlates);
  const finding = {
    needPlates: clearPlates,
    hasPlates: clearPlates - 1,
    train: MY_TRAIN,
  };

  expect(touching).toEqual({ kind: "track" });
  expect(low).toBeNull();
  expect(unmeasured).toBeNull();
  expect(reported).toEqual([{ piece: bridge, ...finding }]);
  expect(below.lowClearances()).toEqual([{ piece: 0, ...finding }]);
  expect(clear.lowClearances()).toEqual([]);
  expect(layout.heightLabels().map((label) => label.text)).toContain(
    `${heightText((clearPlates - 1) * PLATE_LDU - railTop)} clear: too low for ${MY_TRAIN.model}`,
  );
});

it("refuses a model that reaches into raised track's own band and passes one that stops at its underside", async () => {
  const layout = await bareDrawing();
  const halfLength = Number(layout.kit.straightStuds) / 2;
  const raised = 5;
  layAt(layout, studPose(-halfLength, 0, 0), raised);
  const underside = layout.bandBottomLdu(raised);

  expect(layout.modelBlocker(column(underside), [], new Set(), new Set())).toBeNull();
  expect(layout.modelBlocker(column(underside + PLATE_LDU), [], new Set(), new Set())).toEqual({
    kind: "track",
  });
});

it("draws a ramp piece sheared between its two end heights, and keeps both heights through a save and reload", async () => {
  const layout = await bareDrawing();
  const halfLength = Number(layout.kit.straightStuds) / 2;
  const straight = placeableIndex(layout, NINE_VOLT_STRAIGHT);
  const start = studPose(-halfLength, 0, 0);
  const ramp = layAt(layout, start, 3, 2);
  const [chunk] = layout.chunkKeys();
  const instances = chunk === undefined ? null : layout.chunkInstances(chunk);
  const m = instances?.matrices ?? new Float32Array(INSTANCE_MATRIX_FLOATS);
  const yAt = (connector: number): number => {
    const end = zeta16ToStuds(layout.connectorPose(straight, start, connector).position);
    const wx = end.x * STUD_LDU - (instances?.originX ?? 0) - (m[3] ?? 0);
    const wz = end.z * STUD_LDU - (instances?.originZ ?? 0) - (m[11] ?? 0);
    const lx = (m[0] ?? 0) * wx + (m[8] ?? 0) * wz;
    const lz = (m[2] ?? 0) * wx + (m[10] ?? 0) * wz;
    return (m[4] ?? 0) * lx + (m[6] ?? 0) * lz + (m[7] ?? 0);
  };
  const records = layout.records();
  const reloaded = await bareDrawing();
  const restored = reloaded.restore(records);

  expect(yAt(1) - yAt(0)).toBeCloseTo(2 * PLATE_LDU, 3);
  expect(records[ramp]).toMatchObject({ yPlates: 3, rise: 2 });
  expect(restored.ok).toBe(true);
  expect(reloaded.records()).toEqual(records);
  expect(reloaded.laidPiece(ramp)).toMatchObject({ yPlates: 3, rise: 2 });
});

function clearanceIssues(plans: IPlanService, planId: string): ReadonlyArray<string> {
  return plans
    .issues(planId)
    .filter((issue) => issue.rule === "clearance")
    .map((issue) => issue.message);
}

it("lists a bridge lower than the measured train as a plan clearance issue that follows the bridge's own row: absent until the row is written, renamed with the train, gone once the bridge is lifted", async () => {
  const layout = await bareDrawing();
  layout.setTallestTrain(MY_TRAIN);
  const halfLength = Number(layout.kit.straightStuds) / 2;
  layAt(layout, studPose(-halfLength, 0, 0), 0);
  const plans = container.get(PLAN_SERVICE);
  const planId = plans.createPlan({
    name: "Bridge table",
    roomWidthMm: 4000,
    roomDepthMm: 3000,
    originChunkX: -1,
    originChunkZ: -1,
  });
  plans.addTable(planId, {
    name: "Table",
    rect: { x: 0, z: 0, width: 4000, depth: 3000 },
    heightMm: 750,
  });
  const delta = new PlanDelta();
  writeFullRebuild(delta, [], layout);
  plans.apply(delta);
  const [, railTop] = layout.verticalRange();
  const lowPlates = Math.ceil((railTop + MY_TRAIN.heightLdu) / PLATE_LDU) - 1;
  const bridge = layAt(layout, studPose(0, -halfLength, ACROSS), lowPlates);
  const low = new Map(
    (layout.lowClearances() ?? []).map(({ piece, needPlates, hasPlates }) => [
      piece,
      { needPlates, hasPlates },
    ]),
  );
  plans.setLowClearance(low, new Map(), MY_TRAIN.model);
  const beforeRow = clearanceIssues(plans, planId);
  writeTrackLay(delta, layout, 1);
  plans.apply(delta);
  const withRow = clearanceIssues(plans, planId);
  plans.setLowClearance(low, new Map(), "my other train");
  const renamed = clearanceIssues(plans, planId);
  const lift = { lift: [layout.laidPiece(bridge)], lay: [] };
  layout.applyTrack(lift);
  writeTrackChange(delta, layout, lift);
  plans.apply(delta);
  const lifted = clearanceIssues(plans, planId);
  plans.removePlan(planId);
  const finding = `needs ${lowPlates + 1} plates, this bridge has ${lowPlates}.`;

  expect([...low.keys()]).toEqual([bridge]);
  expect(beforeRow).toEqual([]);
  expect(withRow).toEqual([expect.stringContaining(`${MY_TRAIN.model} ${finding}`)]);
  expect(renamed).toEqual([expect.stringContaining(`my other train ${finding}`)]);
  expect(lifted).toEqual([]);
});
