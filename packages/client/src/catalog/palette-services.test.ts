import { ASSET_FETCHER, PART_BUNDLE_LOADER, type IAssetFetcher } from "@brr/catalog";
import {
  SCENE_BACKEND,
  THUMBNAIL_RENDERER,
  type BackendInfo,
  type BufferMemory,
  type ISceneBackend,
  type IThumbnailRenderer,
  type LookSettings,
  type RebaseEvent,
  type ThumbnailRequest,
} from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { TRACK_ITEM_ID, TRACK_PIECE_PREFIX, type IEditor } from "../edit/editor.ts";
import type { MeshCounts } from "../edit/mesh-progress.ts";
import type { CatalogItemView } from "./placeable-catalog.ts";
import {
  EDITOR,
  PALETTE_DRAG,
  PALETTE_MEMORY,
  PALETTE_MEMORY_STORE,
  PALETTE_PREFETCH,
  PALETTE_SEARCH,
  PALETTE_THUMBNAILS,
} from "../tokens.ts";
import { EMPTY_PALETTE_MEMORY } from "./palette-memory.ts";
import type { IPaletteSearch, PaletteSearchSnapshot, PaletteSection } from "./palette-search.ts";
import { chosen, settledChoice } from "../edit/editor-choice.test-support.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const NO_LOOK: LookSettings = {
  plastic: false,
  gtao: false,
  outlines: false,
  bevel: false,
  shadows: false,
  oit: false,
};
const RAY_HEIGHT_LDU = 10_000;
const STRAIGHT_9V = "74746";
const BASEPLATE_32 = "3811";
const GREEN_BASEPLATE = "ldraw:3811@2";
const CROSSROADS = "ldraw:44343p03@72";
const SET = "omr:7936-1";
const WHITE = 15;
const MADE_IN_WHITE = [
  "ldraw:4186",
  "ldraw:3811",
  "ldraw:3857",
  "ldraw:3867",
  "ldraw:4187",
  "ldraw:3865",
];
const NOT_MADE_IN_WHITE = ["ldraw:3334", "ldraw:3497"];

class BundleDirectoryFetcher implements IAssetFetcher {
  readonly paths: string[] = [];

