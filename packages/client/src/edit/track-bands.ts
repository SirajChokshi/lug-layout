import { PLATE_LDU } from "@brr/math";
import { PlanReach } from "./plan-reach.ts";
import { DragField, type SupportedPiece } from "./track-drag.ts";
import {
  NO_TRACK_OBSTACLES,
  sameNumbers,
  sameObstacles,
  type StudSeats,
  type TrackObstacles,
} from "./track-obstacles.ts";

export interface SupportBand {
  readonly obstacles: TrackObstacles;
  readonly pending: boolean;
}

export type SupportBandAt = (
  lowPlates: number,
  highPlates: number,
  reach: PlanReach | null,
) => SupportBand;

export interface HeightSpan {
  readonly bottomLdu: number;
  readonly topLdu: number;
}

export interface BandPieces {
  count(): number;
  outline(placement: number): Float64Array | null;
  bottomLdu(placement: number): number;
  topLdu(placement: number): number;
}

export interface LayingBand {
  readonly field: DragField;
  readonly seats: StudSeats;
  readonly pending: boolean;
}

interface ReachedBand {
  readonly reach: PlanReach;
  readonly band: LayingBand;
}

type SharingOutlines = ReadonlyArray<Float64Array | null>;

interface BuiltBand {
  readonly band: LayingBand;
  readonly support: SupportBand;
  readonly outlines: SharingOutlines;
  cachedAt: number;
}

interface LayingSlots {
  last: BuiltBand;
  previous: BuiltBand | null;
}

const NO_BAND: SupportBand = { obstacles: NO_TRACK_OBSTACLES, pending: false };
const UNSUPPORTED: SupportedPiece = () => false;

function bandKey(lowPlates: number, highPlates: number): string {
  return `${lowPlates}:${highPlates}`;
}

function sameSupportBand(a: SupportBand, b: SupportBand): boolean {
  return a.pending === b.pending && sameObstacles(a.obstacles, b.obstacles);
}

function sameOutlines(a: SharingOutlines, b: SharingOutlines): boolean {
  if (a.length !== b.length) return false;
  for (let p = 0; p < a.length; p++) {
    const outline = a[p] ?? null;
    const other = b[p] ?? null;
    if (outline === null || other === null) {
      if (outline !== other) return false;
    } else if (!sameNumbers(outline, other)) {
      return false;
    }
  }
  return true;
}

function builtFrom(built: BuiltBand, support: SupportBand, outlines: SharingOutlines): boolean {
  return sameSupportBand(built.support, support) && sameOutlines(built.outlines, outlines);
}

export class TrackBands {
  private source: SupportBandAt = () => NO_BAND;
  private readonly layingBands = new Map<string, LayingSlots>();
  private readonly reachedBands = new Map<string, ReachedBand>();
  private readonly solidBands = new Map<string, DragField>();
  private changes = 0;

  constructor(
    private readonly pieces: BandPieces,
    private readonly range: readonly [number, number],
    private readonly supportedOn: (seats: StudSeats) => SupportedPiece,
  ) {}

  setSource(source: SupportBandAt): void {
    this.source = source;
    this.changed();
  }

  get version(): number {
    return this.changes;
  }

  changed(): void {
    this.changes++;
    this.reachedBands.clear();
    this.solidBands.clear();
  }

  clear(): void {
    this.changed();
    this.layingBands.clear();
  }

  span(lowPlates: number, highPlates: number): HeightSpan {
    const [bottom, top] = this.range;
    return { bottomLdu: bottom + lowPlates * PLATE_LDU, topLdu: top + highPlates * PLATE_LDU };
  }

  laying(lowPlates: number, highPlates: number): LayingBand {
    const key = bandKey(lowPlates, highPlates);
    const slots = this.layingBands.get(key);
    if (slots && slots.last.cachedAt === this.changes) return slots.last.band;
    const support = this.source(lowPlates, highPlates, null);
    const outlines = this.sharingHeight(lowPlates, highPlates);
    if (slots) {
      const kept = this.revalidated(slots, support, outlines);
      if (kept) return kept.band;
    }
    const built: BuiltBand = {
      band: this.bandOf(support, outlines),
      support,
      outlines,
      cachedAt: this.changes,
    };
    this.layingBands.set(key, { last: built, previous: slots?.last ?? null });
    return built.band;
  }

  private revalidated(
    slots: LayingSlots,
    support: SupportBand,
    outlines: SharingOutlines,
  ): BuiltBand | null {
    const { last, previous } = slots;
    if (builtFrom(last, support, outlines)) {
      last.cachedAt = this.changes;
      return last;
    }
    if (!previous || !builtFrom(previous, support, outlines)) return null;
    slots.last = previous;
    slots.previous = last;
    previous.cachedAt = this.changes;
    return previous;
  }

  reaching(lowPlates: number, highPlates: number, planBoxes: Float64Array): LayingBand {
    const key = bandKey(lowPlates, highPlates);
    const whole = this.layingBands.get(key)?.last;
    if (whole && whole.cachedAt === this.changes) return whole.band;
    const known = this.reachedBands.get(key);
    if (known?.reach.covers(planBoxes)) return known.band;
    const reach = known ? known.reach.with(planBoxes) : PlanReach.of(planBoxes);
    const band = this.bandOf(
      this.source(lowPlates, highPlates, reach),
      this.sharingHeight(lowPlates, highPlates),
    );
    this.reachedBands.set(key, { reach, band });
    return band;
  }

  private bandOf({ obstacles, pending }: SupportBand, outlines: SharingOutlines): LayingBand {
    const field = new DragField(outlines, obstacles, this.supportedOn(obstacles.seats));
    return { field, seats: obstacles.seats, pending };
  }

  solid(lowPlates: number, highPlates: number): DragField {
    const key = bandKey(lowPlates, highPlates);
    const known = this.solidBands.get(key);
    if (known) return known;
    const outlines = this.sharingHeight(lowPlates, highPlates);
    const field = new DragField(outlines, NO_TRACK_OBSTACLES, UNSUPPORTED);
    this.solidBands.set(key, field);
    return field;
  }

  private sharingHeight(lowPlates: number, highPlates: number): Array<Float64Array | null> {
    const band = this.span(lowPlates, highPlates);
    const outlines: Array<Float64Array | null> = [];
    for (let p = 0, count = this.pieces.count(); p < count; p++) {
      const shares =
        this.pieces.bottomLdu(p) < band.topLdu && band.bottomLdu < this.pieces.topLdu(p);
      outlines.push(shares ? this.pieces.outline(p) : null);
    }
    return outlines;
  }
}
