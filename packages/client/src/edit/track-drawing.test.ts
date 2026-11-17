import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
  type PartAsset,
} from "@brr/catalog";
import { layMoves, runMoves, solveClosure, type TrackSegment } from "@brr/domain";
import { lduFromMm, pose16, STUD_LDU, zeta16, type Pose16 } from "@brr/math";
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
import { ColorTable } from "../scene/viewer-scene.ts";
import { PLAN_SERVICE } from "../tokens.ts";
import { TrackDrawing, type TrackEndView, type TrackFootprint } from "./track-drawing.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const MM_PER_LDU = 1 / lduFromMm(1);
const SHRINK_MM = 2;
const RENDER_FLOAT_LDU = 1e-3;

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
  footprints = drawing.planFootprints();
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
  plans.setPlacements(footprints);
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

function latticePose(x: number, z: number) {
  return pose16(zeta16([BigInt(x), 0n, 0n, 0n, BigInt(z), 0n, 0n, 0n]), 0);
}

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
  for (const footprint of layout.planFootprints()) {
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

function joined(layout: TrackDrawing, a: number, b: number): boolean {
  const routes = layout.routes();
  const ra = routes[a];
  const rb = routes[b];
  if (!ra || !rb) throw new Error("every kit piece has one route");
  return [ra.from, ra.to].some((p) =>
    [rb.from, rb.to].some(
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
  const found: string[] = [];
  for (let a = 0; a < cells.length; a++) {
    for (let b = a + 1; b < cells.length; b++) {
      if (joined(layout, a, b)) continue;
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

it("closes a loop whose ends sit too close for a half circle without looping back over itself or the user's track", async () => {
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
});

it("routes a closure around a road plate in its way with no extra loop", async () => {
  const bundle = await trackAndRoadBundle();
  const layout = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  layRun(layout, studPose(0, 0, 0), [
    { kind: "straight", count: 4 },
    { kind: "turn", sign: 1, curves: 8 },
    { kind: "straight", count: 4 },
  ]);
  const plate = plateRect(bundle.parts, "ldraw:69958", -40, 40);
  layout.setObstacles(Float64Array.from(plate));
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
  layout.setObstacles(Float64Array.from(plateRect(bundle.parts, "ldraw:44336p04", 112, 0)));
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
