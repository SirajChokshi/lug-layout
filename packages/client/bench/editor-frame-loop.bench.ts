import { ASSET_FETCHER, type IAssetFetcher } from "@brr/catalog";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ISceneBackend,
  type LookSettings,
  type RebaseEvent,
} from "@brr/render";
import { Container } from "inversify";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { getHeapSpaceStatistics } from "node:v8";
import type { IEditorCamera } from "../src/camera/editor-camera.ts";
import { mainThreadModules } from "../src/client.module.ts";
import type { IEditor } from "../src/edit/editor.ts";
import { TRACK_ITEM_ID } from "../src/edit/track-edit-session.ts";
import { EDITOR, EDITOR_CAMERA } from "../src/tokens.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const WINDOW_FRAMES = 2_000;
const WINDOWS = 5;
const PROBE_FRAMES = 1;
const PROBE_WARMUP_WINDOWS = 3;
const WARMUP_FRAMES = 200_000;
const CLOCK_CALLS_PER_MS = 64;
const ATTEMPTS = 3;
const ORBIT_STEP_PX = 1;
const SETTLE_MS = 50;
const YOUNG_GENERATION_SPACES: ReadonlyArray<string> = ["new_space", "new_large_object_space"];
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

class FrameBackend implements ISceneBackend {
  needed = true;
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
  rayThrough(): void {}
  setView(): void {}
  resize(): void {}
  renderFrame(): void {}
  needsFrame(): boolean {
    return this.needed;
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

interface Row {
  readonly label: string;
  readonly needed: boolean;
  readonly moving: boolean;
  readonly item: string | null;
}

interface Measured {
  readonly smallestWindowBytes: number;
  readonly largestWindowBytes: number;
  readonly collections: number;
  readonly microsPerFrame: number;
}

const ROWS: ReadonlyArray<Row> = [
  { label: "still camera, the backend needs a frame", needed: true, moving: false, item: null },
  { label: "still camera, the backend needs no frame", needed: false, moving: false, item: null },
  {
    label: "camera orbiting every frame, the backend needs a frame",
    needed: true,
    moving: true,
    item: null,
  },
  {
    label: "track tool chosen and its loop scan finished, the backend needs a frame",
    needed: true,
    moving: false,
    item: TRACK_ITEM_ID,
  },
];

let scheduled: FrameRequestCallback | null = null;
const realNow = performance.now.bind(performance);
const clock = { startMs: 0, calls: 0 };

function wholeMillisecondNow(): number {
  clock.calls++;
  return clock.startMs + ((clock.calls / CLOCK_CALLS_PER_MS) | 0);
}

function useWholeMillisecondClock(): void {
  clock.startMs = Math.ceil(realNow());
  Object.defineProperty(performance, "now", {
    configurable: true,
    writable: true,
    value: wholeMillisecondNow,
  });
}

function scheduleFrame(callback: FrameRequestCallback): number {
  scheduled = callback;
  return 0;
}

function pump(frames: number, camera: IEditorCamera, moving: boolean): void {
  for (let i = 0; i < frames; i++) {
    if (moving) camera.orbit(ORBIT_STEP_PX, 0);
    const callback = scheduled;
    if (callback === null) throw new Error("the frame loop stopped scheduling frames");
    scheduled = null;
    callback(0);
  }
}

function youngGenerationBytes(): number {
  let bytes = 0;
  for (const space of getHeapSpaceStatistics()) {
    if (YOUNG_GENERATION_SPACES.includes(space.space_name)) bytes += space.space_used_size;
  }
  return bytes;
}

function windowBytes(frames: number, camera: IEditorCamera, moving: boolean): number {
  const before = youngGenerationBytes();
  pump(frames, camera, moving);
  return youngGenerationBytes() - before;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

async function startEditor(backend: FrameBackend) {
  Object.assign(globalThis, { requestAnimationFrame: scheduleFrame });
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 1280,
    clientHeight: 800,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  const { status, error } = editor.snapshot();
  if (status !== "ready") throw new Error(`editor did not start: ${error ?? status}`);
  const camera = container.get(EDITOR_CAMERA);
  pump(1, camera, false);
  await settle();
  return { editor, camera };
}

function pumpUntilStatsPublished(editor: IEditor, camera: IEditorCamera, moving: boolean): void {
  const before = editor.snapshot().stats;
  while (editor.snapshot().stats === before) pump(1, camera, moving);
}

async function measureOnce(
  editor: IEditor,
  camera: IEditorCamera,
  row: Row,
): Promise<Measured | null> {
  const collectGarbage = gc;
  if (!collectGarbage) throw new Error("the frame-loop bench runs with --expose-gc");
  pump(WARMUP_FRAMES, camera, row.moving);
  await settle();
  collectGarbage();
  const collectionStarts: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) collectionStarts.push(entry.startTime);
  });
  observer.observe({ entryTypes: ["gc"] });
  pump(2, camera, row.moving);
  for (let window = 0; window < PROBE_WARMUP_WINDOWS; window++) {
    windowBytes(PROBE_FRAMES, camera, row.moving);
  }
  const windowAllocations = new Float64Array(WINDOWS);
  pumpUntilStatsPublished(editor, camera, row.moving);
  const statsBefore = editor.snapshot().stats;
  const startMs = realNow();
  const probe = windowBytes(PROBE_FRAMES, camera, row.moving);
  for (let window = 0; window < WINDOWS; window++) {
    windowAllocations[window] = windowBytes(WINDOW_FRAMES, camera, row.moving) - probe;
  }
  const endMs = realNow();
  const crossedPublication = editor.snapshot().stats !== statsBefore;
  await settle();
  observer.disconnect();
  if (crossedPublication) return null;
  return {
    smallestWindowBytes: Math.min(...windowAllocations),
    largestWindowBytes: Math.max(...windowAllocations),
    collections: collectionStarts.filter((at) => at >= startMs && at <= endMs).length,
    microsPerFrame: ((endMs - startMs) * 1000) / (WINDOWS * WINDOW_FRAMES + PROBE_FRAMES),
  };
}

