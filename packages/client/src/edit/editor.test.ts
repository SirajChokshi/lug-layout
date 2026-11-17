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
import type { BundleLod, BundleManifest } from "@brr/schema/bundle";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ISceneBackend,
  type RebaseEvent,
} from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { SHIPPED_STARTER_LAYOUTS, type StarterLayout } from "../starters/starter-layouts.ts";
import { EDITOR, STARTER_LAYOUTS } from "../tokens.ts";
import { TRACK_ITEM_ID, type IEditor } from "./editor.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const PLACEABLE_SET = "7936-1";
const STUDLESS_SET = "10016-1";
const TOP_DOWN_SPAN_LDU = 4000;
const BASEPLATE_PART = "ldraw:3811";

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

class HeadlessBackend implements ISceneBackend {
  async init(): Promise<BackendInfo> {
    return { requestedApi: "webgl2", activeApi: "webgl2", adapter: "none", backgroundSrgb: 0 };
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
  rayThrough(ndcX: number, ndcY: number, out: Float64Array): void {
    out.set([ndcX * TOP_DOWN_SPAN_LDU, TOP_DOWN_SPAN_LDU, ndcY * TOP_DOWN_SPAN_LDU, 0, -1, 0]);
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

const canvas = {
  clientWidth: 640,
  clientHeight: 480,
  dataset: {},
} as unknown as HTMLCanvasElement;

async function startEditor(
  models: ReadonlyArray<string> = [PLACEABLE_SET, STUDLESS_SET],
  starters: ReadonlyArray<StarterLayout> = SHIPPED_STARTER_LAYOUTS,
) {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const realLoader = container.get(PART_BUNDLE_LOADER);
  container.rebind(PART_BUNDLE_LOADER).toConstantValue(new ModelSubsetLoader(realLoader, models));
  container.rebind(SCENE_BACKEND).toConstantValue(new HeadlessBackend());
  container.rebind(STARTER_LAYOUTS).toConstantValue(starters);
  const editor = container.get(EDITOR);
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1 });
  return { editor, manifest: await realLoader.loadManifest("standard") };
}

function ndcOf(xLdu: number, zLdu: number): readonly [number, number] {
  return [xLdu / TOP_DOWN_SPAN_LDU, zLdu / TOP_DOWN_SPAN_LDU];
}

it("starts with a stud-less set in the bundle, leaving it out of the catalog and reporting it as skipped", async () => {
  const { editor } = await startEditor();

  const snapshot = editor.snapshot();
  expect(snapshot.error).toBeNull();
  expect(snapshot.status).toBe("ready");
  const ids = snapshot.catalog.map((item) => item.id);
  expect(ids).toContain(`omr:${PLACEABLE_SET}`);
  expect(ids).not.toContain(`omr:${STUDLESS_SET}`);
  expect(snapshot.catalogSkipped).toEqual([
    { name: STUDLESS_SET, reason: "no stud lattice from the bake" },
  ]);
  expect(snapshot.credits?.models.map((credit) => credit.name)).toContain(STUDLESS_SET);
}, 120_000);

it("offers every baseplate and road plate in exactly the produced colours the bundle lists", async () => {
  const { editor, manifest } = await startEditor();

  const { catalog } = editor.snapshot();
  const catalogParts = manifest.parts.filter((p) => p.role === "ground" || p.role === "road");
  expect(catalogParts.length).toBeGreaterThan(0);
  const offered = catalogParts.map((part) => [
    part.id,
    catalog.filter((item) => item.group === part.id).map((item) => item.color?.code),
  ]);
  const produced = catalogParts.map((part) => [
    part.id,
    part.producedColors?.colors.map((color) => color.ldraw),
  ]);
  expect(offered).toEqual(produced);
}, 120_000);

function layoutState(editor: IEditor): unknown {
  const dump = editor.dump();
  const rows = dump.placements.refId.map((refId, i) =>
    [
      dump.refs[refId],
      dump.placements.colorId[i],
      dump.placements.x[i],
      dump.placements.z[i],
      dump.placements.yPlates[i],
      dump.placements.rot[i],
    ].join(","),
  );
  const track = editor.snapshot().track;
  return {
    placements: rows.toSorted(),
    track: dump.track,
    openEnds: track?.openEnds,
    joins: track?.joins,
    studs: dump.studs,
  };
}

it("makes every gesture one undo step, and undo then redo walk back and forth through the exact layouts", async () => {
  const { editor } = await startEditor([]);
  const states = [layoutState(editor)];
  let time = 0;
  const gesture = (act: () => void): void => {
    const depth = editor.snapshot().history.undoDepth;
    act();
    expect(editor.snapshot().lastRefusal).toBeNull();
    expect(editor.snapshot().history.undoDepth).toBe(depth + 1);
    states.push(layoutState(editor));
  };
  const click = (x: number, z: number): void => {
    editor.pointerMove(...ndcOf(x, z));
    editor.click(...ndcOf(x, z), time++);
  };
  const drag = (from: readonly [number, number], to: readonly [number, number]): void => {
    editor.pointerMove(...ndcOf(...from));
    expect(editor.dragStart(...ndcOf(...from))).toBe(true);
    editor.dragMove(...ndcOf(...to));
    editor.dragEnd(...ndcOf(...to), time++);
  };

  const baseplate = editor.snapshot().catalog.find((item) => item.group === BASEPLATE_PART)?.id;
  if (!baseplate) throw new Error(`the catalog offers no ${BASEPLATE_PART}`);
  editor.chooseItem(baseplate);
  gesture(() => click(0, 0));
  gesture(() => click(640, 0));
  gesture(() => click(0, 640));
  gesture(() => click(640, 640));
  editor.chooseItem(TRACK_ITEM_ID);
  gesture(() => drag([-320, 0], [320, 0]));
  gesture(() => drag([320, 0], [900, 220]));
  drag([-160, 0], [-160, 0]);
  expect(editor.snapshot().track?.selected).not.toBeNull();
  gesture(() => editor.deleteSelection(time++));
  editor.chooseItem(null);
  click(0, 640);
  expect(editor.snapshot().selection?.item).toBe(baseplate);
  gesture(() => editor.rotate(time++));
  gesture(() => editor.deleteSelection(time++));
  gesture(() => editor.clearWorld(time++));

  for (let step = 1; step < states.length; step++) {
    expect(states[step]).not.toEqual(states[step - 1]);
  }
  for (let depth = states.length - 2; depth >= 0; depth--) {
    editor.undo(time++);
    expect(layoutState(editor)).toEqual(states[depth]);
  }
  expect(editor.snapshot().history.undo).toBeNull();
  for (let depth = 1; depth < states.length; depth++) {
    editor.redo(time++);
    expect(layoutState(editor)).toEqual(states[depth]);
  }
  expect(editor.snapshot().history.redo).toBeNull();
}, 120_000);

const STARTER_MODELS = [
  ...new Set(
    SHIPPED_STARTER_LAYOUTS.flatMap((layout) =>
      layout.pieces.flatMap((piece) => {
        const [source, name] = piece.item.split(":");
        return source === "omr" || source === "generated" ? [name ?? ""] : [];
      }),
    ),
  ),
];

it.each(SHIPPED_STARTER_LAYOUTS.map((layout) => [layout.id]))(
  "loads starter %s as one undoable command, unrefused, with its track joined and no road mismatch",
  async (id) => {
    const { editor } = await startEditor(STARTER_MODELS);
    const view = editor.snapshot().starters.find((starter) => starter.id === id);
    expect(view?.problems).toEqual([]);

    editor.loadStarter(id, 0);

    const loaded = editor.snapshot();
    const state = layoutState(editor);
    expect(loaded.refusals).toBe(0);
    expect(loaded.placements).toBe(view?.tiles.length);
    expect(loaded.track?.pieces).toBe(view?.trackPieces);
    expect(loaded.track?.lastCommit).toBe((view?.trackPieces ?? 0) > 0 ? "joined" : null);
    expect(loaded.track?.coincidentEndIssues).toBe(0);
    expect(loaded.roads.mismatchedCells).toBe(0);
    expect(loaded.roads.overlaps).toBe(0);
    expect(loaded.history).toMatchObject({ undoDepth: 1, redoDepth: 0 });

    editor.undo(1);
    expect(editor.snapshot().placements).toBe(0);
    expect(editor.snapshot().track?.pieces).toBe(0);

    editor.redo(2);
    expect(layoutState(editor)).toEqual(state);
  },
  120_000,
);

it("loads a starter only into an empty world", async () => {
  const { editor } = await startEditor(STARTER_MODELS);
  editor.loadStarter("mils-ring", 0);
  const ring = layoutState(editor);

  editor.loadStarter("oval-town", 1);

  expect(layoutState(editor)).toEqual(ring);
  expect(editor.snapshot().history.undoDepth).toBe(1);
}, 120_000);

function shippedStarter(id: string): StarterLayout {
  const layout = SHIPPED_STARTER_LAYOUTS.find((candidate) => candidate.id === id);
  if (!layout) throw new Error(`no shipped starter ${id}`);
  return layout;
}

const crossroads = shippedStarter("crossroads-square");
const ovalTown = shippedStarter("oval-town");
const REFUSED_STARTERS: ReadonlyArray<StarterLayout> = [
  {
    ...crossroads,
    id: "set-on-the-crossroads",
    pieces: [
      ...crossroads.pieces,
      ...crossroads.pieces
        .filter((piece) => piece.item === "omr:10185-1")
        .map((piece) => ({ ...piece, col: 1, row: 1 })),
    ],
  },
  {
    ...ovalTown,
    id: "oval-without-baseplates",
    pieces: ovalTown.pieces.filter((piece) => piece.item !== "ldraw:3811@2" || piece.row > 2),
  },
];

it.each(REFUSED_STARTERS.map((layout) => [layout.id]))(
  "refuses starter %s and leaves the table and both history stacks exactly as they were",
  async (id) => {
    const { editor } = await startEditor(STARTER_MODELS, REFUSED_STARTERS);
    editor.chooseItem("ldraw:3811@2");
    editor.pointerMove(...ndcOf(-2560, -2560));
    editor.click(...ndcOf(-2560, -2560), 0);
    editor.chooseItem(null);
    const placed = layoutState(editor);
    editor.undo(1);
    const before = editor.snapshot();

    editor.loadStarter(id, 2);

    const after = editor.snapshot();
    expect(after.refusals).toBe(before.refusals + 1);
    expect(after.placements).toBe(0);
    expect(after.track?.pieces).toBe(0);
    expect(after.history).toEqual(before.history);
    editor.redo(3);
    expect(layoutState(editor)).toEqual(placed);
  },
  120_000,
);
