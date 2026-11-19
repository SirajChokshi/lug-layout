import {
  CandidatePoses,
  FootprintGrid,
  MateReport,
  NO_OVERLAP,
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
const INITIAL_KEYS = 64;
const TURN_KEYS = 3 * TURNS;
const NO_INDEX = -1;
const HINTS = 8;

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
  private dense = new Int32Array(INITIAL_KEYS);
  private proposedVotes = new Int32Array(INITIAL_KEYS);
  private proposedStamp = new Int32Array(INITIAL_KEYS);
  private levelStamp = new Int32Array(INITIAL_KEYS);
  private stamp = 0;
  private readonly proposals = new CandidatePoses();
  private readonly countPose = new Pose();
  private readonly oneCell = new VolumeBuffer(1);
  private readonly hints = new Int32Array(HINTS).fill(NO_OVERLAP);
  private nextHint = 0;
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
    const pose = this.pose;
    pose.x = window.x;
    pose.z = window.z;
    pose.yPlates = window.yPlates;
    pose.rot = window.rot;
    this.chooseAt(out, pose, this.solver.votes(model, pose));
    out.walked++;
    out.accepted = false;
    if (pose.yPlates < tableYPlates) return;
    if (this.blocked(model, volumes, boxes, technic, pose, out.votes, true, false)) {
      copyHit(this.hit, out.overlap);
      return;
    }
    out.accepted = out.votes > 0 || pose.yPlates === tableYPlates;
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
    const count = this.reachOrder(window, tableYPlates);
    this.stamp++;
    this.collectProposed(model, window, tableYPlates);
    const pose = this.pose;
    let found = false;
    let bestKey = 0;
    let bestReach = 0;
    let bestJoints = 0;
    let bestVotes = 0;
    for (let k = 0; k < count; k++) {
      const key = this.keys[k] ?? 0;
      const reach = this.decode(window, key, pose);
      if (found && reach > bestReach) break;
      const votes = this.votesAt(model, window, pose);
      if (votes === 0) continue;
      out.walked++;
      const exemptable = this.proposedAt(window, pose);
      if (this.blocked(model, volumes, boxes, technic, pose, votes, exemptable, true)) continue;
      this.solver.evaluate(model, pose, this.tieReport);
      const joints = this.tieReport.jointCount;
      if (!found || joints > bestJoints || (joints === bestJoints && votes > bestVotes)) {
        found = true;
        bestKey = key;
        bestReach = reach;
        bestJoints = joints;
        bestVotes = votes;
      }
    }
    if (!found) return;
    this.decode(window, bestKey, pose);
    this.chooseAt(out, pose, bestVotes);
    out.accepted = true;
  }

  private reachOrder(window: PlacementWindow, tableYPlates: number): number {
    const across = 2 * window.cells + 1;
    const levels = 2 * window.plates + 1;
    const capacity = window.turns * levels * across * across;
    if (this.keys.length < capacity) {
      this.keys = new Float64Array(capacity);
      this.dense = new Int32Array(capacity);
      this.proposedVotes = new Int32Array(capacity);
      this.proposedStamp = new Int32Array(capacity);
      this.levelStamp = new Int32Array(capacity);
    }
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

  private collectProposed(
    model: ModelConnectors,
    window: PlacementWindow,
    tableYPlates: number,
  ): void {
    const proposals = this.proposals;
    this.solver.proposeMates(model, window, proposals);
    const radiusSquared = window.radiusLdu * window.radiusLdu;
    const counted = this.countPose;
    for (let q = 0; q < proposals.count; q++) {
      counted.x = proposals.x[q] ?? 0;
      counted.z = proposals.z[q] ?? 0;
      counted.yPlates = proposals.yPlates[q] ?? 0;
      counted.rot = proposals.rot[q] ?? 0;
      const index = this.ballIndex(window, counted);
      if (index < 0 || counted.yPlates < tableYPlates) continue;
      const dx = counted.x - window.x;
      const dz = counted.z - window.z;
      const dy = (counted.yPlates - window.yPlates) * PLATE_LDU;
      if (dx * dx + dz * dz + dy * dy > radiusSquared) continue;
      this.proposedVotes[index] = this.solver.proposalVotes(model, counted);
      this.proposedStamp[index] = this.stamp;
    }
  }

  private ballIndex(window: PlacementWindow, pose: LatticePose): number {
    const dx = pose.x - window.x;
    const dz = pose.z - window.z;
    if (dx % STUD_LDU !== 0 || dz % STUD_LDU !== 0) return NO_INDEX;
    const across = 2 * window.cells + 1;
    const levels = 2 * window.plates + 1;
    const i = dx / STUD_LDU + window.cells;
    const j = dz / STUD_LDU + window.cells;
    const level = pose.yPlates - window.yPlates + window.plates;
    const turn = (((pose.rot - window.rot) % TURNS) + TURNS) % TURNS;
    if (i < 0 || i >= across || j < 0 || j >= across || level < 0 || level >= levels) {
      return NO_INDEX;
    }
    if (turn < window.firstTurn || turn >= window.turns) return NO_INDEX;
    return ((turn * levels + level) * across + i) * across + j;
  }

  private votesAt(model: ModelConnectors, window: PlacementWindow, pose: LatticePose): number {
    const index = this.ballIndex(window, pose);
    const across = 2 * window.cells + 1;
    const band = Math.floor(index / (across * across));
    if (this.levelStamp[band] !== this.stamp) this.countLevel(model, window, band);
    const proposed =
      this.proposedStamp[index] === this.stamp ? (this.proposedVotes[index] ?? 0) : 0;
    return (this.dense[index] ?? 0) + proposed;
  }

  private proposedAt(window: PlacementWindow, pose: LatticePose): boolean {
    const index = this.ballIndex(window, pose);
    return this.proposedStamp[index] === this.stamp && (this.proposedVotes[index] ?? 0) > 0;
  }

  private countLevel(model: ModelConnectors, window: PlacementWindow, band: number): void {
    const across = 2 * window.cells + 1;
    const levels = 2 * window.plates + 1;
    const turn = Math.floor(band / levels);
    const level = band - turn * levels;
    const radiusSquared = window.radiusLdu * window.radiusLdu;
    const counted = this.countPose;
    counted.rot = (window.rot + turn) % TURNS;
    counted.yPlates = window.yPlates + level - window.plates;
    const dyLdu = (level - window.plates) * PLATE_LDU;
    for (let i = 0; i < across; i++) {
      const dx = (i - window.cells) * STUD_LDU;
      for (let j = 0; j < across; j++) {
        const dz = (j - window.cells) * STUD_LDU;
        const index = (band * across + i) * across + j;
        if (dx * dx + dz * dz + dyLdu * dyLdu > radiusSquared) {
          this.dense[index] = 0;
          continue;
        }
        counted.x = window.x + dx;
        counted.z = window.z + dz;
        this.dense[index] = this.solver.denseVotes(model, counted);
      }
    }
    this.levelStamp[band] = this.stamp;
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
    votes: number,
    exemptable: boolean,
    hinted: boolean,
  ): boolean {
    this.zones.clear();
    if (hinted && !exemptable && this.hintBlocks(volumes, pose)) return true;
    const placed = this.scratch.place(volumes, pose);
    const at = firstOverlapFrom(placed, this.volumes, this.exempt, this.hit, NO_OVERLAP);
    if (at === NO_OVERLAP) return false;
    this.remember(at);
    if (!exemptable || votes === 0 || this.collectZones(model, boxes, technic, pose) === 0) {
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
