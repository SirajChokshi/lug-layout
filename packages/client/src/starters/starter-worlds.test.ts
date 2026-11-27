import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
  type PartAsset,
  type PartModel,
} from "@brr/catalog";
import { isRot90, rot90Cos, rot90Sin } from "@brr/math";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  INSTANCE_MATRIX_FLOATS,
  type ChunkInstances,
  type ISceneBackend,
  type LookSettings,
  type PartPalette,
  type RebaseEvent,
} from "@brr/render";
import { decode, decodedOrThrow, type Decoded } from "@brr/schema/decode";
import type { PlanArchive } from "@brr/schema/plan";
import { STARTER_SHELF_FILE, StarterShelfV1, starterFilePath } from "@brr/schema/starters";
import {
  CREDITS_FILE,
  MANIFEST_FILE,
  WorldManifestV1,
  WorldShardV1,
  WorldShardV2,
  canonicalJson,
  noteShardEntry,
  shardEntry,
  shardName,
  shardPath,
  worldArchiveFiles,
  worldManifest,
  type ImportedFile,
  type WorldArchive,
  type WorldFiles,
  type WorldHeader,
  type NoteShardV2,
  type WorldIndexEntry,
  type WorldVersionEntry,
} from "@brr/schema/world";
import {
  WORLD_REPOSITORY,
  type IWorldRepository,
  type StoredWorld,
  type WorldChange,
} from "@brr/storage";
import { Container } from "inversify";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import type { IEditor } from "../edit/editor.ts";
import { TRACK_ITEM_ID } from "../edit/track-edit-session.ts";
import { chosen } from "../edit/editor-choice.test-support.ts";
import { WithFixtureModels } from "../edit/fixture-model.test-support.ts";
import { EDITOR, STARTER_FILES, STARTER_WORLDS } from "../tokens.ts";
import type { IStarterFiles } from "./starter-files.ts";
import { sourceInstances, type SourceInstance } from "./source-orientation.test-support.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const shippedStartersRoot = new URL("../../../../apps/web/starters/", import.meta.url);
const NO_LOOK: LookSettings = {
  plastic: false,
  gtao: false,
  outlines: false,
  bevel: false,
  shadows: false,
  oit: false,
};
const RAY_HEIGHT_LDU = 10_000;
const GREEN_BASEPLATE = "ldraw:3811@2";
const LOCOMOTIVE = "omr:10133-1";
const RUN_FROM_X = -800;
const RUN_TO_X = 800;
const RUN_Z = 800;
const DRAG_STEPS = 8;
const SYNTHETIC_BRICK = "brick-2x4";
const LOOP = "loop-and-brick";
const MISSING_PART = "missing-part";
const utf8 = new TextEncoder();

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

interface DrawnVehicle {
  readonly model: ChunkInstances;
  readonly posed: boolean;
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
}

