import type { PaletteLevel } from "../scene-backend.ts";

const NO_INDICES = new Uint32Array(0);

function indices(list: ReadonlyArray<number>): Uint32Array {
  return list.length === 0 ? NO_INDICES : Uint32Array.from(list);
}

function sortedIncludes(list: Uint32Array, value: number): boolean {
  let low = 0;
  let high = list.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const at = list[middle] ?? 0;
    if (at === value) return true;
    if (at < value) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

export class ChunkNeeds {
  constructor(
    private readonly detailed: ReadonlyArray<Uint32Array>,
    private readonly far: ReadonlyArray<Uint32Array>,
  ) {}

  detailedAt(tier: number): Uint32Array {
    return this.detailed[tier] ?? NO_INDICES;
  }

  farAt(tier: number): Uint32Array {
    return this.far[tier] ?? NO_INDICES;
  }

  drawsAnyPart(
    tier: number,
    detailedChanged: ReadonlySet<number>,
    farChanged: ReadonlySet<number>,
    farLevelParts: ReadonlyArray<unknown>,
  ): boolean {
    const detailed = this.detailedAt(tier);
    const far = this.farAt(tier);
    for (const part of detailedChanged) {
      if (sortedIncludes(detailed, part)) return true;
      if (farLevelParts[part] === undefined && sortedIncludes(far, part)) return true;
    }
    for (const part of farChanged) {
      if (sortedIncludes(far, part)) return true;
    }
    return false;
  }
}

export class ChunkNeedsBuilder {
  private readonly detailed: number[][];
  private readonly far: number[][];

  constructor(tiers: number) {
    this.detailed = Array.from({ length: tiers }, () => []);
    this.far = Array.from({ length: tiers }, () => []);
  }

  need(tier: number, level: PaletteLevel, index: number): void {
    const list = (level === "far" ? this.far : this.detailed)[tier];
    if (list && list[list.length - 1] !== index) list.push(index);
  }

  build(): ChunkNeeds {
    return new ChunkNeeds(this.detailed.map(indices), this.far.map(indices));
  }
}
