import { EMPTY_COLUMN } from "@brr/catalog";
import {
  OccupancyGrid,
  SupportGrid,
  cellChunkKey,
  firstLayerSupport,
  isSupported,
  trackSupport,
  upperSupport,
  type AppliedEdit,
  type BaseCells,
  type FirstLayerSupport,
  type PlacementHandle,
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
  rayHit(ray: Float64Array): number;
}

export type PlacementSupport =
  | {
      readonly layer: "first";
      readonly support: FirstLayerSupport;
      readonly blocker: PlacedModel | null;
    }
  | { readonly layer: "upper"; readonly support: UpperSupport };

export interface PlacementCheck {
  readonly yPlates: number;
  readonly verdict: PlacementSupport;
}

export interface LostSupport {
  readonly model: PlacedModel;
  readonly support: UpperSupport;
}

export function placementSupported(verdict: PlacementSupport): boolean {
  return verdict.layer === "first"
    ? verdict.support.kind === "on-table"
    : isSupported(verdict.support);
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

interface CandidateCells {
  readonly raised: BaseCells;
  readonly base: BaseCells;
}

function candidateCells(placeable: Placeable, pose: LatticePose): CandidateCells {
  const { cells } = placeable;
  let raisedCount = 0;
  let baseCount = 0;
  for (let cell = 0; cell < cells.width * cells.depth; cell++) {
    if ((cells.columnTop[cell] ?? EMPTY_COLUMN) > 0) raisedCount++;
    if ((cells.footprint[cell] ?? FOOTPRINT_NONE) !== FOOTPRINT_NONE) baseCount++;
  }
  const raised = {
    count: raisedCount,
    cellX: new Int32Array(raisedCount),
    cellZ: new Int32Array(raisedCount),
    flat: new Uint8Array(raisedCount),
  };
  const base = {
    count: baseCount,
    cellX: new Int32Array(baseCount),
    cellZ: new Int32Array(baseCount),
    flat: new Uint8Array(baseCount),
  };
  let o = 0;
  let b = 0;
  for (let j = 0; j < cells.depth; j++) {
    for (let i = 0; i < cells.width; i++) {
      const cell = j * cells.width + i;
      const wx = pose.worldCellX(cells.cellX0 + i, cells.cellZ0 + j);
      const wz = pose.worldCellZ(cells.cellX0 + i, cells.cellZ0 + j);
      if ((cells.columnTop[cell] ?? EMPTY_COLUMN) > 0) {
        raised.cellX[o] = wx;
        raised.cellZ[o] = wz;
        o++;
      }
      if ((cells.footprint[cell] ?? FOOTPRINT_NONE) !== FOOTPRINT_NONE) {
        base.cellX[b] = wx;
        base.cellZ[b] = wz;
        base.flat[b] = cells.footprint[cell] === FOOTPRINT_FLAT ? 1 : 0;
        b++;
      }
    }
  }
  return { raised, base };
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
  readonly box: WorldBox;
  readonly pose: LatticePose;
  readonly x: number;
  readonly yLdu: number;
  readonly z: number;
  readonly cos: number;
  readonly sin: number;

  constructor(
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
    this.box = this.worldBox();
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
    const onLattice = this.placeable.studLattice.onLattice;
    for (let s = 0; s < onLattice.length; s++) {
      if (onLattice[s] !== 1) continue;
      this.columnKeys.add(cellChunkKey(this.studCellX[s] ?? 0, this.studCellZ[s] ?? 0));
    }
  }

  stampColumns(occupancy: OccupancyGrid, support: SupportGrid, onlyChunk: number | null): void {
    const { cells } = this.placeable;
    const yPlates = this.handle.yPlates;
    for (let j = 0; j < cells.depth; j++) {
      for (let i = 0; i < cells.width; i++) {
        const cell = j * cells.width + i;
        const top = cells.columnTop[cell] ?? EMPTY_COLUMN;
        if (top === EMPTY_COLUMN) continue;
        const wx = this.pose.worldCellX(cells.cellX0 + i, cells.cellZ0 + j);
        const wz = this.pose.worldCellZ(cells.cellX0 + i, cells.cellZ0 + j);
        if (onlyChunk !== null && cellChunkKey(wx, wz) !== onlyChunk) continue;
        occupancy.raise(wx, wz, yPlates + top);
        if (cells.baseplate[cell] === 1 && yPlates === 0) support.markBaseplate(wx, wz);
        else support.cover(wx, wz);
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

  columnTopAt(worldCellX: number, worldCellZ: number): number {
    const { cells } = this.placeable;
    const i = this.pose.localCellX(worldCellX, worldCellZ) - cells.cellX0;
    const j = this.pose.localCellZ(worldCellX, worldCellZ) - cells.cellZ0;
    if (i < 0 || j < 0 || i >= cells.width || j >= cells.depth) return EMPTY_COLUMN;
    const top = cells.columnTop[j * cells.width + i] ?? EMPTY_COLUMN;
    return top === EMPTY_COLUMN ? EMPTY_COLUMN : this.handle.yPlates + top;
  }

  private cellAt(worldCellX: number, worldCellZ: number): number {
    const { cells } = this.placeable;
    const i = this.pose.localCellX(worldCellX, worldCellZ) - cells.cellX0;
    const j = this.pose.localCellZ(worldCellX, worldCellZ) - cells.cellZ0;
    if (i < 0 || j < 0 || i >= cells.width || j >= cells.depth) return -1;
    return j * cells.width + i;
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

export class PlacedChunks {
  private readonly entries: PlacedEntry[] = [];
  private readonly byChunk = new Map<number, Set<PlacedEntry>>();
  private readonly byFootprintChunk = new Map<number, Set<PlacedEntry>>();
  private readonly byColumnChunk = new Map<number, Set<PlacedEntry>>();
  private readonly chunkOrigins = new Map<number, readonly [number, number]>();
  private readonly chunkStuds = new Map<number, ChunkStuds>();
  private readonly occupancy = new OccupancyGrid();
  private readonly support = new SupportGrid();

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

  restingHeight(
    placeable: Placeable,
    x: number,
    z: number,
    rot: number,
    ignore: PlacedModel | null,
  ): number {
    return this.check(placeable, x, z, rot, ignore ? [ignore] : []).yPlates;
  }

  check(
    placeable: Placeable,
    x: number,
    z: number,
    rot: number,
    ignore: ReadonlyArray<PlacedModel>,
  ): PlacementCheck {
    const pose = new LatticePose(x, z, rot);
    const cells = candidateCells(placeable, pose);
    return this.withExcluded(this.entriesOf(ignore), () => {
      if (placeable.layer === "first") {
        const support = firstLayerSupport(cells.raised, this.occupancy);
        const blocker =
          support.kind === "blocked"
            ? this.topmostAt(support.cellX, support.cellZ, support.topPlates)
            : null;
        return { yPlates: 0, verdict: { layer: "first", support, blocker } };
      }
      const yPlates = restingHeight(this.occupancy, placeable, pose);
      const support = upperSupport(cells.base, yPlates, this.occupancy, this.support);
      return { yPlates, verdict: { layer: "upper", support } };
    });
  }

  supportAt(
    model: PlacedModel,
    yPlates: number,
    ignore: ReadonlyArray<PlacedModel>,
  ): PlacementSupport {
    const entry = this.entryOf(model);
    return this.withExcluded(this.entriesOf([...ignore, model]), () => {
      if (entry.placeable.layer === "first") {
        const support = firstLayerSupport(entry.candidate.raised, this.occupancy);
        const blocker =
          support.kind === "blocked"
            ? this.topmostAt(support.cellX, support.cellZ, support.topPlates)
            : null;
        return { layer: "first", support, blocker };
      }
      return {
        layer: "upper",
        support: upperSupport(entry.candidate.base, yPlates, this.occupancy, this.support),
      };
    });
  }

  lostSupport(removed: ReadonlyArray<PlacedModel>): ReadonlyArray<LostSupport> {
    const gone = this.entriesOf(removed);
    const keys = new Set<number>();
    for (const entry of gone) for (const key of entry.columnKeys) keys.add(key);
    const lost: LostSupport[] = [];
    for (const entry of this.entries) {
      if (gone.has(entry) || entry.placeable.layer === "first") continue;
      if (![...entry.columnKeys].some((key) => keys.has(key))) continue;
      const support = this.withExcluded(new Set([...gone, entry]), () =>
        upperSupport(entry.candidate.base, entry.handle.yPlates, this.occupancy, this.support),
      );
      if (!isSupported(support)) lost.push({ model: entry, support });
    }
    return lost;
  }

  trackSupport(cells: BaseCells, ignore: ReadonlyArray<PlacedModel>): TrackSupport {
    return this.withExcluded(this.entriesOf(ignore), () => trackSupport(cells, this.support));
  }

  private topmostAt(cellX: number, cellZ: number, topPlates: number): PlacedModel | null {
    for (const entry of this.byColumnChunk.get(cellChunkKey(cellX, cellZ)) ?? []) {
      if (entry.columnTopAt(cellX, cellZ) === topPlates) return entry;
    }
    return null;
  }

  private entryOf(model: PlacedModel): PlacedEntry {
    const entry = this.entries.find((candidate) => candidate === model);
    if (!entry) throw new Error("placement is not in this world view");
    return entry;
  }

  private entriesOf(models: ReadonlyArray<PlacedModel>): ReadonlySet<PlacedEntry> {
    return new Set(models.map((model) => this.entryOf(model)));
  }

  private withExcluded<T>(excluded: ReadonlySet<PlacedEntry>, read: () => T): T {
    if (excluded.size === 0) return read();
    const keys = new Set<number>();
    for (const entry of excluded) for (const key of entry.columnKeys) keys.add(key);
    this.restamp(keys, excluded);
    try {
      return read();
    } finally {
      this.restamp(keys, new Set());
    }
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

  private restamp(keys: ReadonlySet<number>, except: ReadonlySet<PlacedEntry>): void {
    for (const key of keys) {
      this.occupancy.clearChunk(key);
      this.support.clearChunk(key);
      for (const entry of this.byColumnChunk.get(key) ?? []) {
        if (!except.has(entry)) entry.stampColumns(this.occupancy, this.support, key);
      }
    }
  }

  private insert(
    placement: PlacementRef,
    handle: PlacementHandle,
    placeable: Placeable,
  ): PlacedEntry {
    const entry = new PlacedEntry(placement, handle, placeable, this.chunkOrigins);
    this.entries.push(entry);
    for (const key of entry.contributions.keys()) addTo(this.byChunk, key, entry);
    for (const key of entry.footprintKeys) addTo(this.byFootprintChunk, key, entry);
    for (const key of entry.columnKeys) addTo(this.byColumnChunk, key, entry);
    entry.stampColumns(this.occupancy, this.support, null);
    return entry;
  }

  private detach(handle: PlacementHandle): PlacedEntry {
    const index = this.entries.findIndex((entry) => entry.handle === handle);
    const entry = this.entries[index];
    if (!entry) throw new Error("placement is not in this world view");
    this.entries.splice(index, 1);
    for (const key of entry.contributions.keys()) this.byChunk.get(key)?.delete(entry);
    for (const key of entry.footprintKeys) this.byFootprintChunk.get(key)?.delete(entry);
    for (const key of entry.columnKeys) this.byColumnChunk.get(key)?.delete(entry);
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
    const entries = this.byChunk.get(key) ?? new Set<PlacedEntry>();
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
    const chunk: ChunkInstances = {
      originX,
      originZ,
      count: partCount,
      partIndex: new Uint16Array(partCount),
      colorIndex: new Uint16Array(partCount),
      matrices: new Float32Array(partCount * INSTANCE_MATRIX_FLOATS),
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
      for (let slot = firstPart; slot < partSlot; slot++) {
        const i = selectedParts[slot] ?? 0;
        chunk.partIndex[slot] = parts.partIndex[i] ?? 0;
        chunk.colorIndex[slot] = parts.colorIndex[i] ?? 0;
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
