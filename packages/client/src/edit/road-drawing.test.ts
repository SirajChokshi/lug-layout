import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type BricklinkPartCandidates,
  type CatalogCrosswalk,
  type CompiledPartGlb,
  type IAssetFetcher,
  type ImportContext,
  type IPartBundleLoader,
  type ModelBundle,
  type PartBundle,
  type PartFilter,
} from "@brr/catalog";
import type { BundleLod, BundleManifest } from "@brr/schema/bundle";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ISceneBackend,
  type LookSettings,
  type RebaseEvent,
} from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { EDITOR } from "../tokens.ts";
import type { IEditor } from "./editor.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const WORLD_PER_NDC = 10_000;
const EYE_HEIGHT = 1_000;
const TILE = 640;
const NO_LOOK: LookSettings = {
  plastic: false,
  gtao: false,
  outlines: false,
  bevel: false,
  shadows: false,
  oit: false,
};

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

class MilsModulesOnly implements IPartBundleLoader {
  constructor(private readonly loader: IPartBundleLoader) {}

  loadManifest(lod: BundleLod): Promise<BundleManifest> {
    return this.loader.loadManifest(lod);
  }

  async load(lod: BundleLod, include: PartFilter): Promise<PartBundle> {
    const bundle = await this.loader.load(lod, include);
    return { ...bundle, models: bundle.models.filter((m) => m.role === "mils-module") };
  }

  loadModel(lod: BundleLod, name: string): Promise<ModelBundle> {
    return this.loader.loadModel(lod, name);
  }

  loadCrosswalk(lod: BundleLod): Promise<CatalogCrosswalk> {
    return this.loader.loadCrosswalk(lod);
  }

