import {
  CHUNK_STUDS,
  PLATE_LDU,
  STUD_LDU,
  SUPER_CHUNK_CHUNKS,
  rot90Cos,
  rot90Sin,
  type Rot90,
} from "@brr/math";
import { QuadMeshBuilder, type VoxelMeshArrays } from "./mesh-builder.ts";
import type { PlacedVoxels } from "./placed-voxels.ts";

export interface VoxelStamp {
  readonly voxels: PlacedVoxels;
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: Rot90;
}

export const SUPER_CHUNK_MESH_LEVELS = 4;
const SUPER_CHUNK_STUDS = SUPER_CHUNK_CHUNKS * CHUNK_STUDS;
const AXES = 3;
const X = 0;
const Y = 1;
const Z = 2;
const COARSEST_FACTOR = 1 << (SUPER_CHUNK_MESH_LEVELS - 1);
const MAX_BLOCK_COLORS = COARSEST_FACTOR ** 3;

type Phase = "stamp" | "downsample" | "mesh" | "done";

interface PhaseClass {
  readonly yPhaseLdu: number;
  readonly stamps: VoxelStamp[];
  minPlate: number;
  maxPlate: number;
}

interface PlanBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

function stampBounds(stamps: ReadonlyArray<VoxelStamp>): PlanBounds {
  const bounds: PlanBounds = {
    minX: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  };
  for (const stamp of stamps) {
    const { voxels } = stamp;
    const cos = rot90Cos(stamp.rot);
    const sin = rot90Sin(stamp.rot);
    const originX = stamp.x / STUD_LDU;
    const originZ = stamp.z / STUD_LDU;
    for (let i = 0; i < voxels.count; i++) {
      const twiceX = 2 * (voxels.cellX[i] ?? 0) + 1;
      const twiceZ = 2 * (voxels.cellZ[i] ?? 0) + 1;
      const x = originX + (cos * twiceX + sin * twiceZ - 1) / 2;
      const z = originZ + (-sin * twiceX + cos * twiceZ - 1) / 2;
      if (x < bounds.minX) bounds.minX = x;
      if (x + 1 > bounds.maxX) bounds.maxX = x + 1;
      if (z < bounds.minZ) bounds.minZ = z;
      if (z + 1 > bounds.maxZ) bounds.maxZ = z + 1;
    }
  }
  return bounds;
}

function alignDown(studs: number): number {
  return Math.floor(studs / COARSEST_FACTOR) * COARSEST_FACTOR;
}

function alignUp(studs: number): number {
  return Math.ceil(studs / COARSEST_FACTOR) * COARSEST_FACTOR;
}

function phaseClasses(stamps: ReadonlyArray<VoxelStamp>, factor: number): PhaseClass[] {
  const classes = new Map<number, PhaseClass>();
  for (const stamp of stamps) {
    const { voxels } = stamp;
    if (voxels.count === 0) continue;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < voxels.count; i++) {
      const y = voxels.cellY[i] ?? 0;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    let entry = classes.get(voxels.yPhaseLdu);
    if (!entry) {
      entry = {
        yPhaseLdu: voxels.yPhaseLdu,
        stamps: [],
        minPlate: Number.POSITIVE_INFINITY,
        maxPlate: Number.NEGATIVE_INFINITY,
      };
      classes.set(voxels.yPhaseLdu, entry);
    }
    entry.stamps.push(stamp);
    entry.minPlate = Math.min(entry.minPlate, stamp.yPlates + minY);
    entry.maxPlate = Math.max(entry.maxPlate, stamp.yPlates + maxY + 1);
  }
  const list = [...classes.values()].toSorted((a, b) => a.yPhaseLdu - b.yPhaseLdu);
  for (const entry of list) {
    entry.minPlate = Math.floor(entry.minPlate / factor) * factor;
    entry.maxPlate = Math.ceil(entry.maxPlate / factor) * factor;
  }
  return list;
}

class Grid {
  cells = new Uint16Array(0);
  readonly dims = new Int32Array(AXES);
  readonly strides = new Int32Array(AXES);
  readonly lo = new Int32Array(AXES);
  readonly hi = new Int32Array(AXES);

