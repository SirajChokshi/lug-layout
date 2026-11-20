import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
  type PartAsset,
} from "@brr/catalog";
import {
  EditHistory,
  PlanDelta,
  World,
  layMoves,
  runMoves,
  solveClosure,
  type TrackSegment,
} from "@brr/domain";
import { lduFromMm, pose16, STUD_LDU, zeta16, type Pose16 } from "@brr/math";
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
import { writeFullRebuild } from "../plan/plan-producer.ts";
import { ColorTable } from "../scene/viewer-scene.ts";
import { PLAN_SERVICE } from "../tokens.ts";
import { fixtureModel, fixtureModelChecks } from "./fixture-model.test-support.ts";
import { partPlaceable, type Placeable } from "./placeable.ts";
import { PlacedChunks, type PlacedModel } from "./placed-chunks.ts";
import {
  TrackDrawing,
  type ClosureState,
  type TrackEndView,
  type TrackFootprint,
} from "./track-drawing.ts";
import { seatsPending, trackObstacleRects } from "./track-obstacles.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
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
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  deleteVehicle(): void {}
  setIssueBoxes(): void {}
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

const container = new Container();
let drawing: TrackDrawing;
let footprints: ReadonlyArray<TrackFootprint>;
let rendered: Extent;

function drag(from: readonly [number, number], to: readonly [number, number]): void {
  const [fx, fz] = from;
  const [tx, tz] = to;
  drawing.beginDrag(fx * STUD_LDU, fz * STUD_LDU, fx * STUD_LDU, fz * STUD_LDU);
  drawing.moveDrag(tx * STUD_LDU, tz * STUD_LDU);
  drawing.endDrag();
}

beforeAll(async () => {
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  container.rebind(SCENE_BACKEND).toConstantValue(new PlanOnlyBackend());
  const bundle = await container
    .get(PART_BUNDLE_LOADER)
    .load("standard", (part) => part.role === "track");
  drawing = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  drag([180, 190], [260, 190]);
  drag([260, 190], [260, 270]);
  drag([260, 270], [180, 270]);
  drag([180, 270], [180, 190]);
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

function fitIssues(table: { x: number; z: number; width: number; depth: number }): number {
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
  const check = plans.snapshot().checks.find((c) => c.regionId === planId);
  plans.removePlan(planId);
  return check?.issues.filter((issue) => issue.rule === "fit").length ?? -1;
}

it("lays a closed oval of real 9V pieces from four drags", () => {
  expect(drawing.pieceCount).toBe(26);
  expect(drawing.joinedPairs()).toBe(26);
  expect(drawing.openEnds()).toHaveLength(0);
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
  expect(fitIssues({ x, z, width, depth })).toBe(0);
  expect(fitIssues({ x, z, width: width - SHRINK_MM, depth })).toBeGreaterThan(0);
  expect(fitIssues({ x: x + SHRINK_MM, z, width: width - SHRINK_MM, depth })).toBeGreaterThan(0);
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
    layout.endDrag();
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
    expect(run.endDrag().laid).toBeGreaterThan(0);
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
            yard.placePiece(part.catalogIndex, snap.placement);
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
    siding.placePiece(piece, snap.placement);
  };
  const openEndNear = (xStuds: number, zStuds: number) => {
    const end = siding
      .openEnds()
      .find((e) => Math.hypot(e.xLdu / STUD_LDU - xStuds, e.zLdu / STUD_LDU - zStuds) < 1);
    if (!end) throw new Error(`no open end near ${xStuds}, ${zStuds} studs`);
    return end;
  };

  siding.placePiece(right, latticePose(0, 0));
  snapAt(curve, 1, openEndNear(32.69, 12.96));
  const draw = (from: readonly [number, number], to: readonly [number, number]) => {
    siding.beginDrag(
      from[0] * STUD_LDU,
      from[1] * STUD_LDU,
      from[0] * STUD_LDU,
      from[1] * STUD_LDU,
    );
    siding.moveDrag(to[0] * STUD_LDU, to[1] * STUD_LDU);
    return siding.endDrag();
  };
  draw([32, 0], [80, 0]);
  snapAt(left, 1, openEndNear(80, 0));
  snapAt(curve, 0, openEndNear(79.31, 12.96));
  expect(draw([48, 16], [64, 16]).joined).toBe(true);

  expect(siding.pieceCount).toBe(8);
  expect(siding.joinedPairs()).toBe(8);
  expect(siding.openEnds()).toHaveLength(2);
  expect(siding.gaps()).toHaveLength(0);

  for (const lever of siding.switchLevers()) siding.throwSwitch(lever.placement);
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
    layout.placePiece(part.catalogIndex, piece.placement);
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
  const commit = layout.endDrag();
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
  layout.setObstacles(Float64Array.from(plate), false);
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
  layout.setObstacles(Float64Array.from(plateRect(bundle.parts, "ldraw:44336p04", 112, 0)), false);
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

const RIGHT_SWITCH = "ldraw:75541-f1";
const NINE_VOLT_CURVE = "ldraw:74747";
const NINE_VOLT_STRAIGHT = "ldraw:74746";
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
  layout.placePiece(piece, snap.placement);
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
  layout.placePiece(placeableIndex(layout, RIGHT_SWITCH), studPose(0, 0, 0));
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
  layout.setObstacles(Float64Array.from(plates.flat()), false);

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
      layout.setObstacles(Float64Array.from(rect), false);
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
      yPlates: 0,
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

async function trackOver(
  ground: ReadonlyArray<PlacedModel>,
  pendingSeats: (range: readonly [number, number]) => boolean = (range) =>
    seatsPending(ground, range),
): Promise<TrackDrawing> {
  const bundle = await trackAndRoadBundle();
  const layout = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  const range = layout.verticalRange();
  layout.setObstacles(trackObstacleRects(ground, range), pendingSeats(range));
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
    laid: commit.laid,
  };
}

it("never seats a join on a model's pending studs: it waits and lays nothing, pending studs are no seats at all, and the same join seats once the checked studs land", async () => {
  const { pending, checked } = await fixtureModelChecks(BASEPLATE_ROW_MODEL);
  const seated = await acrossTheRow(checked);
  expect(seated.closure).toBe("exact");
  expect(seated.laid).toBeGreaterThan(0);
  expect(await acrossTheRow(pending)).toEqual({ closure: "pending", refusal: "pending", laid: 0 });
  expect(await acrossTheRow(pending, () => false)).toEqual({
    closure: "blocked",
    refusal: "blocked",
    laid: 0,
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
