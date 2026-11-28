import { EMPTY_COLUMN } from "@brr/catalog";
import {
  BOX_MAX_X,
  BOX_MIN_X,
  BOX_STRIDE,
  FACT_STRIDE,
  cellChunkKey,
  clearFacts,
  type AppliedEdit,
  type CarriedTrack,
  type PlacementHandle,
  type PlacementRef,
  type PlanShape,
  type TrackOutline,
} from "@brr/domain";
import {
  CHUNK_LDU,
  CHUNK_STUDS,
  IDENTIFICATION_ACCEPTED_DEVIATION_LDU,
  PLATE_LDU,
  SIXTEENTHS_PER_LDU,
  STUD_LDU,
  chunkKey,
  chunkOf,
  isRot90,
  rot90Cos,
  rot90Sin,
} from "@brr/math";
import {
  INSTANCE_MATRIX_FLOATS,
  type ChunkInstances,
  type FarModelPlacement,
  type IPlanSceneBackend,
  type ISceneBackend,
  type WorldBox,
} from "@brr/render";
import { CellWindowIndex } from "./cell-window-index.ts";
import { BOX_FLOATS, type LocalBox } from "./local-box.ts";
import { partBoxGridOf } from "./part-box-grid.ts";
import { PlanChunks } from "./plan-chunks.ts";
import { PlanShapes } from "./plan-shapes.ts";
import {
  FOOTPRINT_ANTI_STUD,
  FOOTPRINT_FLAT,
  FOOTPRINT_NONE,
  type Placeable,
} from "./placeable.ts";

const IDENTIFIED_SIXTEENTHS = IDENTIFICATION_ACCEPTED_DEVIATION_LDU * SIXTEENTHS_PER_LDU;

function identifiedEdge(ldu: number): number {
  const sixteenths = ldu * SIXTEENTHS_PER_LDU;
  const whole = Math.round(sixteenths);
  return Math.abs(sixteenths - whole) <= IDENTIFIED_SIXTEENTHS ? whole / SIXTEENTHS_PER_LDU : ldu;
}

export interface PlacedModel {
  readonly id: number;
  readonly placement: PlacementRef;
  readonly handle: PlacementHandle;
  readonly placeable: Placeable;
  readonly box: WorldBox;
  studCellX(stud: number): number;
  studCellZ(stud: number): number;
  studBaseLdu(stud: number): number;
  seatsStudAt(cellX: number, cellZ: number, baseLdu: number): boolean;
  readonly shape: PlanShape | null;
  readonly carried: CarriedTrack | null;
  readonly facts: Int32Array;
  rayHit(ray: Float64Array): number;
  aimedTop(ray: Float64Array, groundX: number, groundZ: number, out: Float64Array): boolean;
  worldPartBoxes(): Float64Array;
  raiseToTopOver(x: number, z: number, highest: Float64Array): void;
  meetsInPlan(box: WorldBox): boolean;
}

export interface CarriedTrackParts {
  readonly instances: ReadonlySet<number>;
  readonly outlines: ReadonlyArray<TrackOutline>;
}

export type CarriedTrackSource = (
  placeable: Placeable,
  handle: PlacementHandle,
) => CarriedTrackParts | null;

const NO_CARRIED_TRACK: CarriedTrackSource = () => null;
const NO_INSTANCES: ReadonlySet<number> = new Set();
const AXES = 3;

const HALF_STUD_LDU = STUD_LDU / 2;
const THROUGH_SIDE = 0;
export const ON_TOP_FACE = 1;

function slab(
  origin: number,
  direction: number,
  lo: number,
  hi: number,
  range: Float64Array,
): boolean {
  if (direction === 0) return origin >= lo && origin <= hi;
  const t1 = (lo - origin) / direction;
  const t2 = (hi - origin) / direction;
  range[0] = Math.max(range[0] ?? 0, Math.min(t1, t2));
  range[1] = Math.min(range[1] ?? 0, Math.max(t1, t2));
  return (range[0] ?? 0) <= (range[1] ?? 0);
}

const rayRange = new Float64Array(2);

export function rayBoxDistance(
  ray: Float64Array,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): number {
  rayRange[0] = 0;
  rayRange[1] = Number.POSITIVE_INFINITY;
  const hit =
    slab(ray[0] ?? 0, ray[3] ?? 0, minX, maxX, rayRange) &&
    slab(ray[1] ?? 0, ray[4] ?? 0, minY, maxY, rayRange) &&
    slab(ray[2] ?? 0, ray[5] ?? 0, minZ, maxZ, rayRange);
  return hit ? (rayRange[0] ?? 0) : Number.POSITIVE_INFINITY;
}

export function rayTopFaceDistance(
  ray: Float64Array,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  top: number,
): number {
  const down = ray[4] ?? 0;
  if (down >= 0) return Number.POSITIVE_INFINITY;
  const t = (top - (ray[1] ?? 0)) / down;
  if (t < 0) return Number.POSITIVE_INFINITY;
  const x = (ray[0] ?? 0) + (ray[3] ?? 0) * t;
  const z = (ray[2] ?? 0) + (ray[5] ?? 0) * t;
  return x >= minX && x <= maxX && z >= minZ && z <= maxZ ? t : Number.POSITIVE_INFINITY;
}

const FOOTPRINT_FLAG = 1;
const COLUMNS_FLAG = 2;
const BORDER_FLAG = 4;
const ANTI_STUD_FLAG = 8;
const INITIAL_TOUCHED_CAPACITY = 4;
const NOT_TOUCHED = -1;

class TouchedChunks {
  private keys = new Float64Array(INITIAL_TOUCHED_CAPACITY);
  private parts = new Uint32Array(INITIAL_TOUCHED_CAPACITY);
  private studs = new Uint32Array(INITIAL_TOUCHED_CAPACITY);
  private flags = new Uint8Array(INITIAL_TOUCHED_CAPACITY);
  private rows = 0;

  get length(): number {
    return this.rows;
  }

  rowOf(key: number): number {
    for (let row = 0; row < this.rows; row++) {
      if (this.keys[row] === key) return row;
    }
    return NOT_TOUCHED;
  }

  keyAt(row: number): number {
    return this.keys[row] ?? 0;
  }

  partCountAt(row: number): number {
    return this.parts[row] ?? 0;
  }

  studCountAt(row: number): number {
    return this.studs[row] ?? 0;
  }

  contributes(row: number): boolean {
    return this.partCountAt(row) + this.studCountAt(row) > 0;
  }

  hasFootprint(row: number): boolean {
    return ((this.flags[row] ?? 0) & FOOTPRINT_FLAG) !== 0;
  }

  hasColumns(row: number): boolean {
    return ((this.flags[row] ?? 0) & COLUMNS_FLAG) !== 0;
  }

  borders(row: number): boolean {
    return ((this.flags[row] ?? 0) & BORDER_FLAG) !== 0;
  }

  hasAntiStudFootprint(row: number): boolean {
    return ((this.flags[row] ?? 0) & ANTI_STUD_FLAG) !== 0;
  }