async function measureRow(
  editor: IEditor,
  camera: IEditorCamera,
  backend: FrameBackend,
  row: Row,
): Promise<Measured> {
  backend.needed = row.needed;
  const yawBefore = camera.savedView().yaw;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const measured = await measureOnce(editor, camera, row);
    if (measured === null) continue;
    if (row.moving && camera.savedView().yaw === yawBefore) {
      throw new Error(`${row.label}: the camera did not move`);
    }
    return measured;
  }
  throw new Error(`${row.label}: every window crossed a stats publication`);
}

async function measureInThisProcess(row: Row): Promise<Measured> {
  const backend = new FrameBackend();
  const { editor, camera } = await startEditor(backend);
  if (row.item !== null) editor.chooseItem(row.item);
  if (editor.snapshot().activeItem !== row.item) throw new Error(`${row.label}: not chosen`);
  useWholeMillisecondClock();
  return measureRow(editor, camera, backend, row);
}

function measureInChildProcess(rowIndex: number): Measured {
  const child = spawnSync(
    process.execPath,
    [...process.execArgv, "--expose-gc", fileURLToPath(import.meta.url), String(rowIndex)],
    { encoding: "utf8" },
  );
  if (child.status !== 0) throw new Error(`bench row ${rowIndex} failed: ${child.stderr}`);
  return JSON.parse(child.stdout) as Measured;
}

const childRow = process.argv[2];
if (childRow !== undefined) {
  const row = ROWS[Number(childRow)];
  if (!row) throw new Error(`no bench row ${childRow}`);
  process.stdout.write(JSON.stringify(await measureInThisProcess(row)));
  process.exit(0);
} else {
  const failures: string[] = [];
  const lines = ROWS.map((row, index) => {
    const { smallestWindowBytes, largestWindowBytes, collections, microsPerFrame } =
      measureInChildProcess(index);
    if (smallestWindowBytes !== 0 || collections !== 0) {
      failures.push(
        `${row.label}: ${smallestWindowBytes} bytes in its smallest window, ${collections} collections`,
      );
    }
    return `| ${row.label} | ${WINDOWS} × ${WINDOW_FRAMES.toLocaleString("en-US")} | ${microsPerFrame.toFixed(2)} | ${collections} | ${smallestWindowBytes} | ${largestWindowBytes} |`;
  });
  process.stdout.write(
    [
      `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}, each row in its own process`,
      "",
      "Editor frames through IEditor on a headless backend, each window inside one stats interval.",
      "requestAnimationFrame and performance.now are allocation-free stand-ins. Node's performance.now allocates on every call; the stand-in returns whole milliseconds, which V8 never boxes.",
      "| frames | windows × frames | µs/frame | GCs during windows | bytes in the smallest window | bytes in the largest window |",
      "|---|---|---|---|---|---|",
      ...lines,
      "",
    ].join("\n"),
  );
  if (failures.length > 0) {
    process.stderr.write(`frames allocated:\n${failures.join("\n")}\n`);
    process.exitCode = 1;
  }
}
