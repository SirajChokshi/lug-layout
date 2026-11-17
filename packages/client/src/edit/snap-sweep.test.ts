import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
  type PartAsset,
} from "@brr/catalog";
import { STUD_LDU } from "@brr/math";
import type { MilsEdgeRules } from "@brr/schema/bundle";
import {
  INSTANCE_MATRIX_FLOATS,
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ChunkInstances,
  type ISceneBackend,
  type LookSettings,
  type PartPalette,
  type RebaseEvent,
} from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { EDITOR } from "../tokens.ts";
import type { CatalogItemView, IEditor } from "./editor.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const NDC_TO_LDU = 10_000;
const RAY_START_Y = 1000;
const QUARTER_TURNS = 4;
const HALF_TURN_16 = 8;
const OFF_LATTICE = [7, 3] as const;
const ONE_STUD_OFF = [27, -23] as const;
const OFF_BASEPLATE_GRID = [87, 53] as const;
const AREA_LDU = 8000;
const NEAR_LDU = 3000;
const BASEPLATE_LDU = 640;
const BASEPLATE = "ldraw:3811";
const MILS_PLAIN = "generated:mils-plain";
const STRAIGHT = "track-piece:ldraw:74746";
const CURVE = "track-piece:ldraw:74747";
const TRACK_PIECE_PREFIX = "track-piece:";
const FIELD_COLUMNS = 6;
const FIELD_ROWS = 4;
const TRACK_FIELD_STUDS = 22;
const TRACK_SLOT_X_LDU = 2000;
const TRACK_SLOT_Z_LDU = 1280;
const TRACK_SLOTS_PER_ROW = 6;
const BEYOND_END_LDU = BASEPLATE_LDU / 2;
const SWEEP_TIMEOUT_MS = 300_000;
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

