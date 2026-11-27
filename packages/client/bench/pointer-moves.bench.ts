import { ASSET_FETCHER, type IAssetFetcher } from "@brr/catalog";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ISceneBackend,
  type LookSettings,
  type RebaseEvent,
} from "@brr/render";
import { INDEXED_DB } from "@brr/storage";
import { IDBFactory } from "fake-indexeddb";
import { Container } from "inversify";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  GCProfiler,
  getHeapSpaceStatistics,
  type GCProfilerResult,
  type HeapSpaceStatistics,
} from "node:v8";
import { mainThreadModules } from "../src/client.module.ts";
import type { IEditor } from "../src/edit/editor.ts";
import type { IStarterFiles } from "../src/starters/starter-files.ts";
import { EDITOR, STARTER_FILES, STARTER_WORLDS } from "../src/tokens.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const startersRoot = new URL("../../../../apps/web/starters/", import.meta.url);
const FIXTURE_STARTER = "station-stop";
const SHELF_WAITS = 500;
const SHELF_WAIT_MS = 10;
const TRACK_ITEM = "track:lego-9v";
const TRAIN_ITEM = "omr:10020-1";
const TRAIN_RUN_Z = 6400;
const TRAIN_RUN = [320, 3520] as const;
const SWITCH_PIECE = /^track-piece:ldraw:7554[12]-/u;
const RAY_HEIGHT_LDU = 10_000;
const TILE_LDU = 640;
const RUN_SPACING_LDU = 640;
const RUN_STEPS_LDU = [-5760, -5120, -4480, -3840];
const FIXTURE_RUNS = 24;
const FIXTURE_SWITCHES = 16;
const SWITCH_GRID = 4;
const SWITCH_SPACING_LDU = 1600;
const CIRCLE_RADIUS_LDU = 2400;
const DEGREES = 360;
const SESSION_DRAGS = 100;
const SESSION_MOVES_PER_DRAG = 200;
const SESSION_REPORT_MOVES = 2_000;
const YOUNG_GENERATION_SPACES: ReadonlyArray<string> = ["new_space", "new_large_object_space"];
const TYPED_ARRAYS = [
  Float64Array,
  Float32Array,
  Int32Array,
  Uint32Array,
  Int16Array,
  Uint16Array,
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
];
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

  text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

class DirectoryStarterFiles implements IStarterFiles {
  private readonly files = readdirSync(fileURLToPath(startersRoot), { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(".json"));

  paths(): ReadonlyArray<string> {
    return this.files;
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(new URL(path, startersRoot)));
  }
}

