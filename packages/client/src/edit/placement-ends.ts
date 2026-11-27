import { pieceEnds, type PieceEnds, type TrackPieceSpec } from "@brr/domain";
import type { TrackPlacement } from "./track-placements.ts";

export class PlacementEnds {
  private readonly known = new WeakMap<TrackPlacement, PieceEnds>();

  constructor(private readonly pieces: ReadonlyArray<TrackPieceSpec>) {}

  of(entry: TrackPlacement): PieceEnds {
    const known = this.known.get(entry);
    if (known) return known;
    const spec = this.pieces[entry.piece];
    if (!spec)
      throw new RangeError(`track piece ${entry.piece} is not in the layout's piece table`);
    const ends = pieceEnds(spec, entry);
    this.known.set(entry, ends);
    return ends;
  }
}
