const BLOCK_SHIFT = 5;
const BLOCK_SIZE = 1 << BLOCK_SHIFT;
const BLOCK_MASK = BLOCK_SIZE - 1;
const BLOCK_SLOTS = BLOCK_SIZE * BLOCK_SIZE;
const FIRST_OVERFLOW_RECORDS = 64;
const FIRST_LEVELS = 4;
const CACHE_SHIFT = 2;
const CACHE_MASK = (1 << CACHE_SHIFT) - 1;
const CACHE_SLOTS = 1 << (2 * CACHE_SHIFT);
const NO_OWNER = -1;
const NO_RECORD = -1;

export interface RoadCellRect {
  readonly width: number;
  readonly depth: number;
  readonly top: Float64Array;
  readonly present: Uint8Array;
  readonly levels: Float64Array;
}

export function int32(value: number): number {
  return value | 0;
}

function slotOf(cellX: number, cellZ: number): number {
  return ((cellZ & BLOCK_MASK) << BLOCK_SHIFT) | (cellX & BLOCK_MASK);
}

function cacheSlotOf(blockX: number, blockZ: number): number {
  return ((blockZ & CACHE_MASK) << CACHE_SHIFT) | (blockX & CACHE_MASK);
}

function grownInts(from: Int32Array, length: number): Int32Array<ArrayBuffer> {
  const to = new Int32Array(length);
  to.set(from);
  return to;
}

class CellBlock {
  claimed = 0;
  owner = new Int32Array(BLOCK_SLOTS).fill(NO_OWNER);
  top = new Float64Array(BLOCK_SLOTS);
  phase = new Uint16Array(BLOCK_SLOTS);
  stud = new Float64Array(BLOCK_SLOTS);
  road = new Uint8Array(BLOCK_SLOTS);
  next = new Int32Array(BLOCK_SLOTS).fill(NO_RECORD);
  private nextOverflow = BLOCK_SLOTS;
  private freeRecords = new Int32Array(FIRST_OVERFLOW_RECORDS);
  private freeCount = 0;
  private levels = new Float64Array(FIRST_LEVELS);
  private levelClaims = new Int32Array(FIRST_LEVELS);
  private levelCount = 0;

  first(slot: number): number {
    return this.owner[slot] === NO_OWNER ? NO_RECORD : slot;
  }

  match(record: number, top: number, phase: number): number {
    let r = record;
    while (r !== NO_RECORD && (this.top[r] !== top || this.phase[r] !== phase)) {
      r = this.next[r] ?? NO_RECORD;
    }
    return r;
  }

  holdsLevel(top: number): boolean {
    return this.levelIndex(top) >= 0;
  }

  claim(slot: number, owner: number, top: number, phase: number, stud: number, road: number) {
    let record = slot;
    if (this.owner[slot] !== NO_OWNER) {
      record = this.overflowRecord();
      this.next[record] = this.next[slot] ?? NO_RECORD;
      this.next[slot] = record;
    }
    this.owner[record] = owner;
    this.top[record] = top;
    this.phase[record] = phase;
    this.stud[record] = stud;
    this.road[record] = road;
    this.claimed++;
    this.countLevel(top);
  }

  unclaim(slot: number, owner: number): void {
    let before = NO_RECORD;
    let record = this.first(slot);
    while (record !== NO_RECORD && this.owner[record] !== owner) {
      before = record;
      record = this.next[record] ?? NO_RECORD;
    }
    if (record === NO_RECORD) throw new Error(`owner ${owner} holds no claim in slot ${slot}`);
    const top = this.top[record] ?? 0;
    if (record === slot) this.unlinkHead(slot);
    else {
      this.next[before] = this.next[record] ?? NO_RECORD;
      this.freeRecord(record);
    }
    this.claimed--;
    this.uncountLevel(top);
  }

  clear(): void {
    this.owner.fill(NO_OWNER, 0, BLOCK_SLOTS);
    this.next.fill(NO_RECORD, 0, BLOCK_SLOTS);
    this.nextOverflow = BLOCK_SLOTS;
    this.freeCount = 0;
    this.claimed = 0;
    this.levelCount = 0;
  }

