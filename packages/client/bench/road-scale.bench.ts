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
import { Session } from "node:inspector/promises";
import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { getHeapSpaceStatistics } from "node:v8";
import { mainThreadModules } from "../src/client.module.ts";
import { EDITOR } from "../src/tokens.ts";
import { MAX_FILL_TILES } from "../src/edit/fill-tool.ts";
import type { IEditor } from "../src/edit/editor.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const RAY_HEIGHT_LDU = 10_000;
const SETTLE_MS = 50;
const ITEM = "ldraw:44336p04@72";
const FIELD = Number(process.env["FIELD"] ?? 16);
const TILE = 640;
const HOVER_CALLS = Number(process.env["HOVER_CALLS"] ?? 400);
const SETS = Number(process.env["SETS"] ?? 4);
const SET_ITEM = "omr:10185-1";
const STROKE_CALLS = 120;
const GATE_WARMUP = 400;
const GATE_MOVES = 100;
const GATE_WINDOWS = 3;
const SAMPLING_BYTES = 64;
const PER_TILE_CHECK = "checkPlacement";
const ROAD_AND_TRACK_CHECKS: ReadonlyArray<string> = [
  "restingYPlatesAt",
  "roadOverlap",
  "modelTrackBlock",
];
const WARMUP = 40;
const NO_LOOK: LookSettings = {
  plastic: false,
  gtao: false,
  outlines: false,
  bevel: false,
  shadows: false,
  oit: false,
};
const YOUNG: ReadonlyArray<string> = ["new_space", "new_large_object_space"];

class Fetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