interface Area {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

interface StudCount {
  readonly upright: number;
  readonly onCentre: number;
}

function around(x: number, z: number, reach = NEAR_LDU): Area {
  return { minX: x - reach, maxX: x + reach, minZ: z - reach, maxZ: z + reach };
}

function inside(area: Area, x: number, z: number): boolean {
  return x >= area.minX && x <= area.maxX && z >= area.minZ && z <= area.maxZ;
}

function onStudCentre(ldu: number): boolean {
  return Number.isInteger((ldu - STUD_LDU / 2) / STUD_LDU);
}

function onGrid(ldu: number, grid: number): boolean {
  return Number.isInteger(ldu / grid);
}

class SweepBackend implements ISceneBackend {
  private parts: ReadonlyArray<PartAsset> = [];
  private readonly chunks = new Map<number, ChunkInstances>();

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
    this.parts = palette.detailed.parts;
  }
  setChunk(key: number, chunk: ChunkInstances): void {
    this.chunks.set(key, chunk);
  }
  deleteChunk(key: number): void {
    this.chunks.delete(key);
  }
  setGhost(): void {}
  placeGhost(): void {}
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  forceTier(): void {}
  setFarModel(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  deleteVehicle(): void {}
  setIssueBoxes(): void {}
  rayThrough(ndcX: number, ndcY: number, out: Float64Array): void {
    out.set([ndcX * NDC_TO_LDU, RAY_START_Y, ndcY * NDC_TO_LDU, 0, -1, 0]);
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

  studs(area: Area): StudCount {
    let upright = 0;
    let onCentre = 0;
    for (const chunk of this.chunks.values()) {
      const m = chunk.studs.matrices;
      for (let i = 0; i < chunk.studs.count; i++) {
        const o = i * INSTANCE_MATRIX_FLOATS;
        const x = chunk.originX + (m[o + 3] ?? 0);
        const z = chunk.originZ + (m[o + 11] ?? 0);
        const isUpright = m[o + 1] === 0 && m[o + 9] === 0 && (m[o + 5] ?? 0) > 0;
        if (!isUpright || !inside(area, x, z)) continue;
        upright++;
        if (onStudCentre(x) && onStudCentre(z)) onCentre++;
      }
    }
    return { upright, onCentre };
  }

  groundRects(area: Area): Area[] {
    const rects: Area[] = [];
    for (const chunk of this.chunks.values()) {
      for (let i = 0; i < chunk.count; i++) {
        const part = this.parts[chunk.partIndex[i] ?? 0];
        if (!part || !(part.baseplate || part.role === "road")) continue;
        const m = chunk.matrices.subarray(i * INSTANCE_MATRIX_FLOATS);
        const [minX, maxX] = extent(m, 0, part, chunk.originX);
        const [minZ, maxZ] = extent(m, 2, part, chunk.originZ);
        const rect = { minX, maxX, minZ, maxZ };
        if (inside(area, (minX + maxX) / 2, (minZ + maxZ) / 2)) rects.push(rect);
      }
    }
    return rects;
  }
}

function extent(
  m: Float32Array,
  axis: number,
  part: PartAsset,
  origin: number,
): readonly [number, number] {
  let lo = origin + (m[axis * 4 + 3] ?? 0);
  let hi = lo;
  for (let k = 0; k < 3; k++) {
    const coefficient = m[axis * 4 + k] ?? 0;
    const a = coefficient * (part.boundsMin[k] ?? 0);
    const b = coefficient * (part.boundsMax[k] ?? 0);
    lo += Math.min(a, b);
    hi += Math.max(a, b);
  }
  return [lo, hi];
}

interface Sweep {
  readonly editor: IEditor;
  readonly backend: SweepBackend;
  readonly mils: MilsEdgeRules;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function startSweep(): Promise<Sweep> {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const backend = new SweepBackend();
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const manifest = await container.get(PART_BUNDLE_LOADER).loadManifest("standard");
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  expect(editor.snapshot().error).toBeNull();
  return { editor, backend, mils: manifest.milsEdgeRules };
}

function moveTo(editor: IEditor, x: number, z: number): void {
  editor.pointerMove(x / NDC_TO_LDU, z / NDC_TO_LDU);
}

function clickAt(editor: IEditor, x: number, z: number): void {
  moveTo(editor, x, z);
  editor.click(x / NDC_TO_LDU, z / NDC_TO_LDU, 0);
}

function turnTo(editor: IEditor, rot: number): void {
  for (let press = 0; press < QUARTER_TURNS && editor.snapshot().ghostRot !== rot; press++) {
    editor.rotate(0);
  }
  expect(editor.snapshot().ghostRot).toBe(rot);
}

interface Pose {
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
}

function poseKeys(editor: IEditor): Set<string> {
  const { x, z, yPlates, rot, refId } = editor.dump().placements;
  return new Set(x.map((px, i) => `${refId[i]}|${px}|${z[i]}|${yPlates[i]}|${rot[i]}`));
}

function placedSince(editor: IEditor, before: ReadonlySet<string>): Pose[] {
  return [...poseKeys(editor)]
    .filter((key) => !before.has(key))
    .map((key) => {
      const [, x = "", z = "", yPlates = "", rot = ""] = key.split("|");
      return { x: Number(x), z: Number(z), yPlates: Number(yPlates), rot: Number(rot) };
    });
}

function ghostPose(editor: IEditor): Pose {
  const { hover, ghostRot } = editor.snapshot();
  if (!hover) throw new Error("the cursor left the ground");
  return { x: hover.x, z: hover.z, yPlates: hover.yPlates, rot: ghostRot };
}

function firstOfEachGroup(editor: IEditor): CatalogItemView[] {
  const seen = new Set<string>();
  return editor.snapshot().catalog.filter((item) => {
    if (item.kind === "track" || seen.has(item.group)) return false;
    seen.add(item.group);
    return true;
  });
}

function standsOnTable(item: CatalogItemView): boolean {
  return item.kind !== "model" || item.baseplate !== null;
}

function chooseGroup(editor: IEditor, group: string): void {
  const item = editor.snapshot().catalog.find((entry) => entry.group === group);
  if (!item) throw new Error(`the catalog offers no ${group}`);
  editor.chooseItem(item.id);
}

function layBaseplates(editor: IEditor, x0: number, z0: number, columns: number, rows: number) {
  chooseGroup(editor, BASEPLATE);
  const before = editor.snapshot().placements;
  for (let i = 0; i < columns; i++) {
    for (let j = 0; j < rows; j++) clickAt(editor, x0 + i * BASEPLATE_LDU, z0 + j * BASEPLATE_LDU);
  }
  expect(editor.snapshot().placements - before).toBe(columns * rows);
}

function edgesOn(rect: Area, grid: number): boolean {
  return [rect.minX, rect.maxX, rect.minZ, rect.maxZ].every((edge) => onGrid(edge, grid));
}

type Problem = Readonly<Record<string, unknown>>;

function note(problems: Problem[], holds: boolean, problem: Problem): void {
  if (!holds) problems.push(problem);
}

function samePose(a: Pose | undefined, b: Pose): boolean {
  return (
    a !== undefined && a.x === b.x && a.z === b.z && a.yPlates === b.yPlates && a.rot === b.rot
  );
}

function bounds(rects: ReadonlyArray<Area>): Area {
  return {
    minX: Math.min(...rects.map((r) => r.minX)),
    maxX: Math.max(...rects.map((r) => r.maxX)),
    minZ: Math.min(...rects.map((r) => r.minZ)),
    maxZ: Math.max(...rects.map((r) => r.maxZ)),
  };
}

function sameArea(a: Area, b: Area): boolean {
  return a.minX === b.minX && a.maxX === b.maxX && a.minZ === b.minZ && a.maxZ === b.maxZ;
}

it(
  "lands every first-layer catalog item on the stud lattice where its ghost showed, at every quarter turn, and turns it in place about that pivot",
  async () => {
    const { editor, backend, mils } = await startSweep();
    const gridStuds = editor.snapshot().baseplateGridStuds;
    if (gridStuds === null) throw new Error("the editor reports no baseplate grid");
    const baseplateGrid = gridStuds * STUD_LDU;
    const moduleGrid = mils.moduleStuds * STUD_LDU;
    const items = firstOfEachGroup(editor).filter(standsOnTable);
    expect(items.length).toBeGreaterThan(0);
    const problems: Problem[] = [];
    items.forEach((item, index) => {
      const grid = item.kind === "mils-module" ? moduleGrid : baseplateGrid;
      const studsOnCentre = new Set<number>();
      for (let rot = 0; rot < QUARTER_TURNS; rot++) {
        const at = { item: item.id, rot };
        const cursorX = (index + 1) * AREA_LDU + OFF_BASEPLATE_GRID[0];
        const cursorZ = rot * AREA_LDU + OFF_BASEPLATE_GRID[1];
        const area = around(cursorX, cursorZ);
        editor.chooseItem(item.id);
        turnTo(editor, rot);
        moveTo(editor, cursorX, cursorZ);
        const ghost = ghostPose(editor);
        const before = poseKeys(editor);
        clickAt(editor, cursorX, cursorZ);
        const placed = placedSince(editor, before);
        note(problems, placed.length === 1 && samePose(placed[0], { ...ghost, yPlates: 0 }), {
          ...at,
          ghost,
          placed,
        });
        note(problems, onGrid(ghost.x, STUD_LDU) && onGrid(ghost.z, STUD_LDU), {
          ...at,
          offLattice: ghost,
        });
        const studs = backend.studs(area);
        studsOnCentre.add(studs.onCentre);
        const seated =
          item.kind === "model"
            ? studs.onCentre > studs.upright - studs.onCentre
            : studs.onCentre === studs.upright;
        note(problems, seated, { ...at, studs });
        const ground = backend.groundRects(area);
        note(problems, ground.length > 0 && ground.every((r) => edgesOn(r, grid)), {
          ...at,
          ground,
        });

        editor.chooseItem(null);
        const footprint = bounds(ground);
        clickAt(
          editor,
          (footprint.minX + footprint.maxX) / 2,
          (footprint.minZ + footprint.maxZ) / 2,
        );
        const selected = editor.snapshot().selection;
        note(problems, selected?.x === ghost.x && selected.z === ghost.z && selected.rot === rot, {
          ...at,
          selected,
        });
        for (let turn = 1; turn <= QUARTER_TURNS; turn++) {
          editor.rotate(0);
          const turned = editor.snapshot().selection;
          const expected = { ...ghost, yPlates: 0, rot: (rot + turn) % QUARTER_TURNS };
          const turnedRects = backend.groundRects(area);
          note(
            problems,
            turned !== null &&
              samePose(turned, expected) &&
              turnedRects.every((r) => edgesOn(r, grid)),
            { ...at, turn, turned, turnedRects },
          );
        }
        editor.deleteSelection(0);
        note(problems, backend.studs(area).upright === 0, { ...at, leftAfterDelete: true });
      }
      note(problems, studsOnCentre.size === 1, {
        item: item.id,
        studsOnCentreByTurn: [...studsOnCentre],
      });
    });
    expect(problems).toEqual([]);
  },
  SWEEP_TIMEOUT_MS,
);

it(
  "seats every stud-mounted catalog item on baseplate studs at the baseplate top and on a MILS module at its surface, unless the support rule refuses it",
  async () => {
    const { editor, mils } = await startSweep();
    layBaseplates(editor, 0, 0, FIELD_COLUMNS, FIELD_ROWS);
    const fieldX = ((FIELD_COLUMNS - 1) * BASEPLATE_LDU) / 2 + OFF_LATTICE[0];
    const fieldZ = ((FIELD_ROWS - 1) * BASEPLATE_LDU) / 2 + OFF_LATTICE[1];
    const moduleLdu = mils.moduleStuds * STUD_LDU;
    const moduleX = 4 * moduleLdu + moduleLdu / 2 + OFF_LATTICE[0];
    const moduleZ = 4 * moduleLdu + moduleLdu / 2 + OFF_LATTICE[1];
    editor.chooseItem(MILS_PLAIN);
    clickAt(editor, moduleX, moduleZ);
    expect(editor.snapshot().modules.modules).toBe(1);
    const problems: Problem[] = [];
    let seated = 0;
    for (const item of firstOfEachGroup(editor).filter((entry) => !standsOnTable(entry))) {
      let placedAnywhere = false;
      for (let rot = 0; rot < QUARTER_TURNS; rot++) {
        const at = { item: item.id, rot };
        editor.chooseItem(item.id);
        turnTo(editor, rot);
        moveTo(editor, fieldX, fieldZ);
        const ghost = ghostPose(editor);
        const shown = editor.snapshot().ghost?.refusal?.rule ?? null;
        const before = poseKeys(editor);
        clickAt(editor, fieldX, fieldZ);
        const placed = placedSince(editor, before);
        if (placed.length === 0) {
          const rule = editor.snapshot().lastRefusal?.rule ?? null;
          note(problems, rule === "support" && shown === "support", { ...at, rule, shown });
          continue;
        }
        placedAnywhere = true;
        note(
          problems,
          placed.length === 1 &&
            samePose(placed[0], { ...ghost, yPlates: 0 }) &&
            onGrid(ghost.x, STUD_LDU) &&
            onGrid(ghost.z, STUD_LDU),
          { ...at, ghost, placed },
        );
        editor.undo(0);
      }
      if (!placedAnywhere) continue;
      seated++;
      editor.chooseItem(item.id);
      turnTo(editor, 0);
      const before = poseKeys(editor);
      clickAt(editor, moduleX, moduleZ);
      const onModule = placedSince(editor, before);
      note(problems, onModule.length === 1 && onModule[0]?.yPlates === mils.surfacePlates, {
        item: item.id,
        onModule,
        surfacePlates: mils.surfacePlates,
      });
      if (onModule.length > 0) editor.undo(0);
    }
    expect(seated).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  },
  SWEEP_TIMEOUT_MS,
);

interface Side {
  readonly side: string;
  readonly kind: string;
}

function sideKind(sides: ReadonlyArray<Side> | undefined, side: string): string {
  const found = sides?.find((entry) => entry.side === side);
  if (!found) throw new Error(`no ${side} side in the module fit`);
  return found.kind;
}

it(
  "puts every MILS module beside every MILS module exactly on its module cell, at every turn R shows, and commits the joins the ghost previewed",
  async () => {
    const { editor, backend, mils } = await startSweep();
    const moduleLdu = mils.moduleStuds * STUD_LDU;
    const modules = firstOfEachGroup(editor).filter((item) => item.kind === "mils-module");
    expect(modules.length).toBeGreaterThan(1);
    const column = 1;
    const row = 1;
    const cellCentre = (c: number) => c * moduleLdu + moduleLdu / 2;
    const cell = {
      minX: (column + 1) * moduleLdu,
      maxX: (column + 2) * moduleLdu,
      minZ: row * moduleLdu,
      maxZ: (row + 1) * moduleLdu,
    };
    const cursorX = cellCentre(column + 1) + OFF_LATTICE[0] + moduleLdu / 4;
    const cursorZ = cellCentre(row) + OFF_LATTICE[1] - moduleLdu / 4;
    const problems: Problem[] = [];
    for (const anchor of modules) {
      editor.chooseItem(anchor.id);
      turnTo(editor, 0);
      moveTo(editor, cellCentre(column), cellCentre(row));
      const anchorFacing = sideKind(editor.snapshot().moduleFit?.sides, "maxX");
      clickAt(editor, cellCentre(column), cellCentre(row));
      expect(editor.snapshot().modules).toMatchObject({ modules: 1, offGrid: 0 });
      for (const neighbour of modules) {
        editor.chooseItem(neighbour.id);
        const shown = new Set<number>();
        for (let press = 0; press < QUARTER_TURNS; press++) {
          if (press > 0) editor.rotate(0);
          moveTo(editor, cursorX, cursorZ);
          const ghost = ghostPose(editor);
          if (shown.has(ghost.rot)) continue;
          shown.add(ghost.rot);
          const pair = { anchor: anchor.id, neighbour: neighbour.id, rot: ghost.rot };
          const fit = editor.snapshot().moduleFit;
          note(
            problems,
            fit?.column === column + 1 && fit.row === row && fit.rot === ghost.rot && !fit.occupied,
            { ...pair, fit },
          );
          const facing = sideKind(fit?.sides, "minX");
          const before = poseKeys(editor);
          clickAt(editor, cursorX, cursorZ);
          const placed = placedSince(editor, before);
          if ((anchorFacing === "rail") !== (facing === "rail")) {
            const rule = editor.snapshot().lastRefusal?.rule ?? null;
            note(problems, placed.length === 0 && rule === "rail-edge", { ...pair, placed, rule });
            if (placed.length > 0) editor.undo(0);
            continue;
          }
          note(problems, placed.length === 1 && samePose(placed[0], ghost), {
            ...pair,
            ghost,
            placed,
          });
          if (placed.length === 0) continue;
          const plates = backend.groundRects(
            around(cellCentre(column + 1), cellCentre(row), moduleLdu / 2),
          );
          note(problems, plates.length > 0 && sameArea(bounds(plates), cell), {
            ...pair,
            plates: plates.length > 0 ? bounds(plates) : null,
            cell,
          });
          const joins = editor.snapshot().modules;
          const comparable = facing !== "other" && anchorFacing !== "other";
          const kindsJoin = facing === anchorFacing ? 2 : 0;
          note(
            problems,
            joins.joined === 2 * (fit?.joined ?? 0) &&
              joins.mismatched === 2 * (fit?.mismatched ?? 0) &&
              (!comparable || joins.joined === kindsJoin) &&
              joins.offGrid === 0,
            { ...pair, anchorFacing, facing, fit, joins },
          );
          editor.undo(0);
        }
        note(problems, shown.size === QUARTER_TURNS, {
          anchor: anchor.id,
          neighbour: neighbour.id,
          turnsShownByR: [...shown],
        });
      }
      editor.undo(0);
      expect(editor.snapshot().placements).toBe(0);
    }
    expect(problems).toEqual([]);
  },
  SWEEP_TIMEOUT_MS,
);

function touchesAlongSide(a: Area, b: Area): boolean {
  const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const overlapZ = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  const besideX = (a.maxX === b.minX || b.maxX === a.minX) && overlapZ > 0;
  const besideZ = (a.maxZ === b.minZ || b.maxZ === a.minZ) && overlapX > 0;
  return besideX || besideZ;
}

function sameSquare(a: CatalogItemView, b: CatalogItemView): boolean {
  return a.studsWide === a.studsDeep && b.studsWide === a.studsWide && b.studsDeep === a.studsDeep;
}

function cleanFlushTurns(
  { editor, backend }: Sweep,
  area: Area,
  anchorRect: Area,
  neighbour: CatalogItemView,
  cursorX: number,
  cursorZ: number,
): number[] {
  const clean: number[] = [];
  editor.setSnapRoads(false);
  for (let rot = 0; rot < QUARTER_TURNS; rot++) {
    editor.chooseItem(neighbour.id);
    turnTo(editor, rot);
    const before = poseKeys(editor);
    clickAt(editor, cursorX, cursorZ);
    if (placedSince(editor, before).length === 0) continue;
    const rect = backend.groundRects(area).find((r) => !sameArea(r, anchorRect));
    const roads = editor.snapshot().roads;
    if (
      rect &&
      touchesAlongSide(anchorRect, rect) &&
      roads.joinedCells > 0 &&
      roads.mismatchedCells === 0 &&
      roads.overlaps === 0
    ) {
      clean.push(rot);
    }
    editor.undo(0);
  }
  editor.setSnapRoads(true);
  editor.chooseItem(neighbour.id);
  return clean;
}

it(
  "snaps every road plate exactly flush against every road plate it can join, commits what the ghost previewed, and refuses only mismatched road edges",
  async () => {
    const sweep = await startSweep();
    const { editor, backend } = sweep;
    const roads = firstOfEachGroup(editor).filter((item) => item.kind === "road-plate");
    expect(roads.length).toBeGreaterThan(1);
    const problems: Problem[] = [];
    let snapped = 0;
    roads.forEach((anchor, a) => {
      const originX = a * AREA_LDU;
      const originZ = AREA_LDU;
      const area = around(originX, originZ);
      editor.chooseItem(anchor.id);
      turnTo(editor, 0);
      clickAt(editor, originX, originZ);
      const [anchorRect, ...extra] = backend.groundRects(area);
      if (!anchorRect || extra.length > 0) throw new Error(`${anchor.id} was not drawn alone`);
      const midX = (anchorRect.minX + anchorRect.maxX) / 2;
      const midZ = (anchorRect.minZ + anchorRect.maxZ) / 2;
      roads.forEach((neighbour, n) => {
        editor.chooseItem(neighbour.id);
        const reach = (Math.min(neighbour.studsWide, neighbour.studsDeep) * STUD_LDU) / 2;
        const sides = [
          [anchorRect.maxX + reach, midZ],
          [anchorRect.minX - reach, midZ],
          [midX, anchorRect.maxZ + reach],
          [midX, anchorRect.minZ - reach],
        ] as const;
        const exhaustiveSide = (a + n) % sides.length;
        sides.forEach(([x, z], sideIndex) => {
          const pair = { anchor: anchor.id, neighbour: neighbour.id, side: [x - midX, z - midZ] };
          const cursorX = x + OFF_LATTICE[0];
          const cursorZ = z + OFF_LATTICE[1];
          moveTo(editor, cursorX, cursorZ);
          const ghost = ghostPose(editor);
          const snap = editor.snapshot().snap;
          const before = poseKeys(editor);
          clickAt(editor, cursorX, cursorZ);
          const placed = placedSince(editor, before);
          if (snap?.state !== "snapped") {
            const rule = editor.snapshot().lastRefusal?.rule ?? null;
            note(problems, snap?.state !== "refused" || (placed.length === 0 && rule === "road"), {
              ...pair,
              state: snap?.state,
              placed,
              rule,
            });
            if (placed.length > 0) editor.undo(0);
            const missed =
              sideIndex === exhaustiveSide && sameSquare(anchor, neighbour)
                ? cleanFlushTurns(sweep, area, anchorRect, neighbour, cursorX, cursorZ)
                : [];
            note(problems, missed.length === 0, { ...pair, state: snap?.state, missed });
            return;
          }
          snapped++;
          const rect = backend.groundRects(area).find((r) => !sameArea(r, anchorRect));
          const joins = editor.snapshot().roads;
          note(
            problems,
            placed.length === 1 &&
              samePose(placed[0], ghost) &&
              snap.joinedCells > 0 &&
              rect !== undefined &&
              touchesAlongSide(anchorRect, rect) &&
              joins.mismatchedCells === 0 &&
              joins.overlaps === 0,
            { ...pair, ghost, placed, snap, rect, joins },
          );
          if (placed.length > 0) editor.undo(0);
        });
      });
      editor.undo(0);
    });
    expect(snapped).toBeGreaterThan(roads.length);
    expect(problems).toEqual([]);
  },
  SWEEP_TIMEOUT_MS,
);

function trackEndsIn(editor: IEditor, area: Area) {
  return editor.dump().trackEnds.filter((end) => inside(area, end.xLdu, end.zLdu));
}

it(
  "attaches every drawable track piece by each of its connectors to each open end of a straight and a curve, exactly",
  async () => {
    const { editor } = await startSweep();
    const pieces = editor
      .snapshot()
      .catalog.filter((item) => item.id.startsWith(TRACK_PIECE_PREFIX))
      .map((item) => item.id);
    expect(pieces).toEqual(expect.arrayContaining([STRAIGHT, CURVE]));
    layBaseplates(editor, 0, 0, TRACK_FIELD_STUDS, TRACK_FIELD_STUDS);
    const problems: Problem[] = [];
    let slot = 0;
    for (const anchor of [STRAIGHT, CURVE]) {
      for (const piece of pieces) {
        editor.chooseItem(piece);
        moveTo(editor, 0, 0);
        const connectors = editor.snapshot().track?.held?.connectors ?? 0;
        note(problems, connectors > 1, { piece, connectors });
        for (let connector = 0; connector < connectors; connector++) {
          for (const end of [0, 1]) {
            const join = { anchor, end, piece, connector };
            const slotX = TRACK_SLOT_X_LDU * (1 + (slot % TRACK_SLOTS_PER_ROW));
            const slotZ = TRACK_SLOT_Z_LDU * (1 + Math.floor(slot / TRACK_SLOTS_PER_ROW));
            slot++;
            editor.chooseItem(anchor);
            clickAt(editor, slotX, slotZ);
            const ends = trackEndsIn(editor, around(slotX, slotZ, TRACK_SLOT_Z_LDU / 2));
            const target = ends[end];
            if (ends.length !== 2 || !target) {
              problems.push({ ...join, anchorEnds: ends.length });
              continue;
            }
            const cursorX = target.xLdu + OFF_LATTICE[0];
            const cursorZ = target.zLdu + OFF_LATTICE[1];
            editor.chooseItem(piece);
            moveTo(editor, cursorX, cursorZ);
            for (
              let press = 0;
              press < connectors && editor.snapshot().track?.held?.connector !== connector;
              press++
            ) {
              editor.rotate(0);
            }
            const held = editor.snapshot().track?.held ?? null;
            const joinsBefore = editor.snapshot().track?.joins ?? 0;
            clickAt(editor, cursorX, cursorZ);
            const after = editor.snapshot().track;
            note(
              problems,
              held?.snapped === true &&
                held.joins === 1 &&
                held.connector === connector &&
                after?.lastCommit === "joined" &&
                after.joins === joinsBefore + 1 &&
                after.gaps.length === 0 &&
                after.coincidentEndIssues === 0,
              { ...join, held, commit: after?.lastCommit, joinsBefore, joins: after?.joins },
            );
          }
        }
      }
    }
    expect(problems).toEqual([]);
  },
  SWEEP_TIMEOUT_MS,
);

it(
  "joins a laid straight to every open track end a catalog model carries, and snaps each such model onto a laid end exactly at every turn",
  async () => {
    const { editor } = await startSweep();
    const models = firstOfEachGroup(editor).filter(
      (item) => item.kind === "model" && item.baseplate !== null,
    );
    layBaseplates(editor, 0, 0, 1, 1);
    editor.chooseItem(STRAIGHT);
    clickAt(editor, 0, 0);
    const [laid] = trackEndsIn(editor, around(0, 0, BASEPLATE_LDU)).filter(
      (end) => end.heading === 0,
    );
    if (!laid) throw new Error("the laid straight has no end facing +x");
    const problems: Problem[] = [];
    let modelsWithTrack = 0;
    let modelSnaps = 0;
    models.forEach((item, index) => {
      let carriesTrack = false;
      for (let rot = 0; rot < QUARTER_TURNS; rot++) {
        const originX = (index + 1) * 2 * AREA_LDU;
        const originZ = (rot + 1) * AREA_LDU;
        editor.chooseItem(item.id);
        turnTo(editor, rot);
        const before = poseKeys(editor);
        clickAt(editor, originX + OFF_LATTICE[0], originZ + OFF_LATTICE[1]);
        const [pivot] = placedSince(editor, before);
        if (!pivot) throw new Error(`${item.id} was not placed on the bare table`);
        for (const end of trackEndsIn(editor, around(originX, originZ))) {
          carriesTrack = true;
          const join = { item: item.id, rot, end: [end.xLdu - pivot.x, end.zLdu - pivot.z] };
          const dx = Math.round(Math.cos(end.headingRadians));
          const dz = Math.round(Math.sin(end.headingRadians));
          chooseGroup(editor, BASEPLATE);
          clickAt(
            editor,
            end.xLdu + dx * BEYOND_END_LDU + OFF_LATTICE[0],
            end.zLdu + dz * BEYOND_END_LDU + OFF_LATTICE[1],
          );
          editor.chooseItem(STRAIGHT);
          moveTo(editor, end.xLdu + OFF_LATTICE[0], end.zLdu + OFF_LATTICE[1]);
          const held = editor.snapshot().track?.held ?? null;
          const joinsBefore = editor.snapshot().track?.joins ?? 0;
          clickAt(editor, end.xLdu + OFF_LATTICE[0], end.zLdu + OFF_LATTICE[1]);
          const after = editor.snapshot().track;
          note(
            problems,
            held?.snapped === true &&
              held.joins === 1 &&
              after?.lastCommit === "joined" &&
              after.joins === joinsBefore + 1,
            { ...join, held, commit: after?.lastCommit, joinsBefore, joins: after?.joins },
          );
          if ((end.heading + HALF_TURN_16) % (2 * HALF_TURN_16) !== laid.heading) continue;
          modelSnaps++;
          const expected = {
            x: laid.xLdu - (end.xLdu - pivot.x),
            z: laid.zLdu - (end.zLdu - pivot.z),
            yPlates: 0,
            rot,
          };
          editor.chooseItem(item.id);
          turnTo(editor, rot);
          moveTo(editor, expected.x + ONE_STUD_OFF[0], expected.z + ONE_STUD_OFF[1]);
          const ghost = ghostPose(editor);
          const trackJoins = editor.snapshot().ghost?.trackJoins ?? 0;
          note(problems, samePose(ghost, expected) && trackJoins > 0, {
            ...join,
            expected,
            ghost,
            trackJoins,
          });
        }
      }
      if (carriesTrack) modelsWithTrack++;
    });
    expect(modelsWithTrack).toBeGreaterThan(1);
    expect(modelSnaps).toBeGreaterThanOrEqual(modelsWithTrack);
    expect(problems).toEqual([]);
  },
  SWEEP_TIMEOUT_MS,
);
