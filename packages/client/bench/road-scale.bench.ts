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
import { TRACK_ITEM_ID } from "../src/edit/track-edit-session.ts";
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
const GATE_WARMUP = 1000;
const GATE_MOVES = 100;
const GATE_WINDOWS = 5;
const SAMPLING_BYTES = 64;
const COVERAGE_MOVES = 20;
const PER_TILE_CHECK = "checkPlacement";
const GATED_CHECKS: ReadonlyArray<string> = ["restingYPlatesAt", "roadOverlap", "modelTrackBlock"];
const ROAD_AND_TRACK_FRAMES: ReadonlyArray<string> = [
  ...GATED_CHECKS,
  "reusedRoadProbe",
  "over",
  "raiseToTopOver",
  "partBoxGridOf",
  "roadOverlapCells",
  "overlappingRoadCells",
  "reachablePlacements",
  "near",
  "find",
  "roadUnder",
  "roadAtTop",
  "extentsOverlap",
  "cellExtentInto",
  "solidRectsAt",
  "carriedParts",
  "modelTrack",
  "latticeFrame",
  "heldPieces",
  "heldRuns",
];
const REFUSAL_TEXT: ReadonlyArray<string> = ["refusalText", "refusalHit"];
const TRACK_DRAWING = "modelBlocker";
const TRACK_DRAWING_CALLBACKS: ReadonlyArray<string> = [
  "solidRectsIn",
  "solidRectsAt",
  "carriedParts",
];
const HELD_TRACK: ReadonlyArray<string> = ["latticeFrame", "heldPieces", "heldRuns"];
const CARRIED_TRACK_ITEM = "generated:mils-rail-straight";
const RECESSED_ITEM = "ldraw:69958@72";
const TRACK_PIECES_LDU = 4 * 320;
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

interface ProfileNode {
  readonly id: number;
  readonly callFrame: { readonly functionName: string };
  readonly children: ReadonlyArray<ProfileNode>;
}

interface HeapSample {
  readonly size: number;
  readonly nodeId: number;
}

interface Coverage {
  readonly result: ReadonlyArray<{
    readonly functions: ReadonlyArray<{
      readonly functionName: string;
      readonly ranges: ReadonlyArray<{ readonly count: number }>;
    }>;
  }>;
}

type Charge = "outside" | "tile" | "gated" | "other" | "refusal" | "track";

function chargeOf(parent: Charge, name: string): Charge {
  if (parent === "outside") return name === PER_TILE_CHECK ? "tile" : "outside";
  if (parent === "track") return TRACK_DRAWING_CALLBACKS.includes(name) ? "gated" : "track";
  if (parent === "tile" || parent === "gated") {
    if (name === TRACK_DRAWING) return "track";
    if (REFUSAL_TEXT.includes(name)) return "refusal";
    if (parent === "gated" || ROAD_AND_TRACK_FRAMES.includes(name)) return "gated";
    return "other";
  }
  return parent;
}

function charges(node: ProfileNode, parent: Charge, out: Map<number, Charge>): void {
  const here = chargeOf(parent, node.callFrame.functionName);
  out.set(node.id, here);
  for (const child of node.children) charges(child, here, out);
}

interface Gate {
  readonly name: string;
  readonly atZero: boolean;
  readonly gated: number;
  readonly other: number;
  readonly refusal: number;
  readonly track: number;
  readonly wholeMove: number;
}
const gates: Gate[] = [];

const editorMethods: object = Object.getPrototypeOf(editor);
for (const frame of [PER_TILE_CHECK, ...GATED_CHECKS]) {
  if (typeof Reflect.get(editorMethods, frame) !== "function") {
    throw new Error(`the allocation gate watches ${frame}, which the editor no longer has`);
  }
}

async function sampledWindow(
  name: string,
  atZero: boolean,
  flip: (i: number) => void,
): Promise<Gate> {
  const session = new Session();
  session.connect();
  await session.post("HeapProfiler.enable");
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: SAMPLING_BYTES,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let i = 0; i < GATE_MOVES; i++) flip(i);
  const heap: unknown = await session.post("HeapProfiler.stopSampling");
  session.disconnect();
  const { profile } = heap as {
    readonly profile: { readonly head: ProfileNode; readonly samples: ReadonlyArray<HeapSample> };
  };
  const charged = new Map<number, Charge>();
  charges(profile.head, "outside", charged);
  const bytes: Record<Charge, number> = {
    outside: 0,
    tile: 0,
    gated: 0,
    other: 0,
    refusal: 0,
    track: 0,
  };
  for (const sample of profile.samples) {
    bytes[charged.get(sample.nodeId) ?? "outside"] += sample.size;
  }
  let whole = 0;
  for (const charge of Object.values(bytes)) whole += charge;
  return {
    name,
    atZero,
    gated: (bytes.tile + bytes.gated) / GATE_MOVES,
    other: bytes.other / GATE_MOVES,
    refusal: bytes.refusal / GATE_MOVES,
    track: bytes.track / GATE_MOVES,
    wholeMove: whole / GATE_MOVES,
  };
}

