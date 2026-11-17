export interface BomLine {
  readonly part: string;
  readonly ldrawColor: number;
  readonly quantity: number;
}

export class BomCounter {
  private readonly colorSlot = new Map<number, number>();
  private readonly counts: Float64Array;
  private readonly outsideTable = new Map<string, BomLine>();

  constructor(
    readonly partIds: ReadonlyArray<string>,
    readonly ldrawColors: ReadonlyArray<number>,
  ) {
    ldrawColors.forEach((code, slot) => this.colorSlot.set(code, slot));
    this.counts = new Float64Array(partIds.length * ldrawColors.length);
  }

  private partId(partIndex: number): string {
    const id = Number.isInteger(partIndex) ? this.partIds[partIndex] : undefined;
    if (id === undefined) throw new RangeError(`part index ${partIndex} is not in the part table`);
    return id;
  }

  add(partIndex: number, ldrawColor: number, quantity: number): void {
    const part = this.partId(partIndex);
    const slot = this.colorSlot.get(ldrawColor);
    if (slot === undefined) {
      const key = `${part}\u0000${ldrawColor}`;
      const existing = this.outsideTable.get(key);
      this.outsideTable.set(key, {
        part,
        ldrawColor,
        quantity: (existing?.quantity ?? 0) + quantity,
      });
      return;
    }
    const cell = partIndex * this.ldrawColors.length + slot;
    this.counts[cell] = (this.counts[cell] ?? 0) + quantity;
  }

  addInstances(
    partIndex: ArrayLike<number>,
    ldrawColor: ArrayLike<number>,
    count: number,
    times: number,
  ): void {
    for (let i = 0; i < count; i++) this.add(partIndex[i] ?? 0, ldrawColor[i] ?? 0, times);
  }

  total(): number {
    let sum = 0;
    for (let i = 0; i < this.counts.length; i++) sum += this.counts[i] ?? 0;
    for (const line of this.outsideTable.values()) sum += line.quantity;
    return sum;
  }

  lines(): ReadonlyArray<BomLine> {
    const colorCount = this.ldrawColors.length;
    const lines: BomLine[] = [];
    for (let cell = 0; cell < this.counts.length; cell++) {
      const quantity = this.counts[cell] ?? 0;
      if (quantity === 0) continue;
      lines.push({
        part: this.partIds[Math.floor(cell / colorCount)] ?? "",
        ldrawColor: this.ldrawColors[cell % colorCount] ?? 0,
        quantity,
      });
    }
    lines.push(...this.outsideTable.values());
    return lines.toSorted(byPartThenColor);
  }
}

export function byPartThenColor(
  a: { readonly part: string; readonly ldrawColor: number },
  b: { readonly part: string; readonly ldrawColor: number },
): number {
  return a.part === b.part ? a.ldrawColor - b.ldrawColor : a.part < b.part ? -1 : 1;
}
