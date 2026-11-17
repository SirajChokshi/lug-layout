import { CHUNK_STUDS, PLATE_LDU, STUD_LDU } from "@brr/math";
import {
  StudCursor,
  type ReceptacleIndex,
  firstCellTouched,
  lastCellTouched,
  quadBit,
  quadCell,
  studQuads,
  type StudIndex,
} from "./stud-index.ts";
import {
  FULL_CELL,
  NO_VOLUME_TOP,
  cellChunkKey,
  type CellVolumes,
  type OwnerFilter,
  type SpanFilter,
  type VolumeHit,
  type VolumeIndex,
} from "./volume-index.ts";

const CELLS_PER_CHUNK = CHUNK_STUDS * CHUNK_STUDS;
const BASEPLATE = 1;
const OFF_LATTICE_TOP = 2;

function cellIndex(cellX: number, cellZ: number): number {
  const x = cellX - Math.floor(cellX / CHUNK_STUDS) * CHUNK_STUDS;
  const z = cellZ - Math.floor(cellZ / CHUNK_STUDS) * CHUNK_STUDS;
  return z * CHUNK_STUDS + x;
}

interface SupportChunk {
  readonly flags: Uint8Array;
}

export class SupportGrid {
  private readonly byKey = new Map<number, SupportChunk>();

  offLatticeTopAt(cellX: number, cellZ: number): boolean {
    return (this.flagsAt(cellX, cellZ) & OFF_LATTICE_TOP) !== 0;
  }

  markOffLatticeTop(cellX: number, cellZ: number): void {
    const chunk = this.chunkFor(cellX, cellZ);
    const i = cellIndex(cellX, cellZ);
    chunk.flags[i] = (chunk.flags[i] ?? 0) | OFF_LATTICE_TOP;
  }

  baseplateAt(cellX: number, cellZ: number): boolean {
    return (this.flagsAt(cellX, cellZ) & BASEPLATE) !== 0;
  }

  markBaseplate(cellX: number, cellZ: number): void {
    const chunk = this.chunkFor(cellX, cellZ);
    const i = cellIndex(cellX, cellZ);
    chunk.flags[i] = (chunk.flags[i] ?? 0) | BASEPLATE;
  }

  clearChunk(key: number): void {
    this.byKey.delete(key);
  }

  private flagsAt(cellX: number, cellZ: number): number {
    const chunk = this.byKey.get(cellChunkKey(cellX, cellZ));
    return chunk ? (chunk.flags[cellIndex(cellX, cellZ)] ?? 0) : 0;
  }

  private chunkFor(cellX: number, cellZ: number): SupportChunk {
    const key = cellChunkKey(cellX, cellZ);
    let chunk = this.byKey.get(key);
    if (!chunk) {
      chunk = {
        flags: new Uint8Array(CELLS_PER_CHUNK),
      };
      this.byKey.set(key, chunk);
    }
    return chunk;
  }
}

export interface BaseCells {
  readonly count: number;
  readonly cellX: Int32Array;
  readonly cellZ: Int32Array;
  readonly flat: Uint8Array;
}

export type UpperSupport =
  | { readonly kind: "studs"; readonly engaged: number }
  | { readonly kind: "flat"; readonly cells: number }
  | { readonly kind: "no-base" }
  | { readonly kind: "on-table"; readonly cells: number }
  | {
      readonly kind: "flat-on-studs";
      readonly cellX: number;
      readonly cellZ: number;
      readonly yPlates: number;
    }
  | { readonly kind: "off-lattice-top"; readonly yPlates: number; readonly cells: number }
  | { readonly kind: "offset-stud"; readonly yPlates: number; readonly cells: number }
  | {
      readonly kind: "stud-intrudes";
      readonly x: number;
      readonly z: number;
      readonly baseLdu: number;
      readonly yPlates: number;
    }
  | {
      readonly kind: "no-studs-engaged";
      readonly yPlates: number;
      readonly cells: number;
      readonly touching: number;
    };

const topHit: VolumeHit = { owner: 0, bottomLdu: 0, topLdu: 0 };
const studs = new StudCursor();
const clashHit: VolumeHit = { owner: 0, bottomLdu: 0, topLdu: 0 };

function cellCentre(cell: number): number {
  return cell * STUD_LDU + STUD_LDU / 2;
}

