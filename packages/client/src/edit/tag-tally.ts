export interface TagTally {
  readonly models: number;
  readonly pieces: number;
}

function bump(counts: Map<number, number>, key: number): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

export function tallyByTag<Model>(
  models: ReadonlyArray<Model>,
  modelKey: (model: Model) => number,
  pieceCount: number,
  pieceKey: (placement: number) => number,
): ReadonlyMap<number, TagTally> {
  const modelCounts = new Map<number, number>();
  const pieceCounts = new Map<number, number>();
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    if (model !== undefined) bump(modelCounts, modelKey(model));
  }
  for (let placement = 0; placement < pieceCount; placement++) {
    bump(pieceCounts, pieceKey(placement));
  }
  const tallies = new Map<number, TagTally>();
  for (const key of new Set([...modelCounts.keys(), ...pieceCounts.keys()])) {
    tallies.set(key, { models: modelCounts.get(key) ?? 0, pieces: pieceCounts.get(key) ?? 0 });
  }
  return tallies;
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function tagTallyText(tally: TagTally): string {
  const parts = [
    tally.models > 0 ? counted(tally.models, "model", "models") : null,
    tally.pieces > 0 ? counted(tally.pieces, "track piece", "track pieces") : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "nothing" : parts.join(" and ");
}
