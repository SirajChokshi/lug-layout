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
  superChunkKey,
  superChunkOf,
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
import type { PlacedVoxels } from "../lod/placed-voxels.ts";
import {
  SuperChunkLod,
  type ChunkResidency,
  type SuperChunkLodStats,
  type VoxelPlacement,
} from "../lod/super-chunk-lod.ts";

export interface PlacedModel {
  readonly placement: PlacementRef;
  readonly handle: PlacementHandle;
  readonly placeable: Placeable;
  readonly box: WorldBox;
  rayHit(ray: Float64Array): number;
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

interface Contribution {
  parts: number;
  studs: number;
}

class LatticePose {
  readonly cos: number;
  readonly sin: number;

  constructor(
    readonly x: number,
    readonly z: number,
    rot: number,
  ) {
    if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
    this.cos = rot90Cos(rot);
    this.sin = rot90Sin(rot);
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

function columnOverlaps(
  cells: Placeable["cells"],
  pose: LatticePose,
  yPlates: number,
  worldCellX: number,
  worldCellZ: number,
  fromPlates: number,
  toPlates: number,
): boolean {
  const cell = cellIndex(cells, pose, worldCellX, worldCellZ);
  if (cell < 0) return false;
  const top = cells.columnTop[cell] ?? EMPTY_COLUMN;
  if (top === EMPTY_COLUMN) return false;
  return yPlates + (cells.columnBottom[cell] ?? 0) < toPlates && yPlates + top > fromPlates;
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

class PlacedEntry implements PlacedModel, VoxelPlacement {
  farModelShown = false;
  readonly partKeys: Float64Array;
  readonly studKeys: Float64Array;
  readonly studCellX: Int32Array;
  readonly studCellZ: Int32Array;
  readonly studBaseLdu: Int32Array;
  readonly studCulled: Uint8Array;
  readonly contributions = new Map<number, Contribution>();
  readonly footprintKeys = new Set<number>();
  readonly columnKeys = new Set<number>();
  readonly tongueCellX: Int32Array;
  readonly tongueCellZ: Int32Array;
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
    this.partKeys = this.keysOf(
      placeable.parts.matrices,
      placeable.parts.count,
      chunkOrigins,
      "parts",
    );
    this.studKeys = this.keysOf(
      placeable.studs.matrices,
      placeable.studs.count,
      chunkOrigins,
      "studs",
    );
    const studs = placeable.studLattice;
    const count = placeable.studs.count;
    this.studCellX = new Int32Array(count);
    this.studCellZ = new Int32Array(count);
    this.studBaseLdu = new Int32Array(count);
    this.studCulled = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const lx = studs.cellX[i] ?? 0;
      const lz = studs.cellZ[i] ?? 0;
      this.studCellX[i] = this.pose.worldCellX(lx, lz);
      this.studCellZ[i] = this.pose.worldCellZ(lx, lz);
      this.studBaseLdu[i] = this.yLdu + (studs.baseLdu[i] ?? 0);
    }
    this.registerCells(chunkOrigins);
    const tongues = placeable.tongues;
    const tongueCount = tongues?.count ?? 0;
    this.tongueCellX = new Int32Array(tongueCount);
    this.tongueCellZ = new Int32Array(tongueCount);
    for (let k = 0; k < tongueCount; k++) {
      const lx = tongues?.cellX[k] ?? 0;
      const lz = tongues?.cellZ[k] ?? 0;
      this.tongueCellX[k] = this.pose.worldCellX(lx, lz);
      this.tongueCellZ[k] = this.pose.worldCellZ(lx, lz);
    }
    this.box = this.worldBox();
  }

  columnOverlaps(worldCellX: number, worldCellZ: number, from: number, to: number): boolean {
    const { cells } = this.placeable;
    return columnOverlaps(cells, this.pose, this.handle.yPlates, worldCellX, worldCellZ, from, to);
  }

  tongueOverlaps(worldCellX: number, worldCellZ: number, from: number, to: number): boolean {
    const tongues = this.placeable.tongues;
    if (!tongues) return false;
    const yPlates = this.handle.yPlates;
    for (let k = 0; k < tongues.count; k++) {
      if (this.tongueCellX[k] !== worldCellX || this.tongueCellZ[k] !== worldCellZ) continue;
      if (yPlates + (tongues.bottom[k] ?? 0) < to && yPlates + (tongues.top[k] ?? 0) > from) {
        return true;
      }
    }
    return false;
  }

  private registerCells(chunkOrigins: Map<number, readonly [number, number]>): void {
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
        if (occupied) this.columnKeys.add(key);
        if (footprint) {
          this.footprintKeys.add(key);
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

  markCulled(
    key: number,
    covers: ReadonlyArray<PlacedEntry>,
    closers: ReadonlyArray<PlacedEntry>,
  ): number {
    const onLattice = this.placeable.studLattice.onLattice;
    let visible = 0;
    for (let i = 0; i < this.studKeys.length; i++) {
      if (this.studKeys[i] !== key) continue;
      let culled = 0;
      if (onLattice[i] === 1) {
        const cx = this.studCellX[i] ?? 0;
        const cz = this.studCellZ[i] ?? 0;
        const base = this.studBaseLdu[i] ?? 0;
        for (let c = 0; c < covers.length; c++) {
          const cover = covers[c];
          if (!cover || cover === this) continue;
          const kind = cover.footprintKind(cx, cz, base);
          if (
            kind === FOOTPRINT_FLAT ||
            (kind === FOOTPRINT_ANTI_STUD && closedAround(cx, cz, base, cover, closers))
          ) {
            culled = 1;
            break;
          }
        }
      }
      this.studCulled[i] = culled;
      if (culled === 0) visible++;
    }
    return visible;
  }

  private keysOf(
    matrices: Float32Array,
    count: number,
    chunkOrigins: Map<number, readonly [number, number]>,
    field: keyof Contribution,
  ): Float64Array {
    const keys = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const o = i * INSTANCE_MATRIX_FLOATS;
      const lx = matrices[o + 3] ?? 0;
      const lz = matrices[o + 11] ?? 0;
      const chunkX = chunkOf(this.x + this.cos * lx + this.sin * lz);
      const chunkZ = chunkOf(this.z - this.sin * lx + this.cos * lz);
      const key = chunkKey(chunkX, chunkZ);
      keys[i] = key;
      if (!chunkOrigins.has(key)) chunkOrigins.set(key, [chunkX, chunkZ]);
      let contribution = this.contributions.get(key);
      if (!contribution) {
        contribution = { parts: 0, studs: 0 };
        this.contributions.set(key, contribution);
      }
      contribution[field]++;
    }
    return keys;
  }

  get voxels(): PlacedVoxels | null {
    return this.placeable.voxels;
  }

  get yPlates(): number {
    return this.handle.yPlates;
  }

  get rot(): number {
    return this.handle.rot;
  }

  rebuildKeys(): Set<number> {
    return new Set([...this.contributions.keys(), ...this.footprintKeys]);
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
      chunkKeys: [...this.contributions.keys()],
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

  writeInto(
    source: Float32Array,
    keys: Float64Array,
    skip: Uint8Array | null,
    key: number,
    originX: number,
    originZ: number,
    target: Float32Array,
    firstSlot: number,
    selected: Uint32Array,
  ): number {
    let slot = firstSlot;
    const { cos, sin } = this;
    const tx = this.x - originX;
    const tz = this.z - originZ;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== key || skip?.[i] === 1) continue;
      const s = i * INSTANCE_MATRIX_FLOATS;
      const t = slot * INSTANCE_MATRIX_FLOATS;
      for (let col = 0; col < 4; col++) {
        const row0 = source[s + col] ?? 0;
        const row2 = source[s + 8 + col] ?? 0;
        target[t + col] = cos * row0 + sin * row2;
        target[t + 4 + col] = source[s + 4 + col] ?? 0;
        target[t + 8 + col] = -sin * row0 + cos * row2;
      }
      target[t + 3] = (target[t + 3] ?? 0) + tx;
      target[t + 7] = (target[t + 7] ?? 0) + this.yLdu;
      target[t + 11] = (target[t + 11] ?? 0) + tz;
      selected[slot] = i;
      slot++;
    }
    return slot;
  }
}

export interface TongueClash {
  readonly other: PlacedModel;
  readonly ownTongue: boolean;
}

export interface RebuildReport {
  readonly chunks: number;
  readonly instances: number;
  readonly studs: number;
}

export interface ViewUpdate {
  readonly added: ReadonlyArray<PlacedModel>;
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

export class PlacedChunks implements ChunkResidency {
  private readonly entries: PlacedEntry[] = [];
  private readonly byChunk = new Map<number, Set<PlacedEntry>>();
  private readonly byFootprintChunk = new Map<number, Set<PlacedEntry>>();
  private readonly byColumnChunk = new Map<number, Set<PlacedEntry>>();
  private readonly chunkOrigins = new Map<number, readonly [number, number]>();
  private readonly chunkStuds = new Map<number, ChunkStuds>();
  private readonly occupancy = new OccupancyGrid();
  private readonly chunksBySuper = new Map<number, Set<number>>();
  private readonly liveChunks = new Set<number>();
  private readonly lod: SuperChunkLod;
  private nextId = 0;
  private readonly tongued = new Set<PlacedEntry>();
  placedParts = 0;