  contributedKeys(): number[] {
    const keys: number[] = [];
    for (let row = 0; row < this.rows; row++) {
      if (this.contributes(row)) keys.push(this.keyAt(row));
    }
    return keys;
  }

  addPart(key: number): void {
    const row = this.findOrAddRow(key);
    this.parts[row] = this.partCountAt(row) + 1;
  }

  addStud(key: number): void {
    const row = this.findOrAddRow(key);
    this.studs[row] = this.studCountAt(row) + 1;
  }

  markFootprint(key: number): void {
    this.setFlag(key, FOOTPRINT_FLAG);
  }

  markColumns(key: number): void {
    this.setFlag(key, COLUMNS_FLAG);
  }

  markBorder(key: number): void {
    this.setFlag(key, BORDER_FLAG);
  }

  markAntiStudFootprint(key: number): void {
    this.setFlag(key, ANTI_STUD_FLAG);
  }

  private setFlag(key: number, flag: number): void {
    const row = this.findOrAddRow(key);
    this.flags[row] = (this.flags[row] ?? 0) | flag;
  }

  private findOrAddRow(key: number): number {
    const row = this.rowOf(key);
    if (row !== NOT_TOUCHED) return row;
    if (this.rows === this.keys.length) this.grow();
    this.keys[this.rows] = key;
    return this.rows++;
  }

  private grow(): void {
    const capacity = this.keys.length * 2;
    const keys = new Float64Array(capacity);
    const parts = new Uint32Array(capacity);
    const studs = new Uint32Array(capacity);
    const flags = new Uint8Array(capacity);
    keys.set(this.keys);
    parts.set(this.parts);
    studs.set(this.studs);
    flags.set(this.flags);
    this.keys = keys;
    this.parts = parts;
    this.studs = studs;
    this.flags = flags;
  }
}

class LatticePose {
  x = 0;
  z = 0;
  cos = 1;
  sin = 0;

  constructor(x: number, z: number, rot: number) {
    this.at(x, z, rot);
  }

  at(x: number, z: number, rot: number): this {
    if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
    this.x = x;
    this.z = z;
    this.cos = rot90Cos(rot);
    this.sin = rot90Sin(rot);
    return this;
  }

  worldBox(
    local: ArrayLike<number>,
    from: number,
    yLdu: number,
    out: Float64Array,
    to: number,
  ): void {
    this.worldBoxOf(
      local[from] ?? 0,
      local[from + 1] ?? 0,
      local[from + 2] ?? 0,
      local[from + 3] ?? 0,
      local[from + 4] ?? 0,
      local[from + 5] ?? 0,
      yLdu,
      out,
      to,
    );
  }

  worldBoxOf(
    loX: number,
    loY: number,
    loZ: number,
    hiX: number,
    hiY: number,
    hiZ: number,
    yLdu: number,
    out: Float64Array,
    to: number,
  ): void {
    const ax = this.x + this.cos * loX + this.sin * loZ;
    const az = this.z - this.sin * loX + this.cos * loZ;
    const bx = this.x + this.cos * hiX + this.sin * hiZ;
    const bz = this.z - this.sin * hiX + this.cos * hiZ;
    out[to] = Math.min(ax, bx);
    out[to + 1] = yLdu + loY;
    out[to + 2] = Math.min(az, bz);
    out[to + 3] = Math.max(ax, bx);
    out[to + 4] = yLdu + hiY;
    out[to + 5] = Math.max(az, bz);
  }

  boxOf(box: LocalBox, yLdu: number): WorldBox {
    const out = posedBoxScratch;
    this.worldBoxOf(
      box.min[0],
      box.min[1],
      box.min[2],
      box.max[0],
      box.max[1],
      box.max[2],
      yLdu,
      out,
      0,
    );
    const [minX = 0, minY = 0, minZ = 0, maxX = 0, maxY = 0, maxZ = 0] = out;
    return { minX, minY, minZ, maxX, maxY, maxZ };
  }

  worldCellX(localCellX: number, localCellZ: number): number {
    const lx = localCellX * STUD_LDU + HALF_STUD_LDU;
    const lz = localCellZ * STUD_LDU + HALF_STUD_LDU;
    return Math.floor((this.x + this.cos * lx + this.sin * lz) / STUD_LDU);
  }

  worldCellZ(localCellX: number, localCellZ: number): number {
    const lx = localCellX * STUD_LDU + HALF_STUD_LDU;
    const lz = localCellZ * STUD_LDU + HALF_STUD_LDU;
    return Math.floor((this.z - this.sin * lx + this.cos * lz) / STUD_LDU);
  }

  localCellX(worldCellX: number, worldCellZ: number): number {
    const dx = worldCellX * STUD_LDU + HALF_STUD_LDU - this.x;
    const dz = worldCellZ * STUD_LDU + HALF_STUD_LDU - this.z;
    return Math.floor((this.cos * dx - this.sin * dz) / STUD_LDU);
  }

  localCellZ(worldCellX: number, worldCellZ: number): number {
    const dx = worldCellX * STUD_LDU + HALF_STUD_LDU - this.x;
    const dz = worldCellZ * STUD_LDU + HALF_STUD_LDU - this.z;
    return Math.floor((this.sin * dx + this.cos * dz) / STUD_LDU);
  }
}

const NEIGHBOUR_DX = Int8Array.of(-1, 0, 1, -1, 1, -1, 0, 1);
const NEIGHBOUR_DZ = Int8Array.of(-1, -1, -1, 0, 0, 1, 1, 1);

const CULLING_BORDER_CELLS = 1;
const CULLING_WINDOW_CELLS = CHUNK_STUDS + 2 * CULLING_BORDER_CELLS;
const localRange = new Int32Array(4);

const posedBoxScratch = new Float64Array(BOX_FLOATS);
const posingScratch = new LatticePose(0, 0, 0);

export function posedBox(box: LocalBox, x: number, z: number, yLdu: number, rot: number): WorldBox {
  return new LatticePose(x, z, rot).boxOf(box, yLdu);
}

export function posedCell(
  x: number,
  z: number,
  rot: number,
  localCellX: number,
  localCellZ: number,
  out: Int32Array,
): void {
  const pose = posingScratch.at(x, z, rot);
  out[0] = pose.worldCellX(localCellX, localCellZ);
  out[1] = pose.worldCellZ(localCellX, localCellZ);
}

export function posedSeatsStudAt(
  placeable: Placeable,
  x: number,
  z: number,
  rot: number,
  yLdu: number,
  cellX: number,
  cellZ: number,
  baseLdu: number,
): boolean {
  const pose = posingScratch.at(x, z, rot);
  return placeable.studLattice.seats.has(
    pose.localCellX(cellX, cellZ),
    pose.localCellZ(cellX, cellZ),
    baseLdu - yLdu,
  );
}

export function posedPartBoxes(
  partBoxes: Float32Array,
  x: number,
  z: number,
  yLdu: number,
  rot: number,
): Float64Array {
  return writePosedPartBoxes(partBoxes, x, z, yLdu, rot, new Float64Array(partBoxes.length));
}

