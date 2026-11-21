import {
  BOX_STRIDE,
  checkPlan,
  LABEL_NUMBERED,
  mmRectFromWorld,
  mmRectInWorld,
  NO_ROW,
  PlanDelta,
  regionAround,
  regionOf,
  roomRect,
  TRACK_SEGMENT,
  uncheckedPlan,
  type LduRect,
  type PlacementKey,
  type PlanCheck,
  type PlanPlacement,
  type PlanRegion,
  type PlanState,
} from "@brr/domain";
import { CHUNK_LDU, chunkKey, chunkOf, lduFromMm, mmFromLdu } from "@brr/math";
import type { BufferMemory, ISceneBackend, PlanOverlay, RebaseEvent, WorldBox } from "@brr/render";
import { fitAllBox } from "../camera/editor-camera.ts";
import { overviewOf } from "../camera/overview.ts";
import { GUIDE_GRID_LDU } from "../edit/table-tool.ts";
import {
  writeFullRebuild,
  writeTrackLay,
  writeTrackThrow,
  writeViewUpdate,
  type PlanModelSource,
  type PlanTrackSource,
} from "./plan-producer.ts";
import {
  DEFAULT_MAX_OVERHANG_MM,
  DEFAULT_TABLE_HEIGHT_MM,
  PlanService,
  type NewPlan,
  type ObstacleInput,
  type PlacedForPlan,
  type PlanPatch,
  type TableInput,
} from "./plan-service.ts";

interface PlanSnapshot {
  readonly plans: ReadonlyArray<PlanRegion>;
  readonly activePlanId: string | null;
  readonly checks: ReadonlyArray<PlanCheck>;
  readonly placements: ReadonlyArray<PlacedForPlan>;
  readonly sandboxPlacements: ReadonlyArray<PlacementKey>;
  readonly tableTopY: number;
}

interface TodaysOverviewItem {
  readonly ref: string;
  readonly rect: LduRect;
}

interface TodaysOverviewView {
  readonly items: ReadonlyArray<TodaysOverviewItem>;
  readonly rooms: ReadonlyArray<LduRect>;
  readonly tables: ReadonlyArray<LduRect>;
  readonly obstacles: ReadonlyArray<LduRect>;
  readonly bounds: LduRect | null;
}

function todaysUnionOf(rects: ReadonlyArray<LduRect>): LduRect | null {
  const first = rects[0];
  if (!first) return null;
  let { minX, minZ, maxX, maxZ } = first;
  for (const rect of rects) {
    minX = Math.min(minX, rect.minX);
    minZ = Math.min(minZ, rect.minZ);
    maxX = Math.max(maxX, rect.maxX);
    maxZ = Math.max(maxZ, rect.maxZ);
  }
  return { minX, minZ, maxX, maxZ };
}

function todaysOverviewOf(snapshot: PlanSnapshot): TodaysOverviewView {
  const items = snapshot.placements.map((placement) => ({
    ref: placement.ref,
    rect: {
      minX: placement.box.minX,
      minZ: placement.box.minZ,
      maxX: placement.box.maxX,
      maxZ: placement.box.maxZ,
    },
  }));
  const rooms = snapshot.plans.map(roomRect);
  const tables = snapshot.plans.flatMap((plan) =>
    plan.footprint.tables.map((table) => mmRectInWorld(plan, table.rect)),
  );
  const obstacles = snapshot.plans.flatMap((plan) =>
    plan.footprint.obstacles.map((obstacle) => mmRectInWorld(plan, obstacle.rect)),
  );
  return {
    items,
    rooms,
    tables,
    obstacles,
    bounds: todaysUnionOf([...items.map((item) => item.rect), ...rooms]),
  };
}

const TODAYS_HOME_HALF_LDU = 640;
const TODAYS_HOME_BOX: WorldBox = {
  minX: -TODAYS_HOME_HALF_LDU,
  minY: 0,
  minZ: -TODAYS_HOME_HALF_LDU,
  maxX: TODAYS_HOME_HALF_LDU,
  maxY: 0,
  maxZ: TODAYS_HOME_HALF_LDU,
};

function todaysFlatBox(rect: LduRect): WorldBox {
  return { minX: rect.minX, minY: 0, minZ: rect.minZ, maxX: rect.maxX, maxY: 0, maxZ: rect.maxZ };
}