  reset(dimX: number, dimY: number, dimZ: number): void {
    this.dims[X] = dimX;
    this.dims[Y] = dimY;
    this.dims[Z] = dimZ;
    this.strides[X] = 1;
    this.strides[Z] = dimX;
    this.strides[Y] = dimX * dimZ;
    const size = dimX * dimY * dimZ;
    if (this.cells.length < size) this.cells = new Uint16Array(size);
    else this.cells.fill(0, 0, size);
    for (let axis = 0; axis < AXES; axis++) {
      this.lo[axis] = this.dims[axis] ?? 0;
      this.hi[axis] = 0;
    }
  }

  get empty(): boolean {
    return (this.hi[X] ?? 0) === 0;
  }

  set(x: number, y: number, z: number, value: number): void {
    this.cells[y * (this.strides[Y] ?? 0) + z * (this.strides[Z] ?? 0) + x] = value;
    if (x < (this.lo[X] ?? 0)) this.lo[X] = x;
    if (x + 1 > (this.hi[X] ?? 0)) this.hi[X] = x + 1;
    if (y < (this.lo[Y] ?? 0)) this.lo[Y] = y;
    if (y + 1 > (this.hi[Y] ?? 0)) this.hi[Y] = y + 1;
    if (z < (this.lo[Z] ?? 0)) this.lo[Z] = z;
    if (z + 1 > (this.hi[Z] ?? 0)) this.hi[Z] = z + 1;
  }
}

export class SuperChunkMesher {
  private readonly fine = new Grid();
  private readonly coarse = new Grid();
  private active = this.fine;
  private mask = new Int32Array(0);
  private readonly blockColors = new Uint16Array(MAX_BLOCK_COLORS);
  private readonly blockCounts = new Uint16Array(MAX_BLOCK_COLORS);
  private readonly cellLdu = new Float64Array(AXES);
  private readonly offsetLdu = new Float64Array(AXES);
  private readonly corner = new Float64Array(AXES);
  private readonly edgeU = new Float64Array(AXES);
  private readonly edgeV = new Float64Array(AXES);
  private readonly builder = new QuadMeshBuilder();
  private classes: PhaseClass[] = [];
  private classIndex = 0;
  private factor = 1;
  private originStudX = 0;
  private originStudZ = 0;
  private gridStudX = 0;
  private gridStudZ = 0;
  private gridWidth = 0;
  private gridDepth = 0;
  private minPlate = 0;
  private phase: Phase = "done";
  private nextStamp = 0;
  private axis = 0;
  private slice = 0;

  begin(superX: number, superZ: number, stamps: ReadonlyArray<VoxelStamp>, level: number): void {
    this.factor = 1 << level;
    this.originStudX = superX * SUPER_CHUNK_STUDS;
    this.originStudZ = superZ * SUPER_CHUNK_STUDS;
    const bounds = stampBounds(stamps);
    if (bounds.minX > bounds.maxX) {
      bounds.minX = this.originStudX;
      bounds.maxX = this.originStudX;
      bounds.minZ = this.originStudZ;
      bounds.maxZ = this.originStudZ;
    }
    this.gridStudX = alignDown(bounds.minX);
    this.gridStudZ = alignDown(bounds.minZ);
    this.gridWidth = Math.max(alignUp(bounds.maxX) - this.gridStudX, COARSEST_FACTOR);
    this.gridDepth = Math.max(alignUp(bounds.maxZ) - this.gridStudZ, COARSEST_FACTOR);
    this.classes = phaseClasses(stamps, this.factor);
    this.cellLdu[X] = STUD_LDU * this.factor;
    this.cellLdu[Y] = PLATE_LDU * this.factor;
    this.cellLdu[Z] = STUD_LDU * this.factor;
    this.builder.reset();
    this.classIndex = 0;
    this.beginClass();
  }

  private beginClass(): void {
    const current = this.classes[this.classIndex];
    if (!current) {
      this.phase = "done";
      return;
    }
    this.minPlate = current.minPlate;
    const height = Math.max(current.maxPlate - current.minPlate, this.factor);
    this.fine.reset(this.gridWidth, height, this.gridDepth);
    this.active = this.fine;
    this.offsetLdu[X] = (this.gridStudX - this.originStudX) * STUD_LDU;
    this.offsetLdu[Y] = current.minPlate * PLATE_LDU + current.yPhaseLdu;
    this.offsetLdu[Z] = (this.gridStudZ - this.originStudZ) * STUD_LDU;
    this.nextStamp = 0;
    this.phase = "stamp";
  }

