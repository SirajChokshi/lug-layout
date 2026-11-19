import {
  CandidatePoses,
  MateReport,
  VolumeIndex,
  firstOverlap,
  ModelConnectors,
  placeTechnicInto,
  technicScratch,
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
    technic: TechnicSet,
    pose: LatticePose,
  ): void;
  remove(placement: number): void;
  clear(): void;
  search(
    model: ModelConnectors,
    volumes: CellVolumes,
    boxes: PartBoxes,
    technic: TechnicSet,
    window: SnapWindow,
    moving: number | null,
    out: PlacementChoice,
  ): void;
  strandedByRemoval(placement: number, restsOnTable: RestsOnTable): number | null;
}

interface Placed extends PlacedParts {
  readonly model: ModelConnectors;
  readonly volumes: FrozenVolumes;
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

@injectable()
export class PlacementSearch implements IPlacementSearch {
  private readonly volumes = new VolumeIndex();
  private readonly placed = new Map<number, Placed>();
  private readonly candidates = new CandidatePoses();
  private readonly report = new MateReport();
  private readonly scratch = new VolumeBuffer(0);
  private readonly pose = new Pose();
  private readonly hit = placementChoice().overlap;
  private readonly zones = new MateZones();
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
    technic: TechnicSet,
    pose: LatticePose,
  ): void {
    if (this.placed.has(placement))
      throw new RangeError(`placement ${placement} is already placed`);
    const at: LatticePose = { x: pose.x, z: pose.z, yPlates: pose.yPlates, rot: pose.rot };
    const posed = technicScratch(technic);
    placeTechnicInto(technic, at, posed);
    this.volumes.add(placement, this.scratch.place(volumes, at));
    this.solver.insert(model, at, placement);
    this.placed.set(placement, { model, volumes, boxes, technic: posed, pose: at });
  }

  remove(placement: number): void {
    const placed = this.placed.get(placement);
    if (!placed) throw new RangeError(`placement ${placement} is not placed`);
    this.volumes.remove(placement, this.scratch.place(placed.volumes, placed.pose));
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
    window: SnapWindow,
    moving: number | null,
    out: PlacementChoice,
  ): void {
    const candidates = this.candidates;
    this.solver.rank(model, window, candidates);
    this.moving = moving ?? NO_PLACEMENT;
    out.accepted = false;
    out.walked = 0;
    out.overlap.owner = NO_PLACEMENT;
    for (let i = 0; i < candidates.count; i++) {
      const pose = this.candidatePose(i);
      out.walked = i + 1;
      const placed = this.scratch.place(volumes, pose);
      this.zones.clear();
      let blocked = firstOverlap(placed, this.volumes, this.exempt, this.hit);
      const mated = (candidates.votes[i] ?? 0) > 0;
      if (blocked && mated && this.collectZones(model, boxes, technic, pose) > 0) {
        blocked =
          firstOverlap(placed, this.volumes, this.exempt, this.hit) ||
          this.zones.firstOverlap(this.hit);
      }
      if (i === 0 || !blocked) this.choose(out, i);
      if (i === 0 && blocked) copyHit(this.hit, out.overlap);
      if (blocked) continue;
      out.accepted = true;
      out.overlap.owner = NO_PLACEMENT;
      break;
    }
    this.moving = NO_PLACEMENT;
    this.zones.clear();
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
