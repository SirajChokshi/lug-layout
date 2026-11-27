import {
  ASSET_FETCHER,
  CATALOG_API_BASE_URL,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
} from "@brr/catalog";
import { BUNDLE_POINTER_FILE } from "@brr/schema/bundle-pointer";
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
import type { IEditor } from "../edit/editor.ts";
import { TRACK_ITEM_ID, TRACK_PIECE_PREFIX } from "../edit/track-edit-session.ts";
import { heldItem } from "../edit/held-item.ts";
import type { MeshCounts } from "../edit/mesh-progress.ts";
import { loadCatalogItem } from "./catalog-item.test-support.ts";
import type { CatalogItemView } from "./placeable-catalog.ts";
import {
  COMMAND_PALETTE_SEARCH,
  CONNECTOR_TABLES,
  EDITOR,
  HOTBAR,
  LIBRARY_FILTER_STORE,
  LIBRARY_PART_PLACER,
  MODEL_IMPORTER,
  PALETTE_DRAG,
  PALETTE_MEMORY,
  PALETTE_MEMORY_STORE,
  PALETTE_PREFETCH,
  PALETTE_SEARCH,
  PALETTE_THUMBNAILS,
  PLACEABLE_CATALOG,
} from "../tokens.ts";
import { LibraryFilters, type ILibraryFilterStore } from "./library-filters.ts";
import { EMPTY_PALETTE_MEMORY } from "./palette-memory.ts";
import type { IPaletteSearch, PaletteSearchSnapshot, PaletteSection } from "./palette-search.ts";
import { chosen } from "../edit/editor-choice.test-support.ts";
import type { IModelImporter } from "../import/worker-model-importer.ts";
import type { ICommandPaletteSearch } from "../commands/command-palette-search.ts";
import type { ImportResult, RollingDiagnosticsRows } from "@brr/import";

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
const RED = 4;
const BRICK_2_X_4 = "3001";
const WORKER_UNREACHABLE = "the import worker is unreachable";
const PUBLISHED_KEY = "0123456789abcdef";
const PUBLISHED_MANIFEST = `manifest.${PUBLISHED_KEY}.json`;
const CATALOG_WORKER = "https://catalog.test";

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