class HeadlessBackend implements ISceneBackend {
  readonly chunks = new Map<number, ChunkInstances>();
  readonly vehicles = new Map<number, DrawnVehicle>();
  readonly partIds: string[] = [];
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
  setPalette(palette: PartPalette): void {
    this.partIds.splice(0, this.partIds.length, ...palette.detailed.parts.map((part) => part.id));
  }
  addParts(parts: ReadonlyArray<PartAsset>): void {
    this.partIds.push(...parts.map((part) => part.id));
  }
  setPartMeshes(): void {}
  setFarStuds(): void {}
  setFarModelMesh(): void {}
  setColors(): void {}
  setChunk(key: number, chunk: ChunkInstances): void {
    this.chunks.set(key, chunk);
  }
  deleteChunk(key: number): void {
    this.chunks.delete(key);
  }
  setNeededMeshListener(): void {}
  setGhost(): void {}
  placeGhost(): void {}
  setGhostVerdict(): void {}
  setSelectionBoxes(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setGround(): void {}
  setGuides(): void {}
  projectToNdc(): void {}
  setPlanOverlays(): void {}
  setIssueBoxes(): void {}
  aim(x: number, z: number): void {
    this.aimX = x;
    this.aimZ = z;
  }
  rayThrough(_ndcX: number, _ndcY: number, out: Float64Array): void {
    out.set([this.aimX, RAY_HEIGHT_LDU, this.aimZ, 0, -1, 0]);
  }
  setVehicle(vehicle: number, model: ChunkInstances): void {
    this.vehicles.set(vehicle, { model, posed: false, yaw: 0, pitch: 0, roll: 0 });
  }
  setVehiclePose(
    vehicle: number,
    _x: number,
    _y: number,
    _z: number,
    yaw: number,
    pitch = 0,
    roll = 0,
  ): void {
    const drawn = this.vehicles.get(vehicle);
    if (!drawn) throw new Error(`vehicle ${vehicle} was posed before it was set`);
    this.vehicles.set(vehicle, { model: drawn.model, posed: true, yaw, pitch, roll });
  }
  deleteVehicle(vehicle: number): void {
    this.vehicles.delete(vehicle);
  }
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

interface MemoryWorld {
  header: WorldHeader;
  readonly shards: Map<string, WorldShardV2>;
  readonly notes: Map<string, NoteShardV2>;
}

class MemoryRepository implements IWorldRepository {
  private readonly worlds = new Map<string, MemoryWorld>();
  private nextId = 1;

  constructor(private readonly archives: IWorldRepository) {}

  private entry(id: string, world: MemoryWorld): WorldIndexEntry {
    const manifest = worldManifest(world.header, [...world.shards.values()].map(shardEntry));
    return {
      id,
      name: world.header.name,
      placements: manifest.placements,
      track: manifest.track,
      shards: manifest.shards.length,
      savedAt: 0,
    };
  }

  async list(): Promise<ReadonlyArray<WorldIndexEntry>> {
    return [...this.worlds].map(([id, world]) => this.entry(id, world));
  }

  async create(
    header: WorldHeader,
    shards: ReadonlyArray<WorldShardV2>,
    notes: ReadonlyArray<NoteShardV2>,
  ): Promise<WorldIndexEntry> {
    const id = `world-${this.nextId++}`;
    this.worlds.set(id, { header, shards: new Map(), notes: new Map() });
    return this.save(id, { header, put: shards, drop: [], putNotes: notes, dropNotes: [] });
  }

  async read(id: string): Promise<Decoded<StoredWorld>> {
    const world = this.worlds.get(id);
    if (!world) return { ok: false, issues: [{ path: id, message: "is not stored" }] };
    const shards = [...world.shards.values()];
    const notes = [...world.notes.values()];
    const manifest = worldManifest(world.header, shards.map(shardEntry), notes.map(noteShardEntry));
    return { ok: true, value: { id, manifest, shards, notes } };
  }

  async save(id: string, change: WorldChange): Promise<WorldIndexEntry> {
    const world = this.worlds.get(id) ?? {
      header: change.header,
      shards: new Map(),
      notes: new Map(),
    };
    world.header = change.header;
    for (const superChunk of change.drop) world.shards.delete(shardName(superChunk));
    for (const shard of change.put) world.shards.set(shardName(shard.superChunk), shard);
    for (const superChunk of change.dropNotes) world.notes.delete(shardName(superChunk));
    for (const shard of change.putNotes) world.notes.set(shardName(shard.superChunk), shard);
    this.worlds.set(id, world);
    return this.entry(id, world);
  }

  async remove(id: string): Promise<void> {
    this.worlds.delete(id);
  }

  async shardFiles(): Promise<never[]> {
    return [];
  }

  packArchive(archive: WorldArchive): Uint8Array {
    return this.archives.packArchive(archive);
  }

  readArchive(bytes: Uint8Array): Promise<Decoded<WorldArchive>> {
    return this.archives.readArchive(bytes);
  }

  readWorldFiles(files: ReadonlyMap<string, Uint8Array>): Promise<Decoded<WorldFiles>> {
    return this.archives.readWorldFiles(files);
  }

  packPlanArchive(archive: PlanArchive): Uint8Array {
    return this.archives.packPlanArchive(archive);
  }

  readPlanArchive(bytes: Uint8Array): Promise<Decoded<PlanArchive>> {
    return this.archives.readPlanArchive(bytes);
  }

  async putImportedFile(): Promise<void> {}

  async importedFile(): Promise<ImportedFile | undefined> {
    return undefined;
  }

  async saveVersion(): Promise<never> {
    throw new Error("this test saves no versions");
  }

  async versions(): Promise<ReadonlyArray<WorldVersionEntry>> {
    return [];
  }

  async readVersion(): Promise<Decoded<StoredWorld>> {
    return { ok: false, issues: [{ path: "version", message: "is not saved in this test" }] };
  }
}

class MemoryStarterFiles implements IStarterFiles {
  constructor(private readonly files: ReadonlyMap<string, Uint8Array>) {}

  paths(): ReadonlyArray<string> {
    return [...this.files.keys()];
  }

  async read(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`no starter file ${path}`);
    return bytes;
  }
}

async function startEditor(starterFiles: ReadonlyMap<string, Uint8Array>) {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const backend = new HeadlessBackend();
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "disclaimer" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const shipped = container.get(PART_BUNDLE_LOADER);
  container
    .rebind(PART_BUNDLE_LOADER)
    .toConstantValue(new WithFixtureModels(shipped, [SYNTHETIC_BRICK]));
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const repository = new MemoryRepository(container.get(WORLD_REPOSITORY));
  container.rebind(WORLD_REPOSITORY).toConstantValue(repository);
  container.rebind(STARTER_FILES).toConstantValue(new MemoryStarterFiles(starterFiles));
  const starters = container.get(STARTER_WORLDS);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  return { container, editor, backend, repository, starters };
}

function placed(editor: IEditor): ReadonlyArray<string> {
  const { refs, placements } = editor.dump();
  return placements.refId
    .map(
      (refId, i) =>
        `${refs[refId] ?? refId} ${placements.x[i]},${placements.z[i]} y${placements.yPlates[i]} r${placements.rot[i]}`,
    )
    .toSorted();
}

interface AuthoredWorld {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly placed: ReadonlyArray<string>;
  readonly trackPieces: number;
  readonly openEnds: number;
  readonly trains: ReadonlyArray<string>;
}

function trainsOf(editor: IEditor): ReadonlyArray<string> {
  return editor.snapshot().trains.map((train) => `${train.item} on rails ${train.onRails}`);
}

async function authorLoopAndBrick(): Promise<AuthoredWorld> {
  const { editor, backend, repository } = await startEditor(new Map());
  expect(await editor.newWorld("Loop and brick")).toBe(true);
  const click = async (item: string, x: number, z: number) => {
    await chosen(editor, item);
    backend.aim(x, z);
    editor.pointerMove(0, 0);
    editor.click(0, 0, 0);
  };
  await click(GREEN_BASEPLATE, 0, 0);
  await click(`generated:${SYNTHETIC_BRICK}`, 0, 0);
  await chosen(editor, TRACK_ITEM_ID);
  backend.aim(RUN_FROM_X, RUN_Z);
  editor.dragStart(0, 0);
  for (let step = 1; step <= DRAG_STEPS; step++) {
    backend.aim(RUN_FROM_X + ((RUN_TO_X - RUN_FROM_X) * step) / DRAG_STEPS, RUN_Z);
    editor.dragMove(0, 0);
  }
  editor.dragEnd(0, 0, 0);
  await click(LOCOMOTIVE, 0, RUN_Z);
  await chosen(editor, null);
  const { track } = editor.snapshot();
  const archive = await repository.readArchive((await editor.exportWorld()).bytes);
  if (!archive.ok) throw new Error("the exported world can't be read back");
  return {
    files: new Map(
      worldArchiveFiles(archive.value)
        .filter((file) => file.name !== CREDITS_FILE)
        .map((file) => [file.name, utf8.encode(file.text)]),
    ),
    placed: placed(editor),
    trackPieces: track?.pieces ?? 0,
    openEnds: track?.openEnds ?? 0,
    trains: trainsOf(editor),
  };
}

function withMissingPart(files: ReadonlyMap<string, Uint8Array>): ReadonlyMap<string, Uint8Array> {
  const decoder = new TextDecoder();
  return new Map(
    [...files].map(([name, bytes]) => {
      if (!name.startsWith("shards/")) return [name, bytes];
      const shard = decodedOrThrow(
        decode(WorldShardV2, JSON.parse(decoder.decode(bytes)), name),
        "the exported shard is invalid",
      );
      const placements = shard.placements.map((p) =>
        p.ref === "ldraw:3811" ? { ...p, ref: "ldraw:99999" } : p,
      );
      return [name, utf8.encode(canonicalJson({ ...shard, placements }))];
    }),
  );
}

function shelfFiles(
  shelf: StarterShelfV1,
  worlds: ReadonlyMap<string, ReadonlyMap<string, Uint8Array>>,
): ReadonlyMap<string, Uint8Array> {
  const files = new Map<string, Uint8Array>([
    [STARTER_SHELF_FILE, utf8.encode(JSON.stringify(shelf))],
  ]);
  for (const [world, worldFiles] of worlds) {
    for (const [name, bytes] of worldFiles) files.set(starterFilePath(world, name), bytes);
  }
  return files;
}

let authored: AuthoredWorld;
let starterFiles: ReadonlyMap<string, Uint8Array>;

beforeAll(async () => {
  authored = await authorLoopAndBrick();
  starterFiles = shelfFiles(
    {
      starters: [
        {
          world: LOOP,
          summary: "A train on a run of track beside a baseplate with a brick on it.",
        },
        { world: MISSING_PART, summary: "The same world, but its baseplate isn't a real part." },
      ],
    },
    new Map([
      [LOOP, authored.files],
      [MISSING_PART, withMissingPart(authored.files)],
    ]),
  );
  vi.unstubAllGlobals();
}, 120_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

it("offers the shelf's starters on a fresh profile and opens one as a new world holding exactly the exported world, a synthetic brick model, drawn track and a train standing on it included", async () => {
  const { editor, repository, starters } = await startEditor(starterFiles);
  await vi.waitFor(() => expect(starters.view().shelf).toBe("ready"));
  const offered = starters.view();

  const opened = await starters.open(LOOP);
  const { world, track } = editor.snapshot();

  expect(authored.placed.some((line) => line.startsWith(`generated:${SYNTHETIC_BRICK} `))).toBe(
    true,
  );
  expect(authored.trackPieces).toBeGreaterThan(0);
  expect(authored.trains).toEqual([`${LOCOMOTIVE} on rails true`]);
  expect({ open: offered.open, starters: offered.starters }).toEqual({
    open: true,
    starters: [
      {
        id: LOOP,
        name: "Loop and brick",
        summary: "A train on a run of track beside a baseplate with a brick on it.",
        placements: authored.placed.length,
        track: authored.trackPieces,
      },
      {
        id: MISSING_PART,
        name: "Loop and brick",
        summary: "The same world, but its baseplate isn't a real part.",
        placements: authored.placed.length,
        track: authored.trackPieces,
      },
    ],
  });
  expect({
    opened,
    welcome: starters.view().open,
    world: world?.name,
    stored: (await repository.list()).map((entry) => entry.name).toSorted(),
    placed: placed(editor),
    trackPieces: track?.pieces,
    openEnds: track?.openEnds,
    trains: trainsOf(editor),
  }).toEqual({
    opened: true,
    welcome: false,
    world: "Loop and brick",
    stored: ["Loop and brick", "World 1"],
    placed: authored.placed,
    trackPieces: authored.trackPieces,
    openEnds: authored.openEnds,
    trains: authored.trains,
  });
}, 120_000);

it("refuses a starter that places a part the bundle doesn't carry, keeps the open world and says why", async () => {
  const { editor, repository, starters } = await startEditor(starterFiles);
  await vi.waitFor(() => expect(starters.view().shelf).toBe("ready"));

  const opened = await starters.open(MISSING_PART);

  expect({
    opened,
    welcome: starters.view().open,
    world: editor.snapshot().world?.name,
    stored: (await repository.list()).map((entry) => entry.name),
  }).toEqual({ opened: false, welcome: true, world: "World 1", stored: ["World 1"] });
  expect(starters.view().error).toContain("ldraw:99999");
}, 120_000);

it("offers the starters for each world that opens empty, not again after Start empty or for a world with models, and whenever asked", async () => {
  const { editor, starters } = await startEditor(starterFiles);
  const states: Array<readonly [string, boolean]> = [["fresh profile", starters.view().open]];
  starters.dismiss();
  states.push(["start empty", starters.view().open]);
  await vi.waitFor(() => expect(starters.view().shelf).toBe("ready"));
  expect(await starters.open(LOOP)).toBe(true);
  const loop = editor.snapshot().world?.id;
  states.push(["starter opened", starters.view().open]);
  expect(await editor.newWorld("Blank")).toBe(true);
  states.push(["new world", starters.view().open]);
  if (!loop) throw new Error("the starter world has no id");
  expect(await editor.openWorld(loop)).toBe(true);
  states.push(["world with models", starters.view().open]);
  starters.show();
  states.push(["asked", starters.view().open]);

  expect(states).toEqual([
    ["fresh profile", true],
    ["start empty", false],
    ["starter opened", false],
    ["new world", true],
    ["world with models", false],
    ["asked", true],
  ]);
}, 120_000);

const AXES = 3;
const ROW_FLOATS = 4;
const IDENTITY_ORIENTATION: Orientation = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const REPRESENTATION_ERROR = 1e-6;
const LISTED_MISMATCHES = 5;
const PART_REF = /^ldraw:/u;
const OMR_REF = /^omr:(?<name>.+)$/u;
const STANDARD = "standard";

type Orientation = ReadonlyArray<number>;

interface StarterOrientations {
  readonly world: string;
  readonly missing: ReadonlyArray<string>;
  readonly unexpected: ReadonlyArray<string>;
  readonly drawn: ReadonlyArray<number>;
  readonly sources: number;
  readonly unposed: number;
}

interface ModelSource {
  readonly partIds: ReadonlyArray<string>;
  readonly model: PartModel;
  readonly source: ReadonlyArray<SourceInstance>;
}

interface RigidBodySource {
  readonly parts: string;
  readonly orientations: ReadonlyArray<Orientation>;
}

async function shippedStarterFiles(): Promise<ReadonlyMap<string, Uint8Array>> {
  const root = fileURLToPath(shippedStartersRoot);
  const files = new Map<string, Uint8Array>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(root, path).split(sep).join("/"), await readFile(path));
  }
  return files;
}