  constructor(private readonly backend: ISceneBackend) {
    this.lod = new SuperChunkLod(backend, this);
  }

  models(): ReadonlyArray<PlacedModel> {
    return this.entries;
  }

  apply(edit: AppliedEdit, placeableOf: (refId: number) => Placeable): ViewUpdate {
    const touched = new Set<number>();
    for (const change of edit.changes) {
      if (!change.removed) continue;
      for (const key of this.detach(change.removed).rebuildKeys()) touched.add(key);
    }
    const added: PlacedModel[] = [];
    for (const change of edit.changes) {
      if (!change.added || !change.to) continue;
      const entry = this.insert(change.placement, change.added, placeableOf(change.to.refId));
      for (const key of entry.rebuildKeys()) touched.add(key);
      added.push(entry);
    }
    return { added, report: this.rebuild(touched) };
  }

  get lodStats(): SuperChunkLodStats {
    return this.lod.stats;
  }

  get liveChunkCount(): number {
    return this.liveChunks.size;
  }

  get settled(): boolean {
    return this.lod.settled;
  }

  setSuperChunkLod(enabled: boolean): void {
    this.lod.setEnabled(enabled);
  }

  buildMeshes(deadlineMs: number): void {
    this.lod.work(deadlineMs);
  }

  update(eyeX: number, eyeY: number, eyeZ: number, deadlineMs: number): void {
    this.lod.update(eyeX, eyeY, eyeZ, deadlineMs);
  }