  loadBricklinkParts(lod: BundleLod): Promise<BricklinkPartCandidates> {
    return this.loader.loadBricklinkParts(lod);
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
  setMarkers(): void {}
  setTrackEnds(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  setIssueBoxes(): void {}
  rayThrough(ndcX: number, ndcY: number, out: Float64Array): void {
    out.set([ndcX * WORLD_PER_NDC, EYE_HEIGHT, ndcY * WORLD_PER_NDC, 0, -1, 0]);
  }
  setView(): void {}
  resize(): void {}
  renderFrame(): void {}
  async waitForGpu(): Promise<void> {}
  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return [];
  }
  forceTier(): void {}
  setFarModel(): void {}
  bufferMemory(): BufferMemory {
    return { vertexIndexBytes: 0, otherBytes: 0 };
  }
}

async function startEditor(): Promise<IEditor> {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const realLoader = container.get(PART_BUNDLE_LOADER);
  container.rebind(PART_BUNDLE_LOADER).toConstantValue(new MilsModulesOnly(realLoader));
  container.rebind(SCENE_BACKEND).toConstantValue(new TopDownBackend());
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  return editor;
}

function centre(tile: number): number {
  return TILE / 2 + tile * TILE;
}

function ndc([ix, iz]: readonly [number, number]): readonly [number, number] {
  return [centre(ix) / WORLD_PER_NDC, centre(iz) / WORLD_PER_NDC];
}

function drag(editor: IEditor, tiles: ReadonlyArray<readonly [number, number]>): void {
  const [first, ...rest] = tiles;
  if (!first) return;
  expect(editor.dragStart(...ndc(first))).toBe(true);
  for (const tile of rest) editor.dragMove(...ndc(tile));
  editor.dragEnd(...ndc(tiles.at(-1) ?? first), 0);
}

function kitId(editor: IEditor, matches: (label: string, edge: string) => boolean): string {
  const kit = editor.snapshot().roadKits.find((k) => matches(k.label, k.edge));
  if (!kit) throw new Error("no matching road kit");
  return kit.id;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("draw road", () => {
  let editor: IEditor;
  beforeAll(async () => {
    editor = await startEditor();
  }, 120_000);

  const completeKits = [
    [
      "6-stud Dark Bluish Grey road plates",
      (label: string, edge: string) =>
        label.startsWith("Dark Bluish Grey") && edge === "6 + 20 road + 6",
    ],
    [
      "6-stud Green road plates",
      (label: string, edge: string) => label.startsWith("Green") && edge === "6 + 20 road + 6",
    ],
  ] as const;

  it.each(completeKits)(
    "lays an L stroke of %s that joins on every edge, and undoes it as one step",
    (_, matches) => {
      editor.chooseItem(kitId(editor, matches));
      drag(editor, [
        [0, 0],
        [3, 0],
        [3, 2],
      ]);
      const { roads, placements, history } = editor.snapshot();
      expect(placements).toBe(6);
      expect(roads.mismatchedCells).toBe(0);
      expect(roads.overlaps).toBe(0);
      expect(roads.joinedCells).toBeGreaterThan(0);
      expect(history.undo).toBe("road");
      editor.undo(0);
      expect(editor.snapshot().placements).toBe(0);
      editor.chooseItem(null);
    },
  );

  it("swaps a straight for a T-junction when a branch is drawn off it", () => {
    editor.chooseItem(kitId(editor, completeKits[1][1]));
    drag(editor, [
      [0, 0],
      [4, 0],
    ]);
    drag(editor, [
      [2, 0],
      [2, 2],
    ]);
    const { roadPlacements, roads } = editor.dump();
    const branch = roadPlacements.find((p) => p.x === centre(2) && p.z === centre(0));
    expect(branch?.item).toBe("ldraw:44341p01@2");
    expect(roadPlacements).toHaveLength(7);
    expect(roads.mismatchedCells).toBe(0);
    editor.undo(0);
    expect(
      editor.dump().roadPlacements.find((p) => p.x === centre(2) && p.z === centre(0))?.item,
    ).toBe("ldraw:44336p01@2");
    editor.undo(0);
    editor.chooseItem(null);
  });

  it("re-plans a stroke against the world as it is at release when undo or redo ran during the drag", () => {
    editor.chooseItem(kitId(editor, completeKits[0][1]));
    drag(editor, [
      [0, 0],
      [2, 0],
    ]);
    editor.undo(0);
    expect(editor.dragStart(...ndc([0, 0]))).toBe(true);
    editor.dragMove(...ndc([2, 0]));
    editor.redo(0);
    editor.dragEnd(...ndc([2, 0]), 0);
    expect(editor.snapshot().placements).toBe(3);
    expect(editor.snapshot().roads.overlaps).toBe(0);
    editor.undo(0);
    drag(editor, [
      [0, 0],
      [4, 0],
    ]);
    expect(editor.dragStart(...ndc([2, 0]))).toBe(true);
    editor.dragMove(...ndc([2, 2]));
    editor.undo(0);
    expect(() => editor.dragEnd(...ndc([2, 2]), 0)).not.toThrow();
    const { placements, roads } = editor.snapshot();
    expect(placements).toBe(3);
    expect(roads.overlaps).toBe(0);
    expect(roads.mismatchedCells).toBe(0);
    while (editor.snapshot().history.undoDepth > 0) editor.undo(0);
    editor.chooseItem(null);
  });

  it("names every kit distinctly, so two plate families of one colour can't be confused", () => {
    const labels = editor.snapshot().roadKits.map((kit) => kit.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("refuses a tile over a baseplate it can't replace and names the baseplate", () => {
    editor.chooseItem("ldraw:4186@2");
    editor.click(...ndc([0, 0]), 0);
    editor.chooseItem(
      kitId(
        editor,
        (label, edge) => label.startsWith("Dark Bluish Grey") && edge === "6 + 20 road + 6",
      ),
    );
    drag(editor, [
      [-1, 0],
      [2, 0],
    ]);
    const snapshot = editor.snapshot();
    expect(snapshot.placements).toBe(1);
    expect(snapshot.lastRoadStroke?.result).toBe("refused");
    expect(snapshot.lastRoadStroke?.stroke.issues).toContainEqual(
      expect.objectContaining({ problem: "overlap", blocker: expect.stringContaining("4186") }),
    );
    editor.undo(0);
    editor.chooseItem(null);
  });

  it("lays nothing and says why when a stroke needs a curve the kit doesn't have", () => {
    editor.chooseItem(kitId(editor, (_, edge) => edge === "7 + 8 road + 2 + 8 road + 7"));
    drag(editor, [
      [0, 0],
      [2, 0],
      [2, 2],
    ]);
    const snapshot = editor.snapshot();
    expect(snapshot.placements).toBe(0);
    expect(snapshot.lastRoadStroke?.result).toBe("refused");
    expect(snapshot.lastRoadStroke?.stroke.issues).toContainEqual(
      expect.objectContaining({ problem: "no-piece", shape: "curve", x: centre(2), z: centre(0) }),
    );
    editor.chooseItem(null);
  });
});
