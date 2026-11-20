const NO_CELL = -1;

function sized(array: Int32Array<ArrayBuffer>, needed: number): Int32Array<ArrayBuffer> {
  if (needed <= array.length) return array;
  const larger = new Int32Array(needed + (needed >> 3));
  larger.set(array);
  return larger;
}

export class CellWindowIndex {
  private cellX0 = 0;
  private cellZ0 = 0;
  private width = 0;
  private depth = 0;
  private filling = false;
  private starts = new Int32Array(1);
  private cursors = new Int32Array(0);
  private owners = new Int32Array(0);
  private lows = new Int32Array(0);
  private highs = new Int32Array(0);
  private maxHighs = new Int32Array(0);

  constructor(private readonly answersSpans: boolean) {}

  reset(cellX0: number, cellZ0: number, width: number, depth: number): void {
    const cells = width * depth;
    if (this.starts.length < cells + 1) this.starts = new Int32Array(cells + 1);
    if (this.cursors.length < cells) this.cursors = new Int32Array(cells);
    this.starts.fill(0, 0, cells + 1);
    this.cellX0 = cellX0;
    this.cellZ0 = cellZ0;
    this.width = width;
    this.depth = depth;
    this.filling = false;
  }

  get minCellX(): number {
    return this.cellX0;
  }

  get minCellZ(): number {
    return this.cellZ0;
  }

  get maxCellX(): number {
    return this.cellX0 + this.width - 1;
  }

  get maxCellZ(): number {
    return this.cellZ0 + this.depth - 1;
  }

  push(cellX: number, cellZ: number, owner: number, low: number, high: number): void {
    const cell = this.cellOf(cellX, cellZ);
    if (cell === NO_CELL) return;
    if (!this.filling) {
      this.starts[cell + 1] = (this.starts[cell + 1] ?? 0) + 1;
      return;
    }
    const i = this.cursors[cell] ?? 0;
    this.cursors[cell] = i + 1;
    this.owners[i] = owner;
    this.lows[i] = low;
    this.highs[i] = high;
  }

  startFilling(): void {
    const cells = this.width * this.depth;
    const { starts, cursors } = this;
    for (let cell = 0; cell < cells; cell++) {
      starts[cell + 1] = (starts[cell + 1] ?? 0) + (starts[cell] ?? 0);
      cursors[cell] = starts[cell] ?? 0;
    }
    const records = starts[cells] ?? 0;
    this.owners = sized(this.owners, records);
    this.lows = sized(this.lows, records);
    this.highs = sized(this.highs, records);
    if (this.answersSpans) this.maxHighs = sized(this.maxHighs, records);
    this.filling = true;
  }

  seal(): void {
    const cells = this.width * this.depth;
    for (let cell = 0; cell < cells; cell++) {
      this.sortCell(this.starts[cell] ?? 0, this.starts[cell + 1] ?? 0);
    }
  }

  start(cellX: number, cellZ: number): number {
    const cell = this.cellOf(cellX, cellZ);
    return cell === NO_CELL || !this.filling ? 0 : (this.starts[cell] ?? 0);
  }

  end(cellX: number, cellZ: number): number {
    const cell = this.cellOf(cellX, cellZ);
    return cell === NO_CELL || !this.filling ? 0 : (this.starts[cell + 1] ?? 0);
  }

  firstAtOrAbove(cellX: number, cellZ: number, low: number): number {
    let from = this.start(cellX, cellZ);
    let to = this.end(cellX, cellZ);
    while (from < to) {
      const mid = from + ((to - from) >> 1);
      if ((this.lows[mid] ?? 0) < low) from = mid + 1;
      else to = mid;
    }
    return from;
  }

  spannedByAnotherOwner(cellX: number, cellZ: number, ldu: number, except: number): boolean {
    if (!this.answersSpans) throw new Error("this cell index was built without spans");
    const start = this.start(cellX, cellZ);
    for (let i = this.firstAtOrAbove(cellX, cellZ, ldu + 1) - 1; i >= start; i--) {
      if ((this.maxHighs[i] ?? 0) < ldu) return false;
      if (this.owners[i] !== except && (this.highs[i] ?? 0) >= ldu) return true;
    }
    return false;
  }

  owner(record: number): number {
    return this.owners[record] ?? 0;
  }

  low(record: number): number {
    return this.lows[record] ?? 0;
  }

  high(record: number): number {
    return this.highs[record] ?? 0;
  }

  private sortCell(from: number, to: number): void {
    if (from === to) return;
    const { owners, lows, highs, maxHighs } = this;
    for (let i = from + 1; i < to; i++) {
      const owner = owners[i] ?? 0;
      const low = lows[i] ?? 0;
      const high = highs[i] ?? 0;
      let j = i - 1;
      while (j >= from && (lows[j] ?? 0) > low) {
        owners[j + 1] = owners[j] ?? 0;
        lows[j + 1] = lows[j] ?? 0;
        highs[j + 1] = highs[j] ?? 0;
        j--;
      }
      owners[j + 1] = owner;
      lows[j + 1] = low;
      highs[j + 1] = high;
    }
    if (!this.answersSpans) return;
    let maxHigh = highs[from] ?? 0;
    for (let i = from; i < to; i++) {
      maxHigh = Math.max(maxHigh, highs[i] ?? 0);
      maxHighs[i] = maxHigh;
    }
  }

  private cellOf(cellX: number, cellZ: number): number {
    const x = cellX - this.cellX0;
    const z = cellZ - this.cellZ0;
    if (x < 0 || z < 0 || x >= this.width || z >= this.depth) return NO_CELL;
    return z * this.width + x;
  }
}
