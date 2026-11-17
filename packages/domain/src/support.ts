import { CHUNK_STUDS, PLATE_LDU } from "@brr/math";
import { NO_TOP, cellChunkKey, type VolumeIndex } from "./volume-index.ts";

const CELLS_PER_CHUNK = CHUNK_STUDS * CHUNK_STUDS;
export const NO_STUD_TOP = -0x8000;
const MAX_STUD_PLATES = 0x7fff;
const BASEPLATE = 1;
const OFF_LATTICE_TOP = 2;

function cellIndex(cellX: number, cellZ: number): number {
  const x = cellX - Math.floor(cellX / CHUNK_STUDS) * CHUNK_STUDS;
  const z = cellZ - Math.floor(cellZ / CHUNK_STUDS) * CHUNK_STUDS;
  return z * CHUNK_STUDS + x;
}

interface SupportChunk {
  readonly studTop: Int16Array;
  readonly flags: Uint8Array;
}

export class SupportGrid {
  private readonly byKey = new Map<number, SupportChunk>();

  studTopAt(cellX: number, cellZ: number): number {
    const chunk = this.byKey.get(cellChunkKey(cellX, cellZ));
    return chunk ? (chunk.studTop[cellIndex(cellX, cellZ)] ?? NO_STUD_TOP) : NO_STUD_TOP;
  }

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

  raiseStud(cellX: number, cellZ: number, basePlates: number): void {
    if (
      !Number.isInteger(basePlates) ||
      basePlates < NO_STUD_TOP + 1 ||
      basePlates > MAX_STUD_PLATES
    ) {
      throw new RangeError(`stud base ${basePlates} plates is outside the int16 grid`);
    }
    const chunk = this.chunkFor(cellX, cellZ);
    const i = cellIndex(cellX, cellZ);
    if (basePlates > (chunk.studTop[i] ?? NO_STUD_TOP)) chunk.studTop[i] = basePlates;
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
        studTop: new Int16Array(CELLS_PER_CHUNK).fill(NO_STUD_TOP),
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
  | {
      readonly kind: "no-studs-engaged";
      readonly yPlates: number;
      readonly cells: number;
      readonly touching: number;
    };

export function upperSupport(
  base: BaseCells,
  yPlates: number,
  volumes: VolumeIndex,
  support: SupportGrid,
): UpperSupport {
  if (base.count === 0) return { kind: "no-base" };
  let engaged = 0;
  let touching = 0;
  let overTable = 0;
  let offLattice = 0;
  for (let c = 0; c < base.count; c++) {
    const x = base.cellX[c] ?? 0;
    const z = base.cellZ[c] ?? 0;
    const top = volumes.topAt(x, z);
    if (top === NO_TOP) {
      if (yPlates === 0) overTable++;
      continue;
    }
    const studHere = support.studTopAt(x, z) === yPlates;
    if (studHere && base.flat[c] === 1)
      return { kind: "flat-on-studs", cellX: x, cellZ: z, yPlates };
    if (studHere) engaged++;
    else if (support.offLatticeTopAt(x, z)) offLattice++;
    else if (top === yPlates * PLATE_LDU) touching++;
  }
  if (engaged > 0) return { kind: "studs", engaged };
  if (touching === base.count) return { kind: "flat", cells: touching };
  if (overTable === base.count) return { kind: "on-table", cells: overTable };
  if (offLattice > 0) return { kind: "off-lattice-top", yPlates, cells: offLattice };
  return { kind: "no-studs-engaged", yPlates, cells: base.count, touching };
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
