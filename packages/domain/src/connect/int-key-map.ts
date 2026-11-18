const INITIAL_CAPACITY = 1024;

export const MISSING = -1;

export class IntKeyMap {
  private capacity = INITIAL_CAPACITY;
  private used = 0;
  private keys: Int32Array;
  private values = new Int32Array(INITIAL_CAPACITY).fill(MISSING);
  private occupied = new Uint8Array(INITIAL_CAPACITY);

  constructor(private readonly keyInts: number) {
    this.keys = new Int32Array(INITIAL_CAPACITY * keyInts);
  }

  get(key: Int32Array): number {
    const at = this.find(key);
    return at === MISSING ? MISSING : (this.values[at] ?? MISSING);
  }

  set(key: Int32Array, value: number): void {
    let at = this.find(key);
    if (at === MISSING) {
      if ((this.used + 1) * 2 > this.capacity) this.grow();
      at = this.claim(key, 0);
    }
    this.values[at] = value;
  }

  private hash(key: Int32Array, from: number): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < this.keyInts; i++) {
      h = Math.imul(h ^ (key[from + i] ?? 0), 0x01000193);
      h ^= h >>> 13;
    }
    return Math.imul(h, 0x27d4eb2f) & (this.capacity - 1);
  }

  private find(key: Int32Array): number {
    const mask = this.capacity - 1;
    for (let at = this.hash(key, 0); this.occupied[at] === 1; at = (at + 1) & mask) {
      if (this.matches(at, key, 0)) return at;
    }
    return MISSING;
  }

  private matches(at: number, key: Int32Array, from: number): boolean {
    const k = at * this.keyInts;
    for (let i = 0; i < this.keyInts; i++) if (this.keys[k + i] !== key[from + i]) return false;
    return true;
  }

  private claim(key: Int32Array, from: number): number {
    const mask = this.capacity - 1;
    let at = this.hash(key, from);
    while (this.occupied[at] === 1) at = (at + 1) & mask;
    this.occupied[at] = 1;
    for (let i = 0; i < this.keyInts; i++) this.keys[at * this.keyInts + i] = key[from + i] ?? 0;
    this.used++;
    return at;
  }

  private grow(): void {
    const keys = this.keys;
    const values = this.values;
    const occupied = this.occupied;
    const previous = this.capacity;
    this.capacity *= 2;
    this.keys = new Int32Array(this.capacity * this.keyInts);
    this.values = new Int32Array(this.capacity).fill(MISSING);
    this.occupied = new Uint8Array(this.capacity);
    this.used = 0;
    for (let i = 0; i < previous; i++) {
      if (occupied[i] !== 1) continue;
      this.values[this.claim(keys, i * this.keyInts)] = values[i] ?? MISSING;
    }
  }
}
