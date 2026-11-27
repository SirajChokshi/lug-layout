import type { TrackPlacement } from "./track-placements.ts";
import type { TrackSupport } from "./track-support.ts";

interface Measured {
  readonly support: TrackSupport;
  readonly boxes: ReadonlyArray<number> | null;
}

export class SupportReach {
  private readonly known = new WeakMap<TrackPlacement, Measured>();

  constructor(
    private readonly measure: (
      entry: TrackPlacement,
      support: TrackSupport,
    ) => ReadonlyArray<number> | null,
  ) {}

  of(entry: TrackPlacement, support: TrackSupport): ReadonlyArray<number> | null {
    const known = this.known.get(entry);
    if (known?.support === support) return known.boxes;
    const boxes = this.measure(entry, support);
    this.known.set(entry, { support, boxes });
    return boxes;
  }
}