class PublishedBundleFetcher extends BundleDirectoryFetcher {
  override async text(path: string): Promise<string> {
    if (path === BUNDLE_POINTER_FILE) return JSON.stringify({ manifestFile: PUBLISHED_MANIFEST });
    return super.text(path.replace(PUBLISHED_MANIFEST, "manifest.json"));
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
  setSelectionBoxes(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setGround(): void {}
  setPlanOverlays(): void {}
  setIssueBoxes(): void {}
  setGuides(): void {}
  projectToNdc(): void {}
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

async function startEditor(configure: (container: Container) => void = () => {}) {
  const fetcher = new BundleDirectoryFetcher();
  const backend = new HeadlessBackend();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(fetcher);
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  configure(container);
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

function foundItems(search: ICommandPaletteSearch, query: string): ReadonlyArray<string> {
  return search
    .snapshot()
    .find(query, () => true)
    .flatMap((result) => (result.kind === "item" ? [result.item.id] : []));
}

function libraryIds(search: IPaletteSearch): ReadonlyArray<string> {
  return search.snapshot().library?.hits.map((hit) => hit.part.id) ?? [];
}

class UnreachableWorkerImporter implements IModelImporter {
  readonly files: Array<{ readonly name: string; readonly text: string }> = [];

  async importText(name: string, text: string): Promise<ImportResult> {
    this.files.push({ name, text });
    throw new Error(WORKER_UNREACHABLE);
  }

  async importStudio(name: string): Promise<ImportResult> {
    this.files.push({ name, text: "" });
    throw new Error(WORKER_UNREACHABLE);
  }

  async rollingDiagnostics(): Promise<RollingDiagnosticsRows> {
    throw new Error(WORKER_UNREACHABLE);
  }
}

class InMemoryFilterStore implements ILibraryFilterStore {
  private saved = LibraryFilters.DEFAULT;

  load(): LibraryFilters {
    return this.saved;
  }

  save(filters: LibraryFilters): void {
    this.saved = filters;
  }
}

function workerAnswering(ids: ReadonlyArray<string>): Array<string | null> {
  const asked: Array<string | null> = [];
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input);
    if (url.origin !== CATALOG_WORKER || url.pathname !== `/v1/bundles/${PUBLISHED_KEY}/search`) {
      throw new Error(`unexpected request ${input}`);
    }
    const query = url.searchParams.get("q");
    asked.push(query);
    const results = ids.map((id) => ({
      id,
      label: id,
      section: id === CROSSROADS ? "road" : "baseplates",
      kind: id === CROSSROADS ? "road-plate" : "baseplate",
      file: null,
    }));
    return new Response(JSON.stringify({ manifest: PUBLISHED_KEY, query, results }));
  });
  return asked;
}

function withCatalogWorker(loading: Container): void {
  loading.rebind(ASSET_FETCHER).toConstantValue(new PublishedBundleFetcher());
  loading.bind(CATALOG_API_BASE_URL).toConstantValue(CATALOG_WORKER);
}

function shownItems(search: IPaletteSearch): ReadonlyArray<string> {
  return search.snapshot().hits.flatMap((hit) => hit.items.map((item) => item.id));
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

  it("searches each tab with its own words and colour when searching per tab, counts each tab under its own search, and brings them back after a restart", async () => {
    const store = new InMemoryFilterStore();
    const withStore = (loading: Container): void => {
      loading.rebind(LIBRARY_FILTER_STORE).toConstantValue(store);
    };
    const { container } = await startEditor(withStore);
    const search = container.get(PALETTE_SEARCH);
    const unfiltered = search.snapshot().counts;

    search.setScope("per-tab");
    search.setTab("baseplates");
    search.setQuery(BASEPLATE_32);
    search.chooseColor(WHITE);
    search.setTab("track");
    search.setQuery(STRAIGHT_9V);
    const track = search.snapshot();
    search.setTab("baseplates");
    const baseplates = search.snapshot();

    expect(track.query).toBe(STRAIGHT_9V);
    expect(hitKeys(track)).toContain(TRACK_ITEM_ID);
    expect(track.hits.every((hit) => hit.entry.category === "track")).toBe(true);
    expect([...track.filteredTabs].toSorted()).toEqual(["baseplates", "track"]);
    expect({ query: baseplates.query, color: baseplates.color }).toEqual({
      query: BASEPLATE_32,
      color: WHITE,
    });
    expect(baseplates.hits.map((hit) => [hit.entry.key, hit.chosen?.id])).toEqual([
      ["ldraw:3811", "ldraw:3811@15"],
    ]);
    expect([...baseplates.counts]).toEqual([
      ["all", unfiltered.get("all")],
      ["favorites", 0],
      ["track", track.counts.get("track")],
      ["baseplates", 1],
      ["road", unfiltered.get("road")],
      ["sets", unfiltered.get("sets")],
    ]);

    const restarted = (await startEditor(withStore)).container.get(PALETTE_SEARCH).snapshot();
    expect({
      scope: restarted.scope,
      tab: restarted.tab,
      query: restarted.query,
      color: restarted.color,
      hits: hitKeys(restarted),
    }).toEqual({
      scope: "per-tab",
      tab: "baseplates",
      query: BASEPLATE_32,
      color: WHITE,
      hits: ["ldraw:3811"],
    });
  }, 120_000);

  it("asks the catalog Worker only for the words a part must have, and keeps none of its hits that a minus rules out, in the library and the find palette", async () => {
    const asked = workerAnswering([GREEN_BASEPLATE, CROSSROADS]);
    const { container } = await startEditor(withCatalogWorker);
    const library = container.get(PALETTE_SEARCH);
    const find = container.get(COMMAND_PALETTE_SEARCH);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const query = `${BASEPLATE_32} -green`;

    library.setQuery(query);
    find.search(query);
    await vi.waitFor(() => expect(library.snapshot().status).toBe("ready"));
    await vi.waitFor(() => expect(foundItems(find, query)).toContain(CROSSROADS));

    expect(asked).toEqual([BASEPLATE_32, BASEPLATE_32]);
    expect(shownItems(library)).toContain(CROSSROADS);
    expect(shownItems(library)).toContain("ldraw:3811@15");
    expect(shownItems(library)).not.toContain(GREEN_BASEPLATE);
    expect(foundItems(find, query)).not.toContain(GREEN_BASEPLATE);
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
    const search = container.get(COMMAND_PALETTE_SEARCH);

    expect(foundItems(search, "")).toEqual([CROSSROADS, GREEN_BASEPLATE]);
    expect(foundItems(search, STRAIGHT_9V)).toContain(TRACK_ITEM_ID);
    container.get(PALETTE_MEMORY).forgetRecents();
    expect(foundItems(search, "")).toEqual([]);
  }, 120_000);

  it("asks the catalog Worker for its own query beside the library's, and lists the Worker's hits after its own matches once they arrive", async () => {
    const asked = workerAnswering([GREEN_BASEPLATE]);
    const { container } = await startEditor(withCatalogWorker);
    const library = container.get(PALETTE_SEARCH);
    const find = container.get(COMMAND_PALETTE_SEARCH);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    library.setQuery(BASEPLATE_32);
    find.search("crossroads");
    const local = foundItems(find, "crossroads");
    await vi.waitFor(() => expect(library.snapshot().status).toBe("ready"));
    await vi.waitFor(() => expect(foundItems(find, "crossroads")).toContain(GREEN_BASEPLATE));

    expect(asked).toEqual([BASEPLATE_32, "crossroads"]);
    expect(local).toContain(CROSSROADS);
    expect(local).not.toContain(GREEN_BASEPLATE);
    expect(foundItems(find, "crossroads")).toEqual([...local, GREEN_BASEPLATE]);
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

  it("reads a set's connectors while it holds focus, so picking it places it without waiting", async () => {
    const { container, editor } = await startEditor();
    const tables = container.get(CONNECTOR_TABLES);

    container.get(PALETTE_PREFETCH).focus(SET);
    const set = await loadCatalogItem(container.get(PLACEABLE_CATALOG), SET);
    await vi.waitFor(() => expect(tables.loaded(set)).not.toBeNull(), { timeout: 60_000 });
    editor.chooseItem(SET);

    expect(heldItem(editor.snapshot())).toEqual({ item: SET, tables: "ready", queued: null });
  }, 120_000);

  it("asks for the bundle's two connector packs as the editor starts, so picking a set fetches no other connector file", async () => {
    const connectorFile = /\/(?:connectivity|connectors?)-[^/]+\.json$/u;
    const { editor, fetcher, manifest } = await startEditor();
    const { connectorPacks } = manifest;
    const packs = [connectorPacks?.connectivity.file, connectorPacks?.connectors.file].map(
      (file) => `standard/${file}`,
    );

    await vi.waitFor(() => expect(fetcher.paths).toEqual(expect.arrayContaining(packs)), {
      timeout: 60_000,
    });
    await chosen(editor, SET);

    expect({
      connectorFiles: fetcher.paths.filter((path) => connectorFile.test(path)).toSorted(),
      held: heldItem(editor.snapshot()),
    }).toEqual({
      connectorFiles: packs.toSorted(),
      held: { item: SET, tables: "ready", queued: null },
    });
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
  it("marks parts draggable and not toggleable, and each track tool and the pieces listed under them toggleable and not draggable", async () => {
    const { editor } = await startEditor();
    const { catalog } = editor.snapshot();
    const item = (id: string): CatalogItemView => {
      const found = catalog.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`the catalog has no ${id}`);
      return found;
    };
    const part = { draggable: true, toggleable: false, listedUnder: null };
    const tools = catalog.filter(
      (candidate) => candidate.kind === "track" && candidate.listedUnder === null,
    );
    const toolIds = new Set(tools.map((tool) => tool.id));

    expect(capabilities(item(GREEN_BASEPLATE))).toEqual(part);
    expect(capabilities(item(SET))).toEqual(part);
    expect(tools.map(capabilities)).toEqual(
      tools.map(() => ({ draggable: false, toggleable: true, listedUnder: null })),
    );
    expect(toolIds.has(TRACK_ITEM_ID)).toBe(true);
    const pieces = catalog.filter((candidate) => candidate.id.startsWith(TRACK_PIECE_PREFIX));
    expect(pieces.length).toBeGreaterThan(0);
    expect(
      pieces.map((candidate) => {
        const { listedUnder, ...rest } = capabilities(candidate);
        return { ...rest, underATool: listedUnder !== null && toolIds.has(listedUnder) };
      }),
    ).toEqual(pieces.map(() => ({ draggable: false, toggleable: true, underATool: true })));
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
    expect(shortLabel(`${TRACK_PIECE_PREFIX}ldraw:74746`)).toBe("Train Track 9V Straight");
    const pieces = catalog.filter((item) => item.id.startsWith(TRACK_PIECE_PREFIX));
    expect(new Set(pieces.map((item) => item.shortLabel)).size).toBe(pieces.length);
  }, 120_000);
});

describe("palette drag", () => {
  it("places the dragged item where it is dropped, even before it has loaded, gives back the item picked before, and ignores a drop with no drag", async () => {
    const { container, editor, backend } = await startEditor();
    const drag = container.get(PALETTE_DRAG);
    await chosen(editor, CROSSROADS);

    backend.aim(0, 0);
    drag.start(GREEN_BASEPLATE);
    const pending = editor.snapshot().pendingItem;
    drag.drop(0, 0, 0);
    drag.end();
    const beforeLoad = placedItems(editor);
    await vi.waitFor(() => expect(editor.snapshot().activeItem).toBe(CROSSROADS));
    expect({ pending, beforeLoad, placed: placedItems(editor) }).toEqual({
      pending: GREEN_BASEPLATE,
      beforeLoad: [],
      placed: [GREEN_BASEPLATE],
    });

    backend.aim(2560, 2560);
    drag.drop(0, 0, 0);
    expect(placedItems(editor)).toEqual([GREEN_BASEPLATE]);
  }, 120_000);
});

describe("hotbar", () => {
  it("gives each part the editor picks its own slot, keeps it through a deselect, and picks it again by slot", async () => {
    const { container, editor } = await startEditor();
    const hotbar = container.get(HOTBAR);
    const slots = (): ReadonlyArray<string> => hotbar.snapshot().slots.map((slot) => slot.item);

    editor.chooseItem(GREEN_BASEPLATE);
    editor.chooseItem(SET);
    editor.chooseItem(TRACK_ITEM_ID);
    editor.chooseItem(null);
    editor.chooseItem(GREEN_BASEPLATE);
    expect(slots()).toEqual([GREEN_BASEPLATE, SET, TRACK_ITEM_ID]);

    hotbar.pick(1);
    expect(editor.snapshot().activeItem).toBe(SET);
    hotbar.pick(5);
    expect(editor.snapshot().activeItem).toBe(SET);
    expect(slots()).toEqual([GREEN_BASEPLATE, SET, TRACK_ITEM_ID]);
  }, 120_000);
});

describe("parts library", () => {
  it("falls back to the pinned library's single parts on the All tab, ranked by their own titles, without the parts the palette already offers", async () => {
    const { container } = await startEditor();
    const search = container.get(PALETTE_SEARCH);

    search.setQuery("brick 2 x 4");
    expect(search.snapshot().library?.status).toBe("loading");
    await vi.waitFor(() => expect(search.snapshot().library?.status).toBe("ready"));
    const [first] = search.snapshot().library?.hits ?? [];
    expect(first?.part).toMatchObject({ id: BRICK_2_X_4, title: "Brick 2 x 4", category: "Brick" });
    expect(first?.colors.map((color) => color.code)).toContain(RED);

    search.setQuery("baseplate 32 x 32");
    expect(libraryIds(search).length).toBeGreaterThan(0);
    expect(libraryIds(search)).not.toContain(BASEPLATE_32);

    search.setTab("road");
    expect(search.snapshot().library).toBeNull();
  }, 120_000);

  it("hands the editor's import a one-part LDraw file of the picked part in the picked colour, and keeps the failure on that part", async () => {
    const importer = new UnreachableWorkerImporter();
    const { container } = await startEditor((loading) =>
      loading.rebind(MODEL_IMPORTER).toConstantValue(importer),
    );
    const search = container.get(PALETTE_SEARCH);
    const placer = container.get(LIBRARY_PART_PLACER);
    search.setQuery("brick 2 x 4");
    await vi.waitFor(() => expect(search.snapshot().library?.status).toBe("ready"));
    const [hit] = search.snapshot().library?.hits ?? [];
    const red = hit?.colors.find((color) => color.code === RED);
    if (!hit || !red) throw new Error("the library offers no red 2 x 4 brick");

    expect(await placer.place(hit.part, red)).toBe(false);

    expect(importer.files).toEqual([
      { name: "3001 Brick 2 x 4 in Red.ldr", text: "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n" },
    ]);
    expect(placer.view()).toEqual({
      pending: null,
      refused: {
        part: BRICK_2_X_4,
        color: RED,
        reason: `model import failed: ${WORKER_UNREACHABLE}`,
      },
    });
  }, 120_000);
});