class AimedBackend implements ISceneBackend {
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
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setGround(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  deleteVehicle(): void {}
  setIssueBoxes(): void {}
  setGuides(): void {}
  projectToNdc(): void {}
  aim(x: number, z: number): void {
    this.aimX = x;
    this.aimZ = z;
  }
  rayThrough(_ndcX: number, _ndcY: number, out: Float64Array): void {
    out[0] = this.aimX;
    out[1] = RAY_HEIGHT_LDU;
    out[2] = this.aimZ;
    out[3] = 0;
    out[4] = -1;
    out[5] = 0;
  }
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

function flag(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
}

function youngBytes(): number {
  let bytes = 0;
  for (const space of getHeapSpaceStatistics()) {
    if (YOUNG_GENERATION_SPACES.includes(space.space_name)) bytes += space.space_used_size;
  }
  return bytes;
}

function youngUsed(spaces: ReadonlyArray<HeapSpaceStatistics>): number {
  let bytes = 0;
  for (const space of spaces) {
    if (YOUNG_GENERATION_SPACES.includes(space.spaceName)) bytes += space.spaceUsedSize;
  }
  return bytes;
}

interface YoungAllocation {
  readonly bytes: number;
  readonly collections: number;
}

function allocatedAcross(
  from: number,
  to: number,
  collections: GCProfilerResult["statistics"],
): YoungAllocation {
  let bytes = 0;
  let segmentStart = from;
  for (const collection of collections) {
    bytes += youngUsed(collection.beforeGC.heapSpaceStatistics) - segmentStart;
    segmentStart = youngUsed(collection.afterGC.heapSpaceStatistics);
  }
  return { bytes: bytes + to - segmentStart, collections: collections.length };
}

function youngAllocatedBy(run: () => void): YoungAllocation {
  const profiler = new GCProfiler();
  profiler.start();
  const before = youngBytes();
  run();
  const after = youngBytes();
  return allocatedAcross(before, after, profiler.stop().statistics);
}

function report(value: object): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function median(values: ReadonlyArray<number>): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const mode = process.argv[2] ?? "held";
const fixture = process.argv.includes("--fixture");
const straightRuns = Number(flag("--straight-runs") ?? (fixture ? FIXTURE_RUNS : 0));
const warmupMoves = Number(flag("--warmup") ?? 400);
const windowMoves = Number(flag("--window") ?? 200);
const windowCount = Number(flag("--windows") ?? 5);
const collect = globalThis.gc;
if (!collect) throw new Error("run with --expose-gc");
const gc: () => void = collect;

Reflect.set(globalThis, "requestAnimationFrame", () => 0);
const container = new Container();
container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
if (fixture) {
  container.rebind(INDEXED_DB).toConstantValue(new IDBFactory());
  container.rebind(STARTER_FILES).toConstantValue(new DirectoryStarterFiles());
}
const backend = new AimedBackend();
container.rebind(SCENE_BACKEND).toConstantValue(backend);
const editor: IEditor = container.get(EDITOR);
const canvas = { clientWidth: 640, clientHeight: 480, dataset: {} } as unknown as HTMLCanvasElement;
await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
async function openStarter(id: string): Promise<void> {
  const starters = container.get(STARTER_WORLDS);
  starters.show();
  for (let wait = 0; wait < SHELF_WAITS && starters.view().shelf !== "ready"; wait++) {
    await new Promise((resolve) => setTimeout(resolve, SHELF_WAIT_MS));
  }
  if (!(await starters.open(id))) throw new Error(`the ${id} starter did not open`);
}

if (fixture) await openStarter(FIXTURE_STARTER);

function aimAt(x: number, z: number): void {
  backend.aim(x, z);
}

function stroke(points: ReadonlyArray<readonly [number, number]>): void {
  const [first, ...rest] = points;
  if (!first) return;
  aimAt(...first);
  editor.dragStart(0, 0);
  for (const point of rest) {
    aimAt(...point);
    editor.dragMove(0, 0);
  }
  editor.dragEnd(0, 0, 1);
}

function switchItem(): string {
  const item = editor.snapshot().catalog.find((entry) => SWITCH_PIECE.test(entry.id));
  if (!item) throw new Error("the catalog has no switch piece");
  return item.id;
}

function roadKitId(): string {
  const kit = editor
    .snapshot()
    .roadKits.find((entry) => entry.label.startsWith("Dark Bluish Grey"));
  if (!kit) throw new Error("no Dark Bluish Grey road kit");
  return kit.id;
}

editor.chooseItem(roadKitId());
stroke([2, 3, 4, 5].map((tile) => [TILE_LDU * tile + TILE_LDU / 2, TILE_LDU * 2 + TILE_LDU / 2]));
editor.chooseItem(TRACK_ITEM);
for (let run = 0; run < straightRuns; run++) {
  const z = -12_800 - run * RUN_SPACING_LDU;
  stroke([[-6400, z], ...RUN_STEPS_LDU.map((x): readonly [number, number] => [x, z])]);
}
if (fixture) {
  editor.chooseItem(switchItem());
  for (let k = 0; k < FIXTURE_SWITCHES; k++) {
    aimAt(
      20_000 + (k % SWITCH_GRID) * SWITCH_SPACING_LDU,
      20_000 + Math.floor(k / SWITCH_GRID) * SWITCH_SPACING_LDU,
    );
    editor.pointerMove(0, 0);
    editor.click(0, 0, 1);
  }
}
editor.chooseItem(null);
const track = editor.snapshot().track;
const laidPieces = (track?.pieces ?? 0) + (track?.modelPieces ?? 0);

function dragFrom(x: number, z: number): void {
  editor.chooseItem(TRACK_ITEM);
  aimAt(x, z);
  editor.dragStart(0, 0);
}

function moves(): (i: number) => void {
  switch (mode) {
    case "held": {
      editor.chooseItem(switchItem());
      return (i) => {
        aimAt(-2560 + (i % 17) * 23.7, -2560 + (i % 11) * 31.3);
        editor.pointerMove(0, 0);
      };
    }
    case "stationary": {
      editor.chooseItem(switchItem());
      return () => {
        aimAt(-2560, -2560);
        editor.pointerMove(0, 0);
      };
    }
    case "train-held":
      return (i) => {
        aimAt(TRAIN_RUN[0] + 400 + (i % 29) * 71.3, TRAIN_RUN_Z + (i % 5) * 3.1);
        editor.pointerMove(0, 0);
      };
    case "track-hover": {
      editor.chooseItem(TRACK_ITEM);
      stroke([
        [320, 6400],
        [1600, 6400],
      ]);
      const ends = editor.dump().trackEnds;
      return (i) => {
        const end = ends[i % ends.length];
        aimAt((end?.xLdu ?? 0) + (i % 5) * 13.1, (end?.zLdu ?? 0) + (i % 3) * 17.7);
        editor.pointerMove(0, 0);
      };
    }
    case "road-hover":
      editor.chooseItem(roadKitId());
      return (i) => {
        aimAt(TILE_LDU * (1 + (i % 7)) + 320, TILE_LDU * (1 + (i % 3)) + 320);
        editor.pointerMove(0, 0);
      };
    case "road-stroke":
      editor.chooseItem(roadKitId());
      aimAt(TILE_LDU * 2 + 320, TILE_LDU * 4 + 320);
      editor.dragStart(0, 0);
      return (i) => {
        const step = i % 12;
        aimAt(TILE_LDU * (2 + (step < 6 ? step : 12 - step)) + 320, TILE_LDU * 4 + 320);
        editor.dragMove(0, 0);
      };
    case "drag":
      dragFrom(320, 6400);
      return (i) => {
        aimAt(320 + (i % 23) * 97.3, 6400 + (i % 7) * 41.9);
        editor.dragMove(0, 0);
      };
    case "drag-circle":
      dragFrom(320, 6400);
      return (i) => {
        const angle = ((i % DEGREES) * Math.PI) / 180;
        aimAt(
          320 + CIRCLE_RADIUS_LDU * Math.cos(angle) + CIRCLE_RADIUS_LDU,
          6400 + CIRCLE_RADIUS_LDU * Math.sin(angle),
        );
        editor.dragMove(0, 0);
      };
    case "drag-join": {
      editor.chooseItem(TRACK_ITEM);
      stroke([
        [320, 6400],
        [1600, 6400],
      ]);
      const [end] = editor.dump().trackEnds.toSorted((a, b) => a.xLdu - b.xLdu);
      if (!end) throw new Error("no open end to join");
      dragFrom(end.xLdu - 1920, end.zLdu - 1280);
      for (let step = 1; step <= 12; step++) {
        aimAt(end.xLdu - 1920 + step * 120, end.zLdu - 1280 + step * 100);
        editor.dragMove(0, 0);
      }
      return (i) => {
        aimAt(end.xLdu + ((i % 5) - 2) * 6.1, end.zLdu + ((i % 3) - 1) * 5.3);
        editor.dragMove(0, 0);
      };
    }
    default:
      throw new Error(`unknown mode ${mode}`);
  }
}

interface Windows {
  readonly bytesPerMove: number[];
  readonly collections: number;
}

function windowBytes(move: (i: number) => void, first: number): Windows {
  const bytesPerMove: number[] = [];
  let collections = 0;
  let i = first;
  const runWindow = (): void => {
    for (let m = 0; m < windowMoves; m++) move(i++);
  };
  for (let w = 0; w < windowCount; w++) {
    gc();
    const young = youngAllocatedBy(runWindow);
    bytesPerMove.push(Math.round(young.bytes / windowMoves));
    collections += young.collections;
  }
  return { bytesPerMove, collections };
}

function countTypedArrayBytes(run: () => void): number {
  let bytes = 0;
  const PlainArrayBuffer = ArrayBuffer;
  for (const constructor of TYPED_ARRAYS) {
    const counting = new Proxy(constructor, {
      construct(target, args, newTarget) {
        const made: object = Reflect.construct(target, args, newTarget);
        if (PlainArrayBuffer.isView(made) && !(args[0] instanceof PlainArrayBuffer)) {
          bytes += made.byteLength;
        }
        return made;
      },
    });
    Object.defineProperty(globalThis, constructor.name, { value: counting, writable: true });
  }
  const countingBuffer = new Proxy(PlainArrayBuffer, {
    construct(target, args, newTarget) {
      const made: object = Reflect.construct(target, args, newTarget);
      if (made instanceof PlainArrayBuffer) bytes += made.byteLength;
      return made;
    },
  });
  Object.defineProperty(globalThis, "ArrayBuffer", { value: countingBuffer, writable: true });
  run();
  return bytes;
}

function measureWindows(move: (i: number) => void): void {
  for (let i = 0; i < warmupMoves; i++) move(i);
  const harness = windowBytes(() => undefined, 0);
  const windows = windowBytes(move, warmupMoves);
  const counted = windowMoves * windowCount;
  let i = warmupMoves + counted;
  const typedArrayBytes = countTypedArrayBytes(() => {
    for (let m = 0; m < counted; m++) move(i++);
  });
  const perMove = windows.bytesPerMove;
  report({
    mode,
    fixture,
    straightRuns,
    warmupMoves,
    laidPieces,
    windowMoves,
    bytesPerMove: median(perMove),
    meanBytesPerMove: Math.round(perMove.reduce((sum, bytes) => sum + bytes, 0) / perMove.length),
    harnessBytesPerMove: median(harness.bytesPerMove),
    collectionsInWindows: windows.collections,
    typedArrayBytesPerMove: Math.round(typedArrayBytes / counted),
    windows: perMove,
  });
}

function measureLongSession(): void {
  let moved = 0;
  let windowStart = 0;
  let profiler: GCProfiler | null = null;
  for (let drag = 0; drag < SESSION_DRAGS; drag++) {
    dragFrom(320, 6400);
    for (let m = 0; m < SESSION_MOVES_PER_DRAG; m++) {
      if (moved % SESSION_REPORT_MOVES === SESSION_REPORT_MOVES - windowMoves) {
        gc();
        profiler = new GCProfiler();
        profiler.start();
        windowStart = youngBytes();
      }
      aimAt(320 + (moved % 23) * 97.3, 6400 + (moved % 7) * 41.9);
      editor.dragMove(0, 0);
      moved++;
      if (moved % SESSION_REPORT_MOVES === 0 && profiler) {
        const windowEnd = youngBytes();
        const young = allocatedAcross(windowStart, windowEnd, profiler.stop().statistics);
        profiler = null;
        gc();
        const retainedHeap = process.memoryUsage().heapUsed;
        const solve = editor.snapshot().track?.solve ?? null;
        report({
          mode,
          moves: moved,
          bytesPerMove: Math.round(young.bytes / windowMoves),
          collectionsInWindow: young.collections,
          retainedHeap,
          solveSamples: solve?.samples ?? 0,
        });
      }
    }
    editor.dragEnd(0, 0, 1);
    editor.undo(1);
  }
}

async function holdTrainOverRails(): Promise<void> {
  editor.chooseItem(TRACK_ITEM);
  stroke([
    [TRAIN_RUN[0], TRAIN_RUN_Z],
    [TRAIN_RUN[1], TRAIN_RUN_Z],
  ]);
  editor.chooseItem(TRAIN_ITEM);
  while (editor.snapshot().pendingItem !== null) {
    await new Promise((resolve) => setTimeout(resolve, SHELF_WAIT_MS));
  }
  aimAt(TRAIN_RUN[0] + 400, TRAIN_RUN_Z);
  editor.pointerMove(0, 0);
  if (editor.snapshot().hover?.onRails !== true) {
    throw new Error(`${TRAIN_ITEM} held over the run does not stand on the rails`);
  }
}

if (mode === "train-held") await holdTrainOverRails();
if (mode === "long-session") measureLongSession();
else measureWindows(moves());
process.exit(0);