  private unlinkHead(slot: number): void {
    let beforeTail = NO_RECORD;
    let tail = slot;
    while ((this.next[tail] ?? NO_RECORD) !== NO_RECORD) {
      beforeTail = tail;
      tail = this.next[tail] ?? NO_RECORD;
    }
    if (tail === slot) {
      this.owner[slot] = NO_OWNER;
      return;
    }
    this.owner[slot] = this.owner[tail] ?? NO_OWNER;
    this.top[slot] = this.top[tail] ?? 0;
    this.phase[slot] = this.phase[tail] ?? 0;
    this.stud[slot] = this.stud[tail] ?? 0;
    this.road[slot] = this.road[tail] ?? 0;
    this.next[beforeTail] = NO_RECORD;
    this.freeRecord(tail);
  }

  private overflowRecord(): number {
    if (this.freeCount > 0) return this.freeRecords[--this.freeCount] ?? NO_RECORD;
    const record = this.nextOverflow++;
    if (record >= this.owner.length) this.grow();
    return record;
  }

  private freeRecord(record: number): void {
    this.next[record] = NO_RECORD;
    if (this.freeCount === this.freeRecords.length) {
      this.freeRecords = grownInts(this.freeRecords, 2 * this.freeRecords.length);
    }
    this.freeRecords[this.freeCount++] = record;
  }

  private levelIndex(top: number): number {
    for (let l = 0; l < this.levelCount; l++) if (this.levels[l] === top) return l;
    return -1;
  }

  private countLevel(top: number): void {
    const at = this.levelIndex(top);
    if (at >= 0) {
      this.levelClaims[at] = (this.levelClaims[at] ?? 0) + 1;
      return;
    }
    if (this.levelCount === this.levels.length) {
      const levels = new Float64Array(2 * this.levels.length);
      levels.set(this.levels);
      this.levels = levels;
      this.levelClaims = grownInts(this.levelClaims, levels.length);
    }
    this.levels[this.levelCount] = top;
    this.levelClaims[this.levelCount++] = 1;
  }

  private uncountLevel(top: number): void {
    const at = this.levelIndex(top);
    const left = (this.levelClaims[at] ?? 0) - 1;
    if (left > 0) {
      this.levelClaims[at] = left;
      return;
    }
    const last = --this.levelCount;
    this.levels[at] = this.levels[last] ?? 0;
    this.levelClaims[at] = this.levelClaims[last] ?? 0;
  }

  private grow(): void {
    const overflow = this.owner.length - BLOCK_SLOTS;
    const capacity = BLOCK_SLOTS + Math.max(FIRST_OVERFLOW_RECORDS, 2 * overflow);
    const owner = new Int32Array(capacity);
    const top = new Float64Array(capacity);
    const phase = new Uint16Array(capacity);
    const stud = new Float64Array(capacity);
    const road = new Uint8Array(capacity);
    const next = new Int32Array(capacity);
    owner.set(this.owner);
    top.set(this.top);
    phase.set(this.phase);
    stud.set(this.stud);
    road.set(this.road);
    next.set(this.next);
    this.owner = owner;
    this.top = top;
    this.phase = phase;
    this.stud = stud;
    this.road = road;
    this.next = next;
  }
}

const NO_BLOCK = new CellBlock();

interface BlockSource {
  readonly blocksMade: number;
  readonly clears: number;
  readonly releases: number;
  blockAt(blockX: number, blockZ: number): CellBlock | undefined;
}

class RoadCellCursor {
  private blockX = 0;
  private blockZ = 0;
  private blocksSeen = -1;
  private clearsSeen = -1;
  private releasesSeen = -1;
  private block = NO_BLOCK;
  private record = NO_RECORD;
  private top = 0;
  private phase = 0;

  constructor(private readonly blocks: BlockSource) {}

  seek(cellX: number, cellZ: number, top: number, phase: number): boolean {
    const blockX = cellX >> BLOCK_SHIFT;
    const blockZ = cellZ >> BLOCK_SHIFT;
    const moved = blockX !== this.blockX || blockZ !== this.blockZ;
    const cleared =
      this.blocks.clears !== this.clearsSeen || this.blocks.releases !== this.releasesSeen;
    if (
      moved ||
      cleared ||
      (this.block === NO_BLOCK && this.blocks.blocksMade !== this.blocksSeen)
    ) {
      this.blockX = blockX;
      this.blockZ = blockZ;
      this.blocksSeen = this.blocks.blocksMade;
      this.clearsSeen = this.blocks.clears;
      this.releasesSeen = this.blocks.releases;
      this.block = this.blocks.blockAt(blockX, blockZ) ?? NO_BLOCK;
    }
    this.top = top;
    this.phase = phase;
    this.record = this.block.match(this.block.first(slotOf(cellX, cellZ)), top, phase);
    return this.record !== NO_RECORD;
  }