class Backend implements ISceneBackend {
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
  rayThrough(_x: number, _y: number, out: Float64Array): void {
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

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

let scheduled: FrameRequestCallback | null = null;
function pumpFrame(): void {
  const callback = scheduled;
  scheduled = null;
  callback?.(0);
}

function young(): number {
  let bytes = 0;
  for (const space of getHeapSpaceStatistics()) {
    if (YOUNG.includes(space.space_name)) bytes += space.space_used_size;
  }
  return bytes;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

interface Row {
  readonly name: string;
  readonly calls: number;
  readonly medianUs: number;
  readonly p95Us: number;
  readonly meanUs: number;
  readonly bytesPerCall: number;
  readonly gcs: number;
  readonly note: string;
}
const rows: Row[] = [];

async function time(
  name: string,
  calls: number,
  call: (i: number) => void,
  note: () => string,
): Promise<void> {
  for (let i = 0; i < WARMUP; i++) call(i);
  await settle();
  const samples = new Float64Array(calls);
  const gcBefore = collections;
  const bytesBefore = young();
  for (let i = 0; i < calls; i++) {
    const start = performance.now();
    call(i);
    samples[i] = performance.now() - start;
  }
  const bytes = young() - bytesBefore;
  await settle();
  const gcs = collections - gcBefore;
  const sorted = samples.toSorted();
  let total = 0;
  for (const s of sorted) total += s;
  rows.push({
    name,
    calls,
    medianUs: (sorted[Math.floor(calls / 2)] ?? 0) * 1000,
    p95Us: (sorted[Math.min(calls - 1, Math.ceil(calls * 0.95) - 1)] ?? 0) * 1000,
    meanUs: (total / calls) * 1000,
    bytesPerCall: gcs === 0 ? bytes / calls : Number.NaN,
    gcs,
    note: note(),
  });
}

const backend = new Backend();
Object.assign(globalThis, {
  requestAnimationFrame: (callback: FrameRequestCallback) => {
    scheduled = callback;
    return 0;
  },
});
const container = new Container();
container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
container.rebind(ASSET_FETCHER).toConstantValue(new Fetcher());
container.rebind(SCENE_BACKEND).toConstantValue(backend);
const editor: IEditor = container.get(EDITOR);
await editor.start(
  { clientWidth: 640, clientHeight: 480, dataset: {} } as unknown as HTMLCanvasElement,
  {
    api: "webgl2",
    pixelRatio: 1,
    look: NO_LOOK,
    tier: null,
  },
);
if (editor.snapshot().status !== "ready") throw new Error("editor did not start");

async function hold(item: string): Promise<void> {
  editor.chooseItem(item);
  while (editor.snapshot().pendingItem !== null) await settle();
  if (editor.snapshot().activeItem !== item) throw new Error(`could not hold ${item}`);
}

function move(x: number, z: number): void {
  backend.aim(x, z);
  editor.pointerMove(0, 0);
}

await hold(ITEM);
while (editor.snapshot().fillGridStuds !== 8) editor.cycleFillGrid();
editor.cycleFillGrid();
editor.cycleFillGrid();
const grid = editor.snapshot().fillGridStuds;
if (grid !== 32) throw new Error(`fill grid ${grid}`);
const fieldReach = grid * STUD_LDU * FIELD - STUD_LDU;
const bandRows = Math.floor(MAX_FILL_TILES / FIELD);
for (let row = 0; row < FIELD; row += bandRows) {
  const lastRow = Math.min(FIELD, row + bandRows);
  move(0, row * TILE);
  editor.dragStart(0, 0);
  move(fieldReach, lastRow * TILE - STUD_LDU);
  editor.dragMove(0, 0);
  editor.dragEnd(0, 0, 0);
}
const built = editor.dump().roadPlacements;
if (built.length !== FIELD * FIELD) {
  throw new Error(
    `field laid ${built.length} of ${FIELD * FIELD}: ${editor.snapshot().lastRefusal?.reason}`,
  );
}
let minX = Infinity;
let minZ = Infinity;
for (const p of built) {
  minX = Math.min(minX, p.x);
  minZ = Math.min(minZ, p.z);
}
const centreOf = (column: number, row: number) => ({
  x: minX + column * TILE,
  z: minZ + row * TILE,
});
const half = Math.floor(FIELD / 2);
const mid = centreOf(half, half);

function snapNote(): string {
  const s = editor.snapshot();
  return `snap=${s.snap?.state ?? "none"} overlap=${s.snap?.overlappingCells ?? "-"} refusal=${s.hover?.refusal ? "yes" : "no"}`;
}

const stepHover =
  (x0: number, z0: number, across = 8) =>
  (i: number): void => {
    move(x0 + (i % across) * STUD_LDU, z0 + (Math.floor(i / across) % across) * STUD_LDU);
    pumpFrame();
  };

await time(
  "hover: road plate over the field (rests on placed road)",
  HOVER_CALLS,
  stepHover(mid.x - 80, mid.z - 80),
  snapNote,
);
await time(
  "hover: road plate 1 to 8 studs clear of the field edge",
  HOVER_CALLS,
  stepHover(minX + FIELD * TILE + STUD_LDU, mid.z - 80),
  snapNote,
);

editor.chooseItem(null);
backend.aim(mid.x, mid.z);
editor.toggleSelected(0, 0);
editor.deleteSelection(0);
if (editor.dump().roadPlacements.length !== FIELD * FIELD - 1) throw new Error("hole not cut");
await hold(ITEM);
await time(
  "hover: road plate within a stud of a one-tile hole in the field",
  HOVER_CALLS,
  stepHover(mid.x - STUD_LDU, mid.z - STUD_LDU, 3),
  snapNote,
);
editor.undo(0);
if (editor.dump().roadPlacements.length !== FIELD * FIELD) throw new Error("hole not refilled");

async function fill(
  name: string,
  side: number,
  pressX: number,
  pressZ: number,
  moves: number,
): Promise<void> {
  await hold(ITEM);
  const reach = grid * STUD_LDU * side - STUD_LDU;
  move(pressX, pressZ);
  editor.dragStart(0, 0);
  const flip = (i: number) => {
    const sign = i % 2 === 0 ? 1 : -1;
    move(pressX + sign * reach, pressZ + sign * reach);
    editor.dragMove(0, 0);
  };
  await time(name, moves, flip, () => {
    const d = editor.snapshot().fillDraft;
    return `wanted=${d?.wanted ?? 0} refused=${d?.refused ?? "-"}`;
  });
  editor.cancelGesture();
}

interface ProfileNode {
  readonly id: number;
  readonly callFrame: { readonly functionName: string };
  readonly children: ReadonlyArray<ProfileNode>;
}

interface Sample {
  readonly size: number;
  readonly nodeId: number;
}

function nodesUnder(
  node: ProfileNode,
  frames: ReadonlyArray<string>,
  inside: boolean,
  out: Set<number>,
): void {
  const within = inside || frames.includes(node.callFrame.functionName);
  if (within) out.add(node.id);
  for (const child of node.children) nodesUnder(child, frames, within, out);
}

function nodesWithin(node: ProfileNode, outer: string, out: Set<number>): void {
  if (node.callFrame.functionName === outer) {
    nodesUnder(node, ROAD_AND_TRACK_CHECKS, false, out);
    return;
  }
  for (const child of node.children) nodesWithin(child, outer, out);
}

interface Gate {
  readonly name: string;
  readonly gated: number;
  readonly checks: number;
  readonly wholeMove: number;
}
const gates: Gate[] = [];

const editorMethods: object = Object.getPrototypeOf(editor);
for (const frame of [PER_TILE_CHECK, ...ROAD_AND_TRACK_CHECKS]) {
  if (typeof Reflect.get(editorMethods, frame) !== "function") {
    throw new Error(`the allocation gate watches ${frame}, which the editor no longer has`);
  }
}

async function sampledWindow(name: string, flip: (i: number) => void): Promise<Gate> {
  const session = new Session();
  session.connect();
  await session.post("HeapProfiler.enable");
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: SAMPLING_BYTES,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let i = 0; i < GATE_MOVES; i++) flip(i);
  const stopped: unknown = await session.post("HeapProfiler.stopSampling");
  const { profile } = stopped as {
    readonly profile: { readonly head: ProfileNode; readonly samples: ReadonlyArray<Sample> };
  };
  session.disconnect();
  const gatedNodes = new Set<number>();
  nodesWithin(profile.head, PER_TILE_CHECK, gatedNodes);
  const checkNodes = new Set<number>();
  nodesUnder(profile.head, [PER_TILE_CHECK], false, checkNodes);
  let gated = 0;
  let checks = 0;
  let whole = 0;
  for (const sample of profile.samples) {
    whole += sample.size;
    if (gatedNodes.has(sample.nodeId)) gated += sample.size;
    if (checkNodes.has(sample.nodeId)) checks += sample.size;
  }
  return {
    name,
    gated: gated / GATE_MOVES,
    checks: checks / GATE_MOVES,
    wholeMove: whole / GATE_MOVES,
  };
}

async function sampledFillBytes(
  name: string,
  side: number,
  pressX: number,
  pressZ: number,
): Promise<Gate> {
  await hold(ITEM);
  const reach = grid * STUD_LDU * side - STUD_LDU;
  move(pressX, pressZ);
  editor.dragStart(0, 0);
  const flip = (i: number) => {
    const sign = i % 2 === 0 ? 1 : -1;
    move(pressX + sign * reach, pressZ + sign * reach);
    editor.dragMove(0, 0);
  };
  for (let i = 0; i < GATE_WARMUP; i++) flip(i);
  let cleanest: Gate | null = null;
  for (let window = 0; window < GATE_WINDOWS; window++) {
    const sampled = await sampledWindow(name, flip);
    if (!cleanest || sampled.gated < cleanest.gated) cleanest = sampled;
  }
  editor.cancelGesture();
  if (!cleanest) throw new Error(`${name}: no window was sampled`);
  return cleanest;
}

const fieldCorner = { x: minX - TILE / 2 + half * TILE, z: minZ - TILE / 2 + half * TILE };
await fill(
  "fill preview: 4 x 4 road plates inside the field (16 tiles)",
  4,
  fieldCorner.x,
  fieldCorner.z,
  100,
);
await fill(
  "fill preview: 8 x 8 road plates inside the field (64 tiles)",
  8,
  fieldCorner.x,
  fieldCorner.z,
  60,
);
await fill(
  "fill preview: 8 x 8 road plates on empty ground beside the field (64 tiles)",
  8,
  minX - TILE / 2 - 9 * TILE,
  minZ - TILE / 2 + half * TILE,
  60,
);

const accepted = await sampledFillBytes(
  "fill move: 8 x 8 road plates on empty ground",
  8,
  minX - TILE / 2 - 9 * TILE,
  minZ - TILE / 2 + half * TILE,
);
const refusedTiles = await sampledFillBytes(
  "fill move: 4 x 4 road plates inside the field, every tile refused",
  4,
  fieldCorner.x,
  fieldCorner.z,
);
gates.push(accepted, refusedTiles);
for (const gate of gates) {
  if (gate.gated > 0) {
    throw new Error(
      `${gate.name}: the per-tile road and track checks allocate ${gate.gated} bytes per move; the gate is 0`,
    );
  }
}

async function groupMove(
  name: string,
  block: number,
  dxTiles: number,
  calls: number,
): Promise<void> {
  editor.chooseItem(null);
  for (let r = 0; r < block; r++) {
    for (let c = 0; c < block; c++) {
      const at = centreOf(c, r);
      backend.aim(at.x, at.z);
      editor.toggleSelected(0, 0);
    }
  }
  const picked = editor.snapshot().selection;
  const grab = centreOf(0, 0);
  backend.aim(grab.x, grab.z);
  if (editor.selectDragStart(0, 0, false) !== "move")
    throw new Error(`no move gesture (${JSON.stringify(picked).slice(0, 80)})`);
  await time(
    name,
    calls,
    (i) => {
      backend.aim(grab.x + dxTiles * TILE + (i % 8) * 20, grab.z + ((i >> 3) % 4) * 20 + TILE);
      editor.selectDragMove(0, 0);
    },
    () => {
      const gesture = editor.snapshot().gesture;
      const refused = gesture !== null && gesture.kind !== "box" && gesture.refusal !== null;
      return `refusal=${refused ? "yes" : "no"}`;
    },
  );
  editor.cancelGesture();
  editor.chooseItem(null);
  for (let r = 0; r < block; r++) {
    for (let c = 0; c < block; c++) {
      const at = centreOf(c, r);
      backend.aim(at.x, at.z);
      editor.toggleSelected(0, 0);
    }
  }
}

await groupMove("move gesture: 4 x 4 road plates dragged over the field", 4, half, 200);
await groupMove("move gesture: 8 x 8 road plates dragged over the field", 8, half - 4, 60);
await groupMove("move gesture: 4 x 4 road plates dragged onto empty ground", 4, -8, 200);

await hold(SET_ITEM);
const setsZ = minZ - 3 * TILE;
for (let i = 0; i < SETS; i++) {
  move(minX + i * TILE, setsZ);
  editor.click(0, 0, 0);
}
const setParts = editor.dump().placements.x.length - FIELD * FIELD;
if (setParts !== SETS) throw new Error(`placed ${setParts} of ${SETS} ${SET_ITEM}`);
const kit = editor.snapshot().roadKits.find((k) => k.label.startsWith("Dark Bluish Grey"));
if (!kit) throw new Error("no Dark Bluish Grey road kit");
editor.chooseItem(kit.id);
const strokeZ = setsZ + TILE;
move(minX - TILE, strokeZ);
editor.dragStart(0, 0);
await time(
  `road stroke: 2 to ${SETS + 1} tiles along the front of ${SETS} ${SET_ITEM}`,
  STROKE_CALLS,
  (i) => {
    move(minX + (i % 2 === 0 ? SETS - 1 : 0) * TILE, strokeZ);
    editor.dragMove(0, 0);
  },
  () => {
    const stroke = editor.snapshot().roadStroke;
    return `tiles=${stroke?.tiles ?? 0} issues=${stroke?.issues.length ?? "-"}`;
  },
);
editor.cancelGesture();

observer.disconnect();
process.stdout.write(
  [
    `cpu: ${cpus()[0]?.model ?? "unknown"} x${cpus().length}, node ${process.version}, field ${FIELD} x ${FIELD} = ${FIELD * FIELD} road placements of ${ITEM}, then ${SETS} ${SET_ITEM}`,
    "",
    "| Operation | Calls | Median µs | p95 µs | Mean µs | Young bytes/call (NaN if GC) | GCs | Last state |",
    "|---|---:|---:|---:|---:|---:|---:|---|",
    ...rows.map(
      (r) =>
        `| ${r.name} | ${r.calls} | ${r.medianUs.toFixed(0)} | ${r.p95Us.toFixed(0)} | ${r.meanUs.toFixed(0)} | ${Number.isNaN(r.bytesPerCall) ? "NaN" : Math.round(r.bytesPerCall)} | ${r.gcs} | ${r.note} |`,
    ),
    "",
    `Allocation gate, sampled every ${SAMPLING_BYTES} bytes over ${GATE_MOVES} moves after ${GATE_WARMUP} warm-up moves; the cleanest of ${GATE_WINDOWS} windows, so a deoptimisation inside one window doesn't fail it, while an allocation made on every move shows in all of them. Road and track checks: ${ROAD_AND_TRACK_CHECKS.join(", ")} inside ${PER_TILE_CHECK}, gated at 0. Per-tile checks: everything under ${PER_TILE_CHECK}, the placement solver included.`,
    "",
    "| Row | Bytes per move, road and track checks (gate 0) | Bytes per move, per-tile checks | Bytes per move, whole move |",
    "|---|---:|---:|---:|",
    ...gates.map(
      (g) =>
        `| ${g.name} | ${Math.round(g.gated)} | ${Math.round(g.checks)} | ${Math.round(g.wholeMove)} |`,
    ),
    "",
  ].join("\n"),
);
process.exit(0);
