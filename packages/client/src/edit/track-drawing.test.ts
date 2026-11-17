import { ASSET_FETCHER, PART_BUNDLE_LOADER, type IAssetFetcher } from "@brr/catalog";
import { lduFromMm, pose16, STUD_LDU, zeta16 } from "@brr/math";
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
import { TrackDrawing, type TrackFootprint } from "./track-drawing.ts";

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
  setChunk(): void {}
  deleteChunk(): void {}
  setGhost(): void {}
  placeGhost(): void {}
  setGhostTone(): void {}
  cueGhost(): void {}
  setSnapTargets(): void {}
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
  drawing = new TrackDrawing(bundle.trackCatalog, bundle.parts, new ColorTable(bundle));
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
  const layout = new TrackDrawing(bundle.trackCatalog, bundle.parts, new ColorTable(bundle));
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
  lay([160, 0], [208, 0]);

  const refused = aim([51, 2], [48, 0]);
  expect(refused.closure).toBe("impossible");
  expect(refused.target).toEqual({ end: expect.any(Number), joins: false });

  const exact = aim([48, 0], [160, 0]);
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
  const siding = new TrackDrawing(bundle.trackCatalog, bundle.parts, new ColorTable(bundle));
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

  const reopened = new TrackDrawing(bundle.trackCatalog, bundle.parts, new ColorTable(bundle));
  expect(reopened.restore(siding.records()).ok).toBe(true);
  expect(reopened.switchLevers().map((s) => s.lever)).toEqual(["branching", "branching"]);
  expect(reopened.joinedPairs()).toBe(8);
  expect(reopened.openEnds()).toHaveLength(2);
});