  step(deadlineMs: number): boolean {
    while (this.phase !== "done") {
      switch (this.phase) {
        case "stamp":
          this.stampNext();
          break;
        case "downsample":
          this.downsampleNextLayer();
          break;
        case "mesh":
          this.meshNextSlice();
          break;
        default: {
          const unhandled: never = this.phase;
          throw new Error(`unhandled ${String(unhandled)}`);
        }
      }
      if (performance.now() >= deadlineMs) break;
    }
    return this.phase === "done";
  }

  finish(): VoxelMeshArrays {
    return this.builder.finish();
  }

  private nextClass(): void {
    this.classIndex++;
    this.beginClass();
  }

  private startMeshing(grid: Grid): void {
    this.active = grid;
    this.phase = "mesh";
    this.axis = 0;
    this.slice = grid.lo[0] ?? 0;
  }

  private stampNext(): void {
    const stamp = this.classes[this.classIndex]?.stamps[this.nextStamp];
    if (!stamp) {
      if (this.fine.empty) {
        this.nextClass();
        return;
      }
      if (this.factor === 1) {
        this.startMeshing(this.fine);
        return;
      }
      const f = this.factor;
      const dims = this.fine.dims;
      this.coarse.reset((dims[X] ?? 0) / f, (dims[Y] ?? 0) / f, (dims[Z] ?? 0) / f);
      this.slice = Math.floor((this.fine.lo[Y] ?? 0) / f);
      this.phase = "downsample";
      return;
    }
    this.nextStamp++;
    const { voxels, rot } = stamp;
    const cos = rot90Cos(rot);
    const sin = rot90Sin(rot);
    const grid = this.fine;
    const dimX = grid.dims[X] ?? 0;
    const dimY = grid.dims[Y] ?? 0;
    const dimZ = grid.dims[Z] ?? 0;
    const offsetX = stamp.x / STUD_LDU - this.gridStudX;
    const offsetZ = stamp.z / STUD_LDU - this.gridStudZ;
    const offsetY = stamp.yPlates - this.minPlate;
    for (let i = 0; i < voxels.count; i++) {
      const twiceX = 2 * (voxels.cellX[i] ?? 0) + 1;
      const twiceZ = 2 * (voxels.cellZ[i] ?? 0) + 1;
      const gx = offsetX + (cos * twiceX + sin * twiceZ - 1) / 2;
      const gz = offsetZ + (-sin * twiceX + cos * twiceZ - 1) / 2;
      const gy = offsetY + (voxels.cellY[i] ?? 0);
      if (gx < 0 || gx >= dimX || gz < 0 || gz >= dimZ || gy < 0 || gy >= dimY) continue;
      grid.set(gx, gy, gz, (voxels.colorIndex[i] ?? 0) + 1);
    }
  }

  private downsampleNextLayer(): void {
    const f = this.factor;
    const fine = this.fine;
    const cy = this.slice;
    if (cy * f >= (fine.hi[Y] ?? 0)) {
      if (this.coarse.empty) this.nextClass();
      else this.startMeshing(this.coarse);
      return;
    }
    this.slice++;
    const loX = Math.floor((fine.lo[X] ?? 0) / f);
    const hiX = Math.ceil((fine.hi[X] ?? 0) / f);
    const loZ = Math.floor((fine.lo[Z] ?? 0) / f);
    const hiZ = Math.ceil((fine.hi[Z] ?? 0) / f);
    const strideY = fine.strides[Y] ?? 0;
    const strideZ = fine.strides[Z] ?? 0;
    const cells = fine.cells;
    for (let cz = loZ; cz < hiZ; cz++) {
      for (let cx = loX; cx < hiX; cx++) {
        let distinct = 0;
        for (let dy = 0; dy < f; dy++) {
          for (let dz = 0; dz < f; dz++) {
            const row = (cy * f + dy) * strideY + (cz * f + dz) * strideZ + cx * f;
            for (let dx = 0; dx < f; dx++) {
              const value = cells[row + dx] ?? 0;
              if (value === 0) continue;
              let k = 0;
              while (k < distinct && this.blockColors[k] !== value) k++;
              if (k === distinct) {
                this.blockColors[k] = value;
                this.blockCounts[k] = 0;
                distinct++;
              }
              this.blockCounts[k] = (this.blockCounts[k] ?? 0) + 1;
            }
          }
        }
        if (distinct === 0) continue;
        let best = 0;
        for (let k = 1; k < distinct; k++) {
          const count = this.blockCounts[k] ?? 0;
          const bestCount = this.blockCounts[best] ?? 0;
          if (
            count > bestCount ||
            (count === bestCount && (this.blockColors[k] ?? 0) < (this.blockColors[best] ?? 0))
          ) {
            best = k;
          }
        }
        this.coarse.set(cx, cy, cz, this.blockColors[best] ?? 0);
      }
    }
  }

