import {
  CandidatePoses,
  FootprintGrid,
  MateReport,
  NO_OVERLAP,
  ProposalProgress,
  VolumeIndex,
  firstOverlap,
  firstOverlapFrom,
  ModelConnectors,
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
} from "@brr/domain";
import { PLATE_LDU, STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import { inject, injectable } from "inversify";
import { CONNECTION_SOLVER, SNAP_MATING } from "../tokens.ts";
import { MateZones, type PlacedParts } from "./mate-zones.ts";
import { BLOCKED, FREE, PoseMemo, UNKNOWN } from "./pose-memo.ts";
import type { FrozenTechnic } from "./frozen-technic.ts";
import type { PartBoxes } from "./part-boxes.ts";
import type { FrozenVolumes } from "./placeable-volumes.ts";

const HALF_STUD_LDU = STUD_LDU / 2;
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
  readonly overlap: OverlapHit;
}

export function placementChoice(): PlacementChoice {
  return {
    accepted: false,
    x: 0,
    z: 0,
    yPlates: 0,
    rot: 0,
    votes: 0,
    walked: 0,
    overlap: {
      owner: NO_PLACEMENT,
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

export interface OverlapNamer {
  names(hit: OverlapHit): boolean;
}

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
  strandedByRemoval(placements: ReadonlySet<number>, restsOnTable: RestsOnTable): number | null;
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
  topUnderLdu(volumes: CellVolumes, pose: LatticePose): number;
  revision(): number;
  nameOverlap(
    model: ModelConnectors,
    volumes: CellVolumes,
    boxes: PartBoxes,
    technic: TechnicSet,
    pose: LatticePose,
    moving: number | null,
    namer: OverlapNamer,
    out: OverlapHit,
  ): boolean;
}

interface Placed extends PlacedParts {
  readonly model: ModelConnectors;
  readonly volumes: FrozenVolumes;
  readonly technic: FrozenTechnic;
  readonly row: number;
  readonly grid: FootprintGrid;
}

const TURNS = 4;
const INITIAL_KEYS = 64;
const TURN_KEYS = 3 * TURNS;
const NO_REGION = -1;
const COVER_ATTEMPTS = 2;
const HINTS = 8;
const INITIAL_SEEN = 8;
const PROPOSAL_SLOTS = 64;
const PHASE_IDLE = 0;
const PHASE_COVER = 1;
const PHASE_WALK = 2;
const COVER_HELD = 0;
const COVER_TURNED = 1;
const COVER_DONE = 0;
const COVER_RUNNING = 1;
const COVER_NO_ROOM = 2;

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

class VolumeBuffer implements CellVolumes {
  count = 0;
  cellX: Int32Array;
  cellZ: Int32Array;
  bottomLdu: Int32Array;
  topLdu: Int32Array;

  constructor(capacity: number) {
    this.cellX = new Int32Array(capacity);
    this.cellZ = new Int32Array(capacity);
    this.bottomLdu = new Int32Array(capacity);
    this.topLdu = new Int32Array(capacity);
  }

  place(local: CellVolumes, pose: LatticePose): this {
    if (this.cellX.length < local.count) {
      this.cellX = new Int32Array(local.count);
      this.cellZ = new Int32Array(local.count);
      this.bottomLdu = new Int32Array(local.count);
      this.topLdu = new Int32Array(local.count);
    }
    for (let c = 0; c < local.count; c++) placeCell(local, pose, c, this, c);
    this.count = local.count;
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
}

function copyHit(from: OverlapHit, to: OverlapHit): void {
  to.owner = from.owner;
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
  found = false;
  bestKey = 0;
  bestReach = 0;
  bestJoints = 0;
  bestVotes = 0;
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
  private readonly hints = new Int32Array(HINTS).fill(NO_OVERLAP);
  private seen = new Int32Array(INITIAL_SEEN);
  private seenOwners = 0;
  private nextHint = 0;
  private readonly scratch = new VolumeBuffer(0);
  private readonly pose = new Pose();
  private readonly hit = placementChoice().overlap;
  private readonly zones = new MateZones();
  private readonly bounds = new Bounds();
  private readonly grids = new Map<FrozenVolumes, Array<FootprintGrid | undefined>>();
  private readonly gridUses = new Map<FootprintGrid, number>();
  private moving = NO_PLACEMENT;
  private withheld = NO_PLACEMENTS;

  constructor(
    @inject(CONNECTION_SOLVER) private readonly solver: ConnectionSolver,
    @inject(SNAP_MATING) private readonly mating: SnapMating,
  ) {}

  private readonly exempt = (owner: number, cellX: number, cellZ: number): boolean =>
    owner === this.moving ||
    (this.withheld.size > 0 && this.withheld.has(owner)) ||
    this.zones.exempts(owner, cellX, cellZ);

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
    const at: LatticePose = { x: pose.x, z: pose.z, yPlates: pose.yPlates, rot: pose.rot };
    const world = this.scratch.place(volumes, at);
    const bounds = this.bounds.measure(world);
    const yLdu = at.yPlates * PLATE_LDU;
    const grid = this.gridFor(volumes, at.rot, world, yLdu);
    const row = this.volumes.add(placement, grid, bounds.cellX0, bounds.cellZ0, yLdu);
    this.edits++;
    this.solver.insert(model, at, placement);
    this.placed.set(placement, { model, volumes, boxes, technic, pose: at, row, grid });
  }

  remove(placement: number): void {
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
    this.atCursor(model, volumes, boxes, technic, window, tableYPlates, out);
    this.zones.clear();
    if ((out.accepted && out.votes > 0) || !reachesBeyondCursor(window)) {
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
    flight.found = false;
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
      if (flight.found && reach > flight.bestReach) {
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
      this.solver.evaluate(model, pose, this.tieReport);
      const joints = this.tieReport.jointCount;
      if (
        !flight.found ||
        joints > flight.bestJoints ||
        (joints === flight.bestJoints && votes > flight.bestVotes)
      ) {
        flight.found = true;
        flight.bestKey = key;
        flight.bestReach = reach;
        flight.bestJoints = joints;
        flight.bestVotes = votes;
      }
    }
    return true;
  }

  private finishWalk(flight: Flight): void {
    const out = flight.out;
    if (!flight.found || !out) return;
    const pose = this.pose;
    this.decode(flight, flight.bestKey, pose);
    this.chooseAt(out, pose, flight.bestVotes);
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
      firstOverlap(placed, this.volumes, this.exempt, this.hit) || this.zones.firstOverlap(this.hit)
    );
  }

  private hintBlocks(volumes: CellVolumes, pose: LatticePose): boolean {
    const one = this.oneCell;
    for (let h = 0; h < HINTS; h++) {
      const cell = this.hints[h] ?? NO_OVERLAP;
      if (cell < 0 || cell >= volumes.count) continue;
      placeCell(volumes, pose, cell, one, 0);
      const bottom = one.bottomLdu[0] ?? 0;
      const top = one.topLdu[0] ?? 0;
      if (top <= bottom) continue;
      const x = one.cellX[0] ?? 0;
      const z = one.cellZ[0] ?? 0;
      if (this.volumes.firstOverlap(x, z, bottom, top, this.exempt, this.hit)) return true;
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

  nameOverlap(
    model: ModelConnectors,
    volumes: CellVolumes,
    boxes: PartBoxes,
    technic: TechnicSet,
    pose: LatticePose,
    moving: number | null,
    namer: OverlapNamer,
    out: OverlapHit,
  ): boolean {
    this.moving = moving ?? NO_PLACEMENT;
    this.zones.clear();
    this.collectZones(model, boxes, technic, pose);
    const placed = this.scratch.place(volumes, pose);
    let named = false;
    for (let c = 0; c < placed.count && !named; c++) {
      const x = placed.cellX[c] ?? 0;
      const z = placed.cellZ[c] ?? 0;
      const bottom = placed.bottomLdu[c] ?? 0;
      const top = placed.topLdu[c] ?? 0;
      if (top <= bottom) continue;
      this.seenOwners = 0;
      while (this.volumes.firstOverlap(x, z, bottom, top, this.unseen, this.hit)) {
        this.see(this.hit.owner);
        this.hit.cellX = x;
        this.hit.cellZ = z;
        this.hit.candidateBottomLdu = bottom;
        this.hit.candidateTopLdu = top;
        if (!namer.names(this.hit)) continue;
        copyHit(this.hit, out);
        named = true;
        break;
      }
    }
    this.moving = NO_PLACEMENT;
    this.zones.clear();
    return named;
  }

  private see(owner: number): void {
    if (this.seenOwners === this.seen.length) {
      const grown = new Int32Array(this.seen.length * 2);
      grown.set(this.seen);
      this.seen = grown;
    }
    this.seen[this.seenOwners++] = owner;
  }

  private readonly unseen = (owner: number, cellX: number, cellZ: number): boolean => {
    if (this.exempt(owner, cellX, cellZ)) return true;
    for (let i = 0; i < this.seenOwners; i++) if (this.seen[i] === owner) return true;
    return false;
  };

  restingOn(volumes: CellVolumes, pose: LatticePose, moving: number | null): ReadonlyArray<number> {
    const placed = this.scratch.place(volumes, pose);
    const owners: number[] = [];
    const seen: number[] = [];
    const passed = (owner: number): boolean => owner === moving || seen.includes(owner);
    for (let c = 0; c < placed.count; c++) {
      const x = placed.cellX[c] ?? 0;
      const z = placed.cellZ[c] ?? 0;
      const bottom = placed.bottomLdu[c] ?? 0;
      if ((placed.topLdu[c] ?? 0) <= bottom) continue;
      seen.length = 0;
      while (this.volumes.firstOverlap(x, z, bottom - 1, bottom, passed, this.hit)) {
        seen.push(this.hit.owner);
        if (this.hit.topLdu === bottom && !owners.includes(this.hit.owner)) {
          owners.push(this.hit.owner);
        }
      }
    }
    return owners;
  }

  strandedByRemoval(placements: ReadonlySet<number>, restsOnTable: RestsOnTable): number | null {
    const removed: Array<readonly [number, Placed]> = [];
    for (const placement of placements) {
      const placed = this.placed.get(placement);
      if (!placed) throw new RangeError(`placement ${placement} is not placed`);
      removed.push([placement, placed]);
    }
    const before = new Map<number, number>();
    for (const [other, placed] of this.placed) {
      if (placements.has(other)) continue;
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
    return stranded;
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
    this.atCursor(model, volumes, boxes, technic, pose, tableYPlates, out);
    this.zones.clear();
  }

  topUnderLdu(volumes: CellVolumes, pose: LatticePose): number {
    const placed = this.scratch.place(volumes, pose);
    let top = 0;
    for (let c = 0; c < placed.count; c++) {
      const x = placed.cellX[c] ?? 0;
      const z = placed.cellZ[c] ?? 0;
      if ((placed.topLdu[c] ?? 0) <= (placed.bottomLdu[c] ?? 0)) continue;
      this.seenOwners = 0;
      while (
        this.volumes.firstOverlap(
          x,
          z,
          Number.NEGATIVE_INFINITY,
          Number.POSITIVE_INFINITY,
          this.unseen,
          this.hit,
        )
      ) {
        this.see(this.hit.owner);
        top = Math.max(top, this.hit.topLdu);
      }
    }
    return top;
  }

  private chooseAt(out: PlacementChoice, pose: LatticePose, votes: number): void {
    out.x = pose.x;
    out.z = pose.z;
    out.yPlates = pose.yPlates;
    out.rot = pose.rot;
    out.votes = votes;
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