  loadSuperChunk(superKey: number, deadlineMs: number): boolean {
    const chunks = this.chunksBySuper.get(superKey);
    if (!chunks) return true;
    for (const key of chunks) {
      if (this.liveChunks.has(key)) continue;
      if (performance.now() >= deadlineMs) return false;
      this.rebuildChunk(key);
    }
    return true;
  }

  unloadSuperChunk(superKey: number): void {
    const chunks = this.chunksBySuper.get(superKey);
    if (!chunks) return;
    for (const key of chunks) this.retire(key);
  }

  private superOfChunk(key: number): number {
    const origin = this.chunkOrigins.get(key);
    if (!origin) throw new Error(`chunk ${key} has no recorded origin`);
    return superChunkKey(superChunkOf(origin[0]), superChunkOf(origin[1]));
  }

  private trackChunk(key: number, entry: PlacedEntry): void {
    if (!this.byChunk.has(key)) {
      const superKey = this.superOfChunk(key);
      let chunks = this.chunksBySuper.get(superKey);
      if (!chunks) {
        chunks = new Set();
        this.chunksBySuper.set(superKey, chunks);
      }
      chunks.add(key);
    }
    addTo(this.byChunk, key, entry);
  }

  restingHeight(
    placeable: Placeable,
    x: number,
    z: number,
    rot: number,
    ignore: PlacedModel | null,
  ): number {
    const ignored = this.entries.find((entry) => entry === ignore) ?? null;
    if (ignored) this.restamp(ignored.columnKeys, ignored);
    const yPlates = restingHeight(this.occupancy, placeable, new LatticePose(x, z, rot));
    if (ignored) this.restamp(ignored.columnKeys, null);
    return yPlates;
  }