export function upperSupport(
  base: BaseCells,
  yPlates: number,
  volumes: VolumeIndex,
  support: SupportGrid,
  studIndex: StudIndex,
  ignore: OwnerFilter,
): UpperSupport {
  if (base.count === 0) return { kind: "no-base" };
  const restLdu = yPlates * PLATE_LDU;
  let engaged = 0;
  let touching = 0;
  let overTable = 0;
  let offLattice = 0;
  let offsetStuds = 0;
  for (let c = 0; c < base.count; c++) {
    const x = base.cellX[c] ?? 0;
    const z = base.cellZ[c] ?? 0;
    let studHere = false;
    let offset = false;
    for (studIndex.cursor(x, z, studs); studs.valid; studs.advance()) {
      if (studs.baseLdu !== restLdu) continue;
      if (studs.x === cellCentre(x) && studs.z === cellCentre(z)) studHere = true;
      else offset = true;
    }
    if (offset) {
      offsetStuds++;
      continue;
    }
    const top = volumes.topOwnerAt(x, z, ignore, topHit) ? topHit.topLdu : NO_VOLUME_TOP;
    if (top === NO_VOLUME_TOP) {
      if (yPlates === 0) overTable++;
      continue;
    }
    if (studHere && base.flat[c] === 1)
      return { kind: "flat-on-studs", cellX: x, cellZ: z, yPlates };
    if (studHere) engaged++;
    else if (support.offLatticeTopAt(x, z)) offLattice++;
    else if (top === restLdu && volumes.quadsWithTop(x, z, restLdu, ignore) === FULL_CELL) {
      touching++;
    }
  }
  if (offsetStuds > 0) return { kind: "offset-stud", yPlates, cells: offsetStuds };
  if (engaged > 0) return { kind: "studs", engaged };
  if (touching === base.count) return { kind: "flat", cells: touching };
  if (overTable === base.count) return { kind: "on-table", cells: overTable };
  if (offLattice > 0) return { kind: "off-lattice-top", yPlates, cells: offLattice };
  return { kind: "no-studs-engaged", yPlates, cells: base.count, touching };
}

export interface Receptacles {
  readonly count: number;
  readonly x: Int32Array;
  readonly z: Int32Array;
  readonly bottomLdu: Int32Array;
}

function hasReceptacle(receptacles: Receptacles, x: number, z: number, bottomLdu: number): boolean {
  for (let p = 0; p < receptacles.count; p++) {
    if (
      receptacles.x[p] === x &&
      receptacles.z[p] === z &&
      receptacles.bottomLdu[p] === bottomLdu
    ) {
      return true;
    }
  }
  return false;
}

const AROUND_X = Int8Array.of(-1, 0, -1, 0);
const AROUND_Z = Int8Array.of(-1, -1, 0, 0);
const MAX_COVERING_OWNERS = 16;
const covering = new Int32Array(MAX_COVERING_OWNERS);

function restsInsideOne(
  volumes: VolumeIndex,
  x: number,
  z: number,
  topLdu: number,
  ignore: OwnerFilter,
): boolean {
  const quarter = STUD_LDU / 2;
  const firstX = x + (AROUND_X[0] ?? 0) * quarter;
  const firstZ = z + (AROUND_Z[0] ?? 0) * quarter;
  const owners = volumes.ownersCovering(
    quadCell(firstX),
    quadCell(firstZ),
    quadBit(firstX, firstZ),
    topLdu,
    ignore,
    covering,
  );
  for (let o = 0; o < owners; o++) {
    const owner = covering[o] ?? 0;
    let all = true;
    for (let q = 1; q < AROUND_X.length && all; q++) {
      const cornerX = x + (AROUND_X[q] ?? 0) * quarter;
      const cornerZ = z + (AROUND_Z[q] ?? 0) * quarter;
      all = volumes.ownerCovers(
        owner,
        quadCell(cornerX),
        quadCell(cornerZ),
        quadBit(cornerX, cornerZ),
        topLdu,
      );
    }
    if (all) return true;
  }
  return false;
}

