import type { TrackPlacement } from "./track-placements.ts";

export interface PlacementBand {
  readonly framed: Float64Array | null;
  readonly band: readonly [number, number];
  readonly key: string;
  readonly bottomLdu: number;
  readonly topLdu: number;
}

export class PlacementBands {
  private readonly known = new WeakMap<TrackPlacement, PlacementBand>();

  constructor(private readonly measure: (entry: TrackPlacement) => PlacementBand) {}

  of(entry: TrackPlacement): PlacementBand {
    const known = this.known.get(entry);
    if (known) return known;
    const band = this.measure(entry);
    this.known.set(entry, band);
    return band;
  }
}
