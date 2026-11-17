import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
  type PartBundle,
} from "@brr/catalog";
import { SupportGrid, trackSupport, type BaseCells, type TrackSupport } from "@brr/domain";
import { lduFromMm, PLATE_LDU, STUD_LDU } from "@brr/math";
import { trainGauge, type Gauge } from "./clearance-gauge.ts";
import type { Pier, PierKit } from "./track-piers.ts";
import { latticePose16, type ModelTrack } from "./model-track.ts";
import { modelPlaceable } from "./placeable.ts";
import {
  INSTANCE_MATRIX_FLOATS,
  RAY_FLOATS,
  SCENE_BACKEND,
  type BufferMemory,
  type ISceneBackend,
  type RebaseEvent,
  type WorldBox,
} from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { ColorTable } from "../scene/viewer-scene.ts";
import { PLAN_SERVICE } from "../tokens.ts";
import {
  TrackDrawing,
  type RunBlock,
  type TrackCommit,
  type TrackFootprint,
  type TrackHost,
  type TrackSupportProbe,
} from "./track-drawing.ts";

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
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
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

const openTable: TrackHost = {
  support: (cells: BaseCells): TrackSupport => ({ kind: "on-baseplate", cells: cells.count }),
  overlap: () => null,
  pierOverlap: () => null,
  neighbours: () => new Set(),
  laid: () => undefined,
  relaid: () => undefined,
  piers: () => undefined,
};

const RAY_HEIGHT_LDU = 10_000;
const PIER_PARTS = ["ldraw:3001", "ldraw:3020"];

function downAt(xStuds: number, zStuds: number): Float64Array {
  const ray = new Float64Array(RAY_FLOATS);
  ray.set([xStuds * STUD_LDU, RAY_HEIGHT_LDU, zStuds * STUD_LDU, 0, -1, 0]);
  return ray;
}

const container = new Container();
let drawing: TrackDrawing;
let trackBundle: PartBundle;
let footprints: ReadonlyArray<TrackFootprint>;
let pierKit: PierKit;
let train: Gauge;
let rendered: Extent;

function drag(from: readonly [number, number], to: readonly [number, number]): void {
  drawing.beginDrag(downAt(...from));
  drawing.moveDrag(downAt(...to));
  drawing.endDrag();
}

