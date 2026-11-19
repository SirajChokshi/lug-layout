import {
  CandidatePoses,
  FootprintGrid,
  MateReport,
  VolumeIndex,
  firstOverlap,
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
import type { FrozenTechnic } from "./frozen-technic.ts";
import type { PartBoxes } from "./part-boxes.ts";
import type { FrozenVolumes } from "./placeable-volumes.ts";

const HALF_STUD_LDU = STUD_LDU / 2;
const NO_PLACEMENT = -1;

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

export interface PlacementWindow extends SnapWindow {
  readonly radiusLdu: number;
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
  evaluate(model: ModelConnectors, pose: LatticePose, out: MateReport): void;
  restingOn(volumes: CellVolumes, pose: LatticePose, moving: number | null): ReadonlyArray<number>;
  strandedByRemoval(placement: number, restsOnTable: RestsOnTable): number | null;
}

interface Placed extends PlacedParts {
  readonly model: ModelConnectors;
  readonly volumes: FrozenVolumes;
  readonly technic: FrozenTechnic;
  readonly row: number;
  readonly grid: FootprintGrid;
}

const TURNS = 4;
const INITIAL_ORDER = 64;

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
    const rot = isRot90(pose.rot) ? pose.rot : 0;
    const cos = rot90Cos(rot);
    const sin = rot90Sin(rot);
    const yLdu = pose.yPlates * PLATE_LDU;
    const { cellX, cellZ, bottomLdu, topLdu } = local;
    for (let c = 0; c < local.count; c++) {
      const cx = (cellX[c] ?? 0) * STUD_LDU + HALF_STUD_LDU;
      const cz = (cellZ[c] ?? 0) * STUD_LDU + HALF_STUD_LDU;
      this.cellX[c] = Math.floor((cos * cx + sin * cz + pose.x) / STUD_LDU);
      this.cellZ[c] = Math.floor((-sin * cx + cos * cz + pose.z) / STUD_LDU);
      this.bottomLdu[c] = (bottomLdu[c] ?? 0) + yLdu;
      this.topLdu[c] = (topLdu[c] ?? 0) + yLdu;
    }
    this.count = local.count;
    return this;
  }
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

class CursorWindow implements SnapWindow {
  x = 0;
  z = 0;
  yPlates = 0;
  rot = 0;
  readonly cells = 0;
  readonly plates = 0;
  readonly turns = 1;
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
  private readonly candidates = new CandidatePoses();
  private readonly report = new MateReport();
  private readonly tieReport = new MateReport();
  private readonly cursor = new CursorWindow();
  private order = new Int32Array(INITIAL_ORDER);
  private reach = new Float64Array(INITIAL_ORDER);
  private readonly scratch = new VolumeBuffer(0);
  private readonly pose = new Pose();
  private readonly hit = placementChoice().overlap;
  private readonly zones = new MateZones();
  private readonly bounds = new Bounds();
  private readonly grids = new Map<FrozenVolumes, Array<FootprintGrid | undefined>>();
  private readonly gridUses = new Map<FootprintGrid, number>();
  private moving = NO_PLACEMENT;

  constructor(
    @inject(CONNECTION_SOLVER) private readonly solver: ConnectionSolver,
    @inject(SNAP_MATING) private readonly mating: SnapMating,
  ) {}