  advance(): boolean {
    const next = this.block.next[this.record] ?? NO_RECORD;
    this.record = this.block.match(next, this.top, this.phase);
    return this.record !== NO_RECORD;
  }

  get owner(): number {
    return this.block.owner[this.record] ?? NO_OWNER;
  }

  get stud(): number {
    return this.block.stud[this.record] ?? 0;
  }

  get road(): number {
    return this.block.road[this.record] ?? 0;
  }
}

export class RoadCellGrid implements BlockSource {
  private made = 0;
  private cleared = 0;
  private released = 0;
  private readonly blocks = new Map<number, Map<number, CellBlock>>();
  private readonly freeBlocks: CellBlock[] = [];
  private readonly freeRows: Array<Map<number, CellBlock>> = [];
  private readonly cachedX = new Int32Array(CACHE_SLOTS);
  private readonly cachedZ = new Int32Array(CACHE_SLOTS);
  private readonly cachedKnown = new Uint8Array(CACHE_SLOTS);
  private readonly cached = Array.from<CellBlock | undefined>({ length: CACHE_SLOTS });

  get blocksMade(): number {
    return this.made;
  }

  get clears(): number {
    return this.cleared;
  }

  get releases(): number {
    return this.released;
  }

  cursor(): RoadCellCursor {
    return new RoadCellCursor(this);
  }

  claim(
    cellX: number,
    cellZ: number,
    owner: number,
    top: number,
    phase: number,
    stud: number,
    road: number,
  ): void {
    const blockX = cellX >> BLOCK_SHIFT;
    const blockZ = cellZ >> BLOCK_SHIFT;
    let block = this.blockAt(blockX, blockZ);
    if (!block) {
      let row = this.blocks.get(blockX);
      if (!row) {
        row = this.freeRows.pop() ?? new Map();
        this.blocks.set(blockX, row);
      }
      block = this.freeBlocks.pop() ?? new CellBlock();
      row.set(blockZ, block);
      this.remember(blockX, blockZ, block);
      this.made++;
    }
    block.claim(slotOf(cellX, cellZ), owner, top, phase, stud, road);
  }

  unclaim(cellX: number, cellZ: number, owner: number): void {
    const blockX = cellX >> BLOCK_SHIFT;
    const blockZ = cellZ >> BLOCK_SHIFT;
    const block = this.blockAt(blockX, blockZ);
    if (!block) throw new Error(`no claim at cell ${cellX}, ${cellZ}`);
    block.unclaim(slotOf(cellX, cellZ), owner);
    if (block.claimed > 0) return;
    block.clear();
    const row = this.blocks.get(blockX);
    if (row) {
      row.delete(blockZ);
      if (row.size === 0) {
        this.blocks.delete(blockX);
        this.freeRows.push(row);
      }
    }
    this.freeBlocks.push(block);
    this.remember(blockX, blockZ, undefined);
    this.released++;
  }

  flagOwnersIn(minX: number, minZ: number, maxX: number, maxZ: number, flags: Uint8Array): void {
    for (let blockZ = minZ >> BLOCK_SHIFT; blockZ <= maxZ >> BLOCK_SHIFT; blockZ++) {
      for (let blockX = minX >> BLOCK_SHIFT; blockX <= maxX >> BLOCK_SHIFT; blockX++) {
        const block = this.blockAt(blockX, blockZ);
        if (!block) continue;
        const fromX = Math.max(minX, blockX << BLOCK_SHIFT);
        const toX = Math.min(maxX, (blockX << BLOCK_SHIFT) | BLOCK_MASK);
        const fromZ = Math.max(minZ, blockZ << BLOCK_SHIFT);
        const toZ = Math.min(maxZ, (blockZ << BLOCK_SHIFT) | BLOCK_MASK);
        for (let z = fromZ; z <= toZ; z++) {
          for (let x = fromX; x <= toX; x++) {
            for (
              let r = block.first(slotOf(x, z));
              r !== NO_RECORD;
              r = block.next[r] ?? NO_RECORD
            ) {
              flags[block.owner[r] ?? 0] = 1;
            }
          }
        }
      }
    }
  }