function todaysUnion(boxes: ReadonlyArray<WorldBox>): WorldBox | null {
  const first = boxes[0];
  if (!first) return null;
  let { minX, minY, minZ, maxX, maxY, maxZ } = first;
  for (const box of boxes) {
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    minZ = Math.min(minZ, box.minZ);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
    maxZ = Math.max(maxZ, box.maxZ);
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function todaysFitAllBox(snapshot: PlanSnapshot): WorldBox {
  const { placements, plans } = snapshot;
  return (
    todaysUnion(placements.map((placement) => placement.box)) ??
    todaysUnion(plans.map((plan) => todaysFlatBox(roomRect(plan)))) ??
    TODAYS_HOME_BOX
  );
}

function overviewWithItems(plans: PlanService): TodaysOverviewView {
  const { rooms, tables, obstacles, bounds } = overviewOf(plans);
  const view = plans.placements();
  const items: TodaysOverviewItem[] = [];
  for (let row = view.first(); row !== NO_ROW; row = view.next(row)) {
    items.push({
      ref: view.refOf(row),
      rect: {
        minX: view.minX(row),
        minZ: view.minZ(row),
        maxX: view.maxX(row),
        maxZ: view.maxZ(row),
      },
    });
  }
  return { items, rooms, tables, obstacles, bounds };
}

interface Recorder {
  setPlanOverlays(overlays: ReadonlyArray<PlanOverlay>): void;
  setIssueBoxes(boxes: ReadonlyArray<WorldBox>): void;
}

export class RecordingBackend implements ISceneBackend, Recorder {
  overlays: ReadonlyArray<PlanOverlay> = [];
  boxes: ReadonlyArray<WorldBox> = [];
  async init(): Promise<never> {
    throw new Error("not used");
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
  setPlanOverlays(overlays: ReadonlyArray<PlanOverlay>): void {
    this.overlays = overlays;
  }
  setMarkers(): void {}
  setTrackEnds(): void {}
  setGround(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  deleteVehicle(): void {}
  setIssueBoxes(boxes: ReadonlyArray<WorldBox>): void {
    this.boxes = boxes;
  }
  setGuides(): void {}
  projectToNdc(): void {}
  rayThrough(): void {}
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

type Evaluation = Pick<PlanSnapshot, "checks" | "sandboxPlacements">;

function todaysEvaluate(
  plans: ReadonlyArray<PlanRegion>,
  placed: ReadonlyArray<PlacedForPlan>,
  unsupported: ReadonlyArray<boolean>,
): Evaluation {
  try {
    const domain = placed.map((placement, i) => todaysToDomain(placement, unsupported[i] === true));
    return {
      checks: plans.map((plan) => checkPlan(plan, domain)),
      sandboxPlacements: domain
        .filter((placement) => regionOf(plans, placement.box) === null)
        .map((placement) => placement.key),
    };
  } catch (error) {
    return {
      checks: plans.map((plan) => uncheckedPlan(plan, [], String(error))),
      sandboxPlacements: [],
    };
  }
}

function todaysPlacementId(key: PlacementKey): string {
  return `${key.chunkKey}:${key.slot}`;
}

function todaysToDomain(placement: PlacedForPlan, unsupported: boolean): PlanPlacement {
  const { box } = placement;
  return {
    key: placement.key,
    ref: placement.ref,
    label: placement.label,
    box: { minX: box.minX, minZ: box.minZ, maxX: box.maxX, maxZ: box.maxZ },
    unsupported,
  };
}

interface TodaysModel {
  readonly id: number;
  readonly todays: PlacedForPlan;
}

class TodaysPlanService {
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  private modelIds: ReadonlyArray<number> = [];
  private unsupportedTrack: ReadonlySet<number> = new Set();
  private unsupportedModels: ReadonlySet<number> = new Set();
  private state: PlanSnapshot = {
    plans: [],
    activePlanId: null,
    checks: [],
    placements: [],
    sandboxPlacements: [],
    tableTopY: 0,
  };

  constructor(private readonly backend: Recorder) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): PlanSnapshot {
    return this.state;
  }

  private newId(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }

  private plan(planId: string): PlanRegion {
    const plan = this.state.plans.find((p) => p.id === planId);
    if (!plan) throw new Error(`no plan ${planId}`);
    return plan;
  }

  private replacePlan(planId: string, next: (plan: PlanRegion) => PlanRegion): void {
    this.commit({
      plans: this.state.plans.map((plan) => (plan.id === planId ? next(plan) : plan)),
    });
  }

  createPlan(plan: NewPlan): string {
    const id = this.newId("plan");
    const region: PlanRegion = {
      id,
      name: plan.name,
      originChunkX: plan.originChunkX,
      originChunkZ: plan.originChunkZ,
      footprint: {
        roomWidthMm: plan.roomWidthMm,
        roomDepthMm: plan.roomDepthMm,
        tables: [],
        obstacles: [],
      },
      maxOverhangMm: DEFAULT_MAX_OVERHANG_MM,
    };
    this.commit({ plans: [...this.state.plans, region], activePlanId: id });
    return id;
  }

  updatePlan(planId: string, patch: PlanPatch): void {
    this.replacePlan(planId, (plan) => ({
      ...plan,
      name: patch.name ?? plan.name,
      originChunkX: patch.originChunkX ?? plan.originChunkX,
      originChunkZ: patch.originChunkZ ?? plan.originChunkZ,
      maxOverhangMm: patch.maxOverhangMm ?? plan.maxOverhangMm,
      footprint: {
        ...plan.footprint,
        roomWidthMm: patch.roomWidthMm ?? plan.footprint.roomWidthMm,
        roomDepthMm: patch.roomDepthMm ?? plan.footprint.roomDepthMm,
      },
    }));
  }

  removePlan(planId: string): void {
    this.plan(planId);
    const plans = this.state.plans.filter((p) => p.id !== planId);
    this.commit({
      plans,
      activePlanId:
        this.state.activePlanId === planId ? (plans[0]?.id ?? null) : this.state.activePlanId,
    });
  }

  activatePlan(planId: string | null): void {
    if (planId !== null) this.plan(planId);
    this.commit({ activePlanId: planId });
  }

  addTable(planId: string, table: TableInput): string {
    const id = this.newId("table");
    this.replacePlan(planId, (plan) => ({
      ...plan,
      footprint: { ...plan.footprint, tables: [...plan.footprint.tables, { ...table, id }] },
    }));
    return id;
  }

  updateTable(planId: string, tableId: string, patch: Partial<TableInput>): void {
    this.replacePlan(planId, (plan) => ({
      ...plan,
      footprint: {
        ...plan.footprint,
        tables: plan.footprint.tables.map((t) => (t.id === tableId ? { ...t, ...patch } : t)),
      },
    }));
  }

  removeTable(planId: string, tableId: string): void {
    this.replacePlan(planId, (plan) => ({
      ...plan,
      footprint: {
        ...plan.footprint,
        tables: plan.footprint.tables.filter((t) => t.id !== tableId),
      },
    }));
  }

  drawTable(rect: LduRect): { planId: string; tableId: string } {
    const planId = this.state.activePlanId ?? this.createPlanAround(rect);
    const tableId = this.newId("table");
    this.replacePlan(planId, (plan) => {
      const grown = regionAround(plan, rect);
      const { tables } = grown.footprint;
      const table = {
        id: tableId,
        name: `Table ${tables.length + 1}`,
        rect: mmRectFromWorld(grown, rect),
        heightMm: tables[0]?.heightMm ?? DEFAULT_TABLE_HEIGHT_MM,
      };
      return { ...grown, footprint: { ...grown.footprint, tables: [...tables, table] } };
    });
    return { planId, tableId };
  }

  placeTable(planId: string, tableId: string, rect: LduRect): void {
    this.replacePlan(planId, (plan) => {
      const grown = regionAround(plan, rect);
      const placed = mmRectFromWorld(grown, rect);
      return {
        ...grown,
        footprint: {
          ...grown.footprint,
          tables: grown.footprint.tables.map((t) =>
            t.id === tableId ? { ...t, rect: placed } : t,
          ),
        },
      };
    });
  }

  private createPlanAround(rect: LduRect): string {
    const originChunkX = chunkOf(rect.minX);
    const originChunkZ = chunkOf(rect.minZ);
    return this.createPlan({
      name: `Plan ${this.state.plans.length + 1}`,
      roomWidthMm: mmFromLdu(rect.maxX - originChunkX * CHUNK_LDU),
      roomDepthMm: mmFromLdu(rect.maxZ - originChunkZ * CHUNK_LDU),
      originChunkX,
      originChunkZ,
    });
  }

  restore(state: PlanState): void {
    this.commit({ plans: state.regions, activePlanId: state.activePlanId });
  }

  addObstacle(planId: string, obstacle: ObstacleInput): string {
    const id = this.newId("obstacle");
    this.replacePlan(planId, (plan) => ({
      ...plan,
      footprint: {
        ...plan.footprint,
        obstacles: [...plan.footprint.obstacles, { ...obstacle, id }],
      },
    }));
    return id;
  }

  updateObstacle(planId: string, obstacleId: string, patch: Partial<ObstacleInput>): void {
    this.replacePlan(planId, (plan) => ({
      ...plan,
      footprint: {
        ...plan.footprint,
        obstacles: plan.footprint.obstacles.map((o) =>
          o.id === obstacleId ? { ...o, ...patch } : o,
        ),
      },
    }));
  }

  removeObstacle(planId: string, obstacleId: string): void {
    this.replacePlan(planId, (plan) => ({
      ...plan,
      footprint: {
        ...plan.footprint,
        obstacles: plan.footprint.obstacles.filter((o) => o.id !== obstacleId),
      },
    }));
  }

  setPlacements(models: ReadonlyArray<TodaysModel>, track: ReadonlyArray<PlacedForPlan>): void {
    this.modelIds = models.map((model) => model.id);
    this.commit({ placements: [...models.map((model) => model.todays), ...track] });
  }

  setUnsupported(track: ReadonlySet<number>, models: ReadonlySet<number>): void {
    this.unsupportedTrack = new Set(track);
    this.unsupportedModels = new Set(models);
    this.commit({});
  }

  private unsupportedFlags(placements: ReadonlyArray<PlacedForPlan>): boolean[] {
    const models = this.modelIds;
    return placements.map((_, i) => {
      const id = models[i];
      return id === undefined
        ? this.unsupportedTrack.has(i - models.length)
        : this.unsupportedModels.has(id);
    });
  }

  setTableTopY(y: number): void {
    this.commit({ tableTopY: y });
  }

  private commit(patch: Partial<PlanSnapshot>): void {
    const next = { ...this.state, ...patch };
    this.state = {
      ...next,
      ...todaysEvaluate(next.plans, next.placements, this.unsupportedFlags(next.placements)),
    };
    this.draw();
    for (const listener of this.listeners) listener();
  }

  private draw(): void {
    const { plans, checks, placements, tableTopY, activePlanId } = this.state;
    const overlays: PlanOverlay[] = plans.map((plan, i) => {
      const check = checks[i];
      const heightMm = plan.footprint.tables[0]?.heightMm ?? 0;
      const floorY = tableTopY - lduFromMm(heightMm);
      const tables = (check?.tables ?? []).map((top) => ({
        minX: top.surface.minX,
        minY: tableTopY - lduFromMm(top.heightMm),
        minZ: top.surface.minZ,
        maxX: top.surface.maxX,
        maxY: tableTopY,
        maxZ: top.surface.maxZ,
      }));
      const obstacles = (check?.obstacles ?? []).map((rect) => ({
        ...rect,
        minY: floorY,
        maxY: tableTopY,
      }));
      const room = check?.room;
      return {
        room: {
          minX: room?.minX ?? 0,
          minY: floorY,
          minZ: room?.minZ ?? 0,
          maxX: room?.maxX ?? 0,
          maxY: floorY,
          maxZ: room?.maxZ ?? 0,
        },
        tables,
        obstacles,
        active: plan.id === activePlanId,
      };
    });
    this.backend.setPlanOverlays(overlays);
    const flagged = new Set(
      checks.flatMap((c) => c.issues.flatMap((issue) => issue.placements.map(todaysPlacementId))),
    );
    this.backend.setIssueBoxes(
      flagged.size === 0
        ? []
        : placements.filter((p) => flagged.has(todaysPlacementId(p.key))).map((p) => p.box),
    );
  }
}

const EDITS = 1_000;
const MAX_MODELS = 24;
const MAX_PIECES = 10;
const MAX_REGIONS = 3;
const SAVED_PLAN_STATES = 4;
const CHUNK = 640;
const MANDATORY_EVERY = 12;

export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

type BoxField = keyof WorldBox;
const BOX_FIELDS: ReadonlyArray<BoxField> = ["minX", "minY", "minZ", "maxX", "maxY", "maxZ"];

function throwingBox(box: WorldBox, field: BoxField, message: string): WorldBox {
  return Object.defineProperty({ ...box }, field, {
    get(): number {
      throw new Error(message);
    },
  });
}

interface TestModel extends PlanModelSource {
  readonly todays: PlacedForPlan;
}

function todaysEntry(model: PlanModelSource): PlacedForPlan {
  return {
    key: { chunkKey: model.handle.chunkKey, slot: model.handle.slot },
    ref: model.placeable.id,
    label: `${model.placeable.label} at ${model.handle.x}, ${model.handle.z}`,
    box: model.box,
  };
}

interface TestPiece {
  readonly chunkKey: number;
  readonly ref: string;
  readonly title: string;
  readonly box: WorldBox;
}

class TestTrack implements PlanTrackSource {
  readonly pieces: TestPiece[] = [];

  get pieceCount(): number {
    return this.pieces.length;
  }

  writeFootprint(piece: number, delta: PlanDelta, kind: number): void {
    const { chunkKey: key, ref, title, box } = this.pieces[piece] ?? this.missing(piece);
    const entry = delta.write(kind, TRACK_SEGMENT, piece, piece, ref, LABEL_NUMBERED, title);
    delta.chunkKey[entry] = key;
    delta.labelA[entry] = piece + 1;
    delta.labelB[entry] = 0;
    BOX_FIELDS.forEach((field, k) => {
      delta.box[entry * BOX_STRIDE + k] = box[field];
    });
  }

  todays(): PlacedForPlan[] {
    return this.pieces.map((p, i) => ({
      key: { chunkKey: p.chunkKey, slot: i },
      ref: p.ref,
      label: `${p.title} #${i + 1}`,
      box: p.box,
    }));
  }

  private missing(piece: number): never {
    throw new Error(`no test piece ${piece}`);
  }
}

function anchor(read: () => number): number {
  try {
    const value = Math.round(read());
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function attempt<T>(read: () => T): { readonly value: T } | { readonly threw: string } {
  try {
    return { value: read() };
  } catch (error) {
    return { threw: String(error) };
  }
}

function fiveFields(snapshot: PlanSnapshot): unknown {
  return {
    plans: snapshot.plans,
    checks: snapshot.checks,
    placements: snapshot.placements,
    sandboxPlacements: snapshot.sandboxPlacements,
    tableTopY: snapshot.tableTopY,
  };
}

export class Pair {
  readonly next: () => number;
  readonly sutBackend = new RecordingBackend();
  readonly todayBackend = new RecordingBackend();
  readonly sut = new PlanService(this.sutBackend);
  readonly today = new TodaysPlanService(this.todayBackend);
  readonly delta = new PlanDelta();
  readonly track = new TestTrack();
  readonly throwing = new Set<WorldBox>();
  models: TestModel[] = [];
  removedLast: TestModel | null = null;
  private nextModel = 1;
  private nextSlot = 1;
  private readonly saved: PlanState[] = [];
  readonly hit = new Set<string>();

  constructor(
    readonly seed: number,
    next: () => number,
  ) {
    this.next = next;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  pick<T>(values: ReadonlyArray<T>): T {
    return values[this.int(values.length)] as T;
  }

  planIds(): string[] {
    return this.today.snapshot().plans.map((plan) => plan.id);
  }

  syncToday(): void {
    this.today.setPlacements(this.models, this.track.todays());
  }

  randomBox(): WorldBox {
    const roll = this.next();
    const x = this.int(260) * 20 - 1200 + (roll < 0.05 ? this.next() : 0);
    const z = this.int(260) * 20 - 1200;
    const width = roll > 0.97 ? 0 : (1 + this.int(32)) * 20;
    const depth = (1 + this.int(32)) * 20;
    const y = this.int(4) * 24;
    if (roll > 0.995)
      return { minX: Number.NaN, minY: y, minZ: z, maxX: x, maxY: y + 24, maxZ: z + depth };
    if (roll > 0.99)
      return { minX: x, minY: y, minZ: z, maxX: x + 1e12, maxY: y + 24, maxZ: z + depth };
    return { minX: x, minY: y, minZ: z, maxX: x + width, maxY: y + 24, maxZ: z + depth };
  }

  newModel(box: WorldBox = this.randomBox()): TestModel {
    const id = this.nextModel++;
    const x = anchor(() => box.minX);
    const z = anchor(() => box.minZ);
    const source: PlanModelSource = {
      id,
      handle: {
        chunkKey: chunkKey(Math.floor(x / CHUNK), Math.floor(z / CHUNK)),
        slot: this.nextSlot++,
        x,
        z,
      },
      placeable: { id: `ref-${this.int(5)}`, label: `Item ${this.int(5)}` },
      box,
    };
    return { ...source, todays: todaysEntry(source) };
  }

  unreadableModel(field: BoxField): TestModel {
    const plain = this.randomBox();
    const box = throwingBox(plain, field, `box ${field} is gone ${this.nextModel}`);
    this.throwing.add(box);
    return this.newModel(box);
  }

  view(removed: ReadonlyArray<TestModel>, added: ReadonlyArray<TestModel>): void {
    writeViewUpdate(this.delta, { removed, added });
    this.sut.apply(this.delta);
    this.syncToday();
  }

  place(model: TestModel = this.newModel()): void {
    this.models.push(model);
    this.view([], [model]);
  }

  remove(index = this.int(this.models.length)): void {
    const [model] = this.models.splice(index, 1);
    if (!model) return;
    this.removedLast = model;
    this.view([model], []);
  }

  rotate(index = this.int(this.models.length)): void {
    const [model] = this.models.splice(index, 1);
    if (!model) return;
    const box = model.box;
    const turned = this.throwing.has(box)
      ? box
      : { ...box, maxX: box.minX + (box.maxZ - box.minZ), maxZ: box.minZ + (box.maxX - box.minX) };
    const replacement = this.newModel(turned);
    this.models.push(replacement);
    this.view([model], [replacement]);
  }

  road(): void {
    const removed: TestModel[] = [];
    for (let k = this.int(3); k > 0 && this.models.length > 0; k--) {
      const [model] = this.models.splice(this.int(this.models.length), 1);
      if (model) removed.push(model);
    }
    const added = Array.from({ length: 1 + this.int(5) }, () => this.newModel());
    this.models.push(...added);
    this.view(removed, added);
  }

  undo(): void {
    const model = this.removedLast;
    if (!model) return this.place();
    const back = this.newModel(model.box);
    this.removedLast = null;
    this.models.push(back);
    this.view([], [back]);
  }

  redo(): void {
    this.remove(this.models.length - 1);
  }

  trackLay(laid = 1 + this.int(3)): void {
    for (let k = 0; k < laid; k++) {
      this.track.pieces.push({
        chunkKey: -1 - chunkKey(this.int(6) - 3, this.int(6) - 3),
        ref: this.pick(["ldraw:53401", "ldraw:74746", "ldraw:2861"]),
        title: this.pick(["Straight", "Curve", "Switch"]),
        box: this.randomBox(),
      });
    }
    writeTrackLay(this.delta, this.track, laid);
    this.sut.apply(this.delta);
    this.syncToday();
  }

  switchThrow(piece = this.int(this.track.pieces.length)): void {
    const old = this.track.pieces[piece];
    if (!old) return this.trackLay();
    this.track.pieces[piece] = { ...old, ref: `${old.ref}-thrown`, box: this.randomBox() };
    writeTrackThrow(this.delta, this.track, piece);
    this.sut.apply(this.delta);
    this.syncToday();
  }

  unsupportedEdit(): void {
    const pieces = new Set<number>();
    for (let piece = 0; piece < MAX_PIECES + 2; piece++) {
      if (this.next() < 0.3) pieces.add(piece);
    }
    const models = new Set<number>();
    for (const model of this.models) if (this.next() < 0.3) models.add(model.id);
    if (this.next() < 0.2) models.add(this.nextModel);
    this.both((s) => s.setUnsupported(pieces, models));
  }

  load(): void {
    this.models = this.models.filter(() => this.next() < 0.8).toSorted(() => this.next() - 0.5);
    this.track.pieces.length = Math.min(this.track.pieces.length, this.int(MAX_PIECES));
    writeFullRebuild(this.delta, this.models, this.track);
    this.sut.apply(this.delta);
    this.syncToday();
  }

  both(run: (service: TodaysPlanService | PlanService) => unknown): void {
    const today = attempt(() => run(this.today));
    const sut = attempt(() => run(this.sut));
    if ("threw" in today !== "threw" in sut) this.mismatch("region edit outcome", sut, today);
  }

  mismatchList: unknown[] = [];
  step = 0;

  mismatch(what: string, sut: unknown, today: unknown): void {
    this.mismatchList.push({ seed: this.seed, step: this.step, what, sut, today });
  }

  mm(): number {
    const roll = this.next();
    if (roll < 0.04) return this.int(2000) + 0.5;
    if (roll < 0.06) return -this.int(100);
    return this.int(4000);
  }

  newPlan(): NewPlan {
    return {
      name: `Plan ${this.int(9)}`,
      roomWidthMm: 1000 + this.int(3000),
      roomDepthMm: 1000 + this.int(3000),
      originChunkX: this.int(3) - 2,
      originChunkZ: this.int(3) - 2,
    };
  }

  table(): TableInput {
    return {
      name: `Table ${this.int(9)}`,
      rect: {
        x: this.mm(),
        z: this.mm(),
        width: 200 + this.int(2400),
        depth: 200 + this.int(1200),
      },
      heightMm: this.next() < 0.1 ? 900 : 750,
    };
  }

  obstacle(): ObstacleInput {
    return {
      name: `Pillar ${this.int(9)}`,
      rect: { x: this.mm(), z: this.mm(), width: 100 + this.int(400), depth: 100 + this.int(400) },
    };
  }

  geometryPatch(): PlanPatch {
    return this.pick<PlanPatch>([
      { roomWidthMm: 1000 + this.int(3000) },
      { originChunkX: this.int(3) - 2 },
      { maxOverhangMm: this.int(60) },
      { name: `Renamed ${this.int(9)}`, roomDepthMm: 1000 + this.int(3000) },
    ]);
  }

  firstTable(planId: string): string | null {
    return (
      this.today.snapshot().plans.find((p) => p.id === planId)?.footprint.tables[0]?.id ?? null
    );
  }

  firstObstacle(planId: string): string | null {
    return (
      this.today.snapshot().plans.find((p) => p.id === planId)?.footprint.obstacles[0]?.id ?? null
    );
  }

  latticeRect(): LduRect {
    const minX = (this.int(48) - 24) * GUIDE_GRID_LDU;
    const minZ = (this.int(48) - 24) * GUIDE_GRID_LDU;
    return {
      minX,
      minZ,
      maxX: minX + (1 + this.int(16)) * GUIDE_GRID_LDU,
      maxZ: minZ + (1 + this.int(10)) * GUIDE_GRID_LDU,
    };
  }

  sutState(): PlanState {
    return { regions: this.sut.plans(), activePlanId: this.sut.activePlanId() };
  }

  regionEdit(): void {
    this.saved.push(this.sutState());
    if (this.saved.length > SAVED_PLAN_STATES) this.saved.shift();
    const ids = this.planIds();
    const planId = ids.length > 0 ? this.pick(ids) : null;
    const roll = this.int(12);
    if (planId === null || (roll === 0 && ids.length < MAX_REGIONS)) {
      const plan = this.newPlan();
      this.both((s) => s.createPlan(plan));
      return;
    }
    const tableId = this.firstTable(planId);
    const obstacleId = this.firstObstacle(planId);
    const patch = this.geometryPatch();
    const table = this.table();
    const obstacle = this.obstacle();
    const name = `Renamed ${this.int(9)}`;
    const drawn = this.latticeRect();
    const saved = this.pick(this.saved);
    const edits: Array<(s: TodaysPlanService | PlanService) => unknown> = [
      (s) => s.updatePlan(planId, patch),
      (s) => s.updatePlan(planId, { name }),
      (s) => s.addTable(planId, table),
      (s) => s.addObstacle(planId, obstacle),
      (s) => s.activatePlan(planId),
      (s) => s.activatePlan(null),
      (s) => s.drawTable(drawn),
      (s) => s.restore(saved),
    ];
    if (tableId) {
      edits.push((s) => s.updateTable(planId, tableId, { rect: table.rect }));
      edits.push((s) => s.updateTable(planId, tableId, { name }));
      edits.push((s) => s.removeTable(planId, tableId));
      edits.push((s) => s.placeTable(planId, tableId, drawn));
    }
    if (obstacleId) {
      edits.push((s) => s.updateObstacle(planId, obstacleId, { rect: obstacle.rect }));
      edits.push((s) => s.removeObstacle(planId, obstacleId));
    }
    if (this.next() < 0.08) edits.push((s) => s.removePlan(planId));
    this.both(this.pick(edits));
  }

  randomEdit(): void {
    const roll = this.next();
    if (roll < 0.26 && this.models.length < MAX_MODELS) return this.place();
    if (roll < 0.38) return this.models.length > 0 ? this.remove() : this.place();
    if (roll < 0.46) return this.models.length > 0 ? this.rotate() : this.place();
    if (roll < 0.51) return this.road();
    if (roll < 0.55) return this.undo();
    if (roll < 0.57) return this.models.length > 0 ? this.redo() : this.place();
    if (roll < 0.62 && this.track.pieces.length < MAX_PIECES) return this.trackLay();
    if (roll < 0.67) return this.switchThrow();
    if (roll < 0.85) return this.regionEdit();
    if (roll < 0.87) return this.load();
    if (roll < 0.89) {
      const y = this.int(400) - 200;
      return this.both((s) => s.setTableTopY(y));
    }
    if (roll < 0.91) return this.place(this.unreadableModel(this.pick(BOX_FIELDS)));
    if (roll < 0.95) return this.unsupportedEdit();
    const unreadable = this.models.findIndex((m) => this.throwing.has(m.box));
    if (unreadable >= 0) return this.remove(unreadable);
    return this.place();
  }

  boxesSeen(boxes: ReadonlyArray<WorldBox>): unknown[] {
    return boxes.map((box) =>
      this.throwing.has(box) ? { original: [...this.throwing].indexOf(box) } : { ...box },
    );
  }

  compare(): void {
    const todaySnap = this.today.snapshot();
    const sut = this.sut;
    const sameObject = (a: unknown, b: unknown, what: string): void => {
      if (!sameValue(a, b)) this.mismatch(what, a, b);
    };
    sameObject(sut.materialize(), fiveFields(todaySnap), "materialize");
    sameObject(sut.plans(), todaySnap.plans, "plans");
    sameObject(sut.activePlanId(), todaySnap.activePlanId, "activePlanId");
    sameObject(sut.tableTopY(), todaySnap.tableTopY, "tableTopY");
    sameObject(sut.placementCount(), todaySnap.placements.length, "placementCount");
    sameObject(sut.sandboxCount(), todaySnap.sandboxPlacements.length, "sandboxCount");
    todaySnap.checks.forEach((check: PlanCheck) => {
      const id = check.regionId;
      const view = sut.regionView(id);
      sameObject(
        { room: view.room, tables: view.tables, obstacles: view.obstacles },
        { room: check.room, tables: check.tables, obstacles: check.obstacles },
        `regionView ${id}`,
      );
      sameObject(sut.insideCount(id), check.inside.length, `insideCount ${id}`);
      sameObject(sut.issueCount(id), check.issues.length, `issueCount ${id}`);
      sameObject(sut.issues(id), check.issues, `issues ${id}`);
    });
    sameObject(this.sutBackend.overlays, this.todayBackend.overlays, "overlays sent");
    sameObject(
      this.boxesSeen(this.sutBackend.boxes),
      this.boxesSeen(this.todayBackend.boxes),
      "issue boxes sent",
    );
    sameObject(
      attempt(() => JSON.stringify(sut.materialize())),
      attempt(() => JSON.stringify(fiveFields(todaySnap))),
      "#plan-state JSON",
    );
    sameObject(
      attempt(() => overviewWithItems(sut)),
      attempt(() => todaysOverviewOf(todaySnap)),
      "overviewOf",
    );
    sameObject(
      attempt(() => fitAllBox(sut)),
      attempt(() => todaysFitAllBox(todaySnap)),
      "fitAll",
    );
  }
}

export function deepSame(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      deepSame((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

function sameValue(a: unknown, b: unknown): boolean {
  try {
    return deepSame(a, b);
  } catch {
    return false;
  }
}

interface MandatoryCase {
  readonly name: string;
  run(pair: Pair): void;
}

export function withPlan(pair: Pair): string {
  const ids = pair.planIds();
  if (ids[0]) return ids[0];
  const plan = pair.newPlan();
  pair.both((s) => s.createPlan(plan));
  return pair.planIds()[0] ?? "";
}

function unchecked(pair: Pair, then: (pair: Pair) => void): void {
  pair.place(pair.unreadableModel(pair.pick(["minX", "minZ", "maxX", "maxZ"])));
  then(pair);
}

function recover(pair: Pair): void {
  for (let i = pair.models.length - 1; i >= 0; i--) {
    const model = pair.models[i];
    if (model && pair.throwing.has(model.box)) pair.remove(i);
  }
}

const MANDATORY: ReadonlyArray<MandatoryCase> = [
  { name: "place", run: (p) => p.place() },
  { name: "remove", run: (p) => (p.models.length > 0 ? p.remove() : p.place()) },
  {
    name: "rotate moves the row to the tail",
    run: (p) => {
      p.place();
      p.place();
      p.rotate(0);
    },
  },
  { name: "road stroke", run: (p) => p.road() },
  {
    name: "undo and redo",
    run: (p) => {
      p.remove();
      p.undo();
      p.redo();
    },
  },
  {
    name: "track lay between model edits",
    run: (p) => {
      p.place();
      p.trackLay(2);
      p.place();
    },
  },
  {
    name: "switch throw on a flagged piece mid-list",
    run: (p) => {
      const planId = withPlan(p);
      p.both((s) =>
        s.addTable(planId, {
          name: "T",
          rect: { x: 0, z: 0, width: 100, depth: 100 },
          heightMm: 750,
        }),
      );
      p.trackLay(3);
      p.switchThrow(Math.max(0, p.track.pieces.length - 2));
    },
  },
  { name: "load", run: (p) => p.load() },
  {
    name: "create a plan",
    run: (p) => {
      const plan = p.newPlan();
      p.both((s) => s.createPlan(plan));
    },
  },
  {
    name: "update a plan",
    run: (p) => {
      const id = withPlan(p);
      const patch = p.geometryPatch();
      p.both((s) => s.updatePlan(id, patch));
    },
  },
  {
    name: "remove the active plan",
    run: (p) => {
      const plan = p.newPlan();
      p.both((s) => s.createPlan(plan));
      const id = p.today.snapshot().activePlanId;
      if (id) p.both((s) => s.removePlan(id));
    },
  },
  {
    name: "name-only edit",
    run: (p) => {
      const id = withPlan(p);
      p.both((s) => s.updatePlan(id, { name: "Only a name" }));
    },
  },
  {
    name: "activatePlan",
    run: (p) => {
      const id = withPlan(p);
      p.both((s) => s.activatePlan(id));
    },
  },
  {
    name: "table add, update and remove",
    run: (p) => {
      const id = withPlan(p);
      const table = p.table();
      p.both((s) => s.addTable(id, table));
      const tableId = p.firstTable(id);
      if (!tableId) return;
      const rect = p.table().rect;
      p.both((s) => s.updateTable(id, tableId, { rect }));
      p.both((s) => s.removeTable(id, tableId));
    },
  },
  {
    name: "draw a table that starts a plan, then move it and draw another past the room",
    run: (p) => {
      p.both((s) => s.activatePlan(null));
      const rect = p.latticeRect();
      p.both((s) => s.drawTable(rect));
      const planId = p.today.snapshot().activePlanId;
      const tableId = planId === null ? null : p.firstTable(planId);
      if (planId === null || tableId === null) return;
      const moved = {
        minX: rect.minX - 3 * CHUNK_LDU,
        minZ: rect.minZ - 2 * CHUNK_LDU,
        maxX: rect.maxX + CHUNK_LDU,
        maxZ: rect.maxZ,
      };
      p.both((s) => s.placeTable(planId, tableId, moved));
      const far = p.latticeRect();
      p.both((s) => s.drawTable(far));
      p.place();
    },
  },
  {
    name: "restore earlier plan states across a created and a removed plan",
    run: (p) => {
      const before = p.sutState();
      const plan = p.newPlan();
      p.both((s) => s.createPlan(plan));
      const created = p.sutState();
      const id = withPlan(p);
      const table = p.table();
      p.both((s) => s.addTable(id, table));
      p.both((s) => s.restore(created));
      p.both((s) => s.restore(before));
      p.both((s) => s.restore(created));
      p.place();
    },
  },
  {
    name: "flag laid track and a model carrying track unsupported, then lay, throw, remove and rebuild around the flags",
    run: (p) => {
      withPlan(p);
      p.trackLay(3);
      p.place();
      const carrier = p.models.at(-1)?.id ?? -1;
      p.both((s) => s.setUnsupported(new Set([0, 2, MAX_PIECES + 1]), new Set([carrier])));
      p.trackLay(1);
      p.switchThrow(0);
      p.remove();
      p.load();
    },
  },
  {
    name: "obstacle add, update and remove",
    run: (p) => {
      const id = withPlan(p);
      const obstacle = p.obstacle();
      p.both((s) => s.addObstacle(id, obstacle));
      const obstacleId = p.firstObstacle(id);
      if (!obstacleId) return;
      const rect = p.obstacle().rect;
      p.both((s) => s.updateObstacle(id, obstacleId, { rect }));
      p.both((s) => s.removeObstacle(id, obstacleId));
    },
  },
  {
    name: "negative and fractional mm",
    run: (p) => {
      const id = withPlan(p);
      p.both((s) =>
        s.addTable(id, {
          name: "Odd",
          rect: { x: -40, z: 12.5, width: 300.5, depth: 200 },
          heightMm: 750,
        }),
      );
    },
  },
  {
    name: "two overlapping regions",
    run: (p) => {
      const plan = p.newPlan();
      p.both((s) => s.createPlan(plan));
      p.both((s) =>
        s.createPlan({ ...plan, name: "Overlap", roomWidthMm: plan.roomWidthMm + 500 }),
      );
      p.place();
    },
  },
  {
    name: "unreadable first in order and recovery",
    run: (p) => {
      p.load();
      p.models.unshift(p.unreadableModel("minX"));
      p.load();
      recover(p);
    },
  },
  {
    name: "a second unreadable box",
    run: (p) =>
      unchecked(p, (q) => {
        q.place(q.unreadableModel("maxZ"));
        recover(q);
      }),
  },
  {
    name: "minY-only throw",
    run: (p) => {
      p.place(p.unreadableModel("minY"));
      recover(p);
    },
  },
  {
    name: "edits while unchecked",
    run: (p) =>
      unchecked(p, (q) => {
        const id = withPlan(q);
        q.place();
        q.remove(0);
        q.rotate(q.models.length - 1);
        q.road();
        q.undo();
        q.redo();
        q.trackLay(1);
        q.switchThrow(0);
        q.both((s) => s.updatePlan(id, { roomWidthMm: 3000 }));
        const table = q.table();
        q.both((s) => s.addTable(id, table));
        const obstacle = q.obstacle();
        q.both((s) => s.addObstacle(id, obstacle));
        q.both((s) => s.updatePlan(id, { name: "While unchecked" }));
        q.both((s) => s.activatePlan(id));
        q.both((s) => s.setTableTopY(16));
        q.load();
        recover(q);
      }),
  },
  {
    name: "odd boxes",
    run: (p) => {
      p.place(p.newModel({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 8, maxZ: 40 }));
      p.place(p.newModel({ minX: 3.25, minY: 0, minZ: 7.5, maxX: 1e15, maxY: 8, maxZ: 9 }));
      p.place(p.newModel({ minX: Number.NaN, minY: 0, minZ: 0, maxX: 10, maxY: 8, maxZ: 10 }));
    },
  },
  { name: "setTableTopY", run: (p) => p.both((s) => s.setTableTopY(-24)) },
  {
    name: "NaN reach",
    run: (p) => {
      const id = withPlan(p);
      p.both((s) => s.updatePlan(id, { maxOverhangMm: Number.NaN }));
      p.place();
    },
  },
  {
    name: "infinite reach",
    run: (p) => {
      const id = withPlan(p);
      p.both((s) => s.updatePlan(id, { maxOverhangMm: 4e307 }));
      p.place();
    },
  },
];

export function runSeed(seed: number): { mismatches: unknown[]; missed: string[] } {
  const pair = new Pair(seed, lcg(seed));
  let mandatory = 0;
  for (pair.step = 0; pair.step < EDITS; pair.step++) {
    const due = pair.step % MANDATORY_EVERY === 0 ? MANDATORY[mandatory] : undefined;
    if (due) {
      due.run(pair);
      pair.hit.add(due.name);
      mandatory++;
    } else {
      pair.randomEdit();
    }
    pair.compare();
    if (pair.mismatchList.length > 0) break;
  }
  return {
    mismatches: pair.mismatchList.slice(0, 3),
    missed: MANDATORY.map((c) => c.name).filter((name) => !pair.hit.has(name)),
  };
}