  private readonly exempt = (owner: number, cellX: number, cellZ: number): boolean =>
    owner === this.moving || this.zones.exempts(owner, cellX, cellZ);

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
    this.solver.insert(model, at, placement);
    this.placed.set(placement, { model, volumes, boxes, technic, pose: at, row, grid });
  }

  remove(placement: number): void {
    const placed = this.placed.get(placement);
    if (!placed) throw new RangeError(`placement ${placement} is not placed`);
    this.volumes.remove(placed.row);
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
    this.moving = moving ?? NO_PLACEMENT;
    out.walked = 0;
    this.atCursor(model, volumes, boxes, technic, window, tableYPlates, out);
    if (!(out.accepted && out.votes > 0) && reachesBeyondCursor(window)) {
      this.nearestMate(model, volumes, boxes, technic, window, tableYPlates, out);
    }
    this.moving = NO_PLACEMENT;
    this.zones.clear();
  }

  private atCursor(
    model: ModelConnectors,
    volumes: CellVolumes,
    boxes: PartBoxes,
    technic: TechnicSet,
    window: SnapWindow,
    tableYPlates: number,
    out: PlacementChoice,
  ): void {
    const cursor = this.cursor;
    cursor.x = window.x;
    cursor.z = window.z;
    cursor.yPlates = window.yPlates;
    cursor.rot = window.rot;
    this.solver.rank(model, cursor, this.candidates);
    let index = 0;
    while (index < this.candidates.count && !this.isWindowPose(cursor, index)) index++;
    this.choose(out, index);
    out.walked++;
    out.overlap.owner = NO_PLACEMENT;
    out.accepted = false;
    if (out.yPlates < tableYPlates) return;
    if (this.blocked(model, volumes, boxes, technic, this.candidatePose(index), out.votes)) {
      copyHit(this.hit, out.overlap);
      return;
    }
    out.accepted = out.votes > 0 || out.yPlates === tableYPlates;
  }

  private nearestMate(
    model: ModelConnectors,
    volumes: CellVolumes,
    boxes: PartBoxes,
    technic: TechnicSet,
    window: PlacementWindow,
    tableYPlates: number,
    out: PlacementChoice,
  ): void {
    const candidates = this.candidates;
    this.solver.rank(model, window, candidates);
    const kept = this.nearestFirst(window, tableYPlates);
    let best = -1;
    let bestReach = Number.POSITIVE_INFINITY;
    let bestJoints = -1;
    for (let k = 0; k < kept; k++) {
      const i = this.order[k] ?? 0;
      const reach = this.reach[k] ?? 0;
      if (best >= 0 && reach > bestReach) break;
      out.walked++;
      const votes = candidates.votes[i] ?? 0;
      if (this.blocked(model, volumes, boxes, technic, this.candidatePose(i), votes)) continue;
      this.solver.evaluate(model, this.candidatePose(i), this.tieReport);
      const joints = this.tieReport.jointCount;
      const bestVotes = best >= 0 ? (candidates.votes[best] ?? 0) : -1;
      if (best < 0 || joints > bestJoints || (joints === bestJoints && votes > bestVotes)) {
        best = i;
        bestReach = reach;
        bestJoints = joints;
      }
    }
    if (best < 0) return;
    this.choose(out, best);
    out.accepted = true;
    out.overlap.owner = NO_PLACEMENT;
  }

  private nearestFirst(window: PlacementWindow, tableYPlates: number): number {
    const candidates = this.candidates;
    if (this.order.length < candidates.count) {
      this.order = new Int32Array(candidates.count);
      this.reach = new Float64Array(candidates.count);
    }
    const radiusSquared = window.radiusLdu * window.radiusLdu;
    let kept = 0;
    for (let i = 0; i < candidates.count; i++) {
      if ((candidates.votes[i] ?? 0) === 0 || this.isWindowPose(window, i)) continue;
      const yPlates = candidates.yPlates[i] ?? 0;
      if (yPlates < tableYPlates || !this.onWindowLattice(window, i)) continue;
      const dx = (candidates.x[i] ?? 0) - window.x;
      const dz = (candidates.z[i] ?? 0) - window.z;
      const dy = (yPlates - window.yPlates) * PLATE_LDU;
      const reach = dx * dx + dz * dz + dy * dy;
      if (reach > radiusSquared) continue;
      let k = kept++;
      while (
        k > 0 &&
        this.ranksBefore(window, i, reach, this.order[k - 1] ?? 0, this.reach[k - 1] ?? 0)
      ) {
        this.order[k] = this.order[k - 1] ?? 0;
        this.reach[k] = this.reach[k - 1] ?? 0;
        k--;
      }
      this.order[k] = i;
      this.reach[k] = reach;
    }
    return kept;
  }

  private ranksBefore(
    window: SnapWindow,
    a: number,
    reachA: number,
    b: number,
    reachB: number,
  ): boolean {
    if (reachA !== reachB) return reachA < reachB;
    const candidates = this.candidates;
    const turns =
      quarterTurnsBetween(candidates.rot[a] ?? 0, window.rot) -
      quarterTurnsBetween(candidates.rot[b] ?? 0, window.rot);
    if (turns !== 0) return turns < 0;
    const y = (candidates.yPlates[a] ?? 0) - (candidates.yPlates[b] ?? 0);
    if (y !== 0) return y < 0;
    const x = (candidates.x[a] ?? 0) - (candidates.x[b] ?? 0);
    if (x !== 0) return x < 0;
    return (candidates.z[a] ?? 0) < (candidates.z[b] ?? 0);
  }

  private blocked(
    model: ModelConnectors,
    volumes: CellVolumes,
    boxes: PartBoxes,
    technic: TechnicSet,
    pose: LatticePose,
    votes: number,
  ): boolean {
    const placed = this.scratch.place(volumes, pose);
    this.zones.clear();
    let blocked = firstOverlap(placed, this.volumes, this.exempt, this.hit);
    if (blocked && votes > 0 && this.collectZones(model, boxes, technic, pose) > 0) {
      blocked =
        firstOverlap(placed, this.volumes, this.exempt, this.hit) ||
        this.zones.firstOverlap(this.hit);
    }
    return blocked;
  }

  evaluate(model: ModelConnectors, pose: LatticePose, out: MateReport): void {
    this.solver.evaluate(model, pose, out);
  }

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

  strandedByRemoval(placement: number, restsOnTable: RestsOnTable): number | null {
    const removed = this.placed.get(placement);
    if (!removed) throw new RangeError(`placement ${placement} is not placed`);
    const before = new Map<number, number>();
    for (const [other, placed] of this.placed) {
      if (other === placement) continue;
      this.solver.evaluate(placed.model, placed.pose, this.report);
      if (this.report.count > 0) before.set(other, this.report.count);
    }
    this.solver.remove(removed.model, removed.pose, placement);
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
    this.solver.insert(removed.model, removed.pose, placement);
    return stranded;
  }

  private isWindowPose(window: SnapWindow, index: number): boolean {
    return (
      this.candidates.x[index] === window.x &&
      this.candidates.z[index] === window.z &&
      this.candidates.yPlates[index] === window.yPlates &&
      this.candidates.rot[index] === window.rot
    );
  }

  private onWindowLattice(window: SnapWindow, index: number): boolean {
    const dx = (this.candidates.x[index] ?? 0) - window.x;
    const dz = (this.candidates.z[index] ?? 0) - window.z;
    return dx % STUD_LDU === 0 && dz % STUD_LDU === 0;
  }

  private candidatePose(index: number): Pose {
    const pose = this.pose;
    pose.x = this.candidates.x[index] ?? 0;
    pose.z = this.candidates.z[index] ?? 0;
    pose.yPlates = this.candidates.yPlates[index] ?? 0;
    pose.rot = this.candidates.rot[index] ?? 0;
    return pose;
  }

  private choose(out: PlacementChoice, index: number): void {
    out.x = this.candidates.x[index] ?? 0;
    out.z = this.candidates.z[index] ?? 0;
    out.yPlates = this.candidates.yPlates[index] ?? 0;
    out.rot = this.candidates.rot[index] ?? 0;
    out.votes = this.candidates.votes[index] ?? 0;
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
    this.solver.evaluate(model, pose, this.report);
    return this.zones.collect(this.report, boxes, technic, pose, this.placed);
  }
}
