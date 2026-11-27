import type { TrackFrame, TrackLayout } from "@brr/domain";
import type { Pose16 } from "@brr/math";

export interface TrackPlacement {
  readonly piece: number;
  readonly pose: Pose16;
  readonly yPlates: number;
  readonly rise: number;
  readonly frame: TrackFrame;
}

export function contentOf(layout: TrackLayout, placement: number): TrackPlacement {
  return {
    piece: layout.piece(placement),
    pose: layout.pose(placement),
    yPlates: layout.yPlates(placement),
    rise: layout.rise(placement),
    frame: layout.frame(placement),
  };
}

export class TrackPlacements {
  private readonly entries: TrackPlacement[] = [];
  private laidCount = 0;

  at(placement: number): TrackPlacement {
    const entry = this.entries[placement];
    if (!entry) throw new RangeError(`track placement ${placement} has no mirrored entry`);
    return entry;
  }

  lifted(index: number): void {
    if (index < 0 || index >= this.laidCount) {
      throw new RangeError(`laid track placement ${index} isn't mirrored`);
    }
    this.entries.splice(index, 1);
    this.laidCount--;
  }

  laid(index: number, entry: TrackPlacement): void {
    if (index < 0 || index > this.laidCount) {
      throw new RangeError(`laid track placement ${index} is outside 0-${this.laidCount}`);
    }
    this.entries.splice(index, 0, entry);
    this.laidCount++;
  }

  heldFrom(combined: TrackLayout): void {
    this.entries.length = this.laidCount;
    for (let p = this.laidCount; p < combined.count; p++) this.entries.push(contentOf(combined, p));
  }
}
