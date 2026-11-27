import type { LayingBand } from "./track-bands.ts";
import type { TrackBlockView } from "./track-drag.ts";
import type { TrackObstacles } from "./track-obstacles.ts";
import type { TrackPlacement } from "./track-placements.ts";
import type { TrackSupport } from "./track-support.ts";

export type LevelVerdict =
  | { readonly held: true }
  | { readonly held: false; readonly block: TrackBlockView | null };

interface Judged {
  readonly support: TrackSupport;
  readonly obstacles: TrackObstacles;
  readonly verdict: LevelVerdict;
}

interface Kept {
  latest: Judged;
  earlier: Judged | null;
}

function judgedAgainst(judged: Judged | null, support: TrackSupport, band: LayingBand): boolean {
  return judged?.support === support && judged.obstacles === band.obstacles;
}

export class LevelVerdicts {
  private readonly known = new WeakMap<TrackPlacement, Kept>();

  constructor(
    private readonly judge: (
      entry: TrackPlacement,
      support: TrackSupport,
      band: LayingBand,
    ) => LevelVerdict,
  ) {}

  of(entry: TrackPlacement, support: TrackSupport, band: LayingBand): LevelVerdict {
    const kept = this.known.get(entry);
    if (kept && judgedAgainst(kept.latest, support, band)) return kept.latest.verdict;
    if (kept?.earlier && judgedAgainst(kept.earlier, support, band)) {
      const { earlier, latest } = kept;
      kept.latest = earlier;
      kept.earlier = latest;
      return earlier.verdict;
    }
    const judged = {
      support,
      obstacles: band.obstacles,
      verdict: this.judge(entry, support, band),
    };
    if (kept) {
      kept.earlier = kept.latest;
      kept.latest = judged;
    } else {
      this.known.set(entry, { latest: judged, earlier: null });
    }
    return judged.verdict;
  }
}
