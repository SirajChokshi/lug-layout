export interface LayerTally {
  readonly models: number;
  readonly pieces: number;
}

export interface LayeredModel {
  readonly handle: { readonly layer: number };
}

export interface LayeredTrack {
  readonly pieceCount: number;
  pieceLayer(placement: number): number;
}

function bump(counts: Map<number, number>, layer: number): void {
  counts.set(layer, (counts.get(layer) ?? 0) + 1);
}

export function tallyLayers(
  models: ReadonlyArray<LayeredModel>,
  track: LayeredTrack | null,
): ReadonlyMap<number, LayerTally> {
  const modelCounts = new Map<number, number>();
  const pieceCounts = new Map<number, number>();
  for (let i = 0; i < models.length; i++) bump(modelCounts, models[i]?.handle.layer ?? 0);
  if (track) {
    for (let placement = 0; placement < track.pieceCount; placement++) {
      bump(pieceCounts, track.pieceLayer(placement));
    }
  }
  const tallies = new Map<number, LayerTally>();
  for (const layer of new Set([...modelCounts.keys(), ...pieceCounts.keys()])) {
    tallies.set(layer, {
      models: modelCounts.get(layer) ?? 0,
      pieces: pieceCounts.get(layer) ?? 0,
    });
  }
  return tallies;
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function layerTallyText(tally: LayerTally): string {
  const parts = [
    tally.models > 0 ? counted(tally.models, "model", "models") : null,
    tally.pieces > 0 ? counted(tally.pieces, "track piece", "track pieces") : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "nothing" : parts.join(" and ");
}
