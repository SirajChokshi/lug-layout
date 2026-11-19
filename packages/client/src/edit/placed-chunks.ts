import { EMPTY_COLUMN } from "@brr/catalog";
import {
  OccupancyGrid,
  cellChunkKey,
  type AppliedEdit,
  type PlacementHandle,
  type PlacementRef,
} from "@brr/domain";
import {
  CHUNK_LDU,
  PLATE_LDU,
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
  type ISceneBackend,
  type WorldBox,
} from "@brr/render";
import { BOX_FLOATS } from "./local-box.ts";
import {
  FOOTPRINT_ANTI_STUD,
  FOOTPRINT_FLAT,
  FOOTPRINT_NONE,
  type Placeable,
} from "./placeable.ts";

export interface PlacedModel {
  readonly placement: PlacementRef;
  readonly handle: PlacementHandle;
  readonly placeable: Placeable;
  readonly box: WorldBox;
  studCellX(stud: number): number;
  studCellZ(stud: number): number;
  studBaseLdu(stud: number): number;
  readonly slab: Float64Array;
  rayHit(ray: Float64Array): number;
  worldPartBoxes(): Float64Array;
}

const HALF_STUD_LDU = STUD_LDU / 2;

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

const FOOTPRINT_FLAG = 1;
const COLUMNS_FLAG = 2;
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

  contributedKeys(): number[] {
    const keys: number[] = [];
    for (let row = 0; row < this.rows; row++) {
      if (this.contributes(row)) keys.push(this.keyAt(row));
    }
    return keys;
  }

  keysWithColumns(): number[] {
    const keys: number[] = [];
    for (let row = 0; row < this.rows; row++) {
      if (this.hasColumns(row)) keys.push(this.keyAt(row));
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

const scratchBox = new Float64Array(BOX_FLOATS);

const NEIGHBOUR_DX = Int8Array.of(-1, 0, 1, -1, 1, -1, 0, 1);
const NEIGHBOUR_DZ = Int8Array.of(-1, -1, -1, 0, 0, 1, 1, 1);

function closedAround(
  cellX: number,
  cellZ: number,
  baseLdu: number,
  cover: PlacedEntry,
  closers: ReadonlyArray<PlacedEntry>,
): boolean {
  for (let n = 0; n < NEIGHBOUR_DX.length; n++) {
    const x = cellX + (NEIGHBOUR_DX[n] ?? 0);
    const z = cellZ + (NEIGHBOUR_DZ[n] ?? 0);
    let closed = false;
    for (let c = 0; c < closers.length && !closed; c++) {
      const closer = closers[c];
      closed = closer !== undefined && closer !== cover && closer.columnSpans(x, z, baseLdu);
    }
    if (!closed) return false;
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

function boxesOverlap(a: Float64Array, ao: number, b: Float64Array, bo: number): boolean {
  return (
    (a[ao] ?? 0) < (b[bo + 3] ?? 0) &&
    (b[bo] ?? 0) < (a[ao + 3] ?? 0) &&
    (a[ao + 1] ?? 0) < (b[bo + 4] ?? 0) &&
    (b[bo + 1] ?? 0) < (a[ao + 4] ?? 0) &&
    (a[ao + 2] ?? 0) < (b[bo + 5] ?? 0) &&
    (b[bo + 2] ?? 0) < (a[ao + 5] ?? 0)
  );
}

function restingHeight(occupancy: OccupancyGrid, placeable: Placeable, pose: LatticePose): number {
  const { cells } = placeable;
  let yPlates = 0;
  for (let j = 0; j < cells.depth; j++) {
    for (let i = 0; i < cells.width; i++) {
      const cell = j * cells.width + i;
      if ((cells.columnTop[cell] ?? EMPTY_COLUMN) === EMPTY_COLUMN) continue;
      const lx = cells.cellX0 + i;
      const lz = cells.cellZ0 + j;
      const below = occupancy.topAt(pose.worldCellX(lx, lz), pose.worldCellZ(lx, lz));
      yPlates = Math.max(yPlates, below - (cells.columnBottom[cell] ?? 0));
    }
  }
  return yPlates;
}

class PlacedEntry implements PlacedModel {
  readonly chunks = new TouchedChunks();
  readonly slab: Float64Array;
  readonly box: WorldBox;
  readonly pose: LatticePose;
  readonly x: number;
  readonly yLdu: number;
  readonly z: number;
  readonly cos: number;
  readonly sin: number;

  constructor(
    readonly id: number,
    readonly placement: PlacementRef,
    readonly handle: PlacementHandle,
    readonly placeable: Placeable,
    chunkOrigins: Map<number, readonly [number, number]>,
  ) {
    this.pose = new LatticePose(handle.x, handle.z, handle.rot);
    this.x = handle.x;
    this.z = handle.z;
    this.yLdu = handle.yPlates * PLATE_LDU;
    this.cos = this.pose.cos;
    this.sin = this.pose.sin;
    this.tallyParts(chunkOrigins);
    this.tallyStuds(chunkOrigins);
    this.markCells(chunkOrigins);
    const slabs = placeable.slabBoxes;
    this.slab = new Float64Array(slabs.length);
    for (let b = 0; b < slabs.length; b += BOX_FLOATS) {
      this.pose.worldBox(slabs, b, this.yLdu, this.slab, b);
    }
    this.box = this.worldBox();
  }

  worldPartBoxes(): Float64Array {
    const local = this.placeable.partBoxes;
    const boxes = new Float64Array(local.length);
    for (let b = 0; b < local.length; b += BOX_FLOATS) {
      this.pose.worldBox(local, b, this.yLdu, boxes, b);
    }
    return boxes;
  }

  private markCells(chunkOrigins: Map<number, readonly [number, number]>): void {
    const { cells } = this.placeable;
    for (let j = 0; j < cells.depth; j++) {
      for (let i = 0; i < cells.width; i++) {
        const cell = j * cells.width + i;
        const occupied = (cells.columnTop[cell] ?? EMPTY_COLUMN) !== EMPTY_COLUMN;
        const footprint = (cells.footprint[cell] ?? FOOTPRINT_NONE) !== FOOTPRINT_NONE;
        if (!occupied && !footprint) continue;
        const wx = this.pose.worldCellX(cells.cellX0 + i, cells.cellZ0 + j);
        const wz = this.pose.worldCellZ(cells.cellX0 + i, cells.cellZ0 + j);
        const key = cellChunkKey(wx, wz);
        if (occupied) this.chunks.markColumns(key);
        if (footprint) {
          this.chunks.markFootprint(key);
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

  stampColumns(occupancy: OccupancyGrid, onlyChunk: number | null): void {
    const { cells } = this.placeable;
    const yPlates = this.handle.yPlates;
    for (let j = 0; j < cells.depth; j++) {
      for (let i = 0; i < cells.width; i++) {
        const top = cells.columnTop[j * cells.width + i] ?? EMPTY_COLUMN;
        if (top === EMPTY_COLUMN) continue;
        const wx = this.pose.worldCellX(cells.cellX0 + i, cells.cellZ0 + j);
        const wz = this.pose.worldCellZ(cells.cellX0 + i, cells.cellZ0 + j);
        if (onlyChunk !== null && cellChunkKey(wx, wz) !== onlyChunk) continue;
        occupancy.raise(wx, wz, yPlates + top);
      }
    }
  }

  private cellAt(worldCellX: number, worldCellZ: number): number {
    return cellIndex(this.placeable.cells, this.pose, worldCellX, worldCellZ);
  }

  private columnTopPlates(worldCellX: number, worldCellZ: number): number | null {
    const cell = this.cellAt(worldCellX, worldCellZ);
    if (cell < 0) return null;
    const top = this.placeable.cells.columnTop[cell] ?? EMPTY_COLUMN;
    return top === EMPTY_COLUMN ? null : this.handle.yPlates + top;
  }

  restsOn(base: PlacedEntry): boolean {
    const { cells } = this.placeable;
    for (let j = 0; j < cells.depth; j++) {
      for (let i = 0; i < cells.width; i++) {
        const cell = j * cells.width + i;
        if ((cells.columnTop[cell] ?? EMPTY_COLUMN) === EMPTY_COLUMN) continue;
        const wx = this.pose.worldCellX(cells.cellX0 + i, cells.cellZ0 + j);
        const wz = this.pose.worldCellZ(cells.cellX0 + i, cells.cellZ0 + j);
        const bottom = this.handle.yPlates + (cells.columnBottom[cell] ?? 0);
        if (base.columnTopPlates(wx, wz) === bottom) return true;
      }
    }
    return false;
  }

  footprintKind(worldCellX: number, worldCellZ: number, baseLdu: number): number {
    if (baseLdu !== this.yLdu) return FOOTPRINT_NONE;
    const cell = this.cellAt(worldCellX, worldCellZ);
    return cell < 0 ? FOOTPRINT_NONE : (this.placeable.cells.footprint[cell] ?? FOOTPRINT_NONE);
  }

  columnSpans(worldCellX: number, worldCellZ: number, ldu: number): boolean {
    const cell = this.cellAt(worldCellX, worldCellZ);
    if (cell < 0) return false;
    const { columnBottom, columnTop } = this.placeable.cells;
    const top = columnTop[cell] ?? EMPTY_COLUMN;
    if (top === EMPTY_COLUMN) return false;
    const bottom = columnBottom[cell] ?? 0;
    return this.yLdu + bottom * PLATE_LDU <= ldu && ldu <= this.yLdu + top * PLATE_LDU;
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

  private isStudCulled(
    stud: number,
    covers: ReadonlyArray<PlacedEntry>,
    closers: ReadonlyArray<PlacedEntry>,
  ): boolean {
    if (this.placeable.studLattice.onLattice[stud] !== 1) return false;
    const cx = this.studCellX(stud);
    const cz = this.studCellZ(stud);
    const base = this.studBaseLdu(stud);
    for (let c = 0; c < covers.length; c++) {
      const cover = covers[c];
      if (!cover || cover === this) continue;
      const kind = cover.footprintKind(cx, cz, base);
      if (
        kind === FOOTPRINT_FLAT ||
        (kind === FOOTPRINT_ANTI_STUD && closedAround(cx, cz, base, cover, closers))
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

  addRebuildKeys(out: Set<number>): void {
    const { chunks } = this;
    for (let row = 0; row < chunks.length; row++) {
      if (chunks.contributes(row) || chunks.hasFootprint(row)) out.add(chunks.keyAt(row));
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

  private worldBox(): WorldBox {
    const { min, max } = this.placeable.box;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const lx of [min[0], max[0]]) {
      for (const lz of [min[2], max[2]]) {
        const x = this.x + this.cos * lx + this.sin * lz;
        const z = this.z - this.sin * lx + this.cos * lz;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
    }
    return {
      minX,
      minY: this.yLdu + min[1],
      minZ,
      maxX,
      maxY: this.yLdu + max[1],
      maxZ,
    };
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
    covers: ReadonlyArray<PlacedEntry>,
    closers: ReadonlyArray<PlacedEntry>,
    target: Float32Array,
    firstSlot: number,
    selected: Uint32Array,
  ): number {
    const { matrices, count } = this.placeable.studs;
    let slot = firstSlot;
    for (let i = 0; i < count; i++) {
      if (!this.inChunk(matrices, i, chunkX, chunkZ) || this.isStudCulled(i, covers, closers))
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

const NO_ENTRIES: ReadonlySet<PlacedEntry> = new Set();

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
  readonly culledInsideModels: number;
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

export class PlacedChunks {
  private readonly entries: PlacedEntry[] = [];
  private readonly byChunk = new Map<number, Set<PlacedEntry>>();
  private readonly byFootprintChunk = new Map<number, Set<PlacedEntry>>();
  private readonly byColumnChunk = new Map<number, Set<PlacedEntry>>();
  private readonly chunkOrigins = new Map<number, readonly [number, number]>();
  private readonly chunkStuds = new Map<number, ChunkStuds>();
  private readonly occupancy = new OccupancyGrid();
  private nextId = 0;
  private readonly slabbed: PlacedEntry[] = [];
  private readonly probe = new LatticePose(0, 0, 0);
  private readonly farModels = new Map<Placeable, number>();

  constructor(private readonly backend: ISceneBackend) {}

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

  apply(edit: AppliedEdit, placeableOf: (refId: number) => Placeable): ViewUpdate {
    const touched = new Set<number>();
    const vacated = new Set<number>();
    const removed: PlacedModel[] = [];
    for (const change of edit.changes) {
      if (!change.removed) continue;
      const entry = this.detach(change.removed);
      entry.addRebuildKeys(touched);
      for (const key of entry.chunks.keysWithColumns()) vacated.add(key);
      removed.push(entry);
    }
    this.restamp(vacated, NO_ENTRIES);
    const added: PlacedModel[] = [];
    for (const change of edit.changes) {
      if (!change.added || !change.to) continue;
      const entry = this.insert(change.placement, change.added, placeableOf(change.to.refId));
      entry.addRebuildKeys(touched);
      added.push(entry);
    }
    return { added, removed, report: this.rebuild(touched) };
  }

  restingHeight(
    placeable: Placeable,
    x: number,
    z: number,
    rot: number,
    ignore: PlacedModel | null,
  ): number {
    let ignored: PlacedEntry | null = null;
    for (let e = 0; e < this.entries.length; e++) {
      if (this.entries[e] === ignore) ignored = this.entries[e] ?? null;
    }
    if (ignored) this.restamp(ignored.chunks.keysWithColumns(), new Set([ignored]));
    const yPlates = restingHeight(this.occupancy, placeable, this.probe.at(x, z, rot));
    if (ignored) this.restamp(ignored.chunks.keysWithColumns(), NO_ENTRIES);
    return yPlates;
  }

  riderOn(model: PlacedModel): PlacedModel | null {
    const base = this.entries.find((entry) => entry === model);
    if (!base) return null;
    for (const key of base.chunks.keysWithColumns()) {
      for (const entry of this.byColumnChunk.get(key) ?? []) {
        if (entry !== base && entry.restsOn(base)) return entry;
      }
    }
    return null;
  }

  slabClash(
    placeable: Placeable,
    x: number,
    z: number,
    rot: number,
    yPlates: number,
    ignore: PlacedModel | null,
  ): PlacedModel | null {
    const slabs = placeable.slabBoxes;
    const pose = this.probe.at(x, z, rot);
    const yLdu = yPlates * PLATE_LDU;
    for (let b = 0; b < slabs.length; b += BOX_FLOATS) {
      pose.worldBox(slabs, b, yLdu, scratchBox, 0);
      for (let e = 0; e < this.slabbed.length; e++) {
        const entry = this.slabbed[e];
        if (!entry || entry === ignore) continue;
        const theirs = entry.slab;
        for (let t = 0; t < theirs.length; t += BOX_FLOATS) {
          if (boxesOverlap(scratchBox, 0, theirs, t)) return entry;
        }
      }
    }
    return null;
  }

  strandedRider(removed: PlacedModel): PlacedModel | null {
    const base = this.entries.find((entry) => entry === removed);
    if (!base) return null;
    const riders = new Set<PlacedEntry>();
    for (const key of base.chunks.keysWithColumns()) {
      for (const entry of this.byColumnChunk.get(key) ?? []) {
        if (entry !== base && entry.handle.yPlates > 0) riders.add(entry);
      }
    }
    for (const rider of riders) {
      const without = new Set([base, rider]);
      const keys = new Set([...base.chunks.keysWithColumns(), ...rider.chunks.keysWithColumns()]);
      this.restamp(keys, without);
      const yPlates = restingHeight(this.occupancy, rider.placeable, rider.pose);
      this.restamp(keys, NO_ENTRIES);
      if (yPlates < rider.handle.yPlates) return rider;
    }
    return null;
  }

  studTotals(): StudTotals {
    let drawn = 0;
    let culledUnderFootprints = 0;
    for (const studs of this.chunkStuds.values()) {
      drawn += studs.drawn;
      culledUnderFootprints += studs.culled;
    }
    let culledInsideModels = 0;
    for (const entry of this.entries) culledInsideModels += entry.placeable.bakedCoveredStuds;
    return { drawn, culledInsideModels, culledUnderFootprints };
  }

  private columnsAround(key: number): PlacedEntry[] {
    const origin = this.chunkOrigins.get(key);
    if (!origin) return [];
    const found = new Set<PlacedEntry>();
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const around = chunkKey(origin[0] + dx, origin[1] + dz);
        for (const entry of this.byColumnChunk.get(around) ?? []) found.add(entry);
      }
    }
    return [...found];
  }

  private restamp(keys: Iterable<number>, except: ReadonlySet<PlacedEntry>): void {
    for (const key of keys) {
      this.occupancy.clearChunk(key);
      for (const entry of this.byColumnChunk.get(key) ?? []) {
        if (!except.has(entry)) entry.stampColumns(this.occupancy, key);
      }
    }
  }

  addAll(placements: ReadonlyArray<PlacementSource>): RebuildReport {
    const keys = new Set<number>();
    for (const { placement, handle, placeable } of placements) {
      this.insert(placement, handle, placeable).addRebuildKeys(keys);
    }
    return this.rebuild([...keys].toSorted((a, b) => a - b));
  }

  clear(): void {
    for (const key of new Set([...this.byChunk.keys(), ...this.chunkStuds.keys()])) {
      this.backend.deleteChunk(key);
    }
    for (const key of this.byColumnChunk.keys()) this.occupancy.clearChunk(key);
    this.byChunk.clear();
    this.byFootprintChunk.clear();
    this.byColumnChunk.clear();
    this.slabbed.length = 0;
    this.chunkStuds.clear();
    this.entries.length = 0;
  }

  private insert(
    placement: PlacementRef,
    handle: PlacementHandle,
    placeable: Placeable,
  ): PlacedEntry {
    const entry = new PlacedEntry(this.nextId++, placement, handle, placeable, this.chunkOrigins);
    this.entries.push(entry);
    if (this.farModelOf(placeable) !== null) this.showFarModel(entry);
    const { chunks } = entry;
    for (let row = 0; row < chunks.length; row++) {
      const key = chunks.keyAt(row);
      if (chunks.contributes(row)) addTo(this.byChunk, key, entry);
      if (chunks.hasFootprint(row)) addTo(this.byFootprintChunk, key, entry);
      if (chunks.hasColumns(row)) addTo(this.byColumnChunk, key, entry);
    }
    if (entry.slab.length > 0) this.slabbed.push(entry);
    entry.stampColumns(this.occupancy, null);
    return entry;
  }

  private detach(handle: PlacementHandle): PlacedEntry {
    const index = this.entries.findIndex((entry) => entry.handle === handle);
    const entry = this.entries[index];
    if (!entry) throw new Error("placement is not in this world view");
    this.entries.splice(index, 1);
    this.backend.setFarModel(entry.id, null);
    const { chunks } = entry;
    for (let row = 0; row < chunks.length; row++) {
      const key = chunks.keyAt(row);
      this.byChunk.get(key)?.delete(entry);
      this.byFootprintChunk.get(key)?.delete(entry);
      this.byColumnChunk.get(key)?.delete(entry);
    }
    const slabbed = this.slabbed.indexOf(entry);
    if (slabbed >= 0) this.slabbed.splice(slabbed, 1);
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
    return { chunks, instances, studs };
  }

  private rebuildChunk(key: number): ChunkInstances {
    const origin = this.chunkOrigins.get(key);
    if (!origin) throw new Error(`chunk ${key} has no recorded origin`);
    const [chunkX, chunkZ] = origin;
    const entries = inWorldOrder(this.byChunk.get(key) ?? new Set<PlacedEntry>());
    const covers = [...(this.byFootprintChunk.get(key) ?? [])];
    const closers = covers.length > 0 ? this.columnsAround(key) : [];
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
        covers,
        closers,
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
