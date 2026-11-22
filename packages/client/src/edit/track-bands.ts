import { PLATE_LDU } from "@brr/math";
import { PlanReach } from "./plan-reach.ts";
import { DragField, type SupportedPiece } from "./track-drag.ts";
import { NO_TRACK_OBSTACLES, type StudSeats, type TrackObstacles } from "./track-obstacles.ts";

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

const NO_BAND: SupportBand = { obstacles: NO_TRACK_OBSTACLES, pending: false };
const UNSUPPORTED: SupportedPiece = () => false;

function bandKey(lowPlates: number, highPlates: number): string {
  return `${lowPlates}:${highPlates}`;
}

export class TrackBands {
  private source: SupportBandAt = () => NO_BAND;
  private readonly layingBands = new Map<string, LayingBand>();
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
    this.layingBands.clear();
    this.reachedBands.clear();
    this.solidBands.clear();
  }

  span(lowPlates: number, highPlates: number): HeightSpan {
    const [bottom, top] = this.range;
    return { bottomLdu: bottom + lowPlates * PLATE_LDU, topLdu: top + highPlates * PLATE_LDU };
  }

  laying(lowPlates: number, highPlates: number): LayingBand {
    const key = bandKey(lowPlates, highPlates);
    const known = this.layingBands.get(key);
    if (known) return known;
    const laid = this.build(lowPlates, highPlates, null);
    this.layingBands.set(key, laid);
    return laid;
  }

  reaching(lowPlates: number, highPlates: number, planBoxes: Float64Array): LayingBand {
    const key = bandKey(lowPlates, highPlates);
    const whole = this.layingBands.get(key);
    if (whole) return whole;
    const known = this.reachedBands.get(key);
    if (known?.reach.covers(planBoxes)) return known.band;
    const reach = known ? known.reach.with(planBoxes) : PlanReach.of(planBoxes);
    const band = this.build(lowPlates, highPlates, reach);
    this.reachedBands.set(key, { reach, band });
    return band;
  }

  private build(lowPlates: number, highPlates: number, reach: PlanReach | null): LayingBand {
    const { obstacles, pending } = this.source(lowPlates, highPlates, reach);
    const outlines = this.sharingHeight(lowPlates, highPlates);
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
