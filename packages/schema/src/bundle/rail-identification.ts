import {
  CERTIFIED_RESIDUAL_LIMIT_LDU,
  compareExactRational,
  exactRational,
  exactRationalFromDecimal,
  exactRationalFromFloat64,
  exactRationalToFloat64,
  parseExactDecimal,
  subtractExactRational,
  type ExactRational,
} from "@brr/math";
import type { PoseStatus } from "./index.ts";

export interface CertifiablePose {
  readonly status: PoseStatus;
  readonly residualLdu: number;
}

export type UnidentifiedRailReason = "pose not certified" | "no matching rail";

export type RailIdentification =
  | { readonly outcome: "identified"; readonly rail: number; readonly railResidualLdu: number }
  | { readonly outcome: UnidentifiedRailReason };

export interface RailHeadInterval {
  readonly from: ExactRational;
  readonly to: ExactRational;
}

export type RailHeadBands = readonly [RailHeadInterval, RailHeadInterval];

export interface MeasuredRailHeads {
  readonly railHeads: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

export interface ExactRailHeads {
  readonly from: ReadonlyArray<ExactRational>;
  readonly to: ReadonlyArray<ExactRational>;
}

export const RAIL_IDENTIFICATION_LIMIT = exactRationalFromFloat64(CERTIFIED_RESIDUAL_LIMIT_LDU);

const ZERO = exactRational(0n, 1n);
const POSE_NOT_CERTIFIED: RailIdentification = { outcome: "pose not certified" };
const NO_MATCHING_RAIL: RailIdentification = { outcome: "no matching rail" };

export function poseCertified(pose: CertifiablePose): boolean {
  return pose.status === "certified" && pose.residualLdu <= CERTIFIED_RESIDUAL_LIMIT_LDU;
}

export function unidentifiedRailReason(pose: CertifiablePose): UnidentifiedRailReason {
  return poseCertified(pose) ? "no matching rail" : "pose not certified";
}

function greater(a: ExactRational, b: ExactRational): ExactRational {
  return compareExactRational(a, b) >= 0 ? a : b;
}

function exactSize(value: ExactRational): ExactRational {
  return compareExactRational(value, ZERO) < 0 ? subtractExactRational(ZERO, value) : value;
}

interface ScratchInterval {
  from: ExactRational;
  to: ExactRational;
}

const CLOSURE_BANDS = 4;
const closureScratch: ScratchInterval[] = Array.from({ length: CLOSURE_BANDS }, () => ({
  from: ZERO,
  to: ZERO,
}));

function writeBand(slot: number, from: ExactRational, to: ExactRational): void {
  const scratch = closureScratch[slot];
  if (!scratch) return;
  scratch.from = from;
  scratch.to = to;
}

function sortScratchByStart(): void {
  for (let i = 1; i < CLOSURE_BANDS; i++) {
    for (let j = i; j > 0; j--) {
      const before = closureScratch[j - 1];
      const after = closureScratch[j];
      if (!before || !after || compareExactRational(before.from, after.from) <= 0) break;
      closureScratch[j - 1] = after;
      closureScratch[j] = before;
    }
  }
}

function mergeScratchAtSeams(): number {
  let merged = 0;
  for (let i = 0; i < CLOSURE_BANDS; i++) {
    const band = closureScratch[i];
    const last = closureScratch[merged - 1];
    if (!band) continue;
    const gap = last ? subtractExactRational(band.from, last.to) : null;
    if (last && gap && compareExactRational(gap, RAIL_IDENTIFICATION_LIMIT) <= 0) {
      last.to = greater(last.to, band.to);
      continue;
    }
    const slot = closureScratch[merged];
    if (slot && slot !== band) {
      closureScratch[merged] = band;
      closureScratch[i] = slot;
    }
    merged += 1;
  }
  return merged;
}

export function closedHalfLap(bands: RailHeadBands | null): RailHeadBands | null {
  if (!bands) return null;
  const [near, far] = bands;
  writeBand(0, near.from, near.to);
  writeBand(1, far.from, far.to);
  writeBand(2, subtractExactRational(ZERO, near.to), subtractExactRational(ZERO, near.from));
  writeBand(3, subtractExactRational(ZERO, far.to), subtractExactRational(ZERO, far.from));
  sortScratchByStart();
  const merged = mergeScratchAtSeams();
  const [first, second] = closureScratch;
  return merged === 2 && first && second
    ? [
        { from: first.from, to: first.to },
        { from: second.from, to: second.to },
      ]
    : null;
}

function exactDecimalText(text: string): ExactRational {
  return exactRationalFromDecimal(parseExactDecimal(text));
}

export function exactRailHeads(rails: ReadonlyArray<MeasuredRailHeads>): ExactRailHeads[] {
  return rails.map(({ railHeads }) => ({
    from: railHeads.map((head) => exactDecimalText(head.from)),
    to: railHeads.map((head) => exactDecimalText(head.to)),
  }));
}

function largestEndDifference(bands: RailHeadBands, rail: ExactRailHeads): ExactRational | null {
  if (rail.from.length !== bands.length) return null;
  let largest = ZERO;
  for (let h = 0; h < bands.length; h++) {
    const band = bands[h];
    const from = rail.from[h];
    const to = rail.to[h];
    if (!band || !from || !to) return null;
    largest = greater(largest, exactSize(subtractExactRational(band.from, from)));
    largest = greater(largest, exactSize(subtractExactRational(band.to, to)));
  }
  return largest;
}

export function identifyRail(
  pose: CertifiablePose,
  bands: RailHeadBands | null,
  rails: ReadonlyArray<ExactRailHeads>,
): RailIdentification {
  if (!poseCertified(pose)) return POSE_NOT_CERTIFIED;
  if (!bands) return NO_MATCHING_RAIL;
  let matches = 0;
  let rail = -1;
  let railDifference = ZERO;
  for (let index = 0; index < rails.length; index++) {
    const entry = rails[index];
    const difference = entry ? largestEndDifference(bands, entry) : null;
    if (difference === null) continue;
    if (compareExactRational(difference, RAIL_IDENTIFICATION_LIMIT) > 0) continue;
    matches += 1;
    rail = index;
    railDifference = difference;
  }
  return matches === 1
    ? { outcome: "identified", rail, railResidualLdu: exactRationalToFloat64(railDifference) }
    : NO_MATCHING_RAIL;
}
