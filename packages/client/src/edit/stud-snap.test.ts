import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type CompiledPartGlb,
  type IAssetFetcher,
  type ImportContext,
  type IPartBundleLoader,
  type ModelBundle,
  type PartBundle,
  type PartFilter,
} from "@brr/catalog";
import { STUD_LDU } from "@brr/math";
import type { BundleLod, BundleManifest } from "@brr/schema/bundle";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type EdgeMarker,
  type ISceneBackend,
  type LookSettings,
  type RebaseEvent,
} from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { EDITOR } from "../tokens.ts";
import type { GhostCheckView, IEditor } from "./editor.ts";
import { STUD_SNAP_RADIUS_STUDS } from "./stud-snap.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const STATION = "2150-1";
const BASEPLATE = "ldraw:3811";
const NDC_TO_LDU = 10_000;
const RAY_START_Y = 1000;
const NO_LOOK: LookSettings = {
  plastic: false,
  gtao: false,
  outlines: false,
  bevel: false,
  shadows: false,
  oit: false,
};
const SWEEP_STUDS = 48;

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

class ModelSubsetLoader implements IPartBundleLoader {
  constructor(
    private readonly loader: IPartBundleLoader,
    private readonly models: ReadonlyArray<string>,
  ) {}

  loadManifest(lod: BundleLod): Promise<BundleManifest> {
    return this.loader.loadManifest(lod);
  }

  async load(lod: BundleLod, include: PartFilter): Promise<PartBundle> {
    const bundle = await this.loader.load(lod, include);
    return { ...bundle, models: bundle.models.filter((m) => this.models.includes(m.name)) };
  }

  loadModel(lod: BundleLod, name: string): Promise<ModelBundle> {
    return this.loader.loadModel(lod, name);
  }

  importContext(lod: BundleLod): Promise<ImportContext> {
    return this.loader.importContext(lod);
  }

  loadPartSet(
    lod: BundleLod,
    partIds: ReadonlyArray<string>,
    compiled: ReadonlyArray<CompiledPartGlb>,
  ): Promise<PartBundle> {
    return this.loader.loadPartSet(lod, partIds, compiled);
  }
}

class TopDownBackend implements ISceneBackend {
  markers: ReadonlyArray<EdgeMarker> = [];

  async init(): Promise<BackendInfo> {
    return {
      requestedApi: "webgl2",
      activeApi: "webgl2",
      adapter: "none",
      backgroundSrgb: 0,
      look: NO_LOOK,
    };
  }
  setPalette(): void {}
  setChunk(): void {}
  deleteChunk(): void {}
  setGhost(): void {}
  placeGhost(): void {}
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setMarkers(markers: ReadonlyArray<EdgeMarker>): void {
    this.markers = markers;
  }
  setTrackEnds(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  setIssueBoxes(): void {}
  rayThrough(ndcX: number, ndcY: number, out: Float64Array): void {
    out.set([ndcX * NDC_TO_LDU, RAY_START_Y, ndcY * NDC_TO_LDU, 0, -1, 0]);
  }
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

afterEach(() => {
  vi.unstubAllGlobals();
});

async function startEditor(backend: ISceneBackend): Promise<IEditor> {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const realLoader = container.get(PART_BUNDLE_LOADER);
  container
    .rebind(PART_BUNDLE_LOADER)
    .toConstantValue(new ModelSubsetLoader(realLoader, [STATION]));
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK });
  return editor;
}

function hoverAt(editor: IEditor, x: number, z: number): GhostCheckView {
  editor.pointerMove(x / NDC_TO_LDU, z / NDC_TO_LDU);
  const ghost = editor.snapshot().ghost;
  if (!ghost) throw new Error("no ghost while an item is held");
  return ghost;
}

function padCells(markers: ReadonlyArray<EdgeMarker>): number {
  let cells = 0;
  for (const { kind, box } of markers) {
    if (kind === "joined") cells += Math.round((box.maxX - box.minX) / STUD_LDU);
  }
  return cells;
}

it("snaps a held model to the nearest pose within reach whose anti-studs meet studs, previews those studs, and places it there", async () => {
  const backend = new TopDownBackend();
  const editor = await startEditor(backend);
  expect(editor.snapshot().error).toBeNull();
  editor.chooseItem(BASEPLATE);
  editor.pointerMove(0, 0);
  editor.click(0, 0, 0);
  expect(editor.snapshot().placements).toBe(1);

  editor.chooseItem(`omr:${STATION}`);
  const sweep = Array.from({ length: SWEEP_STUDS }, (_, k) => {
    const z = k * STUD_LDU;
    const ghost = hoverAt(editor, 0, z);
    return { z, ghost, hover: editor.snapshot().hover, pads: padCells(backend.markers) };
  });

  expect(sweep.map(({ pads }) => pads)).toEqual(sweep.map(({ ghost }) => ghost.studsEngaged));
  expect(sweep.filter(({ ghost }) => ghost.refusal === null && ghost.studsEngaged === 0)).toEqual(
    [],
  );
  expect(sweep.map(({ hover }) => hover && [hover.x, hover.z])).toEqual(
    sweep.map(({ z, ghost }) => {
      const [dx, dz] = ghost.snappedStuds ?? [0, 0];
      return [dx * STUD_LDU, z + dz * STUD_LDU];
    }),
  );

  const placeableAsAimed = new Set(
    sweep.filter(({ ghost }) => ghost.refusal === null && !ghost.snappedStuds).map(({ z }) => z),
  );
  const snaps = sweep.flatMap(({ z, ghost }) => (ghost.snappedStuds ? [{ z, ghost }] : []));
  expect(snaps.length).toBeGreaterThan(0);
  expect(snaps.filter(({ ghost }) => ghost.refusal !== null)).toEqual([]);
  for (const { z, ghost } of snaps) {
    const [dx, dz] = ghost.snappedStuds ?? [0, 0];
    const reach = Math.hypot(dx, dz);
    expect(reach).toBeLessThanOrEqual(STUD_SNAP_RADIUS_STUDS);
    const nearer = [...placeableAsAimed].filter((other) => Math.abs(other - z) / STUD_LDU < reach);
    expect(nearer).toEqual([]);
  }
  expect(sweep.at(-1)?.ghost.refusal?.rule).toBe("first-layer");

  const firstSnap = sweep.find(({ ghost }) => ghost.snappedStuds !== null);
  if (!firstSnap) throw new Error("no snapped pose in the sweep");
  editor.click(0, firstSnap.z / NDC_TO_LDU, 0);
  expect(editor.snapshot().placements).toBe(2);
  const { refs, placements } = editor.dump();
  const station = placements.refId.findIndex((ref) => refs[ref] === `omr:${STATION}`);
  expect([placements.x[station], placements.z[station]]).toEqual([
    firstSnap.hover?.x,
    firstSnap.hover?.z,
  ]);
}, 120_000);