  private meshNextSlice(): void {
    const grid = this.active;
    const d = this.axis;
    const u = (d + 1) % AXES;
    const v = (d + 2) % AXES;
    const s = this.slice;
    this.meshSlice(grid, d, u, v, s);
    if (s < (grid.hi[d] ?? 0)) {
      this.slice++;
      return;
    }
    this.axis++;
    if (this.axis === AXES) {
      this.nextClass();
      return;
    }
    this.slice = grid.lo[this.axis] ?? 0;
  }

  private meshSlice(grid: Grid, d: number, u: number, v: number, s: number): void {
    const loU = grid.lo[u] ?? 0;
    const loV = grid.lo[v] ?? 0;
    const width = (grid.hi[u] ?? 0) - loU;
    const height = (grid.hi[v] ?? 0) - loV;
    const strideD = grid.strides[d] ?? 0;
    const strideU = grid.strides[u] ?? 0;
    const strideV = grid.strides[v] ?? 0;
    const hasBelow = s > (grid.lo[d] ?? 0);
    const hasAbove = s < (grid.hi[d] ?? 0);
    if (this.mask.length < width * height) this.mask = new Int32Array(width * height);
    const mask = this.mask;
    const cells = grid.cells;
    for (let j = 0; j < height; j++) {
      const rowBase = s * strideD + (loV + j) * strideV + loU * strideU;
      for (let i = 0; i < width; i++) {
        const index = rowBase + i * strideU;
        const below = hasBelow ? (cells[index - strideD] ?? 0) : 0;
        const above = hasAbove ? (cells[index] ?? 0) : 0;
        mask[j * width + i] =
          below !== 0 && above === 0 ? below : below === 0 && above !== 0 ? -above : 0;
      }
    }
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width;) {
        const value = mask[j * width + i] ?? 0;
        if (value === 0) {
          i++;
          continue;
        }
        let w = 1;
        while (i + w < width && mask[j * width + i + w] === value) w++;
        let h = 1;
        grow: while (j + h < height) {
          for (let k = 0; k < w; k++) {
            if (mask[(j + h) * width + i + k] !== value) break grow;
          }
          h++;
        }
        for (let dy = 0; dy < h; dy++) mask.fill(0, (j + dy) * width + i, (j + dy) * width + i + w);
        this.emit(d, u, v, s, loU + i, loV + j, w, h, value);
        i += w;
      }
    }
  }

  private emit(
    d: number,
    u: number,
    v: number,
    s: number,
    cellU: number,
    cellV: number,
    w: number,
    h: number,
    value: number,
  ): void {
    this.corner[d] = s * (this.cellLdu[d] ?? 0) + (this.offsetLdu[d] ?? 0);
    this.corner[u] = cellU * (this.cellLdu[u] ?? 0) + (this.offsetLdu[u] ?? 0);
    this.corner[v] = cellV * (this.cellLdu[v] ?? 0) + (this.offsetLdu[v] ?? 0);
    this.edgeU.fill(0);
    this.edgeV.fill(0);
    this.edgeU[u] = w * (this.cellLdu[u] ?? 0);
    this.edgeV[v] = h * (this.cellLdu[v] ?? 0);
    this.builder.addQuad(
      this.corner,
      this.edgeU,
      this.edgeV,
      d,
      value > 0 ? 1 : -1,
      Math.abs(value) - 1,
    );
  }
}
