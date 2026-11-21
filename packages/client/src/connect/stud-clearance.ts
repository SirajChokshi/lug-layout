import {
  AXIS_FREE,
  GENDER_MALE,
  VolumeIndex,
  axisDimension,
  axisSign,
  oppositeAxis,
  rotatedAxis,
  type CellVolumes,
  type FootprintGrid,
  type LatticePose,
  type ModelConnectors,
  type OverlapHit,
  type SnapMating,
} from "@brr/domain";
import { PLATE_LDU, SIXTEENTHS_PER_LDU, STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import { inject, injectable } from "inversify";
import { SNAP_MATING } from "../tokens.ts";
import { acrossU, acrossV, type ConnectorLines } from "./connector-lines.ts";
import {
  PART_BOX_FLOATS,
  RANGE_INTS,
  localCellRange,
  posedBox,
  type PartBoxes,
} from "./part-boxes.ts";
import { CellBounds, PosedCells, TurnedGrids } from "./posed-cells.ts";
import { NO_REACH_ENTRY, SOLID_FLOATS, type StudSolids } from "./stud-solids.ts";

export interface PlacedStuds {
  readonly boxes: PartBoxes;
  readonly studs: StudSolids;
  readonly pose: LatticePose;
}

export type Bystander = (owner: number) => boolean;

export interface IStudClearance {
  add(placement: number, studs: StudSolids, pose: LatticePose): void;
  remove(placement: number): void;
  pushesIn(
    studs: StudSolids,
    boxes: PartBoxes,
    volumes: CellVolumes,
    pose: LatticePose,
    bodies: VolumeIndex,
    placed: ReadonlyMap<number, PlacedStuds>,
    bystander: Bystander,
    out: OverlapHit,
  ): boolean;
}

interface ReachRow {
  readonly row: number;
  readonly grid: FootprintGrid;
  readonly studs: StudSolids;
  readonly rot: number;
}

const COORDINATES = 3;
const MAX = 3;
const X = 0;
const Y = 1;
const Z = 2;
const FROM_X = 0;
const FROM_Z = 1;
const TO_X = 2;
const TO_Z = 3;
const TURNS = 4;
const IGNORE_EVERY_OWNER: Bystander = () => true;

function turnCos(rot: number): number {
  return isRot90(rot) ? rot90Cos(rot) : 1;
}

function turnSin(rot: number): number {
  return isRot90(rot) ? rot90Sin(rot) : 0;
}

function worldAxis(axis: number, rot: number): number {
  return axis === AXIS_FREE ? AXIS_FREE : rotatedAxis(axis, rot % TURNS);
}

function localAxis(axis: number, rot: number): number {
  return worldAxis(axis, (TURNS - (rot % TURNS)) % TURNS);
}

function cellRegion(
  box: Float64Array,
  cellX: number,
  cellZ: number,
  bottom: number,
  top: number,
  out: Float64Array,
): boolean {
  out[X] = Math.max(box[X] ?? 0, cellX * STUD_LDU);
  out[MAX + X] = Math.min(box[MAX + X] ?? 0, (cellX + 1) * STUD_LDU);
  out[Z] = Math.max(box[Z] ?? 0, cellZ * STUD_LDU);
  out[MAX + Z] = Math.min(box[MAX + Z] ?? 0, (cellZ + 1) * STUD_LDU);
  out[Y] = Math.max(box[Y] ?? 0, bottom);
  out[MAX + Y] = Math.min(box[MAX + Y] ?? 0, top);
  for (let k = 0; k < COORDINATES; k++) if (!((out[k] ?? 0) < (out[MAX + k] ?? 0))) return false;
  return true;
}

function gapTo(centre: number, lo: number, hi: number): number {
  return Math.max(lo - centre, 0, centre - hi);
}

function overlapsAlong(a: Float64Array, b: Float64Array, k: number): boolean {
  return Math.max(a[k] ?? 0, b[k] ?? 0) < Math.min(a[MAX + k] ?? 0, b[MAX + k] ?? 0);
}

function solidMeets(solid: Float64Array, axis: number, region: Float64Array): boolean {
  if (axis === AXIS_FREE) {
    return (
      overlapsAlong(solid, region, X) &&
      overlapsAlong(solid, region, Y) &&
      overlapsAlong(solid, region, Z)
    );
  }
  const along = axisDimension(axis);
  if (!overlapsAlong(solid, region, along)) return false;
  const u = acrossU(along);
  const v = acrossV(along);
  const radiusU = ((solid[MAX + u] ?? 0) - (solid[u] ?? 0)) / 2;
  const radiusV = ((solid[MAX + v] ?? 0) - (solid[v] ?? 0)) / 2;
  const gapU = gapTo((solid[u] ?? 0) + radiusU, region[u] ?? 0, region[MAX + u] ?? 0);
  const gapV = gapTo((solid[v] ?? 0) + radiusV, region[v] ?? 0, region[MAX + v] ?? 0);
  if (gapU >= radiusU || gapV >= radiusV) return false;
  return (
    gapU * gapU * radiusV * radiusV + gapV * gapV * radiusU * radiusU <
    radiusU * radiusU * radiusV * radiusV
  );
}

@injectable()
export class StudClearance implements IStudClearance {
  private readonly reach = new VolumeIndex();
  private readonly rows = new Map<number, ReachRow>();
  private readonly grids = new TurnedGrids<StudSolids>();
  private readonly cells = new PosedCells(0);
  private readonly bounds = new CellBounds();
  private readonly solid = new Float64Array(SOLID_FLOATS);
  private readonly box = new Float64Array(PART_BOX_FLOATS);
  private readonly region = new Float64Array(PART_BOX_FLOATS);
  private readonly partRange = new Int32Array(RANGE_INTS);
  private readonly studRange = new Int32Array(RANGE_INTS);
  private readonly turned = new Int32Array(COORDINATES);
  private heldStuds: StudSolids | null = null;
  private heldBoxes: PartBoxes | null = null;
  private heldPose: LatticePose | null = null;
  private placed: ReadonlyMap<number, PlacedStuds> | null = null;
  private bystander: Bystander = IGNORE_EVERY_OWNER;
  private out: OverlapHit | null = null;
  private entry = NO_REACH_ENTRY;
  private columnBottom = 0;
  private columnTop = 0;
  private studBottom = 0;
  private studTop = 0;

  constructor(@inject(SNAP_MATING) private readonly mating: SnapMating) {}

  add(placement: number, studs: StudSolids, pose: LatticePose): void {
    if (this.rows.has(placement)) throw new RangeError(`placement ${placement} already has studs`);
    if (studs.reach.count === 0) return;
    const world = this.cells.place(studs.reach, pose);
    const bounds = this.bounds.measure(world);
    const yLdu = pose.yPlates * PLATE_LDU;
    const grid = this.grids.take(studs, pose.rot, world, bounds, yLdu);
    const row = this.reach.add(placement, grid, bounds.cellX0, bounds.cellZ0, yLdu);
    this.rows.set(placement, { row, grid, studs, rot: pose.rot });
  }

  remove(placement: number): void {
    const placed = this.rows.get(placement);
    if (!placed) return;
    this.reach.remove(placed.row);
    this.grids.release(placed.studs, placed.rot, placed.grid);
    this.rows.delete(placement);
  }

  pushesIn(
    studs: StudSolids,
    boxes: PartBoxes,
    volumes: CellVolumes,
    pose: LatticePose,
    bodies: VolumeIndex,
    placed: ReadonlyMap<number, PlacedStuds>,
    bystander: Bystander,
    out: OverlapHit,
  ): boolean {
    this.heldStuds = studs;
    this.heldBoxes = boxes;
    this.heldPose = pose;
    this.placed = placed;
    this.bystander = bystander;
    this.out = out;
    try {
      return (
        this.heldStudsPushIn(studs, pose, bodies, out) || this.placedStudsPushIn(volumes, pose, out)
      );
    } finally {
      this.heldStuds = null;
      this.heldBoxes = null;
      this.heldPose = null;
      this.placed = null;
      this.bystander = IGNORE_EVERY_OWNER;
      this.out = null;
    }
  }

  private heldStudsPushIn(
    studs: StudSolids,
    pose: LatticePose,
    bodies: VolumeIndex,
    out: OverlapHit,
  ): boolean {
    const world = this.cells.place(studs.reach, pose);
    for (let e = 0; e < world.count; e++) {
      this.entry = e;
      const bottom = world.bottomLdu[e] ?? 0;
      const top = world.topLdu[e] ?? 0;
      if (
        bodies.firstOverlap(
          world.cellX[e] ?? 0,
          world.cellZ[e] ?? 0,
          bottom,
          top,
          this.heldStudMisses,
          out,
        )
      ) {
        out.candidateBottomLdu = this.studBottom;
        out.candidateTopLdu = this.studTop;
        return true;
      }
    }
    return false;
  }

  private placedStudsPushIn(volumes: CellVolumes, pose: LatticePose, out: OverlapHit): boolean {
    const world = this.cells.place(volumes, pose);
    for (let c = 0; c < world.count; c++) {
      const bottom = world.bottomLdu[c] ?? 0;
      const top = world.topLdu[c] ?? 0;
      if (top <= bottom) continue;
      this.columnBottom = bottom;
      this.columnTop = top;
      if (
        this.reach.firstOverlap(
          world.cellX[c] ?? 0,
          world.cellZ[c] ?? 0,
          bottom,
          top,
          this.placedStudMisses,
          out,
        )
      ) {
        out.bottomLdu = this.studBottom;
        out.topLdu = this.studTop;
        out.candidateBottomLdu = bottom;
        out.candidateTopLdu = top;
        return true;
      }
    }
    return false;
  }

  private readonly heldStudMisses = (
    owner: number,
    cellX: number,
    cellZ: number,
    bottomLdu: number,
    topLdu: number,
  ): boolean => this.bystander(owner) || !this.heldStudHits(owner, cellX, cellZ, bottomLdu, topLdu);

  private readonly placedStudMisses = (owner: number, cellX: number, cellZ: number): boolean =>
    this.bystander(owner) || !this.placedStudHits(owner, cellX, cellZ);

  private heldStudHits(
    owner: number,
    cellX: number,
    cellZ: number,
    bottom: number,
    top: number,
  ): boolean {
    const other = this.placed?.get(owner);
    const studs = this.heldStuds;
    const pose = this.heldPose;
    if (!other || !studs || !pose) return false;
    for (
      let k = studs.entryStart[this.entry] ?? 0;
      k < (studs.entryStart[this.entry + 1] ?? 0);
      k++
    ) {
      const stud = studs.entryStud[k] ?? 0;
      posedBox(studs.solid, stud, pose, this.solid);
      const axis = worldAxis(studs.axis[stud] ?? AXIS_FREE, pose.rot);
      if (!this.meetsParts(axis, other.boxes, other.pose, cellX, cellZ, bottom, top)) continue;
      if (this.engagesOnLine(studs, stud, pose, other.studs, other.pose)) continue;
      this.hitAt(cellX, cellZ);
      return true;
    }
    return false;
  }

  private placedStudHits(owner: number, cellX: number, cellZ: number): boolean {
    const other = this.placed?.get(owner);
    const held = this.heldStuds;
    const boxes = this.heldBoxes;
    const pose = this.heldPose;
    if (!other || !held || !boxes || !pose) return false;
    const studs = other.studs;
    const range = localCellRange(studs, other.pose, cellX, cellZ, this.studRange);
    for (let lz = range[FROM_Z] ?? 0; lz < (range[TO_Z] ?? 0); lz++) {
      for (let lx = range[FROM_X] ?? 0; lx < (range[TO_X] ?? 0); lx++) {
        const entry = studs.entryAt(lx, lz);
        if (entry === NO_REACH_ENTRY) continue;
        for (let k = studs.entryStart[entry] ?? 0; k < (studs.entryStart[entry + 1] ?? 0); k++) {
          const stud = studs.entryStud[k] ?? 0;
          posedBox(studs.solid, stud, other.pose, this.solid);
          const axis = worldAxis(studs.axis[stud] ?? AXIS_FREE, other.pose.rot);
          if (
            !this.meetsParts(axis, boxes, pose, cellX, cellZ, this.columnBottom, this.columnTop)
          ) {
            continue;
          }
          if (this.engagesOnLine(studs, stud, other.pose, held, pose)) continue;
          this.hitAt(cellX, cellZ);
          return true;
        }
      }
    }
    return false;
  }

  private hitAt(cellX: number, cellZ: number): void {
    const out = this.out;
    if (!out) return;
    out.cellX = cellX;
    out.cellZ = cellZ;
    this.studBottom = this.solid[Y] ?? 0;
    this.studTop = this.solid[MAX + Y] ?? 0;
  }

  private meetsParts(
    axis: number,
    boxes: PartBoxes,
    pose: LatticePose,
    cellX: number,
    cellZ: number,
    bottom: number,
    top: number,
  ): boolean {
    const range = localCellRange(boxes, pose, cellX, cellZ, this.partRange);
    for (let lz = range[FROM_Z] ?? 0; lz < (range[TO_Z] ?? 0); lz++) {
      for (let lx = range[FROM_X] ?? 0; lx < (range[TO_X] ?? 0); lx++) {
        const cell = (lz - boxes.cellZ0) * boxes.width + (lx - boxes.cellX0);
        for (let r = boxes.cellStart[cell] ?? 0; r < (boxes.cellStart[cell + 1] ?? 0); r++) {
          posedBox(boxes.boxes, boxes.cellInstance[r] ?? 0, pose, this.box);
          if (!cellRegion(this.box, cellX, cellZ, bottom, top, this.region)) continue;
          if (solidMeets(this.solid, axis, this.region)) return true;
        }
      }
    }
    return false;
  }

  private engagesOnLine(
    studs: StudSolids,
    stud: number,
    ownPose: LatticePose,
    other: StudSolids,
    otherPose: LatticePose,
  ): boolean {
    const model = studs.model;
    const lines = other.lines;
    for (let l = studs.lineStart[stud] ?? 0; l < (studs.lineStart[stud + 1] ?? 0); l++) {
      const k = studs.lineConnector[l] ?? 0;
      const axis = localAxis(worldAxis(model.axis[k] ?? AXIS_FREE, ownPose.rot), otherPose.rot);
      if (axis === AXIS_FREE) continue;
      this.originIn(model, k, ownPose, otherPose);
      const dimension = axisDimension(axis);
      const u = this.turned[acrossU(dimension)] ?? 0;
      const v = this.turned[acrossV(dimension)] ?? 0;
      const along = this.turned[dimension] ?? 0;
      for (let e = lines.first(dimension, u, v); lines.holds(e, dimension, u, v); e++) {
        if (this.engagesAt(model, k, axis, along, other.model, lines, e)) return true;
      }
    }
    return false;
  }

  private engagesAt(
    model: ModelConnectors,
    k: number,
    axis: number,
    along: number,
    otherModel: ModelConnectors,
    lines: ConnectorLines,
    entry: number,
  ): boolean {
    const c = lines.connector[entry] ?? 0;
    if (otherModel.gender[c] === model.gender[k]) return false;
    if (otherModel.axis[c] !== oppositeAxis(axis)) return false;
    const otherAlong = lines.along(entry);
    if (model.gender[k] === GENDER_MALE) {
      return this.mating.engages(
        model.shape[k] ?? 0,
        otherModel.shape[c] ?? 0,
        (otherAlong - along) * axisSign(axis),
      );
    }
    return this.mating.engages(
      otherModel.shape[c] ?? 0,
      model.shape[k] ?? 0,
      (along - otherAlong) * axisSign(oppositeAxis(axis)),
    );
  }

  private originIn(model: ModelConnectors, k: number, from: LatticePose, to: LatticePose): void {
    const at = k * COORDINATES;
    const x = model.origin[at + X] ?? 0;
    const y = model.origin[at + Y] ?? 0;
    const z = model.origin[at + Z] ?? 0;
    const fromCos = turnCos(from.rot);
    const fromSin = turnSin(from.rot);
    const worldX = fromCos * x + fromSin * z + (from.x - to.x) * SIXTEENTHS_PER_LDU;
    const worldZ = -fromSin * x + fromCos * z + (from.z - to.z) * SIXTEENTHS_PER_LDU;
    const toCos = turnCos(to.rot);
    const toSin = turnSin(to.rot);
    this.turned[X] = toCos * worldX - toSin * worldZ;
    this.turned[Y] = y + (from.yPlates - to.yPlates) * PLATE_LDU * SIXTEENTHS_PER_LDU;
    this.turned[Z] = toSin * worldX + toCos * worldZ;
  }
}
