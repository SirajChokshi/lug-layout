import { runMoves, type DrawingKit, type TrackMove } from "@brr/domain";
import type { Pose16 } from "@brr/math";
import { joinTargets } from "./join-targets.ts";
import type { ExtensionJoin } from "./track-extension.ts";

export interface LoopCloserSite {
  readonly kit: DrawingKit;
  endPoses(): ReadonlyArray<Pose16>;
  endHeight(end: number): number;
  closure(from: number, to: number): ExtensionJoin;
}

export type Clock = () => number;

export interface LoopClosure {
  readonly key: string;
  readonly from: number;
  readonly to: number;
  readonly ends: readonly [number, number];
  readonly start: Pose16;
  readonly goal: Pose16;
  readonly moves: ReadonlyArray<TrackMove>;
  readonly gapLdu: number;
}

interface EndPair {
  readonly from: number;
  readonly to: number;
  readonly gapLdu: number;
}

const NO_CLOSURES: ReadonlyArray<LoopClosure> = [];

function endKey(pose: Pose16, plates: number): string {
  return `${pose.heading}:${pose.position.join(",")}@${plates}`;
}

function nearestFirst(a: EndPair, b: EndPair): number {
  return a.gapLdu - b.gapLdu || a.from - b.from || a.to - b.to;
}

export class LoopCloser {
  private pairs: ReadonlyArray<EndPair> | null = null;
  private next = 0;
  private pendingPairs = 0;
  private found: ReadonlyArray<LoopClosure> = NO_CLOSURES;
  private previewKey: string | null = null;
  private changes = 0;

  constructor(
    private readonly site: LoopCloserSite,
    private readonly clock: Clock,
  ) {}

  get version(): number {
    return this.changes;
  }

  get checked(): number {
    return this.next;
  }

  get pairCount(): number | null {
    return this.pairs?.length ?? null;
  }

  get waiting(): number {
    return this.pendingPairs;
  }

  get scanning(): boolean {
    return this.pairs === null || this.next < this.pairs.length;
  }

  closures(): ReadonlyArray<LoopClosure> {
    return this.found;
  }

  find(key: string | null): LoopClosure | null {
    if (key === null) return this.found[0] ?? null;
    return this.found.find((closure) => closure.key === key) ?? null;
  }

  endsChanged(): void {
    this.pairs = null;
    this.next = 0;
    this.pendingPairs = 0;
    this.found = NO_CLOSURES;
    this.changes++;
  }

  preview(key: string | null): boolean {
    if (key === this.previewKey) return false;
    this.previewKey = key;
    this.changes++;
    return true;
  }

  previewed(): LoopClosure | null {
    return this.previewKey === null ? null : this.find(this.previewKey);
  }

  advance(deadlineMs: number): boolean {
    if (!this.scanning) return false;
    const pairs = (this.pairs ??= this.endPairs());
    for (let solved = 0; this.next < pairs.length; solved++) {
      if (solved > 0 && this.clock() >= deadlineMs) break;
      const pair = pairs[this.next];
      this.next++;
      const closure = pair ? this.closureOf(pair) : null;
      if (closure) this.found = [...this.found, closure];
    }
    this.changes++;
    return true;
  }

  private endPairs(): ReadonlyArray<EndPair> {
    const ends = this.site.endPoses();
    const count = ends.length;
    const seen = new Set<number>();
    const pairs: EndPair[] = [];
    for (let from = 0; from < count; from++) {
      for (const { index: to, distanceLdu } of joinTargets(ends, from)) {
        const pair = Math.min(from, to) * count + Math.max(from, to);
        if (seen.has(pair)) continue;
        seen.add(pair);
        pairs.push({ from, to, gapLdu: distanceLdu });
      }
    }
    return pairs.toSorted(nearestFirst);
  }

  private closureOf({ from, to, gapLdu }: EndPair): LoopClosure | null {
    const ends = this.site.endPoses();
    const start = ends[from];
    const goal = ends[to];
    if (!start || !goal) throw new RangeError(`no open ends ${from} and ${to} to close`);
    const result = this.site.closure(from, to);
    if (result.kind === "refused") {
      if (result.refusal === "pending") this.pendingPairs++;
      return null;
    }
    return {
      key: `${endKey(start, this.site.endHeight(from))}>${endKey(goal, this.site.endHeight(to))}`,
      from,
      to,
      ends: [from, to],
      start,
      goal,
      moves: runMoves(this.site.kit, result.run),
      gapLdu,
    };
  }
}