export function brickSupport(
  receptacles: Receptacles,
  body: CellVolumes,
  yPlates: number,
  volumes: VolumeIndex,
  studIndex: StudIndex,
  ignore: OwnerFilter,
): UpperSupport {
  if (receptacles.count === 0) return { kind: "no-base" };
  let engaged = 0;
  for (let c = 0; c < body.count; c++) {
    const x = body.cellX[c] ?? 0;
    const z = body.cellZ[c] ?? 0;
    const bottom = body.bottomLdu[c] ?? 0;
    const top = body.topLdu[c] ?? 0;
    const quads = body.quads?.[c] ?? FULL_CELL;
    for (studIndex.cursor(x, z, studs); studs.valid; studs.advance()) {
      if (studs.topLdu <= bottom || studs.baseLdu >= top) continue;
      if ((studQuads(x, z, studs.x, studs.z, studs.radius) & quads) === 0) continue;
      if (studs.baseLdu === bottom && hasReceptacle(receptacles, studs.x, studs.z, bottom)) {
        engaged++;
        continue;
      }
      return {
        kind: "stud-intrudes",
        x: studs.x,
        z: studs.z,
        baseLdu: studs.baseLdu,
        yPlates,
      };
    }
  }
  if (engaged > 0) return { kind: "studs", engaged };
  let flat = 0;
  let overTable = 0;
  for (let p = 0; p < receptacles.count; p++) {
    const x = receptacles.x[p] ?? 0;
    const z = receptacles.z[p] ?? 0;
    const bottom = receptacles.bottomLdu[p] ?? 0;
    if (restsInsideOne(volumes, x, z, bottom, ignore)) flat++;
    else if (
      bottom === 0 &&
      !volumes.topOwnerAt(Math.floor(x / STUD_LDU), Math.floor(z / STUD_LDU), ignore, topHit)
    ) {
      overTable++;
    }
  }
  if (flat === receptacles.count) return { kind: "flat", cells: flat };
  if (overTable === receptacles.count) return { kind: "on-table", cells: overTable };
  return { kind: "no-studs-engaged", yPlates, cells: receptacles.count, touching: flat };
}

export interface StudSet {
  readonly count: number;
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly baseLdu: Float64Array;
  readonly topLdu: Float64Array;
  readonly radius: Float64Array;
}

export interface StudClash {
  readonly owner: number;
  readonly x: number;
  readonly z: number;
  readonly baseLdu: number;
}

let clashStudX = 0;
let clashStudZ = 0;
let clashStudBase = 0;
let clashExact: (owner: number) => boolean = () => false;
let clashReceptacles: ReceptacleIndex | null = null;

const clashes: SpanFilter = (owner, bottomLdu) =>
  clashExact(owner) &&
  !(bottomLdu === clashStudBase && clashReceptacles?.has(clashStudX, clashStudZ, bottomLdu));

export function studClash(
  studSet: StudSet,
  volumes: VolumeIndex,
  receptacles: ReceptacleIndex,
  exactBody: (owner: number) => boolean,
): StudClash | null {
  clashExact = exactBody;
  clashReceptacles = receptacles;
  for (let s = 0; s < studSet.count; s++) {
    const x = studSet.x[s] ?? 0;
    const z = studSet.z[s] ?? 0;
    const radius = studSet.radius[s] ?? 0;
    const base = studSet.baseLdu[s] ?? 0;
    const top = studSet.topLdu[s] ?? 0;
    clashStudX = x;
    clashStudZ = z;
    clashStudBase = base;
    for (let cz = firstCellTouched(z, radius); cz <= lastCellTouched(z, radius); cz++) {
      for (let cx = firstCellTouched(x, radius); cx <= lastCellTouched(x, radius); cx++) {
        const quads = studQuads(cx, cz, x, z, radius);
        if (volumes.firstOverlapWhere(cx, cz, base, top, clashes, clashHit, quads)) {
          return { owner: clashHit.owner, x, z, baseLdu: base };
        }
      }
    }
  }
  return null;
}

export function isSupported(verdict: UpperSupport): boolean {
  return verdict.kind === "studs" || verdict.kind === "flat";
}

export type TrackSupport =
  | { readonly kind: "on-baseplate"; readonly cells: number }
  | { readonly kind: "off-baseplate"; readonly cells: number; readonly missing: BaseCells };

export function trackSupport(cells: BaseCells, support: SupportGrid): TrackSupport {
  let missing = 0;
  for (let c = 0; c < cells.count; c++) {
    if (!support.baseplateAt(cells.cellX[c] ?? 0, cells.cellZ[c] ?? 0)) missing++;
  }
  if (missing === 0) return { kind: "on-baseplate", cells: cells.count };
  const out = {
    count: missing,
    cellX: new Int32Array(missing),
    cellZ: new Int32Array(missing),
    flat: new Uint8Array(missing),
  };
  let m = 0;
  for (let c = 0; c < cells.count; c++) {
    const x = cells.cellX[c] ?? 0;
    const z = cells.cellZ[c] ?? 0;
    if (support.baseplateAt(x, z)) continue;
    out.cellX[m] = x;
    out.cellZ[m] = z;
    m++;
  }
  return { kind: "off-baseplate", cells: cells.count, missing: out };
}
