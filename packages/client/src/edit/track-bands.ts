import { overUnder, type TrackSpan } from "@brr/domain";
import { PLATE_LDU } from "@brr/math";
import { DragField, type SupportedPiece, type TrackBlockView } from "./track-drag.ts";
import { NO_TRACK_OBSTACLES, type TrackObstacles } from "./track-obstacles.ts";
import type { TrainGauge } from "./train-gauge.ts";

export interface SupportBand {
  readonly obstacles: TrackObstacles;
  readonly pending: boolean;
}

export type SupportBandAt = (lowPlates: number, highPlates: number) => SupportBand;

export interface BandPieces {
  count(): number;
  outline(placement: number): Float64Array | null;
  span(placement: number): TrackSpan;
}

export interface LayingBand {
  readonly field: DragField;
  readonly seats: ReadonlySet<number>;
  readonly pending: boolean;
}

const NO_BAND: SupportBand = { obstacles: NO_TRACK_OBSTACLES, pending: false };
const UNSUPPORTED: SupportedPiece = () => false;

function bandKey(lowPlates: number, highPlates: number): string {
  return `${lowPlates}:${highPlates}`;
}

export class TrackBands {
  private source: SupportBandAt = () => NO_BAND;
  private gauge: TrainGauge | null = null;
  private readonly layingBands = new Map<string, LayingBand>();
  private readonly solidBands = new Map<string, DragField>();
  private changes = 0;

  constructor(
    private readonly pieces: BandPieces,
    private readonly range: readonly [number, number],
    private readonly supportedOn: (seats: ReadonlySet<number>) => SupportedPiece,
  ) {}

  get trainGauge(): TrainGauge | null {
    return this.gauge;
  }

  setSource(source: SupportBandAt): void {
    this.source = source;
    this.changed();
  }

  setGauge(gauge: TrainGauge | null): void {
    this.gauge = gauge;
    this.changed();
  }

  get version(): number {
    return this.changes;
  }

  changed(): void {
    this.changes++;
    this.layingBands.clear();
    this.solidBands.clear();
  }

  span(lowPlates: number, highPlates: number): TrackSpan {
    const [bottom, top] = this.range;
    return {
      bottomLdu: bottom + lowPlates * PLATE_LDU,
      topLdu: top + highPlates * PLATE_LDU,
      railTopLdu: top + highPlates * PLATE_LDU,
    };
  }

  laying(lowPlates: number, highPlates: number): LayingBand {
    const key = bandKey(lowPlates, highPlates);
    const known = this.layingBands.get(key);
    if (known) return known;
    const { obstacles, pending } = this.source(lowPlates, highPlates);
    const band = this.span(lowPlates, highPlates);
    const gaugeLdu = this.gauge?.heightLdu ?? Number.POSITIVE_INFINITY;
    const outlines: Array<Float64Array | null> = [];
    for (let p = 0, count = this.pieces.count(); p < count; p++) {
      const outline = this.pieces.outline(p);
      const verdict = outline ? overUnder(this.pieces.span(p), band, gaugeLdu) : null;
      outlines.push(verdict && verdict.kind !== "clear" ? outline : null);
    }
    const field = new DragField(outlines, obstacles, this.supportedOn(obstacles.seats), (p) =>
      this.trackView(p, band),
    );
    const laid = { field, seats: obstacles.seats, pending };
    this.layingBands.set(key, laid);
    return laid;
  }

  solid(lowPlates: number, highPlates: number): DragField {
    const key = bandKey(lowPlates, highPlates);
    const known = this.solidBands.get(key);
    if (known) return known;
    const band = this.span(lowPlates, highPlates);
    const outlines: Array<Float64Array | null> = [];
    for (let p = 0, count = this.pieces.count(); p < count; p++) {
      const { bottomLdu, topLdu } = this.pieces.span(p);
      const shares = bottomLdu < band.topLdu && band.bottomLdu < topLdu;
      outlines.push(shares ? this.pieces.outline(p) : null);
    }
    const field = new DragField(outlines, NO_TRACK_OBSTACLES, UNSUPPORTED);
    this.solidBands.set(key, field);
    return field;
  }

  private trackView(placement: number, band: TrackSpan): TrackBlockView {
    const gaugeLdu = this.gauge?.heightLdu ?? Number.POSITIVE_INFINITY;
    const verdict = overUnder(this.pieces.span(placement), band, gaugeLdu);
    if (verdict.kind === "intersects") return { kind: "track" };
    return {
      kind: "clearance",
      gapLdu: verdict.gapLdu,
      above: !verdict.upperIsA,
      gauge: this.gauge,
    };
  }
}
