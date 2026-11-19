import { INSTANCE_MATRIX_FLOATS } from "../scene-backend.ts";

export const STUD_BASIS_FLOATS = 12;
export const STUD_BASIS_TEXELS = 3;
const INITIAL_CAPACITY = 256;
const MAX_BASES = 65_536;

export class StudBasisTable {
  private store = new Float32Array(INITIAL_CAPACITY * STUD_BASIS_FLOATS);
  private used = 0;

  get columns(): Float32Array {
    return this.store;
  }

  get count(): number {
    return this.used;
  }

  indexOf(source: Float32Array, row: number): number {
    const s = row * INSTANCE_MATRIX_FLOATS;
    for (let index = 0; index < this.used; index++) {
      if (this.holds(index, source, s)) return index;
    }
    return this.append(source, s);
  }

  private holds(index: number, source: Float32Array, s: number): boolean {
    const c = index * STUD_BASIS_FLOATS;
    const columns = this.store;
    return (
      Object.is(columns[c], source[s]) &&
      Object.is(columns[c + 1], source[s + 4]) &&
      Object.is(columns[c + 2], source[s + 8]) &&
      Object.is(columns[c + 4], source[s + 1]) &&
      Object.is(columns[c + 5], source[s + 5]) &&
      Object.is(columns[c + 6], source[s + 9]) &&
      Object.is(columns[c + 8], source[s + 2]) &&
      Object.is(columns[c + 9], source[s + 6]) &&
      Object.is(columns[c + 10], source[s + 10])
    );
  }

  private append(source: Float32Array, s: number): number {
    if (this.used === MAX_BASES) {
      throw new RangeError(`a stud basis table holds at most ${MAX_BASES} bases`);
    }
    if ((this.used + 1) * STUD_BASIS_FLOATS > this.store.length) {
      const grown = new Float32Array(this.store.length * 2);
      grown.set(this.store);
      this.store = grown;
    }
    const index = this.used;
    const c = index * STUD_BASIS_FLOATS;
    const columns = this.store;
    columns[c] = source[s] ?? 0;
    columns[c + 1] = source[s + 4] ?? 0;
    columns[c + 2] = source[s + 8] ?? 0;
    columns[c + 4] = source[s + 1] ?? 0;
    columns[c + 5] = source[s + 5] ?? 0;
    columns[c + 6] = source[s + 9] ?? 0;
    columns[c + 8] = source[s + 2] ?? 0;
    columns[c + 9] = source[s + 6] ?? 0;
    columns[c + 10] = source[s + 10] ?? 0;
    this.used = index + 1;
    return index;
  }
}
