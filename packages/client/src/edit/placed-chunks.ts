import { EMPTY_COLUMN } from "@brr/catalog";
import {
  NO_VOLUME_TOP,
  SupportGrid,
  VolumeIndex,
  cellChunkKey,
  firstOverlap,
  isSupported,
  trackSupport,
  upperSupport,
  type AppliedEdit,
  type BaseCells,
  type CellVolumes,
  type Overlap,
  type OwnerFilter,
  type PlacementHandle,
  type VolumeHit,
  type PlacementRef,
  type TrackSupport,
  type UpperSupport,
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
import type { LaidTrackPiece } from "./track-drawing.ts";

export interface PlacedModel {
  readonly placement: PlacementRef;
  readonly handle: PlacementHandle;
  readonly placeable: Placeable;
  readonly box: WorldBox;
  rayHit(ray: Float64Array): number;
}

export type VolumeOwner =
  | { readonly kind: "model"; readonly model: PlacedModel }
  | { readonly kind: "track"; readonly piece: number; readonly pieceId: string };

export interface PlacedOverlap {
  readonly overlap: Overlap;
  readonly owner: VolumeOwner;
}

export interface PlacementCheck {
  readonly yPlates: number;
  readonly support: UpperSupport | null;
  readonly restsOn: VolumeOwner | null;
  readonly overlap: PlacedOverlap | null;
}

export interface LostSupport {
  readonly model: PlacedModel;
  readonly support: UpperSupport;
}

export interface PendingPose {
  readonly placeable: Placeable;
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
}

interface TrackStamp {
  readonly owner: number;
  readonly piece: number;
  readonly pieceId: string;
  readonly cells: BaseCells;
  readonly bottomLdu: number;
  readonly topLdu: number;
}

const keepEveryOwner: OwnerFilter = () => false;
const PENDING_OWNER = 0;

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

const EMPTY_BOXES = new Float32Array(0);
const scratchBox = new Float64Array(BOX_FLOATS);
const scratchTongue = new Float64Array(BOX_FLOATS);

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

function partsOverlap(
  placeable: Placeable,
  pose: LatticePose,
  yLdu: number,
  box: Float64Array,
  from: number,
): boolean {
  const { min, max } = placeable.box;
  pose.worldBoxOf(min[0], min[1], min[2], max[0], max[1], max[2], yLdu, scratchBox, 0);
  if (!boxesOverlap(scratchBox, 0, box, from)) return false;
  const boxes = placeable.partBoxes;
  for (let b = 0; b < boxes.length; b += BOX_FLOATS) {
    pose.worldBox(boxes, b, yLdu, scratchBox, 0);
    if (boxesOverlap(scratchBox, 0, box, from)) return true;
  }
  return false;
}
export type LandingAt =
  | { readonly kind: "cursor"; readonly cellX: number; readonly cellZ: number }
  | { readonly kind: "height"; readonly yPlates: number };

interface Landing {
  yPlates: number;
  owner: number | null;
}

const landingHit: VolumeHit = { owner: 0, bottomLdu: 0, topLdu: 0 };

function landing(
  volumes: VolumeIndex,
  base: BaseCells,
  at: LandingAt,
  ignore: OwnerFilter,
  out: Landing,
): Landing {
  const hit = landingHit;
  if (at.kind === "cursor") {
    const found = volumes.topOwnerAt(at.cellX, at.cellZ, ignore, hit);
    out.yPlates = found ? Math.max(0, Math.ceil(hit.topLdu / PLATE_LDU)) : 0;
    out.owner = found ? hit.owner : null;
    return out;
  }
  const limit = at.yPlates * PLATE_LDU;
  let owner: number | null = null;
  let highest = NO_VOLUME_TOP;
  for (let c = 0; c < base.count; c++) {
    if (!volumes.topOwnerAt(base.cellX[c] ?? 0, base.cellZ[c] ?? 0, ignore, hit)) continue;
    if (hit.topLdu > limit || hit.topLdu <= highest) continue;
    highest = hit.topLdu;
    owner = hit.owner;
  }
  out.yPlates = at.yPlates;
  out.owner = owner;
  return out;
}

interface CandidateCells {
  readonly base: BaseCells;
  readonly volumes: CellVolumes;
}

interface CellBuffers {
  count: number;
  cellX: Int32Array;
  cellZ: Int32Array;
}

interface BaseBuffers extends CellBuffers {
  flat: Uint8Array;
}

interface VolumeBuffers extends CellBuffers {
  bottomLdu: Int32Array;
  topLdu: Int32Array;
}

function baseBuffers(capacity: number): BaseBuffers {
  return {
    count: 0,
    cellX: new Int32Array(capacity),
    cellZ: new Int32Array(capacity),
    flat: new Uint8Array(capacity),
  };
}

function volumeBuffers(capacity: number): VolumeBuffers {
  return {
    count: 0,
    cellX: new Int32Array(capacity),
    cellZ: new Int32Array(capacity),
    bottomLdu: new Int32Array(capacity),
    topLdu: new Int32Array(capacity),
  };
}

function writeCandidateCells(
  placeable: Placeable,
  pose: LatticePose,
  base: BaseBuffers,
  volumes: VolumeBuffers,
): void {
  const { cells } = placeable;
  let v = 0;
  let b = 0;
  for (let j = 0; j < cells.depth; j++) {
    for (let i = 0; i < cells.width; i++) {
      const cell = j * cells.width + i;
      const wx = pose.worldCellX(cells.cellX0 + i, cells.cellZ0 + j);
      const wz = pose.worldCellZ(cells.cellX0 + i, cells.cellZ0 + j);
      const bottom = cells.bottomLdu[cell] ?? 0;
      const top = cells.topLdu[cell] ?? 0;
      if (top > bottom) {
        volumes.cellX[v] = wx;
        volumes.cellZ[v] = wz;
        volumes.bottomLdu[v] = bottom;
        volumes.topLdu[v] = top;
        v++;
      }
      if ((cells.footprint[cell] ?? FOOTPRINT_NONE) !== FOOTPRINT_NONE) {
        base.cellX[b] = wx;
        base.cellZ[b] = wz;
        base.flat[b] = cells.footprint[cell] === FOOTPRINT_FLAT ? 1 : 0;
        b++;
      }
    }
  }
  base.count = b;
  volumes.count = v;
}

function candidateCells(placeable: Placeable, pose: LatticePose): CandidateCells {
  const { cells } = placeable;
  let volumeCount = 0;
  let baseCount = 0;
  for (let cell = 0; cell < cells.width * cells.depth; cell++) {
    if ((cells.topLdu[cell] ?? 0) > (cells.bottomLdu[cell] ?? 0)) volumeCount++;
    if ((cells.footprint[cell] ?? FOOTPRINT_NONE) !== FOOTPRINT_NONE) baseCount++;
  }
  const base = baseBuffers(baseCount);
  const volumes = volumeBuffers(volumeCount);
  writeCandidateCells(placeable, pose, base, volumes);
  return { base, volumes };
}

class CandidateScratch implements CandidateCells {
  private placeable: Placeable | null = null;
  private x = 0;
  private z = 0;
  private rot = 0;
  private readonly pose = new LatticePose(0, 0, 0);
  base = baseBuffers(0);
  volumes = volumeBuffers(0);
  private raisedVolumes = volumeBuffers(0);

  at(placeable: Placeable, x: number, z: number, rot: number): this {
    if (this.placeable === placeable && this.x === x && this.z === z && this.rot === rot) {
      return this;
    }
    const capacity = placeable.cells.width * placeable.cells.depth;
    if (this.base.cellX.length < capacity) {
      this.base = baseBuffers(capacity);
      this.volumes = volumeBuffers(capacity);
      this.raisedVolumes = volumeBuffers(capacity);
    }
    writeCandidateCells(placeable, this.pose.at(x, z, rot), this.base, this.volumes);
    this.placeable = placeable;
    this.x = x;
    this.z = z;
    this.rot = rot;
    return this;
  }

  raised(byLdu: number): CellVolumes {
    if (byLdu === 0) return this.volumes;
    const from = this.volumes;
    const to = this.raisedVolumes;
    for (let c = 0; c < from.count; c++) {
      to.cellX[c] = from.cellX[c] ?? 0;
      to.cellZ[c] = from.cellZ[c] ?? 0;
      to.bottomLdu[c] = (from.bottomLdu[c] ?? 0) + byLdu;
      to.topLdu[c] = (from.topLdu[c] ?? 0) + byLdu;
    }
    to.count = from.count;
    return to;
  }
}

class PlacedEntry implements PlacedModel {
  readonly partKeys: Float64Array;
  readonly studKeys: Float64Array;
  readonly studCellX: Int32Array;
  readonly studCellZ: Int32Array;
  readonly studBaseLdu: Int32Array;
  readonly studCulled: Uint8Array;
  readonly contributions = new Map<number, Contribution>();
  readonly candidate: CandidateCells;
  readonly footprintKeys = new Set<number>();
  readonly columnKeys = new Set<number>();
  readonly tongueBoxes: Float64Array;
  readonly box: WorldBox;
  readonly pose: LatticePose;
  readonly x: number;
  readonly yLdu: number;
  readonly z: number;
  readonly cos: number;
  readonly sin: number;

  constructor(
    readonly owner: number,
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
    this.candidate = candidateCells(placeable, this.pose);
    this.registerCells(chunkOrigins);
    const tongues = placeable.tongueBoxes ?? EMPTY_BOXES;
    this.tongueBoxes = new Float64Array(tongues.length);
    for (let b = 0; b < tongues.length; b += BOX_FLOATS) {
      this.pose.worldBox(tongues, b, this.yLdu, this.tongueBoxes, b);
    }
    this.box = this.worldBox();
  }

  partsOverlap(box: Float64Array, from: number): boolean {
    return partsOverlap(this.placeable, this.pose, this.yLdu, box, from);
  }

  private registerCells(chunkOrigins: Map<number, readonly [number, number]>): void {
    const { cells } = this.placeable;
    for (let j = 0; j < cells.depth; j++) {
      for (let i = 0; i < cells.width; i++) {
        const cell = j * cells.width + i;
        const occupied = (cells.topLdu[cell] ?? 0) > (cells.bottomLdu[cell] ?? 0);
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
    const onLattice = this.placeable.studLattice.onLattice;
    for (let s = 0; s < onLattice.length; s++) {
      if (onLattice[s] !== 1) continue;
      this.columnKeys.add(cellChunkKey(this.studCellX[s] ?? 0, this.studCellZ[s] ?? 0));
    }
  }

  stampColumns(volumes: VolumeIndex, support: SupportGrid, onlyChunk: number | null): void {
    const { cells } = this.placeable;
    const yPlates = this.handle.yPlates;
    for (let j = 0; j < cells.depth; j++) {
      for (let i = 0; i < cells.width; i++) {
        const cell = j * cells.width + i;
        const bottom = cells.bottomLdu[cell] ?? 0;
        const top = cells.topLdu[cell] ?? 0;
        if (top <= bottom) continue;
        const wx = this.pose.worldCellX(cells.cellX0 + i, cells.cellZ0 + j);
        const wz = this.pose.worldCellZ(cells.cellX0 + i, cells.cellZ0 + j);
        if (onlyChunk !== null && cellChunkKey(wx, wz) !== onlyChunk) continue;
        volumes.add(this.owner, wx, wz, this.yLdu + bottom, this.yLdu + top);
        if (cells.offLatticeTop) support.markOffLatticeTop(wx, wz);
        else if (cells.baseplate[cell] === 1 && yPlates === 0) support.markBaseplate(wx, wz);
      }
    }
    const onLattice = this.placeable.studLattice.onLattice;
    for (let s = 0; s < onLattice.length; s++) {
      const base = this.studBaseLdu[s] ?? 0;
      if (onLattice[s] !== 1 || base % PLATE_LDU !== 0) continue;
      const cx = this.studCellX[s] ?? 0;
      const cz = this.studCellZ[s] ?? 0;
      if (onlyChunk !== null && cellChunkKey(cx, cz) !== onlyChunk) continue;
      support.raiseStud(cx, cz, base / PLATE_LDU);
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

export class PlacedChunks {
  private readonly entries: PlacedEntry[] = [];
  private readonly byChunk = new Map<number, Set<PlacedEntry>>();
  private readonly byFootprintChunk = new Map<number, Set<PlacedEntry>>();
  private readonly byColumnChunk = new Map<number, Set<PlacedEntry>>();
  private readonly chunkOrigins = new Map<number, readonly [number, number]>();
  private readonly chunkStuds = new Map<number, ChunkStuds>();
  private readonly volumes = new VolumeIndex();
  private readonly tongued: PlacedEntry[] = [];
  private readonly probe = new LatticePose(0, 0, 0);
  private readonly candidate = new CandidateScratch();
  private readonly lands: Landing = { yPlates: 0, owner: null };
  private readonly support = new SupportGrid();
  private readonly owners = new Map<number, VolumeOwner>();
  private readonly trackStamps = new Map<number, TrackStamp>();
  private readonly byTrackChunk = new Map<number, Set<TrackStamp>>();
  private nextOwner = 1;
  private readonly trackOwnerByPiece = new Map<number, number>();
  private readonly isTrack: OwnerFilter = (owner) => this.owners.get(owner)?.kind === "track";

  constructor(private readonly backend: ISceneBackend) {}

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

  check(
    placeable: Placeable,
    x: number,
    z: number,
    rot: number,
    ignore: ReadonlyArray<PlacedModel>,
    at: LandingAt,
    exempt: OwnerFilter = keepEveryOwner,
  ): PlacementCheck {
    const cells = this.candidate.at(placeable, x, z, rot);
    if (ignore.length === 0) return this.checkCells(placeable, cells, at, exempt);
    return this.withExcluded(this.entriesOf(ignore), () =>
      this.checkCells(placeable, cells, at, exempt),
    );
  }

  private checkCells(
    placeable: Placeable,
    cells: CandidateScratch,
    at: LandingAt,
    exempt: OwnerFilter,
  ): PlacementCheck {
    const first = placeable.layer === "first";
    const lands = this.lands;
    if (first) {
      lands.yPlates = 0;
      lands.owner = null;
    } else {
      landing(this.volumes, cells.base, at, this.isTrack, lands);
    }
    const { yPlates } = lands;
    const restsOn = lands.owner === null ? null : (this.owners.get(lands.owner) ?? null);
    const support = first
      ? null
      : upperSupport(cells.base, yPlates, this.volumes, this.support, this.isTrack);
    const hit = firstOverlap(cells.raised(yPlates * PLATE_LDU), this.volumes, exempt);
    return { yPlates, support, restsOn, overlap: hit ? this.placedOverlap(hit) : null };
  }

  trackOverlap(
    cells: BaseCells,
    bottomLdu: number,
    topLdu: number,
    exempt: OwnerFilter,
  ): PlacedOverlap | null {
    const volumes: CellVolumes = {
      count: cells.count,
      cellX: cells.cellX,
      cellZ: cells.cellZ,
      bottomLdu: new Int32Array(cells.count).fill(bottomLdu),
      topLdu: new Int32Array(cells.count).fill(topLdu),
    };
    const hit = firstOverlap(
      volumes,
      this.volumes,
      (owner, cellX, cellZ) => this.isTrack(owner, cellX, cellZ) || exempt(owner, cellX, cellZ),
    );
    return hit ? this.placedOverlap(hit) : null;
  }

  trackNeighbours(cells: BaseCells): ReadonlySet<number> {
    const owners = new Set<number>();
    for (let c = 0; c < cells.count; c++) {
      this.volumes.ownersAt(cells.cellX[c] ?? 0, cells.cellZ[c] ?? 0, owners);
    }
    const pieces = new Set<number>();
    for (const owner of owners) {
      const known = this.owners.get(owner);
      if (known?.kind === "track") pieces.add(known.piece);
    }
    return pieces;
  }

  trackOwnerOf(piece: number): number | null {
    return this.trackOwnerByPiece.get(piece) ?? null;
  }

  ownerOf(model: PlacedModel): number {
    return this.entryOf(model).owner;
  }

  addTrackPiece(
    piece: number,
    pieceId: string,
    cells: BaseCells,
    bottomLdu: number,
    topLdu: number,
  ): void {
    const owner = this.nextOwner++;
    const stamp: TrackStamp = { owner, piece, pieceId, cells, bottomLdu, topLdu };
    this.owners.set(owner, { kind: "track", piece, pieceId });
    this.trackStamps.set(owner, stamp);
    this.trackOwnerByPiece.set(piece, owner);
    for (let c = 0; c < cells.count; c++) {
      const x = cells.cellX[c] ?? 0;
      const z = cells.cellZ[c] ?? 0;
      let set = this.byTrackChunk.get(cellChunkKey(x, z));
      if (!set) {
        set = new Set();
        this.byTrackChunk.set(cellChunkKey(x, z), set);
      }
      set.add(stamp);
      this.volumes.add(owner, x, z, bottomLdu, topLdu);
    }
  }

  replaceTrackPieces(pieces: ReadonlyArray<LaidTrackPiece>): void {
    const keys = new Set(this.byTrackChunk.keys());
    for (const owner of this.trackStamps.keys()) this.owners.delete(owner);
    this.trackStamps.clear();
    this.trackOwnerByPiece.clear();
    this.byTrackChunk.clear();
    for (const piece of pieces) {
      this.addTrackPiece(piece.piece, piece.pieceId, piece.cells, piece.bottomLdu, piece.topLdu);
    }
    for (const key of this.byTrackChunk.keys()) keys.add(key);
    this.restamp(keys, new Set());
  }

  private placedOverlap(overlap: Overlap): PlacedOverlap {
    const owner = this.owners.get(overlap.owner);
    if (!owner) throw new Error(`volume owner ${overlap.owner} is not registered`);
    return { overlap, owner };
  }

  lostSupport(
    removed: ReadonlyArray<PlacedModel>,
    moved: ReadonlyArray<PendingPose> = [],
  ): ReadonlyArray<LostSupport> {
    const gone = this.entriesOf(removed);
    const arriving = moved.map((pose) => this.pendingEntry(pose));
    const keys = new Set<number>();
    for (const entry of [...gone, ...arriving]) for (const key of entry.columnKeys) keys.add(key);
    const lost: LostSupport[] = [];
    for (const entry of this.entries) {
      if (gone.has(entry) || entry.placeable.layer === "first") continue;
      if (![...entry.columnKeys].some((key) => keys.has(key))) continue;
      const support = this.withExcluded(
        new Set([...gone, entry]),
        () =>
          upperSupport(
            entry.candidate.base,
            entry.handle.yPlates,
            this.volumes,
            this.support,
            this.isTrack,
          ),
        arriving,
      );
      if (!isSupported(support)) lost.push({ model: entry, support });
    }
    return lost;
  }

  trackSupport(
    cells: BaseCells,
    ignore: ReadonlyArray<PlacedModel>,
    moved: ReadonlyArray<PendingPose> = [],
  ): TrackSupport {
    return this.trackSupportWithout(ignore, moved, (support) => support(cells));
  }

  trackSupportWithout<T>(
    ignore: ReadonlyArray<PlacedModel>,
    moved: ReadonlyArray<PendingPose>,
    read: (support: (cells: BaseCells) => TrackSupport) => T,
  ): T {
    return this.withExcluded(
      this.entriesOf(ignore),
      () => read((cells) => trackSupport(cells, this.support)),
      moved.map((pose) => this.pendingEntry(pose)),
    );
  }

  private pendingEntry(pose: PendingPose): PlacedEntry {
    const handle: PlacementHandle = {
      chunkKey: -1,
      slot: -1,
      generation: -1,
      live: false,
      refId: -1,
      colorId: 0,
      x: pose.x,
      z: pose.z,
      yPlates: pose.yPlates,
      rot: pose.rot,
    };
    return new PlacedEntry(PENDING_OWNER, { handle: null }, handle, pose.placeable, new Map());
  }

  private entryOf(model: PlacedModel): PlacedEntry {
    const entry = this.entries.find((candidate) => candidate === model);
    if (!entry) throw new Error("placement is not in this world view");
    return entry;
  }

  private entriesOf(models: ReadonlyArray<PlacedModel>): ReadonlySet<PlacedEntry> {
    return new Set(models.map((model) => this.entryOf(model)));
  }

  private withExcluded<T>(
    excluded: ReadonlySet<PlacedEntry>,
    read: () => T,
    arriving: ReadonlyArray<PlacedEntry> = [],
  ): T {
    if (excluded.size === 0 && arriving.length === 0) return read();
    const keys = new Set<number>();
    for (const entry of [...excluded, ...arriving]) {
      for (const key of entry.columnKeys) keys.add(key);
    }
    this.restamp(keys, excluded, arriving);
    try {
      return read();
    } finally {
      this.restamp(keys, new Set(), []);
    }
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
    const pose = this.probe.at(x, z, rot);
    const yLdu = yPlates * PLATE_LDU;
    for (let e = 0; e < this.tongued.length; e++) {
      const entry = this.tongued[e];
      if (!entry || entry === ignore || mates(entry)) continue;
      const tongues = entry.tongueBoxes;
      for (let b = 0; b < tongues.length; b += BOX_FLOATS) {
        if (partsOverlap(placeable, pose, yLdu, tongues, b)) {
          return { other: entry, ownTongue: false };
        }
      }
    }
    const own = placeable.tongueBoxes ?? EMPTY_BOXES;
    for (let b = 0; b < own.length; b += BOX_FLOATS) {
      pose.worldBox(own, b, yLdu, scratchTongue, 0);
      for (let e = 0; e < this.entries.length; e++) {
        const entry = this.entries[e];
        if (!entry || entry === ignore || mates(entry)) continue;
        if (entry.partsOverlap(scratchTongue, 0)) return { other: entry, ownTongue: true };
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

  private restamp(
    keys: ReadonlySet<number>,
    except: ReadonlySet<PlacedEntry>,
    arriving: ReadonlyArray<PlacedEntry> = [],
  ): void {
    for (const key of keys) {
      this.volumes.clearChunk(key);
      this.support.clearChunk(key);
      for (const entry of this.byColumnChunk.get(key) ?? []) {
        if (!except.has(entry)) entry.stampColumns(this.volumes, this.support, key);
      }
      for (const stamp of this.byTrackChunk.get(key) ?? []) {
        for (let c = 0; c < stamp.cells.count; c++) {
          const x = stamp.cells.cellX[c] ?? 0;
          const z = stamp.cells.cellZ[c] ?? 0;
          if (cellChunkKey(x, z) === key) {
            this.volumes.add(stamp.owner, x, z, stamp.bottomLdu, stamp.topLdu);
          }
        }
      }
      for (const entry of arriving) entry.stampColumns(this.volumes, this.support, key);
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
    for (const key of new Set([...this.byColumnChunk.keys(), ...this.byTrackChunk.keys()])) {
      this.volumes.clearChunk(key);
      this.support.clearChunk(key);
    }
    for (const entry of this.entries) {
      if (entry.placeable.farModel !== null) this.backend.setFarModel(entry.owner, null);
    }
    this.owners.clear();
    this.trackStamps.clear();
    this.byTrackChunk.clear();
    this.byChunk.clear();
    this.byFootprintChunk.clear();
    this.byColumnChunk.clear();
    this.tongued.length = 0;
    this.chunkStuds.clear();
    this.entries.length = 0;
  }

  private insert(
    placement: PlacementRef,
    handle: PlacementHandle,
    placeable: Placeable,
  ): PlacedEntry {
    const entry = new PlacedEntry(
      this.nextOwner++,
      placement,
      handle,
      placeable,
      this.chunkOrigins,
    );
    this.owners.set(entry.owner, { kind: "model", model: entry });
    this.entries.push(entry);
    if (placeable.farModel !== null) {
      this.backend.setFarModel(entry.owner, entry.farModelPlacement(placeable.farModel));
    }
    for (const key of entry.contributions.keys()) addTo(this.byChunk, key, entry);
    for (const key of entry.footprintKeys) addTo(this.byFootprintChunk, key, entry);
    for (const key of entry.columnKeys) addTo(this.byColumnChunk, key, entry);
    if (entry.tongueBoxes.length > 0) this.tongued.push(entry);
    entry.stampColumns(this.volumes, this.support, null);
    return entry;
  }

  private detach(handle: PlacementHandle): PlacedEntry {
    const index = this.entries.findIndex((entry) => entry.handle === handle);
    const entry = this.entries[index];
    if (!entry) throw new Error("placement is not in this world view");
    this.entries.splice(index, 1);
    this.backend.setFarModel(entry.owner, null);
    this.owners.delete(entry.owner);
    for (const key of entry.contributions.keys()) this.byChunk.get(key)?.delete(entry);
    for (const key of entry.footprintKeys) this.byFootprintChunk.get(key)?.delete(entry);
    for (const key of entry.columnKeys) this.byColumnChunk.get(key)?.delete(entry);
    const tongued = this.tongued.indexOf(entry);
    if (tongued >= 0) this.tongued.splice(tongued, 1);
    this.restamp(entry.columnKeys, new Set());
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
      this.backend.deleteChunk(key);
      this.chunkStuds.delete(key);
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
    return chunk;
  }
}
