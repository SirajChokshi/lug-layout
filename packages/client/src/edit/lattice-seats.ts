import { STUD_LDU } from "@brr/math";
import { BOX_FLOATS } from "./local-box.ts";
import { cellKey } from "./track-obstacles.ts";

const ON_LATTICE = 1;
const SEATED_TOP = 1;
const NO_KEYS = new Float64Array(0);

function sortedHas(keys: Float64Array, key: number): boolean {
  let low = 0;
  let high = keys.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const at = keys[middle] ?? 0;
    if (at === key) return true;
    if (at < key) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

export class LatticeSeats {
  private readonly byBase = new Map<number, Float64Array>();

  constructor(onLattice: Uint8Array, cellX: Int32Array, cellZ: Int32Array, baseLdu: Int32Array) {
    const keys = new Map<number, number[]>();
    for (let stud = 0; stud < onLattice.length; stud++) {
      if (onLattice[stud] !== ON_LATTICE) continue;
      const base = baseLdu[stud] ?? 0;
      const atBase = keys.get(base) ?? [];
      atBase.push(cellKey(cellX[stud] ?? 0, cellZ[stud] ?? 0));
      keys.set(base, atBase);
    }
    for (const [base, atBase] of keys) {
      this.byBase.set(base, Float64Array.from(atBase).toSorted());
    }
  }

  has(cellX: number, cellZ: number, baseLdu: number): boolean {
    return sortedHas(this.byBase.get(baseLdu) ?? NO_KEYS, cellKey(cellX, cellZ));
  }

  seatedTops(partBoxes: Float32Array): Uint8Array {
    const tops = new Uint8Array(partBoxes.length / BOX_FLOATS);
    for (let b = 0; b < partBoxes.length; b += BOX_FLOATS) {
      if (this.coversTop(partBoxes, b)) tops[b / BOX_FLOATS] = SEATED_TOP;
    }
    return tops;
  }

  private coversTop(partBoxes: Float32Array, b: number): boolean {
    const top = partBoxes[b + 4] ?? 0;
    const atTop = this.byBase.get(top);
    if (!atTop) return false;
    const cellX1 = Math.ceil((partBoxes[b + 3] ?? 0) / STUD_LDU);
    const cellZ1 = Math.ceil((partBoxes[b + 5] ?? 0) / STUD_LDU);
    for (let cellZ = Math.floor((partBoxes[b + 2] ?? 0) / STUD_LDU); cellZ < cellZ1; cellZ++) {
      for (let cellX = Math.floor((partBoxes[b] ?? 0) / STUD_LDU); cellX < cellX1; cellX++) {
        if (!sortedHas(atTop, cellKey(cellX, cellZ))) return false;
      }
    }
    return true;
  }
}