  async bytes(path: string): Promise<ArrayBuffer> {
    this.paths.push(path);
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    this.paths.push(path);
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

class HeadlessBackend implements ISceneBackend {
  private aimX = 0;
  private aimZ = 0;
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
  setSelectionBox(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setPlanOverlays(): void {}
  setIssueBoxes(): void {}
  aim(x: number, z: number): void {
    this.aimX = x;
    this.aimZ = z;
  }
  rayThrough(_ndcX: number, _ndcY: number, out: Float64Array): void {
    out.set([this.aimX, RAY_HEIGHT_LDU, this.aimZ, 0, -1, 0]);
  }
  setVehicle(): void {}
  setVehiclePose(): void {}
  deleteVehicle(): void {}
  setView(): void {}
  resize(): void {}
  renderFrame(): void {}
  needsFrame(): boolean {
    return true;
  }
  async waitForGpu(): Promise<void> {}
  bufferMemory(): BufferMemory {
    return { vertexIndexBytes: 0, otherBytes: 0 };
  }
  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return [];
  }
  forceTier(): void {}
  setFarModel(): void {}
}

class RecordingThumbnailRenderer implements IThumbnailRenderer {
  readonly drawn: Array<{ readonly instances: number; readonly detailedMeshes: MeshCounts }> = [];

  constructor(private readonly editor: IEditor) {}

  async renderThumbnail(request: ThumbnailRequest): Promise<string> {
    this.drawn.push({
      instances: request.model.count,
      detailedMeshes: this.editor.snapshot().meshes.detailedPartMeshes,
    });
    return `thumbnail-${this.drawn.length}`;
  }
}

async function startEditor() {
  const fetcher = new BundleDirectoryFetcher();
  const backend = new HeadlessBackend();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(fetcher);
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  const manifest = await container.get(PART_BUNDLE_LOADER).loadManifest("standard");
  return { container, editor, backend, fetcher, manifest };
}

function hitKeys(snapshot: PaletteSearchSnapshot): ReadonlyArray<string> {
  return snapshot.hits.map((hit) => hit.entry.key);
}

function sectionOf(search: IPaletteSearch, category: PaletteSection["category"]): PaletteSection {
  const found = search.snapshot().sections.find((section) => section.category === category);
  if (!found) throw new Error(`the palette shows no ${category} section`);
  return found;
}

function rowKeys(rows: PaletteSection["rows"]): ReadonlyArray<string> {
  return rows.map((row) => row.entry.key);
}

function capabilities({ draggable, toggleable, listedUnder }: CatalogItemView) {
  return { draggable, toggleable, listedUnder };
}

function placedItems(editor: IEditor): ReadonlyArray<string> {
  const { refs, placements } = editor.dump();
  return placements.refId.map((refId) => refs[refId] ?? `unknown ref ${refId}`);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("palette search over the editor's catalog", () => {
  it("narrows browsing and results to the chosen category while the tabs keep counting every category", async () => {
    const { container } = await startEditor();
    const search = container.get(PALETTE_SEARCH);

    const browsing = search.snapshot();
    expect(browsing.hits).toEqual([]);
    expect(browsing.sections.map((section) => section.category)).toEqual([
      "track",
      "baseplates",
      "road",
      "sets",
    ]);

    search.setTab("road");
    search.setQuery("baseplate");
    const road = search.snapshot();
    expect(road.sections.map((section) => section.category)).toEqual(["road"]);
    expect(road.hits.length).toBeGreaterThan(0);
    expect(road.hits.every((hit) => hit.entry.category === "road")).toBe(true);
    expect(road.counts.get("baseplates")).toBeGreaterThan(0);

    search.setQuery("  ");
    expect(search.snapshot().hits).toEqual([]);
  }, 120_000);

  it("finds the Draw track entry by the part number of a piece it lays, and not by an unrelated part", async () => {
    const { container } = await startEditor();
    const search = container.get(PALETTE_SEARCH);

    search.setQuery(STRAIGHT_9V);
    expect(hitKeys(search.snapshot())).toContain(TRACK_ITEM_ID);
    search.setQuery(BASEPLATE_32);
    expect(hitKeys(search.snapshot())).not.toContain(TRACK_ITEM_ID);
  }, 120_000);
});

describe("find palette", () => {
  it("ranks parts on the palette's own index and opens on the recents the palette memory keeps", async () => {
    const { container } = await startEditor();
    container.rebind(PALETTE_MEMORY_STORE).toConstantValue({
      load: () => ({ ...EMPTY_PALETTE_MEMORY, recents: [CROSSROADS, GREEN_BASEPLATE] }),
      save: () => {},
    });
    const search = container.get(PALETTE_SEARCH);
    const foundItems = (query: string): ReadonlyArray<string> =>
      search
        .snapshot()
        .find(query, () => true)
        .flatMap((result) => (result.kind === "item" ? [result.item.id] : []));

    expect(foundItems("")).toEqual([CROSSROADS, GREEN_BASEPLATE]);
    expect(foundItems(STRAIGHT_9V)).toContain(TRACK_ITEM_ID);
    container.get(PALETTE_MEMORY).forgetRecents();
    expect(foundItems("")).toEqual([]);
  }, 120_000);
});

describe("palette colour and favourites", () => {
  it("folds baseplates not made in the chosen colour away, keeps showing every colour where it isn't offered, and lets search fall back to another colour", async () => {
    const { container } = await startEditor();
    const search = container.get(PALETTE_SEARCH);

    search.chooseColor(WHITE);
    const baseplates = sectionOf(search, "baseplates");
    expect(baseplates.colors.current).toBe(WHITE);
    expect(rowKeys(baseplates.rows)).toEqual(MADE_IN_WHITE);
    expect(baseplates.rows.find((row) => row.entry.key === "ldraw:3811")?.chosen?.id).toBe(
      "ldraw:3811@15",
    );
    expect(rowKeys(baseplates.unmade)).toEqual(NOT_MADE_IN_WHITE);
    expect(baseplates.unmade.map((row) => row.chosen)).toEqual([undefined, undefined]);
    expect(baseplates.unmade.every((row) => row.preview !== undefined)).toBe(true);
    expect(sectionOf(search, "road").colors.current).toBeNull();
    expect(sectionOf(search, "road").unmade).toEqual([]);

    search.setQuery(BASEPLATE_32);
    expect(search.snapshot().hits[0]?.chosen?.id).toBe("ldraw:3811@15");
    search.setQuery("3334");
    const [notInWhite] = search.snapshot().hits;
    expect(notInWhite?.entry.key).toBe("ldraw:3334");
    expect(notInWhite?.chosen).toBeDefined();
    expect(notInWhite?.chosen?.color?.code).not.toBe(WHITE);

    search.chooseColor(null);
    expect(search.snapshot().color).toBeNull();
    expect(sectionOf(search, "baseplates").unmade).toEqual([]);
  }, 120_000);

  it("lists only favourite entries under the favourites tab, with or without a query, and counts them", async () => {
    const { container } = await startEditor();
    const search = container.get(PALETTE_SEARCH);
    const memory = container.get(PALETTE_MEMORY);
    memory.toggleFavorite("ldraw:3811");

    search.setTab("favorites");
    expect(hitKeys(search.snapshot())).toEqual(["ldraw:3811"]);
    memory.toggleFavorite(SET);
    expect(hitKeys(search.snapshot()).toSorted()).toEqual(["ldraw:3811", SET].toSorted());
    expect(search.snapshot().counts.get("favorites")).toBe(2);
    expect(search.snapshot().sections).toEqual([]);
    search.setQuery(BASEPLATE_32);
    expect(hitKeys(search.snapshot())).toEqual(["ldraw:3811"]);
    expect(search.snapshot().counts.get("favorites")).toBe(1);
  }, 120_000);
});

describe("palette prefetch", () => {
  it("fetches a set's record when the pointer rests on it or it takes focus, and not when the pointer passes over it", async () => {
    const { container, fetcher, manifest } = await startEditor();
    const prefetch = container.get(PALETTE_PREFETCH);
    const record = (name: string): string =>
      `standard/${manifest.models.find((model) => model.name === name)?.file}`;
    const [passed, rested, focused] = ["7936-1", "2150-1", "4554-1"].map(record);
    expect(fetcher.paths).not.toContain(passed);
    expect(fetcher.paths).not.toContain(rested);
    expect(fetcher.paths).not.toContain(focused);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    prefetch.pointerEnter("omr:7936-1");
    prefetch.pointerLeave();
    prefetch.pointerEnter("omr:2150-1");
    await vi.waitFor(() => expect(fetcher.paths).toContain(rested));
    prefetch.focus("omr:4554-1");
    await vi.waitFor(() => expect(fetcher.paths).toContain(focused));
    expect(fetcher.paths).not.toContain(passed);
  }, 120_000);
});

describe("palette thumbnails", () => {
  it("draws a set's thumbnail from the set's own model once its detailed meshes are in", async () => {
    const { container, editor } = await startEditor();
    const renderer = new RecordingThumbnailRenderer(editor);
    container.rebind(THUMBNAIL_RENDERER).toConstantValue(renderer);
    const thumbnails = container.get(PALETTE_THUMBNAILS);
    const set = editor.snapshot().catalog.find((item) => item.id === SET);
    if (!set) throw new Error(`the catalog has no ${SET}`);

    thumbnails.request(SET);

    await vi.waitFor(() => expect(thumbnails.snapshot().get(SET)).toBe("thumbnail-1"), {
      timeout: 60_000,
    });
    const meshes = renderer.drawn[0]?.detailedMeshes;
    expect({
      drawings: renderer.drawn.length,
      instances: renderer.drawn[0]?.instances,
      meshesIn: meshes !== undefined && meshes.wanted > 0 && meshes.loaded === meshes.wanted,
    }).toEqual({ drawings: 1, instances: set.parts, meshesIn: true });
  }, 120_000);
});

describe("palette item capabilities", () => {
  it("marks parts draggable and not toggleable, and the track tool and the pieces listed under it toggleable and not draggable", async () => {
    const { editor } = await startEditor();
    const { catalog } = editor.snapshot();
    const item = (id: string): CatalogItemView => {
      const found = catalog.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`the catalog has no ${id}`);
      return found;
    };
    const part = { draggable: true, toggleable: false, listedUnder: null };
    const piece = { draggable: false, toggleable: true, listedUnder: TRACK_ITEM_ID };

    expect(capabilities(item(GREEN_BASEPLATE))).toEqual(part);
    expect(capabilities(item(SET))).toEqual(part);
    expect(capabilities(item(TRACK_ITEM_ID))).toEqual({
      draggable: false,
      toggleable: true,
      listedUnder: null,
    });
    const pieces = catalog.filter((candidate) => candidate.id.startsWith(TRACK_PIECE_PREFIX));
    expect(pieces.length).toBeGreaterThan(0);
    expect(pieces.map(capabilities)).toEqual(pieces.map(() => piece));
    expect(catalog.filter((candidate) => candidate.listedUnder !== null)).toEqual(pieces);
  }, 120_000);
});

describe("palette item labels", () => {
  it("gives each item the short label the recent strip shows", async () => {
    const { editor } = await startEditor();
    const { catalog } = editor.snapshot();
    const shortLabel = (id: string): string | undefined =>
      catalog.find((item) => item.id === id)?.shortLabel;

    expect(shortLabel(GREEN_BASEPLATE)).toBe("3811 32×32");
    expect(shortLabel(SET)).toBe("7936-1 Level Crossing");
    expect(shortLabel(TRACK_ITEM_ID)).toBe("Track");
    const pieces = catalog.filter((item) => item.id.startsWith(TRACK_PIECE_PREFIX));
    expect(pieces.map((item) => item.shortLabel)).toEqual(pieces.map(() => "Track"));
  }, 120_000);
});

describe("palette drag", () => {
  it("places the dragged item where it is dropped, gives back the item picked before, and ignores a drop with no drag", async () => {
    const { container, editor, backend } = await startEditor();
    const drag = container.get(PALETTE_DRAG);
    await chosen(editor, CROSSROADS);

    backend.aim(0, 0);
    drag.start(GREEN_BASEPLATE);
    await settledChoice(editor);
    expect(editor.snapshot().activeItem).toBe(GREEN_BASEPLATE);
    drag.drop(0, 0, 0);
    drag.end();
    expect(placedItems(editor)).toEqual([GREEN_BASEPLATE]);
    expect(editor.snapshot().activeItem).toBe(CROSSROADS);

    backend.aim(2560, 2560);
    drag.drop(0, 0, 0);
    expect(placedItems(editor)).toEqual([GREEN_BASEPLATE]);
  }, 120_000);
});
