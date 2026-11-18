const WORD_BITS = 32;
const WORD_SHIFT = 5;
const WORD_MASK = WORD_BITS - 1;
const TILE_ROW_SHIFT = 5;
const TILE_ROWS = 1 << TILE_ROW_SHIFT;
const TILE_ROW_MASK = TILE_ROWS - 1;
const TILE_CELLS = WORD_BITS * TILE_ROWS;
const MAX_STACKED = 255;
const GROWTH_MARGIN_TILES = 4;
const NO_TILE = -1;

export function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

export class StudLevel {
  private tileX0 = 0;
  private tileZ0 = 0;
  private tilesW = 0;
  private tilesD = 0;
  private slotOf = new Int32Array(0);
  private bits = new Uint32Array(0);
  private stacked = new Uint8Array(0);
  private slots = 0;
  private reachedMinX = Infinity;
  private reachedMinZ = Infinity;
  private reachedMaxX = -Infinity;
  private reachedMaxZ = -Infinity;

  add(cellX: number, cellZ: number): void {
    const slot = this.ensureTile(cellX >> WORD_SHIFT, cellZ >> TILE_ROW_SHIFT);
    const row = cellZ & TILE_ROW_MASK;
    const bit = cellX & WORD_MASK;
    const cell = slot * TILE_CELLS + row * WORD_BITS + bit;
    const stacked = this.stacked[cell] ?? 0;
    if (stacked === MAX_STACKED) {
      throw new RangeError(`more than ${MAX_STACKED} connectors share cell ${cellX}, ${cellZ}`);
    }
    this.stacked[cell] = stacked + 1;
    const word = slot * TILE_ROWS + row;
    this.bits[word] = ((this.bits[word] ?? 0) | (1 << bit)) >>> 0;
    this.reachedMinX = Math.min(this.reachedMinX, cellX);
    this.reachedMinZ = Math.min(this.reachedMinZ, cellZ);
    this.reachedMaxX = Math.max(this.reachedMaxX, cellX);
    this.reachedMaxZ = Math.max(this.reachedMaxZ, cellZ);
  }

  remove(cellX: number, cellZ: number): void {
    const slot = this.slotAt(cellX >> WORD_SHIFT, cellZ >> TILE_ROW_SHIFT);
    const row = cellZ & TILE_ROW_MASK;
    const bit = cellX & WORD_MASK;
    const cell = slot * TILE_CELLS + row * WORD_BITS + bit;
    const stacked = slot === NO_TILE ? 0 : (this.stacked[cell] ?? 0);
    if (stacked === 0) throw new RangeError(`no connector to remove at cell ${cellX}, ${cellZ}`);
    this.stacked[cell] = stacked - 1;
    if (stacked > 1) return;
    const word = slot * TILE_ROWS + row;
    this.bits[word] = ((this.bits[word] ?? 0) & ~(1 << bit)) >>> 0;
  }

  has(cellX: number, cellZ: number): boolean {
    const slot = this.slotAt(cellX >> WORD_SHIFT, cellZ >> TILE_ROW_SHIFT);
    if (slot === NO_TILE) return false;
    const word = this.bits[slot * TILE_ROWS + (cellZ & TILE_ROW_MASK)] ?? 0;
    return ((word >>> (cellX & WORD_MASK)) & 1) === 1;
  }