export function writePosedPartBoxes(
  partBoxes: Float32Array,
  x: number,
  z: number,
  yLdu: number,
  rot: number,
  out: Float64Array,
): Float64Array {
  const pose = posingScratch.at(x, z, rot);
  for (let b = 0; b < partBoxes.length; b += BOX_FLOATS) pose.worldBox(partBoxes, b, yLdu, out, b);
  return out;
}

function closedAround(
  cellX: number,
  cellZ: number,
  baseLdu: number,
  cover: number,
  columns: CellWindowIndex,
): boolean {
  for (let n = 0; n < NEIGHBOUR_DX.length; n++) {
    const x = cellX + (NEIGHBOUR_DX[n] ?? 0);
    const z = cellZ + (NEIGHBOUR_DZ[n] ?? 0);
    if (!columns.spannedByAnotherOwner(x, z, baseLdu, cover)) return false;
  }
  return true;
}

function cellIndex(
  cells: Placeable["cells"],
  pose: LatticePose,
  worldCellX: number,
  worldCellZ: number,
): number {
  const i = pose.localCellX(worldCellX, worldCellZ) - cells.cellX0;
  const j = pose.localCellZ(worldCellX, worldCellZ) - cells.cellZ0;
  if (i < 0 || j < 0 || i >= cells.width || j >= cells.depth) return -1;
  return j * cells.width + i;
}

class PlacedEntry implements PlacedModel {
  readonly chunks = new TouchedChunks();
  columnsIndexedIn = -1;
  touchedIn = -1;
  readonly shape: PlanShape | null;
  readonly carried: CarriedTrack | null;
  readonly facts = new Int32Array(FACT_STRIDE);
  readonly box: WorldBox;
  readonly pose: LatticePose;
  readonly x: number;
  readonly yLdu: number;
  readonly z: number;
  readonly rot: number;
  readonly cos: number;
  readonly sin: number;

  constructor(
    readonly id: number,
    readonly placement: PlacementRef,
    readonly handle: PlacementHandle,
    readonly placeable: Placeable,
    chunkOrigins: Map<number, readonly [number, number]>,
    carriedTrack: CarriedTrackSource,
    planShapes: PlanShapes,
  ) {
    this.pose = new LatticePose(handle.x, handle.z, handle.rot);
    this.x = handle.x;
    this.z = handle.z;
    this.rot = handle.rot;
    this.yLdu = handle.yPlates * PLATE_LDU;
    this.cos = this.pose.cos;
    this.sin = this.pose.sin;
    this.tallyParts(chunkOrigins);
    this.tallyStuds(chunkOrigins);
    this.markCells(chunkOrigins);
    this.box = this.worldBox();
    const carried = carriedTrack(placeable, handle);
    this.shape = planShapes.of(placeable, handle.rot, carried?.instances ?? NO_INSTANCES);
    this.carried =
      carried === null
        ? null
        : { outlines: carried.outlines, bodyBox: this.bodyBox(carried.instances) };
    clearFacts(this.facts, 0);
  }

  private bodyBox(without: ReadonlySet<number>): Float64Array | null {
    const local = this.placeable.partBoxes;
    const part = new Float64Array(BOX_STRIDE);
    const body = new Float64Array(BOX_STRIDE);
    let found = false;
    for (let b = 0, instance = 0; b < local.length; b += BOX_FLOATS, instance++) {
      if (without.has(instance)) continue;
      this.pose.worldBox(local, b, this.yLdu, part, 0);
      if (!found) {
        body.set(part);
        found = true;
        continue;
      }
      for (let axis = 0; axis < AXES; axis++) {
        body[BOX_MIN_X + axis] = Math.min(body[BOX_MIN_X + axis] ?? 0, part[BOX_MIN_X + axis] ?? 0);
        body[BOX_MAX_X + axis] = Math.max(body[BOX_MAX_X + axis] ?? 0, part[BOX_MAX_X + axis] ?? 0);
      }
    }
    return found ? body : null;
  }

  worldPartBoxes(): Float64Array {
    const boxes = new Float64Array(this.placeable.partBoxes.length);
    this.writeWorldPartBoxes(boxes);
    return boxes;
  }

  private writeWorldPartBoxes(out: Float64Array): void {
    const local = this.placeable.partBoxes;
    for (let b = 0; b < local.length; b += BOX_FLOATS) {
      this.pose.worldBox(local, b, this.yLdu, out, b);
    }
  }

  private markCells(chunkOrigins: Map<number, readonly [number, number]>): void {
    const { cells } = this.placeable;
    for (let j = 0; j < cells.depth; j++) {
      for (let i = 0; i < cells.width; i++) {
        const cell = j * cells.width + i;
        const occupied = (cells.columnTop[cell] ?? EMPTY_COLUMN) !== EMPTY_COLUMN;
        const kind = cells.footprint[cell] ?? FOOTPRINT_NONE;
        const footprint = kind !== FOOTPRINT_NONE;
        if (!occupied && !footprint) continue;
        const wx = this.pose.worldCellX(cells.cellX0 + i, cells.cellZ0 + j);
        const wz = this.pose.worldCellZ(cells.cellX0 + i, cells.cellZ0 + j);
        const key = cellChunkKey(wx, wz);
        this.markChunksAcrossTheBorder(wx, wz, key);
        if (occupied) this.chunks.markColumns(key);
        if (footprint) {
          this.chunks.markFootprint(key);
          if (kind === FOOTPRINT_ANTI_STUD) this.chunks.markAntiStudFootprint(key);
          if (!chunkOrigins.has(key)) {
            chunkOrigins.set(key, [
              chunkOf(wx * STUD_LDU + HALF_STUD_LDU),
              chunkOf(wz * STUD_LDU + HALF_STUD_LDU),
            ]);
          }
        }
      }
    }
  }