beforeAll(async () => {
  container.load(...mainThreadModules({ bundleBaseUrl: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  container.rebind(SCENE_BACKEND).toConstantValue(new PlanOnlyBackend());
  const loader = container.get(PART_BUNDLE_LOADER);
  const bundle = await loader.load(
    "standard",
    (part) => part.role === "track" || PIER_PARTS.includes(part.id),
  );
  trackBundle = bundle;
  const pierPart = (id: string) => {
    const partIndex = bundle.parts.findIndex((part) => part.id === id);
    const part = bundle.parts[partIndex];
    if (!part) throw new Error(`the bundle has no ${id}`);
    return { partIndex, color: 0, part };
  };
  pierKit = { brick: pierPart("ldraw:3001"), plate: pierPart("ldraw:3020") };
  const trains = await Promise.all(
    bundle.models
      .filter((entry) => entry.origin === "omr")
      .map((entry) => loader.loadModel("standard", entry.name)),
  );
  const measured = trainGauge(
    trains.map(({ bundle: own, entry, model }) => ({
      name: entry.name,
      model,
      parts: own.parts,
      studPrimitives: own.studPrimitives,
    })),
    "ldraw:74746",
  );
  if (!measured) throw new Error("no bundled train runs on 74746");
  train = measured;
  drawing = new TrackDrawing(bundle.trackCatalog, bundle.parts, new ColorTable(bundle), openTable, {
    pier: pierKit,
    train,
  });
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

const BASEPLATE_STUDS = 32;

function baseplates(...minCorners: ReadonlyArray<readonly [number, number]>): SupportGrid {
  const grid = new SupportGrid();
  for (const [x0, z0] of minCorners) {
    for (let z = z0; z < z0 + BASEPLATE_STUDS; z++) {
      for (let x = x0; x < x0 + BASEPLATE_STUDS; x++) grid.markBaseplate(x, z);
    }
  }
  return grid;
}

function probeOn(grid: SupportGrid): TrackSupportProbe {
  return (cells) => trackSupport(cells, grid);
}

function drawingOn(grid: SupportGrid, host: Partial<TrackHost> = {}): TrackDrawing {
  return new TrackDrawing(
    trackBundle.trackCatalog,
    trackBundle.parts,
    new ColorTable(trackBundle),
    { ...openTable, support: probeOn(grid), ...host },
    { pier: pierKit, train },
  );
}

function lay(
  target: TrackDrawing,
  from: readonly [number, number],
  to: readonly [number, number],
): TrackCommit {
  target.beginDrag(downAt(...from));
  target.moveDrag(downAt(...to));
  return target.endDrag();
}

describe("track on baseplates: only the span between a piece's own connectors needs one (P6)", () => {
  it("lays a straight whose open end is flush with the baseplate edge, and refuses one that starts past it", () => {
    const plate = baseplates([-16, -16]);
    expect(lay(drawingOn(plate), [-16, -8], [0, -8])).toMatchObject({ laid: 1, refusal: null });
    expect(lay(drawingOn(plate), [-20, 8], [-4, 8])).toMatchObject({
      laid: 0,
      refusal: "off-baseplate",
    });
  });

  it("fills one 3811 edge to edge with two straights", () => {
    expect(lay(drawingOn(baseplates([-16, -16])), [-16, 0], [16, 0])).toMatchObject({
      laid: 2,
      refusal: null,
    });
  });

  it("needs both baseplates under a straight across a seam, but only its own under one that ends at it", () => {
    const both = baseplates([-16, -16], [16, -16]);
    const westOnly = probeOn(baseplates([-16, -16]));
    const across = drawingOn(both);
    expect(lay(across, [8, 0], [24, 0])).toMatchObject({ laid: 1, refusal: null });
    expect(across.unsupportedPieces(westOnly)).toHaveLength(1);
    const toSeam = drawingOn(both);
    expect(lay(toSeam, [0, 8], [16, 8])).toMatchObject({ laid: 1, refusal: null });
    expect(toSeam.unsupportedPieces(westOnly)).toHaveLength(0);
  });
});

async function heldTrack(name: string): Promise<ModelTrack | null> {
  const loader = container.get(PART_BUNDLE_LOADER);
  const [{ bundle, entry, model }, plates] = await Promise.all([
    loader.loadModel("standard", name),
    loader.load("standard", (part) => part.id === "ldraw:3811"),
  ]);
  const baseplate = plates.parts[0];
  if (!baseplate) throw new Error("the bundle has no baseplate");
  return modelPlaceable(
    name,
    name,
    entry.role,
    model,
    { name, source: entry.source, sections: model.sections },
    bundle.parts,
    new ColorTable(bundle),
    baseplate.boundsMin[1],
    trackBundle.trackCatalog,
  ).track;
}

async function summary(name: string) {
  const track = await heldTrack(name);
  return {
    pieces: track?.pieces.map((piece) => `${piece.pieceId}@${piece.plates}`),
    open: track?.openEnds.length,
    uncertified: track?.uncertified,
  };
}

describe("track held by models", () => {
  it("turns every catalog track part in a model into exact track at the model's height, following LDraw redirects", async () => {
    expect(await summary("7936-1")).toEqual({
      pieces: Array.from({ length: 4 }, () => "ldraw:53401@0"),
      open: 4,
      uncertified: [],
    });
    expect((await summary("10128-1")).pieces).toEqual(
      Array.from({ length: 3 }, () => "ldraw:74746@0"),
    );
    expect((await summary("4555-1")).pieces).toEqual(
      Array.from({ length: 2 }, () => "ldraw:74746@0"),
    );
  });

  it("checks a run joined to a model's track end against the baseplates exactly as it checks laid track", () => {
    const plate = baseplates([-16, -16]);
    const straight = trackBundle.trackCatalog.pieces.findIndex(
      (piece) => piece.id === "ldraw:74746",
    );
    const heldAt = (xStuds: number) => [
      {
        owner: 1,
        label: "a model",
        catalogIndex: straight,
        placement: latticePose16(xStuds * STUD_LDU, 0, 0),
        plates: 0,
      },
    ];
    const flush = drawingOn(plate);
    flush.syncHeld(heldAt(16));
    expect(lay(flush, [16, 0], [0, 0])).toMatchObject({ laid: 1, refusal: null });
    expect(flush.joinedPairs()).toBe(1);
    expect(flush.unsupportedPieces(probeOn(plate))).toHaveLength(0);
    const endsUnderTheModelPiece = baseplates([-9, -16]);
    const short = drawingOn(endsUnderTheModelPiece);
    short.syncHeld(heldAt(24));
    expect(lay(short, [24, 0], [8, 0])).toMatchObject({ laid: 0, refusal: "off-baseplate" });
  });
});

interface LaidSpan {
  readonly cells: BaseCells;
  readonly bottomLdu: number;
  readonly topLdu: number;
}

function sharesCell(a: BaseCells, b: BaseCells): boolean {
  for (let i = 0; i < a.count; i++) {
    for (let j = 0; j < b.count; j++) {
      if (a.cellX[i] === b.cellX[j] && a.cellZ[i] === b.cellZ[j]) return true;
    }
  }
  return false;
}

function trackedTable(grid: SupportGrid) {
  const laid = new Map<number, LaidSpan>();
  let piers: ReadonlyArray<Pier> = [];
  const target = drawingOn(grid, {
    laid: (piece, _id, cells, bottomLdu, topLdu) => laid.set(piece, { cells, bottomLdu, topLdu }),
    piers: (next) => {
      piers = next;
    },
    neighbours: (cells) =>
      new Set([...laid].filter(([, span]) => sharesCell(span.cells, cells)).map(([p]) => p)),
    pierOverlap: (cells, bottomLdu, topLdu) => {
      for (const [piece, span] of laid) {
        const stacked = span.bottomLdu < topLdu && bottomLdu < span.topLdu;
        if (!stacked || !sharesCell(span.cells, cells)) continue;
        return {
          owner: { kind: "track", piece, pieceId: "ldraw:74746" },
          overlap: {
            owner: piece,
            cellX: 0,
            cellZ: 0,
            bottomLdu: span.bottomLdu,
            topLdu: span.topLdu,
            candidateBottomLdu: bottomLdu,
            candidateTopLdu: topLdu,
          },
        };
      }
      return null;
    },
  });
  return { target, piers: () => piers };
}

function blockOf(commit: TrackCommit): RunBlock["kind"] | TrackCommit["refusal"] | "laid" {
  return commit.blocked?.kind ?? commit.refusal ?? "laid";
}

const FIELD_CORNERS = [-64, -32, 0, 32];

function field(): SupportGrid {
  return baseplates(
    ...FIELD_CORNERS.flatMap((z) => FIELD_CORNERS.map((x): readonly [number, number] => [x, z])),
  );
}

function crossOver(plates: number) {
  const { target } = trackedTable(field());
  lay(target, [-24, 0], [24, 0]);
  target.setDrawPlates(plates);
  return { target, commit: lay(target, [0, -24], [0, 24]) };
}

describe("raised track", () => {
  it("stands every raised joint on a pier of whole bricks, then plates, to its exact height", () => {
    const { target, piers } = trackedTable(field());
    target.setDrawPlates(7);
    expect(lay(target, [-16, -40], [16, -40])).toMatchObject({ laid: 2, refusal: null });
    expect(piers().map((pier) => pier.heightPlates)).toEqual([7, 7, 7]);
    expect(target.pierParts().map((line) => [line.partId, line.count])).toEqual([
      ["ldraw:3001", 6],
      ["ldraw:3020", 3],
    ]);
    expect(target.openEnds().map((end) => end.plates)).toEqual([7, 7]);
  });

  it("climbs from a ground end one plate per straight, and refuses a join that would need a steeper climb", () => {
    const { target } = trackedTable(field());
    expect(lay(target, [-48, 40], [-32, 40])).toMatchObject({ laid: 1 });
    target.setDrawPlates(2);
    expect(lay(target, [-32, 40], [32, 40])).toMatchObject({ laid: 4, refusal: null });
    expect(
      [0, 1, 2, 3, 4].map((piece) => {
        const { fromPlates, toPlates } = target.pieceHeights(piece);
        return `${fromPlates}->${toPlates}`;
      }),
    ).toEqual(["0->0", "0->1", "1->2", "2->2", "2->2"]);
    const steep = trackedTable(field()).target;
    lay(steep, [-48, 40], [-32, 40]);
    steep.setDrawPlates(9);
    lay(steep, [0, 40], [16, 40]);
    steep.setDrawPlates(0);
    steep.beginDrag(downAt(-32, 40));
    steep.moveDrag(downAt(0, 40));
    expect(steep.dragView()).toMatchObject({ closure: "exact", pieces: 2 });
    expect(steep.dragView()?.blocked?.kind ?? null).toBe("too-steep");
  });

  it("passes over laid track only when the tallest bundled train fits under it", () => {
    const needPlates = Math.ceil((train.heightLdu + trackBundleRailTop()) / PLATE_LDU);
    expect(blockOf(crossOver(needPlates - 1).commit)).toBe("low-clearance");
    const passing = crossOver(needPlates);
    expect(passing.commit).toMatchObject({ laid: 3, refusal: null });
    expect(passing.target.crossings().map((c) => c.gapLdu >= train.heightLdu)).toEqual([true]);
  });

  it("refuses a pier that would stand on laid track", () => {
    const { target } = trackedTable(field());
    lay(target, [-24, 0], [24, 0]);
    target.setDrawPlates(60);
    expect(blockOf(lay(target, [0, -16], [0, 16]))).toBe("pier-blocked");
  });
});

function trackBundleRailTop(): number {
  return drawingOn(new SupportGrid()).railTopLdu;
}