async function calledIn(flip: (i: number) => void): Promise<ReadonlySet<string>> {
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
  for (let i = 0; i < COVERAGE_MOVES; i++) flip(i);
  const taken: unknown = await session.post("Profiler.takePreciseCoverage");
  await session.post("Profiler.stopPreciseCoverage");
  session.disconnect();
  const called = new Set<string>();
  for (const script of (taken as Coverage).result) {
    for (const fn of script.functions) {
      if ((fn.ranges[0]?.count ?? 0) > 0) called.add(fn.functionName);
    }
  }
  return called;
}

interface SampledFill {
  readonly name: string;
  readonly item: string;
  readonly side: number;
  readonly pressX: number;
  readonly pressZ: number;
  readonly mustRun: ReadonlyArray<string>;
  readonly atZero: boolean;
}

async function sampledFill({
  name,
  item,
  side,
  pressX,
  pressZ,
  mustRun,
  atZero,
}: SampledFill): Promise<void> {
  await hold(item);
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
    const sampled = await sampledWindow(name, atZero, flip);
    if (!cleanest || sampled.gated < cleanest.gated) cleanest = sampled;
  }
  const ran = await calledIn(flip);
  editor.cancelGesture();
  if (!cleanest) throw new Error(`${name}: no window was sampled`);
  const missing = [PER_TILE_CHECK, ...GATED_CHECKS, ...mustRun].filter((frame) => !ran.has(frame));
  if (missing.length > 0) {
    throw new Error(`${name}: ${missing.join(", ")} never ran, so the gate wouldn't watch them`);
  }
  if (atZero && cleanest.gated > 0) {
    throw new Error(
      `${name}: the per-tile check and its road and track functions allocate ${cleanest.gated} bytes per move; the gate is 0`,
    );
  }
  gates.push(cleanest);
}

const emptyGround = { pressX: minX - TILE / 2 - 9 * TILE, pressZ: minZ - TILE / 2 + half * TILE };
await sampledFill({
  name: "fill move: 8 x 8 road plates on empty ground",
  item: ITEM,
  side: 8,
  ...emptyGround,
  mustRun: [],
  atZero: true,
});
await sampledFill({
  name: "fill move: 4 x 4 69958 plates onto the road field, road at another top",
  item: RECESSED_ITEM,
  side: 4,
  pressX: fieldCorner.x,
  pressZ: fieldCorner.z,
  mustRun: ["roadUnder"],
  atZero: true,
});
editor.chooseItem(TRACK_ITEM_ID);
const trackZ = minZ - 12 * TILE;
backend.aim(minX, trackZ);
editor.pointerMove(0, 0);
editor.dragStart(0, 0);
backend.aim(minX + TRACK_PIECES_LDU, trackZ);
editor.pointerMove(0, 0);
editor.dragMove(0, 0);
editor.dragEnd(0, 0, 0);
if ((editor.snapshot().track?.pieces ?? 0) === 0) throw new Error("no track was laid");
await sampledFill({
  name: "fill move: 8 x 8 road plates on empty ground, with track laid",
  item: ITEM,
  side: 8,
  ...emptyGround,
  mustRun: [TRACK_DRAWING, "solidRectsIn"],
  atZero: true,
});
await sampledFill({
  name: "fill move: 4 x 4 MILS rail straights, which carry track, on empty ground, with track laid",
  item: CARRIED_TRACK_ITEM,
  side: 4,
  ...emptyGround,
  mustRun: [TRACK_DRAWING, ...HELD_TRACK],
  atZero: false,
});

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
    `Allocation gate: heap sampled every ${SAMPLING_BYTES} bytes over ${GATE_MOVES} moves after ${GATE_WARMUP} warm-up moves, the cleanest of ${GATE_WINDOWS} windows. Gated at 0: bytes charged to ${PER_TILE_CHECK} itself, where V8 charges inlined helpers, and to the road and track functions under it with their callees (${ROAD_AND_TRACK_FRAMES.join(", ")}), including the editor callbacks the track drawing calls back into (${TRACK_DRAWING_CALLBACKS.join(", ")}). Reported beside it: every other frame under ${PER_TILE_CHECK} (the placement solver and other base code), refusal text (${REFUSAL_TEXT.join(", ")}) and the rest of the track drawing's ${TRACK_DRAWING}. Placeables that carry track build their held track per tile (${HELD_TRACK.join(", ")}), so their row is reported, not gated; every other row is gated at 0, so held track built for a placeable that carries none fails it. Each row fails if precise coverage over ${COVERAGE_MOVES} further moves shows ${[PER_TILE_CHECK, ...GATED_CHECKS].join(", ")} or its own named functions never called.`,
    "",
    "| Row | Gated | Solver and other base code | Refusal text | Track drawing | Whole move |",
    "|---|---:|---:|---:|---:|---:|",
    ...gates.map(
      (g) =>
        `| ${g.name} | ${Math.round(g.gated)}${g.atZero ? " (gate 0)" : " (reported)"} | ${Math.round(g.other)} | ${Math.round(g.refusal)} | ${Math.round(g.track)} | ${Math.round(g.wholeMove)} |`,
    ),
    "",
  ].join("\n"),
);
process.exit(0);