  private markChunksAcrossTheBorder(worldCellX: number, worldCellZ: number, key: number): void {
    const inChunkX = worldCellX - Math.floor(worldCellX / CHUNK_STUDS) * CHUNK_STUDS;
    const inChunkZ = worldCellZ - Math.floor(worldCellZ / CHUNK_STUDS) * CHUNK_STUDS;
    const interior =
      inChunkX > 0 && inChunkX < CHUNK_STUDS - 1 && inChunkZ > 0 && inChunkZ < CHUNK_STUDS - 1;
    if (interior) return;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const neighbour = cellChunkKey(worldCellX + dx, worldCellZ + dz);
        if (neighbour !== key) this.chunks.markBorder(neighbour);
      }
    }
  }

  private cellAt(worldCellX: number, worldCellZ: number): number {
    return cellIndex(this.placeable.cells, this.pose, worldCellX, worldCellZ);
  }

  private localCellsIn(index: CellWindowIndex): boolean {
    const { cells } = this.placeable;
    const pose = this.pose;
    let minI = Number.POSITIVE_INFINITY;
    let maxI = Number.NEGATIVE_INFINITY;
    let minJ = Number.POSITIVE_INFINITY;
    let maxJ = Number.NEGATIVE_INFINITY;
    for (let corner = 0; corner < 4; corner++) {
      const wx = corner & 1 ? index.maxCellX : index.minCellX;
      const wz = corner & 2 ? index.maxCellZ : index.minCellZ;
      const i = pose.localCellX(wx, wz) - cells.cellX0;
      const j = pose.localCellZ(wx, wz) - cells.cellZ0;
      minI = Math.min(minI, i);
      maxI = Math.max(maxI, i);
      minJ = Math.min(minJ, j);
      maxJ = Math.max(maxJ, j);
    }
    localRange[0] = Math.max(0, minI);
    localRange[1] = Math.min(cells.width - 1, maxI);
    localRange[2] = Math.max(0, minJ);
    localRange[3] = Math.min(cells.depth - 1, maxJ);
    return localRange[0] <= localRange[1] && localRange[2] <= localRange[3];
  }

  indexFootprints(index: CellWindowIndex): void {
    if (!this.localCellsIn(index)) return;
    const { cells } = this.placeable;
    const i0 = localRange[0] ?? 0;
    const i1 = localRange[1] ?? -1;
    const j0 = localRange[2] ?? 0;
    const j1 = localRange[3] ?? -1;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const kind = cells.footprint[j * cells.width + i] ?? FOOTPRINT_NONE;
        if (kind === FOOTPRINT_NONE) continue;
        const lx = cells.cellX0 + i;
        const lz = cells.cellZ0 + j;
        index.push(
          this.pose.worldCellX(lx, lz),
          this.pose.worldCellZ(lx, lz),
          this.id,
          this.yLdu,
          kind,
        );
      }
    }
  }

  indexColumns(index: CellWindowIndex): void {
    if (!this.localCellsIn(index)) return;
    const { cells } = this.placeable;
    const i0 = localRange[0] ?? 0;
    const i1 = localRange[1] ?? -1;
    const j0 = localRange[2] ?? 0;
    const j1 = localRange[3] ?? -1;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cell = j * cells.width + i;
        const top = cells.columnTop[cell] ?? EMPTY_COLUMN;
        if (top === EMPTY_COLUMN) continue;
        const lx = cells.cellX0 + i;
        const lz = cells.cellZ0 + j;
        index.push(
          this.pose.worldCellX(lx, lz),
          this.pose.worldCellZ(lx, lz),
          this.id,
          this.yLdu + (cells.columnBottom[cell] ?? 0) * PLATE_LDU,
          this.yLdu + top * PLATE_LDU,
        );
      }
    }
  }

  studCellX(stud: number): number {
    const lattice = this.placeable.studLattice;
    return this.pose.worldCellX(lattice.cellX[stud] ?? 0, lattice.cellZ[stud] ?? 0);
  }

  studCellZ(stud: number): number {
    const lattice = this.placeable.studLattice;
    return this.pose.worldCellZ(lattice.cellX[stud] ?? 0, lattice.cellZ[stud] ?? 0);
  }

  studBaseLdu(stud: number): number {
    return this.yLdu + (this.placeable.studLattice.baseLdu[stud] ?? 0);
  }

  seatsStudAt(cellX: number, cellZ: number, baseLdu: number): boolean {
    return this.placeable.studLattice.seats.has(
      this.pose.localCellX(cellX, cellZ),
      this.pose.localCellZ(cellX, cellZ),
      baseLdu - this.yLdu,
    );
  }

  private isStudCulled(
    stud: number,
    footprints: CellWindowIndex,
    columns: CellWindowIndex,
  ): boolean {
    if (this.placeable.studLattice.onLattice[stud] !== 1) return false;
    const cx = this.studCellX(stud);
    const cz = this.studCellZ(stud);
    const base = this.studBaseLdu(stud);
    const end = footprints.end(cx, cz);
    for (let r = footprints.firstAtOrAbove(cx, cz, base); r < end; r++) {
      if (footprints.low(r) !== base) break;
      const cover = footprints.owner(r);
      if (cover === this.id) continue;
      const kind = footprints.high(r);
      if (
        kind === FOOTPRINT_FLAT ||
        (kind === FOOTPRINT_ANTI_STUD && closedAround(cx, cz, base, cover, columns))
      ) {
        return true;
      }
    }
    return false;
  }

  private chunkXOf(matrices: Float32Array, i: number): number {
    const o = i * INSTANCE_MATRIX_FLOATS;
    return chunkOf(this.x + this.cos * (matrices[o + 3] ?? 0) + this.sin * (matrices[o + 11] ?? 0));
  }

  private chunkZOf(matrices: Float32Array, i: number): number {
    const o = i * INSTANCE_MATRIX_FLOATS;
    return chunkOf(this.z - this.sin * (matrices[o + 3] ?? 0) + this.cos * (matrices[o + 11] ?? 0));
  }

  private inChunk(matrices: Float32Array, i: number, chunkX: number, chunkZ: number): boolean {
    return this.chunkXOf(matrices, i) === chunkX && this.chunkZOf(matrices, i) === chunkZ;
  }

  private recordChunkKey(
    matrices: Float32Array,
    i: number,
    chunkOrigins: Map<number, readonly [number, number]>,
  ): number {
    const chunkX = this.chunkXOf(matrices, i);
    const chunkZ = this.chunkZOf(matrices, i);
    const key = chunkKey(chunkX, chunkZ);
    if (!chunkOrigins.has(key)) chunkOrigins.set(key, [chunkX, chunkZ]);
    return key;
  }

  private tallyParts(chunkOrigins: Map<number, readonly [number, number]>): void {
    const { matrices, count } = this.placeable.parts;
    for (let i = 0; i < count; i++)
      this.chunks.addPart(this.recordChunkKey(matrices, i, chunkOrigins));
  }

  private tallyStuds(chunkOrigins: Map<number, readonly [number, number]>): void {
    const { matrices, count } = this.placeable.studs;
    for (let i = 0; i < count; i++)
      this.chunks.addStud(this.recordChunkKey(matrices, i, chunkOrigins));
  }

  addRebuildKeys(out: Set<number>, hasAntiStudCovers: (key: number) => boolean): void {
    const { chunks } = this;
    for (let row = 0; row < chunks.length; row++) {
      const key = chunks.keyAt(row);
      if (
        chunks.contributes(row) ||
        chunks.hasFootprint(row) ||
        ((chunks.borders(row) || chunks.hasColumns(row)) && hasAntiStudCovers(key))
      ) {
        out.add(key);
      }
    }
  }

  farModelPlacement(farModel: number): FarModelPlacement {
    const [sx, sy, sz] = this.placeable.frameShift;
    const originX = chunkOf(this.x) * CHUNK_LDU;
    const originZ = chunkOf(this.z) * CHUNK_LDU;
    const { cos, sin } = this;
    return {
      modelIndex: farModel,
      originX,
      originZ,
      matrix: Float32Array.of(
        cos,
        0,
        sin,
        this.x - originX + cos * sx + sin * sz,
        0,
        1,
        0,
        this.yLdu + sy,
        -sin,
        0,
        cos,
        this.z - originZ - sin * sx + cos * sz,
      ),
      chunkKeys: this.chunks.contributedKeys(),
    };
  }

  rayHit(ray: Float64Array): number {
    const box = this.box;
    if (
      rayBoxDistance(ray, box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ) ===
      Number.POSITIVE_INFINITY
    ) {
      return Number.POSITIVE_INFINITY;
    }
    const boxes = this.placeable.partBoxes;
    const { cos, sin } = this;
    let nearest = Number.POSITIVE_INFINITY;
    for (let b = 0; b < boxes.length; b += BOX_FLOATS) {
      const loX = boxes[b] ?? 0;
      const loZ = boxes[b + 2] ?? 0;
      const hiX = boxes[b + 3] ?? 0;
      const hiZ = boxes[b + 5] ?? 0;
      const ax = this.x + cos * loX + sin * loZ;
      const az = this.z - sin * loX + cos * loZ;
      const bx = this.x + cos * hiX + sin * hiZ;
      const bz = this.z - sin * hiX + cos * hiZ;
      const t = rayBoxDistance(
        ray,
        Math.min(ax, bx),
        this.yLdu + (boxes[b + 1] ?? 0),
        Math.min(az, bz),
        Math.max(ax, bx),
        this.yLdu + (boxes[b + 4] ?? 0),
        Math.max(az, bz),
      );
      if (t < nearest) nearest = t;
    }
    return nearest;
  }

  aimedTop(ray: Float64Array, groundX: number, groundZ: number, out: Float64Array): boolean {
    const box = this.box;
    if (
      rayBoxDistance(ray, box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ) ===
      Number.POSITIVE_INFINITY
    ) {
      return false;
    }
    const boxes = this.placeable.partBoxes;
    const { cos, sin } = this;
    let found = false;
    for (let b = 0; b < boxes.length; b += BOX_FLOATS) {
      const loX = boxes[b] ?? 0;
      const loZ = boxes[b + 2] ?? 0;
      const hiX = boxes[b + 3] ?? 0;
      const hiZ = boxes[b + 5] ?? 0;
      const ax = this.x + cos * loX + sin * loZ;
      const az = this.z - sin * loX + cos * loZ;
      const bx = this.x + cos * hiX + sin * hiZ;
      const bz = this.z - sin * hiX + cos * hiZ;
      const minX = Math.min(ax, bx);
      const maxX = Math.max(ax, bx);
      const minZ = Math.min(az, bz);
      const maxZ = Math.max(az, bz);
      const top = this.yLdu + (boxes[b + 4] ?? 0);
      const overGround = groundX >= minX && groundX <= maxX && groundZ >= minZ && groundZ <= maxZ;
      const t = overGround
        ? rayBoxDistance(ray, minX, this.yLdu + (boxes[b + 1] ?? 0), minZ, maxX, top, maxZ)
        : rayTopFaceDistance(ray, minX, minZ, maxX, maxZ, top);
      if (t === Number.POSITIVE_INFINITY || (found && t >= (out[0] ?? 0))) continue;
      out[0] = t;
      out[1] = top;
      const entersTop = !overGround || t === (top - (ray[1] ?? 0)) / (ray[4] ?? 0);
      out[2] = entersTop ? ON_TOP_FACE : THROUGH_SIDE;
      found = true;
    }
    return found;
  }

  raiseToTopOver(x: number, z: number, highest: Float64Array): void {
    const own = this.box;
    if (x < own.minX || x > own.maxX || z < own.minZ || z > own.maxZ) return;
    const boxes = this.placeable.partBoxes;
    const grid = partBoxGridOf(boxes);
    const localX = this.localX(x, z);
    const localZ = this.localZ(x, z);
    const { cos, sin } = this;
    let top = highest[0] ?? Number.NEGATIVE_INFINITY;
    const lastRow = grid.lastRow(localZ);
    const lastColumn = grid.lastColumn(localX);
    for (let row = grid.firstRow(localZ); row <= lastRow; row++) {
      for (let column = grid.firstColumn(localX); column <= lastColumn; column++) {
        const end = grid.end(column, row);
        for (let entry = grid.start(column, row); entry < end; entry++) {
          const b = grid.boxAt(entry);
          const loX = boxes[b] ?? 0;
          const loZ = boxes[b + 2] ?? 0;
          const hiX = boxes[b + 3] ?? 0;
          const hiZ = boxes[b + 5] ?? 0;
          const ax = this.x + cos * loX + sin * loZ;
          const az = this.z - sin * loX + cos * loZ;
          const bx = this.x + cos * hiX + sin * hiZ;
          const bz = this.z - sin * hiX + cos * hiZ;
          const over =
            x >= Math.min(ax, bx) &&
            x <= Math.max(ax, bx) &&
            z >= Math.min(az, bz) &&
            z <= Math.max(az, bz);
          if (over) top = Math.max(top, this.yLdu + (boxes[b + 4] ?? 0));
        }
      }
    }
    highest[0] = top;
  }

  meetsInPlan(box: WorldBox): boolean {
    const own = this.box;
    if (
      own.minX >= box.maxX ||
      own.maxX <= box.minX ||
      own.minZ >= box.maxZ ||
      own.maxZ <= box.minZ
    ) {
      return false;
    }
    const boxes = this.placeable.partBoxes;
    const grid = partBoxGridOf(boxes);
    const cornerX = this.localX(box.minX, box.minZ);
    const cornerZ = this.localZ(box.minX, box.minZ);
    const oppositeX = this.localX(box.maxX, box.maxZ);
    const oppositeZ = this.localZ(box.maxX, box.maxZ);
    const { cos, sin } = this;
    const lastRow = grid.lastRow(Math.max(cornerZ, oppositeZ));
    const lastColumn = grid.lastColumn(Math.max(cornerX, oppositeX));
    for (let row = grid.firstRow(Math.min(cornerZ, oppositeZ)); row <= lastRow; row++) {
      for (
        let column = grid.firstColumn(Math.min(cornerX, oppositeX));
        column <= lastColumn;
        column++
      ) {
        const end = grid.end(column, row);
        for (let entry = grid.start(column, row); entry < end; entry++) {
          const b = grid.boxAt(entry);
          const loX = boxes[b] ?? 0;
          const loZ = boxes[b + 2] ?? 0;
          const hiX = boxes[b + 3] ?? 0;
          const hiZ = boxes[b + 5] ?? 0;
          const ax = identifiedEdge(this.x + cos * loX + sin * loZ);
          const az = identifiedEdge(this.z - sin * loX + cos * loZ);
          const bx = identifiedEdge(this.x + cos * hiX + sin * hiZ);
          const bz = identifiedEdge(this.z - sin * hiX + cos * hiZ);
          if (
            Math.min(ax, bx) < box.maxX &&
            Math.max(ax, bx) > box.minX &&
            Math.min(az, bz) < box.maxZ &&
            Math.max(az, bz) > box.minZ
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private localX(x: number, z: number): number {
    return this.cos * (x - this.x) - this.sin * (z - this.z);
  }

  private localZ(x: number, z: number): number {
    return this.sin * (x - this.x) + this.cos * (z - this.z);
  }

  private worldBox(): WorldBox {
    return this.pose.boxOf(this.placeable.box, this.yLdu);
  }

  writeParts(
    chunkX: number,
    chunkZ: number,
    target: Float32Array,
    firstSlot: number,
    selected: Uint32Array,
  ): number {
    const { matrices, count } = this.placeable.parts;
    let slot = firstSlot;
    for (let i = 0; i < count; i++) {
      if (!this.inChunk(matrices, i, chunkX, chunkZ)) continue;
      this.writeInstance(matrices, i, chunkX, chunkZ, target, slot);
      selected[slot++] = i;
    }
    return slot;
  }

  writeDrawnStuds(
    chunkX: number,
    chunkZ: number,
    footprints: CellWindowIndex,
    columns: CellWindowIndex,
    target: Float32Array,
    firstSlot: number,
    selected: Uint32Array,
  ): number {
    const { matrices, count } = this.placeable.studs;
    let slot = firstSlot;
    for (let i = 0; i < count; i++) {
      if (!this.inChunk(matrices, i, chunkX, chunkZ) || this.isStudCulled(i, footprints, columns))
        continue;
      this.writeInstance(matrices, i, chunkX, chunkZ, target, slot);
      selected[slot++] = i;
    }
    return slot;
  }

  private writeInstance(
    source: Float32Array,
    i: number,
    chunkX: number,
    chunkZ: number,
    target: Float32Array,
    slot: number,
  ): void {
    const { cos, sin } = this;
    const s = i * INSTANCE_MATRIX_FLOATS;
    const t = slot * INSTANCE_MATRIX_FLOATS;
    for (let col = 0; col < 4; col++) {
      const row0 = source[s + col] ?? 0;
      const row2 = source[s + 8 + col] ?? 0;
      target[t + col] = cos * row0 + sin * row2;
      target[t + 4 + col] = source[s + 4 + col] ?? 0;
      target[t + 8 + col] = -sin * row0 + cos * row2;
    }
    target[t + 3] = (target[t + 3] ?? 0) + this.x - chunkX * CHUNK_LDU;
    target[t + 7] = (target[t + 7] ?? 0) + this.yLdu;
    target[t + 11] = (target[t + 11] ?? 0) + this.z - chunkZ * CHUNK_LDU;
  }
}

export const NO_MODELS: ReadonlySet<PlacedModel> = new Set();
const NO_ENTRIES: ReadonlyArray<PlacedEntry> = [];

export interface RebuildReport {
  readonly chunks: number;
  readonly instances: number;
  readonly studs: number;
}

export interface ViewUpdate {
  readonly added: ReadonlyArray<PlacedModel>;
  readonly removed: ReadonlyArray<PlacedModel>;
  readonly report: RebuildReport;
}

export interface StudTotals {
  readonly drawn: number;
  readonly culledInsideModels: number | null;
  readonly culledUnderFootprints: number;
}

interface ChunkStuds {
  readonly drawn: number;
  readonly culled: number;
}

function addTo(index: Map<number, Set<PlacedEntry>>, key: number, entry: PlacedEntry): void {
  let set = index.get(key);
  if (!set) {
    set = new Set();
    index.set(key, set);
  }
  set.add(entry);
}

export interface RestProbe {
  readonly placeable: Placeable;
  readonly x: number;
  readonly z: number;
  readonly rot: number;
}

export interface PlacementSource {
  readonly placement: PlacementRef;
  readonly handle: PlacementHandle;
  readonly placeable: Placeable;
}

function byPlacementValue(a: PlacedEntry, b: PlacedEntry): number {
  if (a.placeable.group !== b.placeable.group)
    return a.placeable.group < b.placeable.group ? -1 : 1;
  return (
    a.placeable.worldColor - b.placeable.worldColor ||
    a.x - b.x ||
    a.z - b.z ||
    a.yLdu - b.yLdu ||
    a.handle.rot - b.handle.rot
  );
}

function inWorldOrder(entries: ReadonlySet<PlacedEntry>): PlacedEntry[] {
  return [...entries].toSorted(byPlacementValue);
}

export type PlacedModels = Pick<PlacedChunks, "models" | "version">;

export class PlacedChunks {
  private readonly entries: PlacedEntry[] = [];
  private changes = 0;
  private readonly live = new Set<PlacedEntry>();
  private readonly byChunk = new Map<number, Set<PlacedEntry>>();
  private readonly byFootprintChunk = new Map<number, Set<PlacedEntry>>();
  private readonly byAntiStudChunk = new Map<number, Set<PlacedEntry>>();
  private readonly byColumnChunk = new Map<number, Set<PlacedEntry>>();
  private readonly byBoxChunk = new Map<number, Map<number, PlacedEntry[]>>();
  private readonly chunkOrigins = new Map<number, readonly [number, number]>();
  private readonly planShapes = new PlanShapes();
  private readonly chunkStuds = new Map<number, ChunkStuds>();
  private nextId = 0;
  private touchEpoch = 0;
  private readonly farModels = new Map<Placeable, number>();
  private readonly hasAntiStudCovers = (key: number): boolean =>
    (this.byAntiStudChunk.get(key)?.size ?? 0) > 0;
  private readonly footprints = new CellWindowIndex(false);
  private readonly columns = new CellWindowIndex(true);
  private cullingEpoch = 0;
  private readonly indexFootprints = (entry: PlacedEntry): void =>
    entry.indexFootprints(this.footprints);
  private readonly indexColumns = (entry: PlacedEntry): void => {
    if (entry.columnsIndexedIn === this.cullingEpoch) return;
    entry.columnsIndexedIn = this.cullingEpoch;
    entry.indexColumns(this.columns);
  };

  private readonly planChunks: PlanChunks;

  constructor(
    private readonly backend: ISceneBackend,
    plan: IPlanSceneBackend,
    private readonly carriedTrack: CarriedTrackSource = NO_CARRIED_TRACK,
  ) {
    this.planChunks = new PlanChunks(plan);
  }

  private farModelOf(placeable: Placeable): number | null {
    return this.farModels.get(placeable) ?? placeable.farModel;
  }

  useFarModel(placeable: Placeable, farModel: number): RebuildReport {
    this.farModels.set(placeable, farModel);
    const keys = new Set<number>();
    for (const entry of this.entries) {
      if (entry.placeable !== placeable) continue;
      this.showFarModel(entry);
      const { chunks } = entry;
      for (let row = 0; row < chunks.length; row++) {
        if (chunks.contributes(row)) keys.add(chunks.keyAt(row));
      }
    }
    return this.rebuild([...keys].toSorted((a, b) => a - b));
  }

  private showFarModel(entry: PlacedEntry): void {
    const farModel = this.farModelOf(entry.placeable);
    this.backend.setFarModel(
      entry.id,
      farModel === null ? null : entry.farModelPlacement(farModel),
    );
  }

  models(): ReadonlyArray<PlacedModel> {
    return this.entries;
  }

  get version(): number {
    return this.changes;
  }

  apply(edit: AppliedEdit, placeableOf: (refId: number) => Placeable): ViewUpdate {
    const touched = new Set<number>();
    const removed: PlacedEntry[] = [];
    for (const change of edit.changes) {
      if (!change.removed) continue;
      const entry = this.detach(change.removed);
      entry.addRebuildKeys(touched, this.hasAntiStudCovers);
      removed.push(entry);
    }
    const added: PlacedModel[] = [];
    for (const change of edit.changes) {
      if (!change.added || !change.to) continue;
      const entry = this.insert(change.placement, change.added, placeableOf(change.to.refId));
      entry.addRebuildKeys(touched, this.hasAntiStudCovers);
      added.push(entry);
    }
    return { added, removed, report: this.rebuild(touched) };
  }

  replacePlaceable(previous: Placeable, next: Placeable): ViewUpdate {
    const farModel = this.farModels.get(previous);
    if (farModel !== undefined) this.farModels.set(next, farModel);
    this.farModels.delete(previous);
    const touched = new Set<number>();
    const removed: PlacedModel[] = [];
    const added: PlacedEntry[] = [];
    for (let index = 0; index < this.entries.length; index++) {
      const entry = this.entries[index];
      if (entry?.placeable !== previous) continue;
      entry.addRebuildKeys(touched, this.hasAntiStudCovers);
      const replaced = new PlacedEntry(
        entry.id,
        entry.placement,
        entry.handle,
        next,
        this.chunkOrigins,
        this.carriedTrack,
        this.planShapes,
      );
      this.entries[index] = replaced;
      this.planChunks.remove(entry);
      this.planChunks.add(replaced);
      removed.push(entry);
      added.push(replaced);
    }
    if (added.length === 0) return { added, removed, report: this.rebuild(touched) };
    this.changes++;
    this.reindex();
    for (const entry of added) {
      if (this.farModelOf(entry.placeable) !== null) this.showFarModel(entry);
      entry.addRebuildKeys(touched, this.hasAntiStudCovers);
    }
    return { added, removed, report: this.rebuild(touched) };
  }

  private reindex(): void {
    this.live.clear();
    this.byChunk.clear();
    this.byFootprintChunk.clear();
    this.byAntiStudChunk.clear();
    this.byColumnChunk.clear();
    this.byBoxChunk.clear();
    for (const entry of this.entries) this.index(entry);
  }

  touching(box: WorldBox, out: PlacedModel[]): void {
    out.length = 0;
    const epoch = ++this.touchEpoch;
    const x0 = chunkOf(box.minX - STUD_LDU);
    const x1 = chunkOf(box.maxX + STUD_LDU);
    const z0 = chunkOf(box.minZ - STUD_LDU);
    const z1 = chunkOf(box.maxZ + STUD_LDU);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        for (const entry of this.byColumnChunk.get(chunkKey(cx, cz)) ?? NO_ENTRIES) {
          if (entry.touchedIn === epoch) continue;
          entry.touchedIn = epoch;
          const other = entry.box;
          if (
            other.minX <= box.maxX &&
            box.minX <= other.maxX &&
            other.minZ <= box.maxZ &&
            box.minZ <= other.maxZ &&
            other.minY <= box.maxY &&
            box.minY <= other.maxY
          ) {
            out.push(entry);
          }
        }
      }
    }
  }

  over(box: WorldBox, out: PlacedModel[]): number {
    let count = 0;
    const epoch = ++this.touchEpoch;
    const x1 = chunkOf(box.maxX);
    const z1 = chunkOf(box.maxZ);
    for (let cz = chunkOf(box.minZ); cz <= z1; cz++) {
      for (let cx = chunkOf(box.minX); cx <= x1; cx++) {
        const entries = this.byBoxChunk.get(cx)?.get(cz) ?? NO_ENTRIES;
        for (let e = 0; e < entries.length; e++) {
          const entry = entries[e];
          if (!entry || entry.touchedIn === epoch) continue;
          entry.touchedIn = epoch;
          const other = entry.box;
          if (
            other.minX <= box.maxX &&
            box.minX <= other.maxX &&
            other.minZ <= box.maxZ &&
            box.minZ <= other.maxZ
          ) {
            out[count++] = entry;
          }
        }
      }
    }
    return count;
  }

  contains(model: PlacedModel): boolean {
    return model instanceof PlacedEntry && this.live.has(model);
  }

  studTotals(): StudTotals {
    let drawn = 0;
    let culledUnderFootprints = 0;
    for (const studs of this.chunkStuds.values()) {
      drawn += studs.drawn;
      culledUnderFootprints += studs.culled;
    }
    let culledInsideModels: number | null = 0;
    for (const entry of this.entries) {
      const covered = entry.placeable.bakedCoveredStuds;
      culledInsideModels =
        covered === null || culledInsideModels === null ? null : culledInsideModels + covered;
    }
    return { drawn, culledInsideModels, culledUnderFootprints };
  }

  private indexCulling(key: number, chunkX: number, chunkZ: number): void {
    const cellX0 = chunkX * CHUNK_STUDS - CULLING_BORDER_CELLS;
    const cellZ0 = chunkZ * CHUNK_STUDS - CULLING_BORDER_CELLS;
    this.footprints.reset(cellX0, cellZ0, CULLING_WINDOW_CELLS, CULLING_WINDOW_CELLS);
    this.columns.reset(cellX0, cellZ0, CULLING_WINDOW_CELLS, CULLING_WINDOW_CELLS);
    const covers = this.byFootprintChunk.get(key);
    if (!covers || covers.size === 0) return;
    covers.forEach(this.indexFootprints);
    this.footprints.startFilling();
    covers.forEach(this.indexFootprints);
    this.footprints.seal();
    this.indexClosers(chunkX, chunkZ);
    this.columns.startFilling();
    this.indexClosers(chunkX, chunkZ);
    this.columns.seal();
  }

  private indexClosers(chunkX: number, chunkZ: number): void {
    this.cullingEpoch++;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        this.byColumnChunk.get(chunkKey(chunkX + dx, chunkZ + dz))?.forEach(this.indexColumns);
      }
    }
  }

  addAll(placements: ReadonlyArray<PlacementSource>): RebuildReport {
    const keys = new Set<number>();
    for (const { placement, handle, placeable } of placements) {
      this.insert(placement, handle, placeable).addRebuildKeys(keys, this.hasAntiStudCovers);
    }
    return this.rebuild([...keys].toSorted((a, b) => a - b));
  }

  clear(): void {
    for (const entry of this.entries) this.backend.setFarModel(entry.id, null);
    for (const key of new Set([...this.byChunk.keys(), ...this.chunkStuds.keys()])) {
      this.backend.deleteChunk(key);
    }
    this.byChunk.clear();
    this.byFootprintChunk.clear();
    this.byAntiStudChunk.clear();
    this.byColumnChunk.clear();
    this.byBoxChunk.clear();
    this.chunkStuds.clear();
    this.planChunks.clear();
    this.entries.length = 0;
    this.changes++;
    this.live.clear();
  }

  private insert(
    placement: PlacementRef,
    handle: PlacementHandle,
    placeable: Placeable,
  ): PlacedEntry {
    const entry = new PlacedEntry(
      this.nextId++,
      placement,
      handle,
      placeable,
      this.chunkOrigins,
      this.carriedTrack,
      this.planShapes,
    );
    this.entries.push(entry);
    this.changes++;
    if (this.farModelOf(placeable) !== null) this.showFarModel(entry);
    this.index(entry);
    this.planChunks.add(entry);
    return entry;
  }

  private index(entry: PlacedEntry): void {
    this.live.add(entry);
    const { chunks } = entry;
    for (let row = 0; row < chunks.length; row++) {
      const key = chunks.keyAt(row);
      if (chunks.contributes(row)) addTo(this.byChunk, key, entry);
      if (chunks.hasFootprint(row)) addTo(this.byFootprintChunk, key, entry);
      if (chunks.hasAntiStudFootprint(row)) addTo(this.byAntiStudChunk, key, entry);
      if (chunks.hasColumns(row)) addTo(this.byColumnChunk, key, entry);
    }
    this.forBoxChunks(entry, (cx, cz) => {
      let column = this.byBoxChunk.get(cx);
      if (!column) {
        column = new Map();
        this.byBoxChunk.set(cx, column);
      }
      const models = column.get(cz);
      if (models) models.push(entry);
      else column.set(cz, [entry]);
    });
  }

  private forBoxChunks(entry: PlacedEntry, visit: (chunkX: number, chunkZ: number) => void): void {
    const { box } = entry;
    const x1 = chunkOf(box.maxX);
    const z1 = chunkOf(box.maxZ);
    for (let cz = chunkOf(box.minZ); cz <= z1; cz++) {
      for (let cx = chunkOf(box.minX); cx <= x1; cx++) visit(cx, cz);
    }
  }

  private detach(handle: PlacementHandle): PlacedEntry {
    const index = this.entries.findIndex((entry) => entry.handle === handle);
    const entry = this.entries[index];
    if (!entry) throw new Error("placement is not in this world view");
    this.entries.splice(index, 1);
    this.changes++;
    this.live.delete(entry);
    this.planChunks.remove(entry);
    this.backend.setFarModel(entry.id, null);
    const { chunks } = entry;
    for (let row = 0; row < chunks.length; row++) {
      const key = chunks.keyAt(row);
      this.byChunk.get(key)?.delete(entry);
      this.byFootprintChunk.get(key)?.delete(entry);
      this.byAntiStudChunk.get(key)?.delete(entry);
      this.byColumnChunk.get(key)?.delete(entry);
    }
    this.forBoxChunks(entry, (cx, cz) => {
      const column = this.byBoxChunk.get(cx);
      const models = column?.get(cz);
      const at = models?.indexOf(entry) ?? -1;
      if (!column || !models || at < 0) return;
      models.splice(at, 1);
      if (models.length > 0) return;
      column.delete(cz);
      if (column.size === 0) this.byBoxChunk.delete(cx);
    });
    return entry;
  }

  private rebuild(keys: Iterable<number>): RebuildReport {
    let chunks = 0;
    let instances = 0;
    let studs = 0;
    for (const key of keys) {
      const built = this.rebuildChunk(key);
      chunks++;
      instances += built.count;
      studs += built.studs.count;
    }
    this.planChunks.flush();
    return { chunks, instances, studs };
  }

  private rebuildChunk(key: number): ChunkInstances {
    const origin = this.chunkOrigins.get(key);
    if (!origin) throw new Error(`chunk ${key} has no recorded origin`);
    const [chunkX, chunkZ] = origin;
    const entries = inWorldOrder(this.byChunk.get(key) ?? new Set<PlacedEntry>());
    this.indexCulling(key, chunkX, chunkZ);
    let partCount = 0;
    let studsBefore = 0;
    for (const entry of entries) {
      const row = entry.chunks.rowOf(key);
      partCount += entry.chunks.partCountAt(row);
      studsBefore += entry.chunks.studCountAt(row);
    }
    const partIndex = new Uint16Array(partCount);
    const colorIndex = new Uint16Array(partCount);
    const matrices = new Float32Array(partCount * INSTANCE_MATRIX_FLOATS);
    const voxelized = new Uint8Array(partCount);
    const studPrimitives = new Uint8Array(studsBefore);
    const studColors = new Uint16Array(studsBefore);
    const studMatrices = new Float32Array(studsBefore * INSTANCE_MATRIX_FLOATS);
    const selectedParts = new Uint32Array(partCount);
    const selectedStuds = new Uint32Array(studsBefore);
    let partSlot = 0;
    let studSlot = 0;
    for (const entry of entries) {
      const { parts, studs } = entry.placeable;
      const firstPart = partSlot;
      partSlot = entry.writeParts(chunkX, chunkZ, matrices, partSlot, selectedParts);
      const voxel = this.farModelOf(entry.placeable) === null ? 0 : 1;
      for (let slot = firstPart; slot < partSlot; slot++) {
        const i = selectedParts[slot] ?? 0;
        partIndex[slot] = parts.partIndex[i] ?? 0;
        colorIndex[slot] = parts.colorIndex[i] ?? 0;
        voxelized[slot] = voxel;
      }
      const firstStud = studSlot;
      studSlot = entry.writeDrawnStuds(
        chunkX,
        chunkZ,
        this.footprints,
        this.columns,
        studMatrices,
        studSlot,
        selectedStuds,
      );
      for (let slot = firstStud; slot < studSlot; slot++) {
        const i = selectedStuds[slot] ?? 0;
        studPrimitives[slot] = studs.primitiveIndex[i] ?? 0;
        studColors[slot] = studs.colorIndex[i] ?? 0;
      }
    }
    const chunk: ChunkInstances = {
      originX: chunkX * CHUNK_LDU,
      originZ: chunkZ * CHUNK_LDU,
      count: partCount,
      partIndex,
      colorIndex,
      matrices,
      voxelized,
      studs: {
        count: studSlot,
        primitiveIndex: studPrimitives.slice(0, studSlot),
        colorIndex: studColors.slice(0, studSlot),
        matrices: studMatrices.slice(0, studSlot * INSTANCE_MATRIX_FLOATS),
      },
    };
    if (partCount === 0 && studSlot === 0) {
      this.backend.deleteChunk(key);
      this.chunkStuds.delete(key);
      return chunk;
    }
    this.chunkStuds.set(key, { drawn: studSlot, culled: studsBefore - studSlot });
    this.backend.setChunk(key, chunk);
    return chunk;
  }
}