  tongueClash(
    placeable: Placeable,
    x: number,
    z: number,
    rot: number,
    yPlates: number,
    ignore: PlacedModel | null,
    mates: (other: PlacedModel) => boolean,
  ): TongueClash | null {
    const pose = new LatticePose(x, z, rot);
    const { cells } = placeable;
    for (const entry of this.tongued) {
      if (entry === ignore || mates(entry)) continue;
      const tongues = entry.placeable.tongues;
      if (!tongues) continue;
      for (let k = 0; k < tongues.count; k++) {
        const wx = entry.tongueCellX[k] ?? 0;
        const wz = entry.tongueCellZ[k] ?? 0;
        const from = entry.handle.yPlates + (tongues.bottom[k] ?? 0);
        const to = entry.handle.yPlates + (tongues.top[k] ?? 0);
        if (columnOverlaps(cells, pose, yPlates, wx, wz, from, to)) {
          return { other: entry, ownTongue: false };
        }
      }
    }
    const tongues = placeable.tongues;
    for (let k = 0; k < (tongues?.count ?? 0); k++) {
      const lx = tongues?.cellX[k] ?? 0;
      const lz = tongues?.cellZ[k] ?? 0;
      const wx = pose.worldCellX(lx, lz);
      const wz = pose.worldCellZ(lx, lz);
      const from = yPlates + (tongues?.bottom[k] ?? 0);
      const to = yPlates + (tongues?.top[k] ?? 0);
      for (const entry of this.byColumnChunk.get(cellChunkKey(wx, wz)) ?? []) {
        if (entry === ignore || mates(entry)) continue;
        if (entry.columnOverlaps(wx, wz, from, to)) return { other: entry, ownTongue: true };
      }
      for (const entry of this.tongued) {
        if (entry === ignore || mates(entry)) continue;
        if (entry.tongueOverlaps(wx, wz, from, to)) return { other: entry, ownTongue: true };
      }
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

  private restamp(keys: ReadonlySet<number>, except: PlacedEntry | null): void {
    for (const key of keys) {
      this.occupancy.clearChunk(key);
      for (const entry of this.byColumnChunk.get(key) ?? []) {
        if (entry !== except) entry.stampColumns(this.occupancy, key);
      }
    }
  }

  addAll(placements: ReadonlyArray<PlacementSource>): RebuildReport {
    const keys = new Set<number>();
    for (const { placement, handle, placeable } of placements) {
      for (const key of this.insert(placement, handle, placeable).rebuildKeys()) keys.add(key);
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
    this.tongued.clear();
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
    this.placedParts += placeable.parts.count;
    for (const key of entry.contributions.keys()) this.trackChunk(key, entry);
    for (const key of entry.footprintKeys) addTo(this.byFootprintChunk, key, entry);
    for (const key of entry.columnKeys) addTo(this.byColumnChunk, key, entry);
    if (entry.tongueCellX.length > 0) this.tongued.add(entry);
    entry.stampColumns(this.occupancy, null);
    this.lod.add(entry);
    return entry;
  }

  private detach(handle: PlacementHandle): PlacedEntry {
    const index = this.entries.findIndex((entry) => entry.handle === handle);
    const entry = this.entries[index];
    if (!entry) throw new Error("placement is not in this world view");
    this.entries.splice(index, 1);
    this.placedParts -= entry.placeable.parts.count;
    if (entry.farModelShown) this.backend.setFarModel(entry.id, null);
    entry.farModelShown = false;
    for (const key of entry.contributions.keys()) this.byChunk.get(key)?.delete(entry);
    for (const key of entry.footprintKeys) this.byFootprintChunk.get(key)?.delete(entry);
    for (const key of entry.columnKeys) this.byColumnChunk.get(key)?.delete(entry);
    this.tongued.delete(entry);
    this.restamp(entry.columnKeys, null);
    this.lod.remove(entry);
    return entry;
  }

  private syncFarModels(key: number): void {
    const entries = this.byChunk.get(key);
    if (!entries) return;
    for (const entry of entries) {
      const farModel = entry.placeable.farModel;
      if (farModel === null) continue;
      let live = false;
      for (const chunk of entry.contributions.keys()) {
        if (this.liveChunks.has(chunk)) live = true;
      }
      if (live === entry.farModelShown) continue;
      entry.farModelShown = live;
      this.backend.setFarModel(entry.id, live ? entry.farModelPlacement(farModel) : null);
    }
  }

  private retire(key: number): void {
    this.chunkStuds.delete(key);
    if (!this.liveChunks.delete(key)) return;
    this.backend.deleteChunk(key);
    this.syncFarModels(key);
  }

  private forgetIfEmpty(key: number): void {
    if ((this.byChunk.get(key)?.size ?? 0) > 0) return;
    this.retire(key);
    this.byChunk.delete(key);
    this.chunksBySuper.get(this.superOfChunk(key))?.delete(key);
  }

  private rebuild(keys: Iterable<number>): RebuildReport {
    let chunks = 0;
    let instances = 0;
    let studs = 0;
    for (const key of keys) {
      if (!this.lod.isResident(this.superOfChunk(key))) {
        this.forgetIfEmpty(key);
        continue;
      }
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
    const originX = origin[0] * CHUNK_LDU;
    const originZ = origin[1] * CHUNK_LDU;
    const entries = inWorldOrder(this.byChunk.get(key) ?? new Set<PlacedEntry>());
    const covers = [...(this.byFootprintChunk.get(key) ?? [])];
    const closers = covers.length > 0 ? this.columnsAround(key) : [];
    let partCount = 0;
    let studCount = 0;
    let studsBefore = 0;
    for (const entry of entries) {
      const contribution = entry.contributions.get(key);
      partCount += contribution?.parts ?? 0;
      studsBefore += contribution?.studs ?? 0;
      studCount += entry.markCulled(key, covers, closers);
    }
    this.chunkStuds.set(key, { drawn: studCount, culled: studsBefore - studCount });
    const voxelizedFlags = new Uint8Array(partCount);
    const chunk: ChunkInstances = {
      originX,
      originZ,
      count: partCount,
      partIndex: new Uint16Array(partCount),
      colorIndex: new Uint16Array(partCount),
      matrices: new Float32Array(partCount * INSTANCE_MATRIX_FLOATS),
      voxelized: voxelizedFlags,
      studs: {
        count: studCount,
        primitiveIndex: new Uint8Array(studCount),
        colorIndex: new Uint16Array(studCount),
        matrices: new Float32Array(studCount * INSTANCE_MATRIX_FLOATS),
      },
    };
    if (partCount === 0 && studCount === 0) {
      this.retire(key);
      this.forgetIfEmpty(key);
      return chunk;
    }
    const selectedParts = new Uint32Array(partCount);
    const selectedStuds = new Uint32Array(studCount);
    let partSlot = 0;
    let studSlot = 0;
    for (const entry of entries) {
      const { parts, studs } = entry.placeable;
      const firstPart = partSlot;
      partSlot = entry.writeInto(
        parts.matrices,
        entry.partKeys,
        null,
        key,
        originX,
        originZ,
        chunk.matrices,
        partSlot,
        selectedParts,
      );
      const voxelized = entry.placeable.farModel === null ? 0 : 1;
      for (let slot = firstPart; slot < partSlot; slot++) {
        const i = selectedParts[slot] ?? 0;
        chunk.partIndex[slot] = parts.partIndex[i] ?? 0;
        chunk.colorIndex[slot] = parts.colorIndex[i] ?? 0;
        voxelizedFlags[slot] = voxelized;
      }
      const firstStud = studSlot;
      studSlot = entry.writeInto(
        studs.matrices,
        entry.studKeys,
        entry.studCulled,
        key,
        originX,
        originZ,
        chunk.studs.matrices,
        studSlot,
        selectedStuds,
      );
      for (let slot = firstStud; slot < studSlot; slot++) {
        const i = selectedStuds[slot] ?? 0;
        chunk.studs.primitiveIndex[slot] = studs.primitiveIndex[i] ?? 0;
        chunk.studs.colorIndex[slot] = studs.colorIndex[i] ?? 0;
      }
    }
    this.backend.setChunk(key, chunk);
    this.liveChunks.add(key);
    this.syncFarModels(key);
    return chunk;
  }
}