  occupiedCells(
    rect: RoadCellRect,
    offsetX: number,
    offsetZ: number,
    ySixteenths: number,
    phase: number,
    stopAtFirst: boolean,
  ): number {
    const minX = int32(offsetX);
    const minZ = int32(offsetZ);
    const maxX = minX + rect.width - 1;
    const maxZ = minZ + rect.depth - 1;
    let occupied = 0;
    for (let blockZ = minZ >> BLOCK_SHIFT; blockZ <= maxZ >> BLOCK_SHIFT; blockZ++) {
      for (let blockX = minX >> BLOCK_SHIFT; blockX <= maxX >> BLOCK_SHIFT; blockX++) {
        const block = this.blockAt(blockX, blockZ);
        if (!block || block.claimed === 0) continue;
        const fromX = Math.max(minX, blockX << BLOCK_SHIFT);
        const toX = Math.min(maxX, (blockX << BLOCK_SHIFT) | BLOCK_MASK);
        const fromZ = Math.max(minZ, blockZ << BLOCK_SHIFT);
        const toZ = Math.min(maxZ, (blockZ << BLOCK_SHIFT) | BLOCK_MASK);
        for (let z = fromZ; z <= toZ; z++) {
          const rowSlot = (z & BLOCK_MASK) << BLOCK_SHIFT;
          const rowCell = (z - minZ) * rect.width - minX;
          for (let x = fromX; x <= toX; x++) {
            let r = block.first(rowSlot | (x & BLOCK_MASK));
            if (r === NO_RECORD || rect.present[rowCell + x] === 0) continue;
            const top = (rect.top[rowCell + x] ?? 0) + ySixteenths;
            while (r !== NO_RECORD && (block.top[r] !== top || block.phase[r] !== phase)) {
              r = block.next[r] ?? NO_RECORD;
            }
            if (r === NO_RECORD) continue;
            occupied++;
            if (stopAtFirst) return occupied;
          }
        }
      }
    }
    return occupied;
  }

  reachesLevels(
    rect: RoadCellRect,
    offsetX: number,
    offsetZ: number,
    ySixteenths: number,
  ): boolean {
    const maxX = offsetX + rect.width;
    const maxZ = offsetZ + rect.depth;
    for (let blockZ = (offsetZ - 1) >> BLOCK_SHIFT; blockZ <= maxZ >> BLOCK_SHIFT; blockZ++) {
      for (let blockX = (offsetX - 1) >> BLOCK_SHIFT; blockX <= maxX >> BLOCK_SHIFT; blockX++) {
        const block = this.blockAt(blockX, blockZ);
        if (!block) continue;
        for (let l = 0; l < rect.levels.length; l++) {
          if (block.holdsLevel((rect.levels[l] ?? 0) + ySixteenths)) return true;
        }
      }
    }
    return false;
  }

  holds(cellX: number, cellZ: number, top: number, owner: number): boolean {
    const block = this.blockAt(cellX >> BLOCK_SHIFT, cellZ >> BLOCK_SHIFT);
    if (!block) return false;
    for (
      let r = block.first(slotOf(cellX, cellZ));
      r !== NO_RECORD;
      r = block.next[r] ?? NO_RECORD
    ) {
      if (block.top[r] === top && block.owner[r] === owner) return true;
    }
    return false;
  }

  clear(): void {
    this.blocks.forEach(this.releaseRow);
    this.blocks.clear();
    this.cachedKnown.fill(0);
    this.cached.fill(undefined);
    this.cleared++;
  }

  private readonly releaseRow = (row: Map<number, CellBlock>): void => {
    row.forEach(this.releaseBlock);
    row.clear();
    this.freeRows.push(row);
  };

  private readonly releaseBlock = (block: CellBlock): void => {
    if (block.claimed > 0) block.clear();
    this.freeBlocks.push(block);
  };

  blockAt(blockX: number, blockZ: number): CellBlock | undefined {
    const slot = cacheSlotOf(blockX, blockZ);
    if (
      this.cachedKnown[slot] === 1 &&
      this.cachedX[slot] === blockX &&
      this.cachedZ[slot] === blockZ
    ) {
      return this.cached[slot];
    }
    const block = this.blocks.get(blockX)?.get(blockZ);
    this.remember(blockX, blockZ, block);
    return block;
  }

  private remember(blockX: number, blockZ: number, block: CellBlock | undefined): void {
    const slot = cacheSlotOf(blockX, blockZ);
    this.cachedX[slot] = blockX;
    this.cachedZ[slot] = blockZ;
    this.cachedKnown[slot] = 1;
    this.cached[slot] = block;
  }
}
