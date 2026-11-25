import type { TrackCatalog } from "@brr/schema/bundle";
import type { PlacedModel, PlacedModels } from "./placed-chunks.ts";
import type { PlanReach } from "./plan-reach.ts";
import type { SupportBand } from "./track-bands.ts";
import {
  REACHES,
  obstaclesOver,
  seatsPending,
  trackObstacles,
  type TrackPartsOf,
} from "./track-obstacles.ts";

interface ReachedBand {
  readonly reaching: Uint8Array;
  readonly band: SupportBand;
}

interface BandSlot {
  whole: SupportBand | null;
  reached: ReachedBand | null;
}

function sameReaching(stored: Uint8Array, reaching: Uint8Array, count: number): boolean {
  for (let owner = 0; owner < count; owner++) {
    if (stored[owner] !== reaching[owner]) return false;
  }
  return true;
}

function everyReaches(reaching: Uint8Array, count: number): boolean {
  for (let owner = 0; owner < count; owner++) {
    if (reaching[owner] !== REACHES) return false;
  }
  return true;
}

export class ModelBands {
  private placed: PlacedModels | null = null;
  private version = -1;
  private trackCatalog: TrackCatalog | null = null;
  private readonly slots = new Map<number, Map<number, BandSlot>>();
  private scratch = new Uint8Array(0);

  constructor(private readonly trackParts: TrackPartsOf) {}

  clear(): void {
    this.slots.clear();
    this.placed = null;
    this.version = -1;
    this.trackCatalog = null;
  }

  band(
    placed: PlacedModels,
    trackCatalog: TrackCatalog | null,
    range: readonly [number, number],
    reach: PlanReach | null,
  ): SupportBand {
    this.keepFor(placed, trackCatalog);
    const slot = this.slotAt(range);
    const models = placed.models();
    if (reach === null) {
      if (slot.whole) return slot.whole;
      const whole = this.measured(models, range, null);
      slot.whole = whole;
      return whole;
    }
    const count = models.length;
    const reaching = this.reachingOf(models, reach);
    const { reached, whole } = slot;
    if (reached && sameReaching(reached.reaching, reaching, count)) return reached.band;
    if (whole && everyReaches(reaching, count)) return whole;
    const band = this.measured(models, range, reaching);
    slot.reached = { reaching: reaching.slice(0, count), band };
    return band;
  }

  private keepFor(placed: PlacedModels, trackCatalog: TrackCatalog | null): void {
    const { version } = placed;
    if (placed === this.placed && version === this.version && trackCatalog === this.trackCatalog) {
      return;
    }
    this.slots.clear();
    this.placed = placed;
    this.version = version;
    this.trackCatalog = trackCatalog;
  }

  private slotAt([bottom, top]: readonly [number, number]): BandSlot {
    let tops = this.slots.get(bottom);
    if (!tops) {
      tops = new Map();
      this.slots.set(bottom, tops);
    }
    let slot = tops.get(top);
    if (!slot) {
      slot = { whole: null, reached: null };
      tops.set(top, slot);
    }
    return slot;
  }

  private reachingOf(models: ReadonlyArray<PlacedModel>, reach: PlanReach): Uint8Array {
    if (this.scratch.length < models.length) this.scratch = new Uint8Array(models.length);
    const reaching = this.scratch;
    for (let owner = 0; owner < models.length; owner++) {
      const model = models[owner];
      reaching[owner] = model && reach.reaches(model.box) ? REACHES : 0;
    }
    return reaching;
  }

  private measured(
    models: ReadonlyArray<PlacedModel>,
    range: readonly [number, number],
    reaching: Uint8Array | null,
  ): SupportBand {
    const obstacles =
      reaching === null
        ? trackObstacles(models, range, this.trackParts)
        : obstaclesOver(models, range, this.trackParts, reaching);
    return { obstacles, pending: seatsPending(models, range) };
  }
}