function jsonFile(files: ReadonlyMap<string, Uint8Array>, path: string): unknown {
  const bytes = files.get(path);
  if (!bytes) throw new Error(`no shipped starter file ${path}`);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function orientationAt(matrices: Float32Array, instance: number): number[] {
  const out: number[] = [];
  for (let row = 0; row < AXES; row++) {
    for (let column = 0; column < AXES; column++) {
      out.push(matrices[instance * INSTANCE_MATRIX_FLOATS + row * ROW_FLOATS + column] ?? 0);
    }
  }
  return out;
}

function quarterTurned(orientation: Orientation, rot: number): number[] {
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn`);
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  const out: number[] = [];
  for (let column = 0; column < AXES; column++) {
    const x = orientation[column] ?? 0;
    const z = orientation[2 * AXES + column] ?? 0;
    out[column] = cos * x + sin * z;
    out[AXES + column] = orientation[AXES + column] ?? 0;
    out[2 * AXES + column] = -sin * x + cos * z;
  }
  return out;
}

function product(a: Orientation, b: Orientation): number[] {
  const out: number[] = [];
  for (let row = 0; row < AXES; row++) {
    for (let column = 0; column < AXES; column++) {
      let value = 0;
      for (let k = 0; k < AXES; k++) {
        value += (a[row * AXES + k] ?? 0) * (b[k * AXES + column] ?? 0);
      }
      out.push(value);
    }
  }
  return out;
}

function inverse(m: Orientation): number[] {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0, i = 0] = m;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    (e * i - f * h) / determinant,
    (c * h - b * i) / determinant,
    (b * f - c * e) / determinant,
    (f * g - d * i) / determinant,
    (a * i - c * g) / determinant,
    (c * d - a * f) / determinant,
    (d * h - e * g) / determinant,
    (b * g - a * h) / determinant,
    (a * e - b * d) / determinant,
  ];
}

function headingTurn(yaw: number): number[] {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return [cos, 0, -sin, 0, 1, 0, sin, 0, cos];
}

function within(a: Orientation, b: Orientation): boolean {
  return a.every((value, k) => Math.abs(value - (b[k] ?? 0)) <= REPRESENTATION_ERROR);
}

function isTurnAboutUp(turn: Orientation): boolean {
  const [xx = 0, xy = 0, xz = 0, yx = 0, yy = 0, yz = 0, zx = 0, zy = 0, zz = 0] = turn;
  return within(
    [xy, yx, yz, zy, yy, xx - zz, xz + zx, xx * xx + xz * xz],
    [0, 0, 0, 0, 1, 0, 0, 1],
  );
}

function movedRigidly(drawn: ReadonlyArray<Orientation>, source: RigidBodySource): boolean {
  const [first, firstSource] = [drawn[0], source.orientations[0]];
  if (!first || !firstSource || drawn.length !== source.orientations.length) return false;
  const turn = product(first, inverse(firstSource));
  return (
    isTurnAboutUp(turn) &&
    drawn.every((orientation, k) =>
      within(orientation, product(turn, source.orientations[k] ?? IDENTITY_ORIENTATION)),
    )
  );
}

function orientationKey(partId: string, orientation: Orientation): string {
  return `${partId} ${orientation.map((value) => String(value + 0)).join(" ")}`;
}

function tally(keys: ReadonlyArray<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

function surplus(more: Map<string, number>, fewer: Map<string, number>): ReadonlyArray<string> {
  return [...more]
    .filter(([key, count]) => count > (fewer.get(key) ?? 0))
    .map(([key, count]) => `${count - (fewer.get(key) ?? 0)}× ${key}`)
    .slice(0, LISTED_MISMATCHES);
}

async function modelSource(container: Container, name: string): Promise<ModelSource> {
  const { bundle, entry, model } = await container
    .get(PART_BUNDLE_LOADER)
    .loadModel(STANDARD, name);
  const source = await sourceInstances(entry);
  const partIds = Array.from(model.partIndex, (part) => bundle.parts[part]?.id ?? "");
  const walked = source.map((instance) => instance.partId);
  if (walked.join(" ") !== partIds.join(" ")) {
    throw new Error(`walking ${name}'s source file doesn't give the parts its bake draws`);
  }
  return { partIds, model, source };
}

function omrModelName(ref: string): string | null {
  return OMR_REF.exec(ref)?.groups?.["name"] ?? null;
}

async function sourcePlacedParts(
  container: Container,
  shards: ReadonlyArray<WorldShardV1>,
): Promise<ReadonlyArray<string>> {
  const keys: string[] = [];
  for (const placement of shards.flatMap((shard) => shard.placements)) {
    const name = omrModelName(placement.ref);
    if (name !== null) {
      const { source } = await modelSource(container, name);
      for (const instance of source) {
        const stored = instance.orientation.map((value) => Math.fround(value));
        keys.push(orientationKey(instance.partId, quarterTurned(stored, placement.rot)));
      }
    } else if (PART_REF.test(placement.ref)) {
      keys.push(orientationKey(placement.ref, quarterTurned(IDENTITY_ORIENTATION, placement.rot)));
    } else {
      throw new Error(`starter placement ${placement.ref} is neither an OMR model nor a part`);
    }
  }
  return keys;
}

function drawnPlacedParts(
  backend: HeadlessBackend,
  shards: ReadonlyArray<WorldShardV1>,
): ReadonlyArray<string> {
  const laidTrack = new Set(shards.flatMap((shard) => shard.track.map((piece) => piece.ref)));
  const keys: string[] = [];
  for (const chunk of backend.chunks.values()) {
    for (let i = 0; i < chunk.count; i++) {
      const partId = backend.partIds[chunk.partIndex[i] ?? 0] ?? "";
      if (!laidTrack.has(partId))
        keys.push(orientationKey(partId, orientationAt(chunk.matrices, i)));
    }
  }
  return keys;
}

function rigidBodySource(
  instances: ArrayLike<number>,
  { partIds, source }: ModelSource,
): RigidBodySource {
  return {
    parts: Array.from(instances, (i) => partIds[i] ?? "").join(" "),
    orientations: Array.from(instances, (i) => source[i]?.orientation ?? []),
  };
}

async function consistSources(
  container: Container,
  manifest: WorldManifestV1,
): Promise<ReadonlyArray<RigidBodySource>> {
  const bodies: RigidBodySource[] = [];
  for (const consist of manifest.consists ?? []) {
    const name = omrModelName(consist.ref);
    if (name === null) throw new Error(`consist ${consist.ref} is not an OMR model`);
    const walked = await modelSource(container, name);
    const riding = new Set<number>();
    for (const vehicle of walked.model.vehicles) {
      for (const instances of [vehicle.body, ...vehicle.bogies.map((bogie) => bogie.instances)]) {
        for (const i of instances) riding.add(i);
        bodies.push(rigidBodySource(instances, walked));
      }
    }
    const beside = walked.source.flatMap((_, i) => (riding.has(i) ? [] : [i]));
    if (beside.length > 0) bodies.push(rigidBodySource(beside, walked));
  }
  return bodies;
}

function unmatchedVehicles(
  backend: HeadlessBackend,
  sources: ReadonlyArray<RigidBodySource>,
): { readonly drawn: ReadonlyArray<number>; readonly sources: number; readonly unposed: number } {
  const open = [...sources];
  const drawn: number[] = [];
  let unposed = 0;
  for (const [id, vehicle] of backend.vehicles) {
    if (!vehicle.posed || vehicle.pitch !== 0 || vehicle.roll !== 0) unposed++;
    const parts = Array.from(vehicle.model.partIndex, (p) => backend.partIds[p] ?? "").join(" ");
    const turn = headingTurn(vehicle.yaw);
    const orientations = Array.from({ length: vehicle.model.count }, (_, k) =>
      product(turn, orientationAt(vehicle.model.matrices, k)),
    );
    const at = open.findIndex(
      (source) => source.parts === parts && movedRigidly(orientations, source),
    );
    if (at < 0) drawn.push(id);
    else open.splice(at, 1);
  }
  return { drawn, sources: open.length, unposed };
}

it("draws every shipped starter's parts in the orientations their pinned LDraw sources give them, mirrored parts, standing trains and the figures beside them included", async () => {
  const files = await shippedStarterFiles();
  const shelf = decodedOrThrow(
    decode(StarterShelfV1, jsonFile(files, STARTER_SHELF_FILE), STARTER_SHELF_FILE),
    "the shipped shelf is invalid",
  );
  const results: StarterOrientations[] = [];
  for (const { world } of shelf.starters) {
    const manifestPath = starterFilePath(world, MANIFEST_FILE);
    const manifest = decodedOrThrow(
      decode(WorldManifestV1, jsonFile(files, manifestPath), manifestPath),
      `${world}'s manifest is invalid`,
    );
    const shards = manifest.shards.map((entry) => {
      const path = starterFilePath(world, shardPath(entry.superChunk));
      return decodedOrThrow(
        decode(WorldShardV1, jsonFile(files, path), path),
        `${path} is invalid`,
      );
    });
    const { container, backend, starters } = await startEditor(files);
    await vi.waitFor(() => expect(starters.view().shelf).toBe("ready"));
    expect(await starters.open(world)).toBe(true);
    const expected = tally(await sourcePlacedParts(container, shards));
    const drawn = tally(drawnPlacedParts(backend, shards));
    const vehicles = unmatchedVehicles(backend, await consistSources(container, manifest));
    results.push({
      world,
      missing: surplus(expected, drawn),
      unexpected: surplus(drawn, expected),
      ...vehicles,
    });
  }

  expect(results).toEqual(
    shelf.starters.map(({ world }) => ({
      world,
      missing: [],
      unexpected: [],
      drawn: [],
      sources: 0,
      unposed: 0,
    })),
  );
}, 600_000);
