import {
  AXIS_NEG_Y,
  AXIS_POS_Y,
  CELL_BOX_INTS,
  CandidatePoses,
  FootprintGrid,
  HEIGHT_BOX_INTS,
  MateReport,
  NO_OVERLAP,
  NO_PARTNER,
  NO_PART_INSTANCE,
  NO_SHAPE,
  ProposalProgress,
  VolumeIndex,
  firstOverlap,
  firstOverlapFrom,
  ModelConnectors,
  type CellParts,
  type CellVolumes,
  type ConnectionSolver,
  type ConnectorTable,
  type LatticePose,
  type OverlapHit,
  type PartInstances,
  type SnapMating,
  type SnapWindow,
  type TechnicSet,
  type TrackEnd,
  type VolumeHit,
} from "@brr/domain";
import { PLATE_LDU, SIXTEENTHS_PER_LDU, STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import { inject, injectable } from "inversify";
import { CONNECTION_SOLVER, SNAP_MATING } from "../tokens.ts";
import { TRACK_FAMILY } from "./finders.ts";
import { MateZones, type PlacedParts } from "./mate-zones.ts";
import { BLOCKED, FREE, PoseMemo, UNKNOWN } from "./pose-memo.ts";
import type { FrozenTechnic } from "./frozen-technic.ts";
import type { PartBoxes } from "./part-boxes.ts";
import type { FrozenVolumes } from "./placeable-volumes.ts";

const HALF_STUD_LDU = STUD_LDU / 2;
const ORIGIN_INTS = 3;
const X = 0;
const Y = 1;
const Z = 2;
const HANGS = 0;
const RESTS = 1;
const RESTS_PRESSING_UP = 2;
const NO_PLACEMENT = -1;
const NO_PLACEMENTS: ReadonlySet<number> = new Set();

export const SETTLED_AT_ONCE = 0;

export type SearchStep = "settled" | "running" | "stale";

export interface PlacementChoice {
  accepted: boolean;
  x: number;
  z: number;
  yPlates: number;
  rot: number;
  votes: number;
  walked: number;
  waitingOn: number;
  waitFailed: boolean;
  readonly overlap: OverlapHit;
}

export const NOT_WAITING = -1;

export type Stranding =
  | { readonly kind: "none" }
  | { readonly kind: "stranded"; readonly placement: number }
  | { readonly kind: "waiting"; readonly placement: number; readonly failed: boolean };

const NOT_STRANDED: Stranding = { kind: "none" };

export interface SearchReach {
  readonly cells: number;
  readonly plates: number;
  readonly turns: number;
  readonly firstTurn: number;
}

const AT_POSE_ONLY: SearchReach = { cells: 0, plates: 0, turns: 1, firstTurn: 0 };

export function placementChoice(): PlacementChoice {
  return {
    accepted: false,
    x: 0,
    z: 0,
    yPlates: 0,
    rot: 0,
    votes: 0,
    walked: 0,
    waitingOn: NOT_WAITING,
    waitFailed: false,
    overlap: {
      owner: NO_PLACEMENT,
      instance: NO_PART_INSTANCE,
      candidateInstance: NO_PART_INSTANCE,
      bottomLdu: 0,
      topLdu: 0,
      cellX: 0,
      cellZ: 0,
      candidateBottomLdu: 0,
      candidateTopLdu: 0,
    },
  };
}

export type RestsOnTable = (placement: number) => boolean;

export interface PlacementWindow extends SnapWindow {
  readonly radiusLdu: number;
  readonly firstTurn: number;
}

export interface IPlacementSearch {
  model(
    parts: ReadonlyArray<ConnectorTable | null>,
    instances: PartInstances,
    trackEnds: ReadonlyArray<TrackEnd>,
  ): ModelConnectors;
  add(
    placement: number,
    model: ModelConnectors,
    volumes: FrozenVolumes,
    boxes: PartBoxes,
    technic: FrozenTechnic,
    pose: LatticePose,
  ): void;
  awaitTables(placement: number, volumes: CellVolumes, pose: LatticePose): void;
  tablesFailed(placement: number): void;
  remove(placement: number): void;
  clear(): void;
  search(
    model: ModelConnectors,
    volumes: CellVolumes,
    boxes: PartBoxes,
    technic: TechnicSet,
    window: PlacementWindow,
    tableYPlates: number,
    moving: number | null,
    out: PlacementChoice,
  ): void;
  begin(
    model: ModelConnectors,
    volumes: CellVolumes,
    boxes: PartBoxes,
    technic: TechnicSet,
    window: PlacementWindow,
    tableYPlates: number,
    moving: number | null,
    out: PlacementChoice,
  ): number;
  advance(ticket: number, deadlineMs: number): SearchStep;
  cancel(): void;
  evaluate(model: ModelConnectors, pose: LatticePose, out: MateReport): void;
  restingOn(volumes: CellVolumes, pose: LatticePose, moving: number | null): ReadonlyArray<number>;
  strandedByRemoval(placements: ReadonlySet<number>, restsOnTable: RestsOnTable): Stranding;
  withdrawn<T>(placements: ReadonlySet<number>, during: () => T): T;
  check(
    model: ModelConnectors,
    volumes: CellVolumes,
    boxes: PartBoxes,
    technic: TechnicSet,
    pose: LatticePose,
    tableYPlates: number,
    out: PlacementChoice,
  ): void;
  revision(): number;
  has(placement: number): boolean;
  holdingMates(placement: number): number;
  overlapOf(placement: number): number;
  standsOnTable(placement: number, tableYPlates: number): boolean;
}

interface Placed extends PlacedParts {
  readonly model: ModelConnectors;
  readonly volumes: FrozenVolumes;
  readonly technic: FrozenTechnic;
  readonly row: number;
  readonly grid: FootprintGrid;
  readonly verticalX0: number;
  readonly verticalZ0: number;
  readonly verticalX1: number;
  readonly verticalZ1: number;
}

function verticalBoxesMeet(a: Placed, b: Placed): boolean {
  return (
    a.verticalX0 <= b.verticalX1 &&
    b.verticalX0 <= a.verticalX1 &&
    a.verticalZ0 <= b.verticalZ1 &&
    b.verticalZ0 <= a.verticalZ1
  );
}

function meetsAnyVerticalBox(
  placed: Placed,
  removed: ReadonlyArray<readonly [number, Placed]>,
): boolean {
  for (let r = 0; r < removed.length; r++) {
    const other = removed[r];
    if (other && verticalBoxesMeet(placed, other[1])) return true;
  }
  return false;
}

const TURNS = 4;
const INITIAL_KEYS = 64;
const TURN_KEYS = 3 * TURNS;
const NO_REGION = -1;
const COVER_ATTEMPTS = 2;
const HINTS = 8;
const PROPOSAL_SLOTS = 64;
const PHASE_IDLE = 0;
const PHASE_COVER = 1;
const PHASE_WALK = 2;
const COVER_HELD = 0;
const COVER_TURNED = 1;
const COVER_DONE = 0;
const COVER_RUNNING = 1;
const COVER_NO_ROOM = 2;
const AWAITED_ID = 0;
const AWAITED_X0 = 1;
const AWAITED_Z0 = 2;
const AWAITED_X1 = 3;
const AWAITED_Z1 = 4;
const AWAITED_BOTTOM = 5;
const AWAITED_TOP = 6;
const AWAITED_FAILED = 7;
const AWAITED_INTS = 8;
const NO_SLOT = -1;
const INITIAL_AWAITED = 4;
const TOUCHING_CELLS = 1;

class Reach {
  x0 = 0;
  z0 = 0;
  x1 = 0;
  z1 = 0;
  bottom = 0;
  top = 0;
  empty = true;

  start(): this {
    this.empty = true;
    return this;
  }

  grow(world: CellVolumes): this {
    for (let c = 0; c < world.count; c++) {
      const bottom = world.bottomLdu[c] ?? 0;
      const top = world.topLdu[c] ?? 0;
      if (top <= bottom) continue;
      const x = world.cellX[c] ?? 0;
      const z = world.cellZ[c] ?? 0;
      if (this.empty) {
        this.x0 = this.x1 = x;
        this.z0 = this.z1 = z;
        this.bottom = bottom;
        this.top = top;
        this.empty = false;
        continue;
      }
      this.x0 = Math.min(this.x0, x);
      this.z0 = Math.min(this.z0, z);
      this.x1 = Math.max(this.x1, x);
      this.z1 = Math.max(this.z1, z);
      this.bottom = Math.min(this.bottom, bottom);
      this.top = Math.max(this.top, top);
    }
    return this;
  }

  copy(from: Reach): this {
    this.x0 = from.x0;
    this.z0 = from.z0;
    this.x1 = from.x1;
    this.z1 = from.z1;
    this.bottom = from.bottom;
    this.top = from.top;
    this.empty = from.empty;
    return this;
  }

  planGapSquared(awaited: Int32Array, at: number): number {
    if (this.empty) return 0;
    const gapX = Math.max(
      0,
      (awaited[at + AWAITED_X0] ?? 0) - this.x1,
      this.x0 - (awaited[at + AWAITED_X1] ?? 0),
    );
    const gapZ = Math.max(
      0,
      (awaited[at + AWAITED_Z0] ?? 0) - this.z1,
      this.z0 - (awaited[at + AWAITED_Z1] ?? 0),
    );
    return gapX * gapX + gapZ * gapZ;
  }

  widen(cells: number, ldu: number): this {
    this.x0 -= cells;
    this.z0 -= cells;
    this.x1 += cells;
    this.z1 += cells;
    this.bottom -= ldu;
    this.top += ldu;
    return this;
  }

  touches(awaited: Int32Array, at: number): boolean {
    return (
      !this.empty &&
      (awaited[at + AWAITED_X0] ?? 0) <= this.x1 &&
      (awaited[at + AWAITED_X1] ?? 0) >= this.x0 &&
      (awaited[at + AWAITED_Z0] ?? 0) <= this.z1 &&
      (awaited[at + AWAITED_Z1] ?? 0) >= this.z0 &&
      (awaited[at + AWAITED_BOTTOM] ?? 0) <= this.top &&
      (awaited[at + AWAITED_TOP] ?? 0) >= this.bottom
    );
  }
}

class Bounds {
  cellX0 = 0;
  cellZ0 = 0;
  width = 0;
  depth = 0;

  measure(world: CellVolumes): this {
    let x0 = 0;
    let z0 = 0;
    let x1 = -1;
    let z1 = -1;
    for (let c = 0; c < world.count; c++) {
      const x = world.cellX[c] ?? 0;
      const z = world.cellZ[c] ?? 0;
      if (c === 0 || x < x0) x0 = x;
      if (c === 0 || z < z0) z0 = z;
      if (c === 0 || x > x1) x1 = x;
      if (c === 0 || z > z1) z1 = z;
    }
    this.cellX0 = x0;
    this.cellZ0 = z0;
    this.width = x1 - x0 + 1;
    this.depth = z1 - z0 + 1;
    return this;
  }
}

class VerticalBox {
  x0 = Number.POSITIVE_INFINITY;
  z0 = Number.POSITIVE_INFINITY;
  x1 = Number.NEGATIVE_INFINITY;
  z1 = Number.NEGATIVE_INFINITY;

  measure(model: ModelConnectors, pose: LatticePose): this {
    const rot = isRot90(pose.rot) ? pose.rot : 0;
    const cos = rot90Cos(rot);
    const sin = rot90Sin(rot);
    const offsetX = pose.x * SIXTEENTHS_PER_LDU;
    const offsetZ = pose.z * SIXTEENTHS_PER_LDU;
    this.x0 = Number.POSITIVE_INFINITY;
    this.z0 = Number.POSITIVE_INFINITY;
    this.x1 = Number.NEGATIVE_INFINITY;
    this.z1 = Number.NEGATIVE_INFINITY;
    for (let c = 0; c < model.count; c++) {
      const axis = model.axis[c];
      if (axis !== AXIS_POS_Y && axis !== AXIS_NEG_Y) continue;
      const mx = model.origin[c * ORIGIN_INTS + X] ?? 0;
      const mz = model.origin[c * ORIGIN_INTS + Z] ?? 0;
      const x = cos * mx + sin * mz + offsetX;
      const z = -sin * mx + cos * mz + offsetZ;
      this.x0 = Math.min(this.x0, x);
      this.z0 = Math.min(this.z0, z);
      this.x1 = Math.max(this.x1, x);
      this.z1 = Math.max(this.z1, z);
    }
    return this;
  }
}

const NO_CELL_PARTS: CellParts = {
  start: new Int32Array(1),
  instance: new Uint32Array(0),
  cellBox: new Int16Array(0),
  heightBox: new Int32Array(0),
};

class VolumeBuffer implements CellVolumes {
  count = 0;
  cellX: Int32Array;
  cellZ: Int32Array;
  bottomLdu: Int32Array;
  topLdu: Int32Array;
  partsAt: Int32Array;
  parts: CellParts = NO_CELL_PARTS;
  turn = 0;
  sixteenthsUp = 0;

  constructor(capacity: number) {
    this.cellX = new Int32Array(capacity);
    this.cellZ = new Int32Array(capacity);
    this.bottomLdu = new Int32Array(capacity);
    this.topLdu = new Int32Array(capacity);
    this.partsAt = new Int32Array(capacity);
  }

  place(local: CellVolumes, pose: LatticePose): this {
    if (this.cellX.length < local.count) {
      this.cellX = new Int32Array(local.count);
      this.cellZ = new Int32Array(local.count);
      this.bottomLdu = new Int32Array(local.count);
      this.topLdu = new Int32Array(local.count);
      this.partsAt = new Int32Array(local.count);
    }
    this.posedAs(local, pose);
    for (let c = 0; c < local.count; c++) placeCell(local, pose, c, this, c);
    this.count = local.count;
    return this;
  }

  posedAs(local: CellVolumes, pose: LatticePose): void {
    this.parts = local.parts;
    this.turn = (local.turn + (isRot90(pose.rot) ? pose.rot : 0)) % TURNS;
    this.sixteenthsUp = local.sixteenthsUp + pose.yPlates * PLATE_LDU * SIXTEENTHS_PER_LDU;
  }
}

const CELL_SIXTEENTHS = STUD_LDU * SIXTEENTHS_PER_LDU;
const BOX_X1 = 2;
const BOX_Z1 = 3;
const BOTTOM = 0;
const TOP = 1;

class SlabUnder implements CellVolumes {
  readonly count = 1;
  readonly cellX = new Int32Array(1);
  readonly cellZ = new Int32Array(1);
  readonly bottomLdu = new Int32Array(1);
  readonly topLdu = new Int32Array(1);
  readonly partsAt = new Int32Array(1);
  readonly turn = 0;
  readonly sixteenthsUp = 0;
  private readonly heightBox = new Int32Array(HEIGHT_BOX_INTS);
  readonly parts: CellParts;

  constructor() {
    const cellBox = new Int16Array(CELL_BOX_INTS);
    cellBox[BOX_X1] = CELL_SIXTEENTHS;
    cellBox[BOX_Z1] = CELL_SIXTEENTHS;
    this.parts = {
      start: Int32Array.of(0, 1),
      instance: Int32Array.of(NO_PART_INSTANCE),
      cellBox,
      heightBox: this.heightBox,
    };
  }

  under(cellX: number, cellZ: number, bottomLdu: number): this {
    this.cellX[0] = cellX;
    this.cellZ[0] = cellZ;
    this.bottomLdu[0] = bottomLdu - 1;
    this.topLdu[0] = bottomLdu;
    this.heightBox[BOTTOM] = (bottomLdu - 1) * SIXTEENTHS_PER_LDU;
    this.heightBox[TOP] = bottomLdu * SIXTEENTHS_PER_LDU;
    return this;
  }
}

function placeCell(
  local: CellVolumes,
  pose: LatticePose,
  c: number,
  out: VolumeBuffer,
  at: number,
): void {
  const rot = isRot90(pose.rot) ? pose.rot : 0;
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  const yLdu = pose.yPlates * PLATE_LDU;
  const cx = (local.cellX[c] ?? 0) * STUD_LDU + HALF_STUD_LDU;
  const cz = (local.cellZ[c] ?? 0) * STUD_LDU + HALF_STUD_LDU;
  out.cellX[at] = Math.floor((cos * cx + sin * cz + pose.x) / STUD_LDU);
  out.cellZ[at] = Math.floor((-sin * cx + cos * cz + pose.z) / STUD_LDU);
  out.bottomLdu[at] = (local.bottomLdu[c] ?? 0) + yLdu;
  out.topLdu[at] = (local.topLdu[c] ?? 0) + yLdu;
  out.partsAt[at] = local.partsAt[c] ?? 0;
}

function copyHit(from: OverlapHit, to: OverlapHit): void {
  to.owner = from.owner;
  to.instance = from.instance;
  to.candidateInstance = from.candidateInstance;
  to.bottomLdu = from.bottomLdu;
  to.topLdu = from.topLdu;
  to.cellX = from.cellX;
  to.cellZ = from.cellZ;
  to.candidateBottomLdu = from.candidateBottomLdu;
  to.candidateTopLdu = from.candidateTopLdu;
}

class Pose implements LatticePose {
  x = 0;
  z = 0;
  yPlates = 0;
  rot = 0;
}

class RegionWindow implements SnapWindow {
  x = 0;
  z = 0;
  yPlates = 0;
  rot = 0;
  cells = NO_REGION;
  plates = 0;
  turns = 1;

  copy(from: SnapWindow): void {
    this.x = from.x;
    this.z = from.z;
    this.yPlates = from.yPlates;
    this.rot = from.rot;
    this.cells = from.cells;
    this.plates = from.plates;
    this.turns = from.turns;
  }
}

class Candidate {
  found = false;
  key = 0;
  reach = 0;
  joints = 0;
  votes = 0;

  reset(): void {
    this.found = false;
  }

  consider(key: number, reach: number, joints: number, votes: number): void {
    if (
      this.found &&
      (reach !== this.reach ||
        joints < this.joints ||
        (joints === this.joints && votes <= this.votes))
    ) {
      return;
    }
    this.found = true;
    this.key = key;
    this.reach = reach;
    this.joints = joints;
    this.votes = votes;
  }
}

class Flight implements PlacementWindow {
  x = 0;
  z = 0;
  yPlates = 0;
  rot = 0;
  cells = 0;
  plates = 0;
  turns = 1;
  radiusLdu = 0;
  firstTurn = 0;
  model: ModelConnectors | null = null;
  volumes: CellVolumes | null = null;
  boxes: PartBoxes | null = null;
  technic: TechnicSet | null = null;
  out: PlacementChoice | null = null;
  tableYPlates = 0;
  moving = NO_PLACEMENT;
  revision = -1;
  keyCount = 0;
  nextKey = 0;
  readonly resting = new Candidate();
  coverAttempt = 0;
  coverStage = COVER_HELD;
  covering = false;
  phase = PHASE_IDLE;
  ticket = SETTLED_AT_ONCE;

  copyWindow(window: PlacementWindow): void {
    this.x = window.x;
    this.z = window.z;
    this.yPlates = window.yPlates;
    this.rot = window.rot;
    this.cells = window.cells;
    this.plates = window.plates;
    this.turns = window.turns;
    this.radiusLdu = window.radiusLdu;
    this.firstTurn = window.firstTurn;
  }

  release(): void {
    this.phase = PHASE_IDLE;
    this.covering = false;
    this.model = null;
    this.volumes = null;
    this.boxes = null;
    this.technic = null;
    this.out = null;
    this.ticket++;
  }
}

function reachesBeyondCursor(window: PlacementWindow): boolean {
  return window.radiusLdu > 0 || window.plates > 0 || window.turns > 1;
}

function quarterTurnsBetween(a: number, b: number): number {
  const turns = (((a - b) % TURNS) + TURNS) % TURNS;
  return Math.min(turns, TURNS - turns);
}

@injectable()
export class PlacementSearch implements IPlacementSearch {
  private readonly volumes = new VolumeIndex();
  private readonly placed = new Map<number, Placed>();
  private readonly report = new MateReport();
  private readonly tieReport = new MateReport();
  private keys = new Float64Array(INITIAL_KEYS);
  private readonly proposals = new CandidatePoses();
  private readonly memo = new PoseMemo();
  private readonly heldRegion = new RegionWindow();
  private readonly turnedRegion = new RegionWindow();
  private readonly proposing = new RegionWindow();
  private readonly progress = new ProposalProgress();
  private readonly flight = new Flight();
  private memoModel: ModelConnectors | null = null;
  private memoRevision = -1;
  private memoMoving = NO_PLACEMENT;
  private edits = 0;
  private readonly countPose = new Pose();
  private readonly oneCell = new VolumeBuffer(1);
  private readonly slab = new SlabUnder();
  private readonly hints = new Int32Array(HINTS).fill(NO_OVERLAP);
  private nextHint = 0;
  private readonly scratch = new VolumeBuffer(0);
  private readonly pose = new Pose();
  private readonly hit = placementChoice().overlap;
  private readonly contact: VolumeHit = {
    owner: NO_PLACEMENT,
    instance: NO_PART_INSTANCE,
    bottomLdu: 0,
    topLdu: 0,
  };
  private readonly zones = new MateZones();
  private readonly bounds = new Bounds();
  private readonly verticalBox = new VerticalBox();
  private readonly reach = new Reach();
  private readonly footprint = new Reach();
  private readonly reachPose = new Pose();
  private awaited = new Int32Array(INITIAL_AWAITED * AWAITED_INTS);
  private awaitedCount = 0;
  private readonly grids = new Map<FrozenVolumes, Array<FootprintGrid | undefined>>();
  private readonly gridUses = new Map<FootprintGrid, number>();
  private moving = NO_PLACEMENT;
  private withheld = NO_PLACEMENTS;
  private lowestModel: ModelConnectors | null = null;
  private lowestY = Number.POSITIVE_INFINITY;
  private standing = NO_PLACEMENT;

  constructor(
    @inject(CONNECTION_SOLVER) private readonly solver: ConnectionSolver,
    @inject(SNAP_MATING) private readonly mating: SnapMating,
  ) {}

  private readonly isStanding = (owner: number): boolean => owner === this.standing;

  private readonly exempt = (
    owner: number,
    cellX: number,
    cellZ: number,
    heldCell: number,
  ): boolean =>
    owner === this.moving ||
    (this.withheld.size > 0 && this.withheld.has(owner)) ||
    this.zones.exempts(owner, cellX, cellZ, heldCell);

  model(
    parts: ReadonlyArray<ConnectorTable | null>,
    instances: PartInstances,
    trackEnds: ReadonlyArray<TrackEnd>,
  ): ModelConnectors {
    return ModelConnectors.fromParts(parts, instances, this.mating, trackEnds);
  }

  add(
    placement: number,
    model: ModelConnectors,
    volumes: FrozenVolumes,
    boxes: PartBoxes,
    technic: FrozenTechnic,
    pose: LatticePose,
  ): void {
    if (this.placed.has(placement))
      throw new RangeError(`placement ${placement} is already placed`);
    this.forget(placement);
    const at: LatticePose = { x: pose.x, z: pose.z, yPlates: pose.yPlates, rot: pose.rot };
    const world = this.scratch.place(volumes, at);
    const bounds = this.bounds.measure(world);
    const yLdu = at.yPlates * PLATE_LDU;
    const grid = this.gridFor(volumes, at.rot, world, yLdu);
    const row = this.volumes.add(placement, grid, bounds.cellX0, bounds.cellZ0, yLdu);
    this.edits++;
    this.solver.insert(model, at, placement);
    const vertical = this.verticalBox.measure(model, at);
    this.placed.set(placement, {
      model,
      volumes,
      boxes,
      technic,
      pose: at,
      row,
      grid,
      verticalX0: vertical.x0,
      verticalZ0: vertical.z0,
      verticalX1: vertical.x1,
      verticalZ1: vertical.z1,
    });
  }

  awaitTables(placement: number, volumes: CellVolumes, pose: LatticePose): void {
    if (this.placed.has(placement) || this.awaitedAt(placement) !== NOT_WAITING) {
      throw new RangeError(`placement ${placement} is already in the search`);
    }
    const reach = this.reach.start().grow(this.scratch.place(volumes, pose));
    if (this.awaited.length < (this.awaitedCount + 1) * AWAITED_INTS) {
      const grown = new Int32Array(this.awaited.length * 2);
      grown.set(this.awaited);
      this.awaited = grown;
    }
    const at = this.awaitedCount++ * AWAITED_INTS;
    this.awaited[at + AWAITED_ID] = placement;
    this.awaited[at + AWAITED_X0] = reach.empty ? 0 : reach.x0;
    this.awaited[at + AWAITED_Z0] = reach.empty ? 0 : reach.z0;
    this.awaited[at + AWAITED_X1] = reach.empty ? -1 : reach.x1;
    this.awaited[at + AWAITED_Z1] = reach.empty ? -1 : reach.z1;
    this.awaited[at + AWAITED_BOTTOM] = reach.bottom;
    this.awaited[at + AWAITED_TOP] = reach.top;
    this.awaited[at + AWAITED_FAILED] = 0;
    this.edits++;
  }

  tablesFailed(placement: number): void {
    const a = this.awaitedAt(placement);
    if (a === NOT_WAITING) throw new RangeError(`placement ${placement} is not awaiting tables`);
    this.awaited[a * AWAITED_INTS + AWAITED_FAILED] = 1;
    this.edits++;
  }

  private awaitedAt(placement: number): number {
    for (let a = 0; a < this.awaitedCount; a++) {
      if (this.awaited[a * AWAITED_INTS + AWAITED_ID] === placement) return a;
    }
    return NOT_WAITING;
  }

  private forget(placement: number): boolean {
    const a = this.awaitedAt(placement);
    if (a === NOT_WAITING) return false;
    const last = --this.awaitedCount;
    this.awaited.copyWithin(a * AWAITED_INTS, last * AWAITED_INTS, (last + 1) * AWAITED_INTS);
    this.edits++;
    return true;
  }

  private awaitedTouching(reach: Reach, nearest: Reach): number {
    let chosen = NO_SLOT;
    for (let a = 0; a < this.awaitedCount; a++) {
      const at = a * AWAITED_INTS;
      const id = this.awaited[at + AWAITED_ID] ?? NOT_WAITING;
      if (id === this.moving || (this.withheld.size > 0 && this.withheld.has(id))) continue;
      if (!reach.touches(this.awaited, at)) continue;
      if (chosen === NO_SLOT || this.awaitedBefore(a, chosen, nearest)) chosen = a;
    }
    return chosen;
  }

  private awaitedBefore(a: number, b: number, nearest: Reach): boolean {
    const atA = a * AWAITED_INTS;
    const atB = b * AWAITED_INTS;
    const failedA = this.awaited[atA + AWAITED_FAILED] ?? 0;
    const failedB = this.awaited[atB + AWAITED_FAILED] ?? 0;
    if (failedA !== failedB) return failedA > failedB;
    const gapA = nearest.planGapSquared(this.awaited, atA);
    const gapB = nearest.planGapSquared(this.awaited, atB);
    if (gapA !== gapB) return gapA < gapB;
    return (this.awaited[atA + AWAITED_ID] ?? 0) < (this.awaited[atB + AWAITED_ID] ?? 0);
  }

  private chooseAwaited(slot: number, out: PlacementChoice): void {
    out.waitingOn =
      slot === NO_SLOT ? NOT_WAITING : (this.awaited[slot * AWAITED_INTS + AWAITED_ID] ?? 0);
    out.waitFailed = slot !== NO_SLOT && this.awaited[slot * AWAITED_INTS + AWAITED_FAILED] === 1;
  }

  private awaitedWithin(volumes: CellVolumes, at: LatticePose, window: SearchReach): number {
    if (this.awaitedCount === 0) return NO_SLOT;
    const pose = this.reachPose;
    pose.x = at.x;
    pose.z = at.z;
    pose.yPlates = at.yPlates;
    pose.rot = at.rot;
    const footprint = this.footprint.start().grow(this.scratch.place(volumes, pose));
    const reach = this.reach.copy(footprint);
    for (let turn = window.firstTurn; turn < window.turns; turn++) {
      if (turn === 0) continue;
      pose.rot = (at.rot + turn) % TURNS;
      reach.grow(this.scratch.place(volumes, pose));
    }
    return this.awaitedTouching(
      reach.widen(window.cells + TOUCHING_CELLS, window.plates * PLATE_LDU),
      footprint,
    );
  }

  remove(placement: number): void {
    if (this.forget(placement)) return;
    const placed = this.placed.get(placement);
    if (!placed) throw new RangeError(`placement ${placement} is not placed`);
    this.volumes.remove(placed.row);
    this.edits++;
    this.release(placed);
    this.solver.remove(placed.model, placed.pose, placement);
    this.placed.delete(placement);
  }

  clear(): void {
    for (const placement of this.placed.keys()) this.remove(placement);
    if (this.awaitedCount > 0) this.edits++;
    this.awaitedCount = 0;
  }

  search(
    model: ModelConnectors,
    volumes: CellVolumes,
    boxes: PartBoxes,
    technic: TechnicSet,
    window: PlacementWindow,
    tableYPlates: number,
    moving: number | null,
    out: PlacementChoice,
  ): void {
    const ticket = this.begin(model, volumes, boxes, technic, window, tableYPlates, moving, out);
    if (ticket !== SETTLED_AT_ONCE) this.advance(ticket, Number.POSITIVE_INFINITY);
  }

  begin(
    model: ModelConnectors,
    volumes: CellVolumes,
    boxes: PartBoxes,
    technic: TechnicSet,
    window: PlacementWindow,
    tableYPlates: number,
    moving: number | null,
    out: PlacementChoice,
  ): number {
    this.cancel();
    this.moving = moving ?? NO_PLACEMENT;
    out.walked = 0;
    this.atCursor(model, volumes, boxes, technic, window, window, tableYPlates, out);
    this.zones.clear();
    const matedAtCursor = out.waitingOn === NOT_WAITING && out.accepted && out.votes > 0;
    if (
      out.waitingOn !== NOT_WAITING ||
      !reachesBeyondCursor(window) ||
      (matedAtCursor && this.support(model, this.pose, tableYPlates) !== HANGS)
    ) {
      this.moving = NO_PLACEMENT;
      return SETTLED_AT_ONCE;
    }
    const flight = this.flight;
    flight.copyWindow(window);
    flight.model = model;
    flight.volumes = volumes;
    flight.boxes = boxes;
    flight.technic = technic;
    flight.tableYPlates = tableYPlates;
    flight.moving = this.moving;
    flight.out = out;
    flight.revision = this.edits;
    flight.keyCount = this.reachOrder(flight, tableYPlates);
    this.prepareMemo(model, flight.keyCount);
    flight.nextKey = 0;
    flight.resting.reset();
    flight.coverAttempt = 0;
    flight.coverStage = COVER_HELD;
    flight.covering = false;
    flight.phase = PHASE_COVER;
    this.moving = NO_PLACEMENT;
    return flight.ticket;
  }

  advance(ticket: number, deadlineMs: number): SearchStep {
    const flight = this.flight;
    if (ticket !== flight.ticket || flight.phase === PHASE_IDLE) return "stale";
    if (flight.revision !== this.edits) {
      this.cancel();
      return "stale";
    }
    this.moving = flight.moving;
    if (flight.phase === PHASE_COVER && this.coverStep(flight, deadlineMs)) {
      flight.phase = PHASE_WALK;
    }
    const settled = flight.phase === PHASE_WALK && this.walkStep(flight, deadlineMs);
    this.moving = NO_PLACEMENT;
    this.zones.clear();
    if (!settled) return "running";
    this.finishWalk(flight);
    this.cancel();
    return "settled";
  }

  cancel(): void {
    this.flight.release();
  }

  private atCursor(
    model: ModelConnectors,
    volumes: CellVolumes,
    boxes: PartBoxes,
    technic: TechnicSet,
    window: LatticePose,
    reach: SearchReach,
    tableYPlates: number,
    out: PlacementChoice,
  ): void {
    const pose = this.pose;
    pose.x = window.x;
    pose.z = window.z;
    pose.yPlates = window.yPlates;
    pose.rot = window.rot;
    this.chooseAt(out, pose, this.solver.votes(model, pose));
    out.walked++;
    out.accepted = false;
    this.chooseAwaited(this.awaitedWithin(volumes, pose, reach), out);
    if (out.waitingOn !== NOT_WAITING) return;
    if (pose.yPlates < tableYPlates) return;
    if (this.blocked(model, volumes, boxes, technic, pose, out.votes > 0, false)) {
      copyHit(this.hit, out.overlap);
      return;
    }
    out.accepted = out.votes > 0 || pose.yPlates === tableYPlates;
  }

  private prepareMemo(model: ModelConnectors, count: number): void {
    if (
      model === this.memoModel &&
      this.edits === this.memoRevision &&
      this.moving === this.memoMoving &&
      this.memo.roomFor(count)
    ) {
      return;
    }
    this.memo.reset();
    this.memoModel = model;
    this.memoRevision = this.edits;
    this.memoMoving = this.moving;
    this.heldRegion.cells = NO_REGION;
    this.turnedRegion.cells = NO_REGION;
  }

  private coverStep(flight: Flight, deadlineMs: number): boolean {
    for (;;) {
      const held = flight.coverStage === COVER_HELD;
      const turns = held ? 1 : flight.turns - 1;
      if ((held && flight.firstTurn !== 0) || turns <= 0) {
        if (!held) return true;
        flight.coverStage = COVER_TURNED;
        continue;
      }
      const region = held ? this.heldRegion : this.turnedRegion;
      const rot = held ? flight.rot : (flight.rot + 1) % TURNS;
      const covered = this.coverRegion(flight, region, rot, turns, deadlineMs);
      if (covered === COVER_RUNNING) return false;
      if (covered === COVER_NO_ROOM) {
        this.memo.reset();
        this.heldRegion.cells = NO_REGION;
        this.turnedRegion.cells = NO_REGION;
        flight.coverAttempt++;
        flight.coverStage = COVER_HELD;
        continue;
      }
      if (!held) return true;
      flight.coverStage = COVER_TURNED;
    }
  }

  private coverRegion(
    flight: Flight,
    region: RegionWindow,
    rot: number,
    turns: number,
    deadlineMs: number,
  ): number {
    const proposing = this.proposing;
    if (!flight.covering) {
      if (
        region.cells !== NO_REGION &&
        region.rot === rot &&
        region.turns >= turns &&
        Math.abs(flight.x - region.x) + flight.cells * STUD_LDU <= region.cells * STUD_LDU &&
        Math.abs(flight.z - region.z) + flight.cells * STUD_LDU <= region.cells * STUD_LDU &&
        Math.abs(flight.yPlates - region.yPlates) + flight.plates <= region.plates
      ) {
        return COVER_DONE;
      }
      proposing.x = flight.x;
      proposing.z = flight.z;
      proposing.yPlates = flight.yPlates;
      proposing.rot = rot;
      proposing.turns = turns;
      proposing.cells = flight.cells;
      proposing.plates = flight.plates;
      this.progress.restart();
      flight.covering = true;
    }
    const model = flight.model;
    if (!model) throw new Error("a placement search flight lost its held model");
    const proposals = this.proposals;
    while (
      !this.solver.proposeMatesFrom(model, proposing, proposals, this.progress, PROPOSAL_SLOTS)
    ) {
      if (performance.now() >= deadlineMs) return COVER_RUNNING;
    }
    flight.covering = false;
    const lastAttempt = flight.coverAttempt >= COVER_ATTEMPTS - 1;
    if (!lastAttempt && !this.memo.roomFor(flight.keyCount + proposals.count)) return COVER_NO_ROOM;
    region.copy(proposing);
    for (let q = 0; q < proposals.count; q++) {
      const x = proposals.x[q] ?? 0;
      const z = proposals.z[q] ?? 0;
      if ((x - flight.x) % STUD_LDU !== 0 || (z - flight.z) % STUD_LDU !== 0) continue;
      const slot = this.memo.slot(x, z, proposals.yPlates[q] ?? 0, proposals.rot[q] ?? 0);
      this.memo.proposed[slot] = 1;
    }
    return COVER_DONE;
  }

  private walkStep(flight: Flight, deadlineMs: number): boolean {
    const model = flight.model;
    const volumes = flight.volumes;
    const boxes = flight.boxes;
    const technic = flight.technic;
    const out = flight.out;
    if (!model || !volumes || !boxes || !technic || !out) {
      throw new Error("a placement search flight lost its held model");
    }
    const memo = this.memo;
    const pose = this.pose;
    let first = true;
    while (flight.nextKey < flight.keyCount) {
      if (!first && performance.now() >= deadlineMs) return false;
      first = false;
      const key = this.keys[flight.nextKey++] ?? 0;
      const reach = this.decode(flight, key, pose);
      if (flight.resting.found && reach > flight.resting.reach) {
        flight.nextKey = flight.keyCount;
        return true;
      }
      const slot = memo.slot(pose.x, pose.z, pose.yPlates, pose.rot);
      if (memo.dense[slot] === UNKNOWN) this.countLevel(model, flight, pose.rot, pose.yPlates);
      const dense = memo.dense[slot] ?? 0;
      const proposed = memo.proposed[slot] === 1;
      if (dense === 0 && !proposed) continue;
      if (memo.verdict[slot] === 0) {
        const blocked = this.blocked(model, volumes, boxes, technic, pose, proposed, true);
        memo.verdict[slot] = blocked ? BLOCKED : FREE;
      }
      if (memo.verdict[slot] === BLOCKED) continue;
      const votes = dense + this.proposalAt(model, pose, slot);
      if (votes === 0) continue;
      out.walked++;
      if (this.support(model, pose, flight.tableYPlates) !== RESTS) continue;
      flight.resting.consider(key, reach, this.tieReport.jointCount, votes);
    }
    return true;
  }

  private finishWalk(flight: Flight): void {
    const out = flight.out;
    const chosen = flight.resting;
    if (!chosen.found || !out) return;
    const pose = this.pose;
    this.decode(flight, chosen.key, pose);
    this.chooseAt(out, pose, chosen.votes);
    out.accepted = true;
  }

  private proposalAt(model: ModelConnectors, pose: LatticePose, slot: number): number {
    const memo = this.memo;
    if (memo.proposed[slot] === 0) return 0;
    if (memo.proposal[slot] === UNKNOWN)
      memo.proposal[slot] = this.solver.proposalVotes(model, pose);
    return memo.proposal[slot] ?? 0;
  }

  private countLevel(
    model: ModelConnectors,
    window: PlacementWindow,
    rot: number,
    yPlates: number,
  ): void {
    const memo = this.memo;
    const radiusSquared = window.radiusLdu * window.radiusLdu;
    const counted = this.countPose;
    counted.rot = rot;
    counted.yPlates = yPlates;
    const dyLdu = (yPlates - window.yPlates) * PLATE_LDU;
    for (let i = -window.cells; i <= window.cells; i++) {
      const dx = i * STUD_LDU;
      for (let j = -window.cells; j <= window.cells; j++) {
        const dz = j * STUD_LDU;
        if (dx * dx + dz * dz + dyLdu * dyLdu > radiusSquared) continue;
        counted.x = window.x + dx;
        counted.z = window.z + dz;
        const slot = memo.slot(counted.x, counted.z, yPlates, rot);
        if (memo.dense[slot] === UNKNOWN) memo.dense[slot] = this.solver.denseVotes(model, counted);
      }
    }
  }

  private reachOrder(window: PlacementWindow, tableYPlates: number): number {
    const across = 2 * window.cells + 1;
    const levels = 2 * window.plates + 1;
    const capacity = window.turns * levels * across * across;
    if (this.keys.length < capacity) this.keys = new Float64Array(capacity);
    const radiusSquared = window.radiusLdu * window.radiusLdu;
    let count = 0;
    for (let turn = window.firstTurn; turn < window.turns; turn++) {
      const turnRank = quarterTurnsBetween(window.rot + turn, window.rot) * TURNS + turn;
      for (let level = 0; level < levels; level++) {
        const dy = level - window.plates;
        if (window.yPlates + dy < tableYPlates) continue;
        const dyLdu = dy * PLATE_LDU;
        for (let i = 0; i < across; i++) {
          const dx = (i - window.cells) * STUD_LDU;
          for (let j = 0; j < across; j++) {
            const dz = (j - window.cells) * STUD_LDU;
            const reach = dx * dx + dz * dz + dyLdu * dyLdu;
            if (reach > radiusSquared || (reach === 0 && turn === 0)) continue;
            this.keys[count++] =
              (((reach * TURN_KEYS + turnRank) * levels + level) * across + i) * across + j;
          }
        }
      }
    }
    this.keys.fill(Number.POSITIVE_INFINITY, count);
    this.keys.sort();
    return count;
  }

  private support(model: ModelConnectors, pose: LatticePose, tableYPlates: number): number {
    const report = this.tieReport;
    this.solver.evaluate(model, pose, report);
    const lowest = this.lowestFacingDown(model);
    let heldFromBelow = pose.yPlates === tableYPlates;
    let pressesUp = false;
    for (let k = 0; k < report.count; k++) {
      if (report.shape[k] === NO_SHAPE) continue;
      const connector = report.connector[k] ?? 0;
      const axis = model.axis[connector];
      if (axis === AXIS_POS_Y) pressesUp = true;
      if (axis === AXIS_NEG_Y && model.origin[connector * ORIGIN_INTS + Y] === lowest) {
        heldFromBelow = true;
      }
    }
    if (!heldFromBelow) return HANGS;
    return pressesUp ? RESTS_PRESSING_UP : RESTS;
  }

  private lowestFacingDown(model: ModelConnectors): number {
    if (model === this.lowestModel) return this.lowestY;
    let lowest = Number.POSITIVE_INFINITY;
    for (let c = 0; c < model.count; c++) {
      if (model.axis[c] !== AXIS_NEG_Y) continue;
      lowest = Math.min(lowest, model.origin[c * ORIGIN_INTS + Y] ?? lowest);
    }
    this.lowestModel = model;
    this.lowestY = lowest;
    return lowest;
  }

  private decode(window: PlacementWindow, key: number, out: Pose): number {
    const across = 2 * window.cells + 1;
    const levels = 2 * window.plates + 1;
    let rest = key;
    const j = rest % across;
    rest = (rest - j) / across;
    const i = rest % across;
    rest = (rest - i) / across;
    const level = rest % levels;
    rest = (rest - level) / levels;
    const turnRank = rest % TURN_KEYS;
    out.x = window.x + (i - window.cells) * STUD_LDU;
    out.z = window.z + (j - window.cells) * STUD_LDU;
    out.yPlates = window.yPlates + level - window.plates;
    out.rot = (window.rot + (turnRank % TURNS)) % TURNS;
    return (rest - turnRank) / TURN_KEYS;
  }

  private blocked(
    model: ModelConnectors,
    volumes: CellVolumes,
    boxes: PartBoxes,
    technic: TechnicSet,
    pose: LatticePose,
    exemptable: boolean,
    hinted: boolean,
  ): boolean {
    this.zones.clear();
    if (hinted && !exemptable && this.hintBlocks(volumes, pose)) return true;
    const placed = this.scratch.place(volumes, pose);
    const at = firstOverlapFrom(placed, this.volumes, this.exempt, this.hit, NO_OVERLAP);
    if (at === NO_OVERLAP) return false;
    this.remember(at);
    if (!exemptable || this.collectZones(model, boxes, technic, pose) === 0) {
      return true;
    }
    return (
      firstOverlap(placed, this.volumes, this.exempt, this.hit) ||
      this.zones.firstOverlap(this.volumes, placed, this.hit)
    );
  }

  private hintBlocks(volumes: CellVolumes, pose: LatticePose): boolean {
    const one = this.oneCell;
    one.posedAs(volumes, pose);
    for (let h = 0; h < HINTS; h++) {
      const cell = this.hints[h] ?? NO_OVERLAP;
      if (cell < 0 || cell >= volumes.count) continue;
      placeCell(volumes, pose, cell, one, 0);
      if ((one.topLdu[0] ?? 0) <= (one.bottomLdu[0] ?? 0)) continue;
      const x = one.cellX[0] ?? 0;
      const z = one.cellZ[0] ?? 0;
      if (!this.volumes.firstOverlap(x, z, one, 0, this.exempt, this.hit)) continue;
      this.hit.cellX = x;
      this.hit.cellZ = z;
      return true;
    }
    return false;
  }

  private remember(cell: number): void {
    for (let h = 0; h < HINTS; h++) if (this.hints[h] === cell) return;
    this.hints[this.nextHint] = cell;
    this.nextHint = (this.nextHint + 1) % HINTS;
  }

  evaluate(model: ModelConnectors, pose: LatticePose, out: MateReport): void {
    this.solver.evaluate(model, pose, out);
  }

  revision(): number {
    return this.edits;
  }

  restingOn(volumes: CellVolumes, pose: LatticePose, moving: number | null): ReadonlyArray<number> {
    const placed = this.scratch.place(volumes, pose);
    const owners: number[] = [];
    const passed = (owner: number): boolean => owner === moving || owners.includes(owner);
    for (let c = 0; c < placed.count; c++) {
      if ((placed.topLdu[c] ?? 0) <= (placed.bottomLdu[c] ?? 0)) continue;
      const x = placed.cellX[c] ?? 0;
      const z = placed.cellZ[c] ?? 0;
      while (this.volumes.firstContactBelow(x, z, placed, c, passed, this.contact)) {
        owners.push(this.contact.owner);
      }
    }
    return owners;
  }

  strandedByRemoval(placements: ReadonlySet<number>, restsOnTable: RestsOnTable): Stranding {
    const removed: Array<readonly [number, Placed]> = [];
    for (const placement of placements) {
      const own = this.awaitedAt(placement);
      if (own !== NOT_WAITING) return this.waitingOn(own);
      const placed = this.placed.get(placement);
      if (!placed) throw new RangeError(`placement ${placement} is not placed`);
      removed.push([placement, placed]);
    }
    for (const [, placed] of removed) {
      const footprint = this.footprint
        .start()
        .grow(this.scratch.place(placed.volumes, placed.pose));
      const waiting = this.awaitedTouching(
        this.reach.copy(footprint).widen(TOUCHING_CELLS, 0),
        footprint,
      );
      if (waiting !== NO_SLOT) return this.waitingOn(waiting);
    }
    if (this.withheld.size > 0) throw new Error("placements are already withdrawn");
    const partners = this.partnersOf(removed);
    const before = new Map<number, number>();
    for (const [other, placed] of this.placed) {
      if (placements.has(other)) continue;
      if (!partners.has(other) && !meetsAnyVerticalBox(placed, removed)) continue;
      this.solver.evaluate(placed.model, placed.pose, this.report);
      if (this.report.count > 0) before.set(other, this.report.count);
    }
    for (const [placement, placed] of removed) {
      this.solver.remove(placed.model, placed.pose, placement);
    }
    let stranded: number | null = null;
    for (const [other, mates] of before) {
      const placed = this.placed.get(other);
      if (!placed || mates === 0) continue;
      this.solver.evaluate(placed.model, placed.pose, this.report);
      if (this.report.count === 0 && !restsOnTable(other)) {
        stranded = other;
        break;
      }
    }
    for (const [placement, placed] of removed) {
      this.solver.insert(placed.model, placed.pose, placement);
    }
    return stranded === null ? NOT_STRANDED : { kind: "stranded", placement: stranded };
  }

  private partnersOf(removed: ReadonlyArray<readonly [number, Placed]>): ReadonlySet<number> {
    const partners = new Set<number>();
    for (const [, placed] of removed) {
      this.solver.partneredMates(placed.model, placed.pose, this.report);
      for (let k = 0; k < this.report.count; k++) {
        partners.add(this.report.partner[k] ?? NO_PARTNER);
      }
    }
    return partners;
  }

  private waitingOn(slot: number): Stranding {
    return {
      kind: "waiting",
      placement: this.awaited[slot * AWAITED_INTS + AWAITED_ID] ?? 0,
      failed: this.awaited[slot * AWAITED_INTS + AWAITED_FAILED] === 1,
    };
  }

  withdrawn<T>(placements: ReadonlySet<number>, during: () => T): T {
    if (this.withheld.size > 0) throw new Error("placements are already withdrawn");
    const removed: Array<readonly [number, Placed]> = [];
    for (const placement of placements) {
      const placed = this.placed.get(placement);
      if (placed) removed.push([placement, placed]);
    }
    for (const [placement, placed] of removed) {
      this.solver.remove(placed.model, placed.pose, placement);
    }
    this.withheld = placements;
    try {
      return during();
    } finally {
      this.withheld = NO_PLACEMENTS;
      for (const [placement, placed] of removed) {
        this.solver.insert(placed.model, placed.pose, placement);
      }
    }
  }

  has(placement: number): boolean {
    return this.placed.has(placement);
  }

  holdingMates(placement: number): number {
    const { model, pose } = this.placedAt(placement);
    const report = this.report;
    this.solver.evaluate(model, pose, report);
    let holding = 0;
    for (let k = 0; k < report.count; k++) {
      if (report.family[k] === TRACK_FAMILY) continue;
      if (model.axis[report.connector[k] ?? 0] !== AXIS_POS_Y) holding++;
    }
    return holding;
  }

  overlapOf(placement: number): number {
    const { model, volumes, boxes, technic, pose } = this.placedAt(placement);
    const moving = this.moving;
    this.moving = placement;
    try {
      const mated = this.solver.votes(model, pose) > 0;
      return this.blocked(model, volumes, boxes, technic, pose, mated, false)
        ? this.hit.owner
        : NO_PLACEMENT;
    } finally {
      this.moving = moving;
      this.zones.clear();
    }
  }

  standsOnTable(placement: number, tableYPlates: number): boolean {
    const placed = this.placedAt(placement);
    const world = this.scratch.place(placed.volumes, placed.pose);
    const table = tableYPlates * PLATE_LDU;
    this.standing = placement;
    try {
      for (let c = 0; c < world.count; c++) {
        const bottom = world.bottomLdu[c] ?? 0;
        if (bottom > table || (world.topLdu[c] ?? 0) <= bottom) continue;
        const x = world.cellX[c] ?? 0;
        const z = world.cellZ[c] ?? 0;
        const slab = this.slab.under(x, z, bottom);
        if (!this.volumes.firstOverlap(x, z, slab, 0, this.isStanding, this.hit)) return true;
      }
      return false;
    } finally {
      this.standing = NO_PLACEMENT;
    }
  }

  private placedAt(placement: number): Placed {
    const placed = this.placed.get(placement);
    if (!placed) throw new RangeError(`placement ${placement} is not placed`);
    return placed;
  }

  check(
    model: ModelConnectors,
    volumes: CellVolumes,
    boxes: PartBoxes,
    technic: TechnicSet,
    pose: LatticePose,
    tableYPlates: number,
    out: PlacementChoice,
  ): void {
    out.walked = 0;
    this.atCursor(model, volumes, boxes, technic, pose, AT_POSE_ONLY, tableYPlates, out);
    this.zones.clear();
  }

  private chooseAt(out: PlacementChoice, pose: LatticePose, votes: number): void {
    out.x = pose.x;
    out.z = pose.z;
    out.yPlates = pose.yPlates;
    out.rot = pose.rot;
    out.votes = votes;
    out.waitingOn = NOT_WAITING;
    out.waitFailed = false;
    out.overlap.owner = NO_PLACEMENT;
  }

  private gridFor(
    volumes: FrozenVolumes,
    rot: number,
    world: CellVolumes,
    yLdu: number,
  ): FootprintGrid {
    const turn = isRot90(rot) ? rot : 0;
    let byTurn = this.grids.get(volumes);
    if (!byTurn) {
      byTurn = Array.from<FootprintGrid | undefined>({ length: TURNS });
      this.grids.set(volumes, byTurn);
    }
    const { cellX0, cellZ0, width, depth } = this.bounds;
    let grid = byTurn[turn];
    if (!grid) {
      grid = FootprintGrid.of(world, cellX0, cellZ0, width, depth, yLdu);
      byTurn[turn] = grid;
    } else if (grid.width !== width || grid.depth !== depth) {
      throw new RangeError(`a placed footprint changed shape under translation`);
    }
    this.gridUses.set(grid, (this.gridUses.get(grid) ?? 0) + 1);
    return grid;
  }

  private release(placed: Placed): void {
    const uses = (this.gridUses.get(placed.grid) ?? 0) - 1;
    if (uses > 0) {
      this.gridUses.set(placed.grid, uses);
      return;
    }
    this.gridUses.delete(placed.grid);
    const byTurn = this.grids.get(placed.volumes);
    if (!byTurn) return;
    byTurn[isRot90(placed.pose.rot) ? placed.pose.rot : 0] = undefined;
    for (let turn = 0; turn < TURNS; turn++) {
      if (byTurn[turn] !== undefined) return;
    }
    this.grids.delete(placed.volumes);
  }

  private collectZones(
    model: ModelConnectors,
    boxes: PartBoxes,
    technic: TechnicSet,
    pose: LatticePose,
  ): number {
    this.solver.partneredMates(model, pose, this.report);
    return this.zones.collect(this.report, boxes, technic, pose, this.placed);
  }
}
