import { ASSET_FETCHER, type IAssetFetcher } from "@brr/catalog";
import { STUD_LDU } from "@brr/math";
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
import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { getHeapSpaceStatistics } from "node:v8";
import { mainThreadModules } from "../src/client.module.ts";
import { EDITOR } from "../src/tokens.ts";
import type { IEditor } from "../src/edit/editor.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const RAY_HEIGHT_LDU = 10_000;
const SETTLE_MS = 50;
const PREVIEW_WARMUP = 20;
const PREVIEW_MOVES = 200;
const COMMITS = 5;
const SIDES: ReadonlyArray<number> = [8, 16, 32];
const HELD = [
  { item: "ldraw:3867@2", label: "16 × 16 baseplate, 16-stud grid", gridPresses: 1 },
  { item: "ldraw:3811@2", label: "32 × 32 baseplate, 32-stud grid", gridPresses: 2 },
  { item: "ldraw:44336p04@72", label: "32 × 32 road straight, 32-stud grid", gridPresses: 2 },
] as const;
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

  async text(path: string): Promise<string> {
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

interface Row {
  readonly held: string;
  readonly tiles: number;
  readonly previewUsPerTile: number;
  readonly previewBytesPerMove: number;
  readonly previewBufferBytesPerMove: number;
  readonly previewGcs: number;
  readonly commitUsPerTile: number;
  readonly undoUsPerTile: number;
}

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

function youngGenerationBytes(): number {
  let bytes = 0;
  for (const space of getHeapSpaceStatistics()) {
    if (YOUNG_GENERATION_SPACES.includes(space.space_name)) bytes += space.space_used_size;
  }
  return bytes;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

function median(values: ReadonlyArray<number>): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function startEditor(): Promise<{ editor: IEditor; backend: HeadlessBackend }> {
  const backend = new HeadlessBackend();
  Object.assign(globalThis, { requestAnimationFrame: () => 0 });
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  const { status, error } = editor.snapshot();
  if (status !== "ready") throw new Error(`editor did not start: ${error ?? status}`);
  return { editor, backend };
}

async function hold(editor: IEditor, item: string): Promise<void> {
  editor.chooseItem(item);
  while (editor.snapshot().pendingItem !== null) await settle();
  if (editor.snapshot().activeItem !== item) throw new Error(`could not hold ${item}`);
}

function press(editor: IEditor, backend: HeadlessBackend, x: number, z: number): void {
  backend.aim(x, z);
  editor.pointerMove(0, 0);
  editor.dragStart(0, 0);
}

function moveTo(editor: IEditor, backend: HeadlessBackend, x: number, z: number): void {
  backend.aim(x, z);
  editor.pointerMove(0, 0);
  editor.dragMove(0, 0);
}

async function measure(
  editor: IEditor,
  backend: HeadlessBackend,
  held: string,
  side: number,
): Promise<Row> {
  const reach = editor.snapshot().fillGridStuds * STUD_LDU * side - STUD_LDU;
  press(editor, backend, 0, 0);
  for (let i = 0; i < PREVIEW_WARMUP; i++) {
    const sign = i % 2 === 0 ? 1 : -1;
    moveTo(editor, backend, sign * reach, sign * reach);
  }
  const tiles = editor.snapshot().fillDraft?.wanted ?? 0;
  if (tiles !== side * side) throw new Error(`expected ${side * side} tiles, saw ${tiles}`);
  await settle();
  const gcBefore = collections;
  const bytesBefore = youngGenerationBytes();
  const buffersBefore = process.memoryUsage().arrayBuffers;
  const started = performance.now();
  for (let i = 0; i < PREVIEW_MOVES; i++) {
    const sign = i % 2 === 0 ? 1 : -1;
    moveTo(editor, backend, sign * reach, sign * reach);
  }
  const previewMs = performance.now() - started;
  const bytes = youngGenerationBytes() - bytesBefore;
  const bufferBytes = process.memoryUsage().arrayBuffers - buffersBefore;
  await settle();
  const previewGcs = collections - gcBefore;
  editor.dragEnd(0, 0, 0);
  editor.undo(0);
  const commits: number[] = [];
  const undos: number[] = [];
  for (let c = 0; c < COMMITS; c++) {
    press(editor, backend, 0, 0);
    moveTo(editor, backend, reach, reach);
    const before = editor.snapshot().placements;
    const commitStart = performance.now();
    editor.dragEnd(0, 0, 0);
    commits.push(performance.now() - commitStart);
    if (editor.snapshot().placements - before !== tiles) {
      throw new Error(`the fill placed ${editor.snapshot().placements - before} of ${tiles}`);
    }
    const undoStart = performance.now();
    editor.undo(0);
    undos.push(performance.now() - undoStart);
    if (editor.snapshot().placements !== before) throw new Error("one undo left tiles behind");
  }
  return {
    held,
    tiles,
    previewUsPerTile: ((previewMs / PREVIEW_MOVES) * 1000) / tiles,
    previewBytesPerMove: Math.max(0, bytes) / PREVIEW_MOVES,
    previewBufferBytesPerMove: Math.max(0, bufferBytes) / PREVIEW_MOVES,
    previewGcs,
    commitUsPerTile: (median(commits) * 1000) / tiles,
    undoUsPerTile: (median(undos) * 1000) / tiles,
  };
}

const { editor, backend } = await startEditor();
const rows: Row[] = [];
for (const { item, label, gridPresses } of HELD) {
  await hold(editor, item);
  while (editor.snapshot().fillGridStuds !== 8) editor.cycleFillGrid();
  for (let p = 0; p < gridPresses; p++) editor.cycleFillGrid();
  for (const side of SIDES) rows.push(await measure(editor, backend, label, side));
}
observer.disconnect();
process.stdout.write(
  [
    `cpu: ${cpus()[0]?.model ?? "unknown"} x${cpus().length}, node ${process.version}`,
    `method: the real editor (all client modules, the built part bundle, a headless scene backend) holds each plate and drags a square fill of side² tiles from the origin. Preview: ${PREVIEW_MOVES} drag moves that flip the square across the press, so every move lays and checks every tile again (height, slab clash, road fit against laid road and the fill's earlier tiles, guides, label), after ${PREVIEW_WARMUP} warm-up moves; young-generation bytes, ArrayBuffer backing bytes and GCs are counted over the timed moves. Commit: the release that places every tile as one edit (history, chunk rebuild, plan delta), and the one undo that removes them, medians of ${COMMITS}.`,
    "",
    "| Held | Tiles | Preview µs per tile | Preview heap bytes per move | Preview ArrayBuffer bytes per move | GCs in preview | Commit µs per tile | Undo µs per tile |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map(
      (row) =>
        `| ${row.held} | ${row.tiles} | ${row.previewUsPerTile.toFixed(2)} | ${Math.round(row.previewBytesPerMove)} | ${Math.round(row.previewBufferBytesPerMove)} | ${row.previewGcs} | ${row.commitUsPerTile.toFixed(1)} | ${row.undoUsPerTile.toFixed(1)} |`,
    ),
    "",
  ].join("\n"),
);
