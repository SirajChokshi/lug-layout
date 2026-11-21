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

class CellBlock {
  claimed = 0;
  owner = new Int32Array(BLOCK_SLOTS).fill(NO_OWNER);
  top = new Float64Array(BLOCK_SLOTS);
  phase = new Uint16Array(BLOCK_SLOTS);
  stud = new Float64Array(BLOCK_SLOTS);
  road = new Uint8Array(BLOCK_SLOTS);
  next = new Int32Array(BLOCK_SLOTS).fill(NO_RECORD);
  private nextOverflow = BLOCK_SLOTS;
  private levels = new Float64Array(FIRST_LEVELS);
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
    for (let l = 0; l < this.levelCount; l++) if (this.levels[l] === top) return true;
    return false;
  }

  claim(slot: number, owner: number, top: number, phase: number, stud: number, road: number) {
    let record = slot;
    if (this.owner[slot] !== NO_OWNER) {
      record = this.nextOverflow++;
      if (record >= this.owner.length) this.grow();
      this.next[record] = this.next[slot] ?? NO_RECORD;
      this.next[slot] = record;
    }
    this.owner[record] = owner;
    this.top[record] = top;
    this.phase[record] = phase;
    this.stud[record] = stud;
    this.road[record] = road;
    this.claimed++;
    if (!this.holdsLevel(top)) this.addLevel(top);
  }

  clear(): void {
    this.owner.fill(NO_OWNER, 0, BLOCK_SLOTS);
    this.next.fill(NO_RECORD, 0, BLOCK_SLOTS);
    this.nextOverflow = BLOCK_SLOTS;
    this.claimed = 0;
    this.levelCount = 0;
  }

  private addLevel(top: number): void {
    if (this.levelCount === this.levels.length) {
      const levels = new Float64Array(2 * this.levels.length);
      levels.set(this.levels);
      this.levels = levels;
    }
    this.levels[this.levelCount++] = top;
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
  blockAt(blockX: number, blockZ: number): CellBlock | undefined;
}

class RoadCellCursor {
  private blockX = 0;
  private blockZ = 0;
  private blocksSeen = -1;
  private block = NO_BLOCK;
  private record = NO_RECORD;
  private top = 0;
  private phase = 0;

  constructor(private readonly blocks: BlockSource) {}

  seek(cellX: number, cellZ: number, top: number, phase: number): boolean {
    const blockX = cellX >> BLOCK_SHIFT;
    const blockZ = cellZ >> BLOCK_SHIFT;
    const moved = blockX !== this.blockX || blockZ !== this.blockZ;
    if (moved || (this.block === NO_BLOCK && this.blocks.blocksMade !== this.blocksSeen)) {
      this.blockX = blockX;
      this.blockZ = blockZ;
      this.blocksSeen = this.blocks.blocksMade;
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
  private readonly blocks = new Map<number, Map<number, CellBlock>>();
  private readonly cachedX = new Int32Array(CACHE_SLOTS);
  private readonly cachedZ = new Int32Array(CACHE_SLOTS);
  private readonly cachedKnown = new Uint8Array(CACHE_SLOTS);
  private readonly cached = Array.from<CellBlock | undefined>({ length: CACHE_SLOTS });

  get blocksMade(): number {
    return this.made;
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
        row = new Map();
        this.blocks.set(blockX, row);
      }
      block = new CellBlock();
      row.set(blockZ, block);
      this.remember(blockX, blockZ, block);
      this.made++;
    }
    block.claim(slotOf(cellX, cellZ), owner, top, phase, stud, road);
  }

  occupiedCells(
    rect: RoadCellRect,
    offsetX: number,
    offsetZ: number,
    yLdu: number,
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
            const top = (rect.top[rowCell + x] ?? 0) + yLdu;
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

  reachesLevels(rect: RoadCellRect, offsetX: number, offsetZ: number, yLdu: number): boolean {
    const maxX = offsetX + rect.width;
    const maxZ = offsetZ + rect.depth;
    for (let blockZ = (offsetZ - 1) >> BLOCK_SHIFT; blockZ <= maxZ >> BLOCK_SHIFT; blockZ++) {
      for (let blockX = (offsetX - 1) >> BLOCK_SHIFT; blockX <= maxX >> BLOCK_SHIFT; blockX++) {
        const block = this.blockAt(blockX, blockZ);
        if (!block) continue;
        for (let l = 0; l < rect.levels.length; l++) {
          if (block.holdsLevel((rect.levels[l] ?? 0) + yLdu)) return true;
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
    for (const row of this.blocks.values()) {
      for (const block of row.values()) if (block.claimed > 0) block.clear();
    }
  }

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