  countRows(
    raster: Uint32Array,
    offset: number,
    rows: number,
    words: number,
    cellX: number,
    cellZ: number,
  ): number {
    const firstRow = Math.max(0, this.reachedMinZ - cellZ);
    const lastRow = Math.min(rows - 1, this.reachedMaxZ - cellZ);
    const firstWord = Math.max(0, (this.reachedMinX - cellX) >> WORD_SHIFT);
    const lastWord = Math.min(words - 1, (this.reachedMaxX - cellX) >> WORD_SHIFT);
    if (firstRow > lastRow || firstWord > lastWord) return 0;
    const shift = cellX & WORD_MASK;
    const column = (cellX >> WORD_SHIFT) - this.tileX0;
    let n = 0;
    for (let j = firstRow; j <= lastRow; j++) {
      const row = cellZ + j;
      const tileRow = (row >> TILE_ROW_SHIFT) - this.tileZ0;
      if (tileRow < 0 || tileRow >= this.tilesD) continue;
      const slotRow = tileRow * this.tilesW;
      const r = row & TILE_ROW_MASK;
      const from = offset + j * words;
      let current = this.word(slotRow, column + firstWord, r);
      for (let w = firstWord; w <= lastWord; w++) {
        const next = this.word(slotRow, column + w + 1, r);
        const window = shift === 0 ? current : (current >>> shift) | (next << (WORD_BITS - shift));
        n += popcount32(window & (raster[from + w] ?? 0));
        current = next;
      }
    }
    return n;
  }

  private word(slotRow: number, column: number, row: number): number {
    if (column < 0 || column >= this.tilesW) return 0;
    const slot = this.slotOf[slotRow + column] ?? NO_TILE;
    return slot === NO_TILE ? 0 : (this.bits[slot * TILE_ROWS + row] ?? 0);
  }

  private slotAt(tileX: number, tileZ: number): number {
    const x = tileX - this.tileX0;
    const z = tileZ - this.tileZ0;
    if (x < 0 || z < 0 || x >= this.tilesW || z >= this.tilesD) return NO_TILE;
    return this.slotOf[z * this.tilesW + x] ?? NO_TILE;
  }

  private ensureTile(tileX: number, tileZ: number): number {
    const existing = this.slotAt(tileX, tileZ);
    if (existing !== NO_TILE) return existing;
    if (
      tileX < this.tileX0 ||
      tileZ < this.tileZ0 ||
      tileX >= this.tileX0 + this.tilesW ||
      tileZ >= this.tileZ0 + this.tilesD
    ) {
      this.growGrid(tileX, tileZ);
    }
    if ((this.slots + 1) * TILE_ROWS > this.bits.length) this.growSlots();
    const slot = this.slots++;
    this.slotOf[(tileZ - this.tileZ0) * this.tilesW + (tileX - this.tileX0)] = slot;
    return slot;
  }

  private growGrid(tileX: number, tileZ: number): void {
    const empty = this.tilesW === 0;
    const x0 = Math.min(empty ? tileX : this.tileX0, tileX - GROWTH_MARGIN_TILES);
    const z0 = Math.min(empty ? tileZ : this.tileZ0, tileZ - GROWTH_MARGIN_TILES);
    const x1 = Math.max(empty ? tileX : this.tileX0 + this.tilesW, tileX + GROWTH_MARGIN_TILES + 1);
    const z1 = Math.max(empty ? tileZ : this.tileZ0 + this.tilesD, tileZ + GROWTH_MARGIN_TILES + 1);
    const width = x1 - x0;
    const slotOf = new Int32Array(width * (z1 - z0)).fill(NO_TILE);
    for (let z = 0; z < this.tilesD; z++) {
      const to = (z + this.tileZ0 - z0) * width + (this.tileX0 - x0);
      slotOf.set(this.slotOf.subarray(z * this.tilesW, (z + 1) * this.tilesW), to);
    }
    this.slotOf = slotOf;
    this.tileX0 = x0;
    this.tileZ0 = z0;
    this.tilesW = width;
    this.tilesD = z1 - z0;
  }

  private growSlots(): void {
    const slots = Math.max(1, (this.bits.length / TILE_ROWS) * 2);
    const bits = new Uint32Array(slots * TILE_ROWS);
    bits.set(this.bits);
    this.bits = bits;
    const stacked = new Uint8Array(slots * TILE_CELLS);
    stacked.set(this.stacked);
    this.stacked = stacked;
  }
}
