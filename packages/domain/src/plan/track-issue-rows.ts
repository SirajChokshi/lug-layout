import { mmFromLdu, ZETA16_ORDER } from "@brr/math";
import { regionOriginX, regionOriginZ, type PlanRegion } from "./plan-region.ts";
import { placementLabel } from "./plan-rows.ts";
import { BOX_STRIDE, type PlacementKey, type PlanIssue } from "./plan-rules.ts";

export const TRACK_OPEN_END = 0;
export const TRACK_UNJOINED_ENDS = 1;
export const TRACK_UNVERIFIED = 2;
export const TRACK_UNIDENTIFIED = 3;
export const TRACK_LAID_UNVERIFIED = 4;

const NO_HEADING_OFFSET = -1;
const INITIAL_ISSUES = 8;
const INITIAL_OWNERS = 8;
const DEGREES_PER_STEP = 360 / ZETA16_ORDER;
const TWO_ENDS = 2;

function roomUint8(array: Uint8Array<ArrayBuffer>, length: number): Uint8Array<ArrayBuffer> {
  if (array.length >= length) return array;
  const grown = new Uint8Array(Math.max(length, array.length * 2));
  grown.set(array);
  return grown;
}

function roomInt32(array: Int32Array<ArrayBuffer>, length: number): Int32Array<ArrayBuffer> {
  if (array.length >= length) return array;
  const grown = new Int32Array(Math.max(length, array.length * 2));
  grown.set(array);
  return grown;
}

function roomFloat64(array: Float64Array<ArrayBuffer>, length: number): Float64Array<ArrayBuffer> {
  if (array.length >= length) return array;
  const grown = new Float64Array(Math.max(length, array.length * 2));
  grown.set(array);
  return grown;
}

export class TrackIssueRows {
  count = 0;
  kind = new Uint8Array(INITIAL_ISSUES);
  x = new Float64Array(INITIAL_ISSUES);
  z = new Float64Array(INITIAL_ISSUES);
  quantity = new Int32Array(INITIAL_ISSUES);
  headingOffset = new Int32Array(INITIAL_ISSUES);
  ownerStart = new Int32Array(INITIAL_ISSUES + 1);
  ownerCount = 0;
  ownerBox = new Float64Array(INITIAL_OWNERS * BOX_STRIDE);
  ownerChunkKey = new Float64Array(INITIAL_OWNERS);
  ownerSlot = new Int32Array(INITIAL_OWNERS);
  ownerLabelKind = new Uint8Array(INITIAL_OWNERS);
  ownerLabelA = new Float64Array(INITIAL_OWNERS);
  ownerLabelB = new Float64Array(INITIAL_OWNERS);
  readonly ownerLabelBase: string[] = [];
  readonly part: string[] = [];
  readonly title: string[] = [];

  clear(): void {
    this.count = 0;
    this.ownerCount = 0;
    this.ownerStart[0] = 0;
  }

  add(kind: number, part: string, title: string): number {
    const at = this.count++;
    this.reserveIssues(this.count);
    this.kind[at] = kind;
    this.x[at] = 0;
    this.z[at] = 0;
    this.quantity[at] = 1;
    this.headingOffset[at] = NO_HEADING_OFFSET;
    this.part[at] = part;
    this.title[at] = title;
    this.ownerStart[at + 1] = this.ownerCount;
    return at;
  }

  addOwner(issue: number, labelKind: number, labelBase: string, slot: number): number {
    const at = this.ownerCount++;
    this.reserveOwners(this.ownerCount);
    this.ownerSlot[at] = slot;
    this.ownerLabelKind[at] = labelKind;
    this.ownerLabelBase[at] = labelBase;
    this.ownerStart[issue + 1] = this.ownerCount;
    return at;
  }

  setOwnerBox(owner: number, from: Float64Array, offset: number): void {
    const to = owner * BOX_STRIDE;
    for (let k = 0; k < BOX_STRIDE; k++) this.ownerBox[to + k] = from[offset + k] ?? Number.NaN;
  }

  sameIssue(issue: number, other: TrackIssueRows, otherIssue: number): boolean {
    const first = this.ownerStart[issue] ?? 0;
    const owners = (this.ownerStart[issue + 1] ?? 0) - first;
    const otherFirst = other.ownerStart[otherIssue] ?? 0;
    if (owners !== (other.ownerStart[otherIssue + 1] ?? 0) - otherFirst) return false;
    if (
      this.kind[issue] !== other.kind[otherIssue] ||
      !Object.is(this.x[issue], other.x[otherIssue]) ||
      !Object.is(this.z[issue], other.z[otherIssue]) ||
      this.quantity[issue] !== other.quantity[otherIssue] ||
      this.headingOffset[issue] !== other.headingOffset[otherIssue] ||
      this.part[issue] !== other.part[otherIssue] ||
      this.title[issue] !== other.title[otherIssue]
    ) {
      return false;
    }
    for (let k = 0; k < owners; k++) {
      const a = first + k;
      const b = otherFirst + k;
      for (let e = 0; e < BOX_STRIDE; e++) {
        const edge = this.ownerBox[a * BOX_STRIDE + e];
        if (!Object.is(edge, other.ownerBox[b * BOX_STRIDE + e])) return false;
      }
      if (
        !Object.is(this.ownerChunkKey[a], other.ownerChunkKey[b]) ||
        this.ownerSlot[a] !== other.ownerSlot[b] ||
        this.ownerLabelKind[a] !== other.ownerLabelKind[b] ||
        this.ownerLabelBase[a] !== other.ownerLabelBase[b] ||
        !Object.is(this.ownerLabelA[a], other.ownerLabelA[b]) ||
        !Object.is(this.ownerLabelB[a], other.ownerLabelB[b])
      ) {
        return false;
      }
    }
    return true;
  }

  sameAs(other: TrackIssueRows): boolean {
    if (this.count !== other.count) return false;
    for (let issue = 0; issue < this.count; issue++) {
      if (!this.sameIssue(issue, other, issue)) return false;
    }
    return true;
  }

  copyFrom(other: TrackIssueRows): void {
    const issues = other.count;
    const owners = other.ownerCount;
    this.reserveIssues(issues);
    this.reserveOwners(owners);
    this.count = issues;
    this.ownerCount = owners;
    for (let i = 0; i < issues; i++) {
      this.kind[i] = other.kind[i] ?? 0;
      this.x[i] = other.x[i] ?? Number.NaN;
      this.z[i] = other.z[i] ?? Number.NaN;
      this.quantity[i] = other.quantity[i] ?? 0;
      this.headingOffset[i] = other.headingOffset[i] ?? NO_HEADING_OFFSET;
      this.ownerStart[i + 1] = other.ownerStart[i + 1] ?? 0;
      this.part[i] = other.part[i] ?? "";
      this.title[i] = other.title[i] ?? "";
    }
    this.ownerStart[0] = 0;
    for (let k = 0; k < owners * BOX_STRIDE; k++) {
      this.ownerBox[k] = other.ownerBox[k] ?? Number.NaN;
    }
    for (let o = 0; o < owners; o++) {
      this.ownerChunkKey[o] = other.ownerChunkKey[o] ?? 0;
      this.ownerSlot[o] = other.ownerSlot[o] ?? 0;
      this.ownerLabelKind[o] = other.ownerLabelKind[o] ?? 0;
      this.ownerLabelA[o] = other.ownerLabelA[o] ?? 0;
      this.ownerLabelB[o] = other.ownerLabelB[o] ?? 0;
      this.ownerLabelBase[o] = other.ownerLabelBase[o] ?? "";
    }
  }

  private reserveIssues(issues: number): void {
    this.kind = roomUint8(this.kind, issues);
    this.x = roomFloat64(this.x, issues);
    this.z = roomFloat64(this.z, issues);
    this.quantity = roomInt32(this.quantity, issues);
    this.headingOffset = roomInt32(this.headingOffset, issues);
    this.ownerStart = roomInt32(this.ownerStart, issues + 1);
  }

  private reserveOwners(owners: number): void {
    this.ownerBox = roomFloat64(this.ownerBox, owners * BOX_STRIDE);
    this.ownerChunkKey = roomFloat64(this.ownerChunkKey, owners);
    this.ownerSlot = roomInt32(this.ownerSlot, owners);
    this.ownerLabelKind = roomUint8(this.ownerLabelKind, owners);
    this.ownerLabelA = roomFloat64(this.ownerLabelA, owners);
    this.ownerLabelB = roomFloat64(this.ownerLabelB, owners);
  }
}

function ownerLabel(rows: TrackIssueRows, owner: number): string {
  return placementLabel(
    rows.ownerLabelKind[owner] ?? 0,
    rows.ownerLabelBase[owner] ?? "",
    rows.ownerLabelA[owner] ?? 0,
    rows.ownerLabelB[owner] ?? 0,
  );
}

function listed(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

function planPosition(region: PlanRegion, rows: TrackIssueRows, issue: number): string {
  const x = Math.round(mmFromLdu((rows.x[issue] ?? 0) - regionOriginX(region)));
  const z = Math.round(mmFromLdu((rows.z[issue] ?? 0) - regionOriginZ(region)));
  return `(${x} mm, ${z} mm)`;
}

function partNumber(part: string): string {
  const colon = part.indexOf(":");
  return colon < 0 ? part : part.slice(colon + 1);
}

function heldParts(names: ReadonlyArray<string>, rows: TrackIssueRows, issue: number): string {
  return `${listed(names)} holds ${rows.quantity[issue] ?? 0} × ${partNumber(rows.part[issue] ?? "")} ${rows.title[issue] ?? ""}`;
}

const UNCHECKED_ENDS = "so the plan can't check their ends or join anything to them.";
const UNVERIFIED_POSES =
  "whose connector poses are unverified: they're derived from the part file but not certified, so their joins are only as exact as those poses.";

function unjoinedMessage(
  names: ReadonlyArray<string>,
  at: string,
  ends: number,
  offset: number,
): string {
  if (ends === TWO_ENDS && offset !== NO_HEADING_OFFSET) {
    const who = names.length === 1 ? `Two track ends of ${names[0] ?? ""}` : listed(names);
    return `${who} meet at ${at} but don't join: their headings are ${offset * DEGREES_PER_STEP}° off a straight join.`;
  }
  return `${ends} track ends of ${listed(names)} meet at ${at}, so none of them joins: a track end joins exactly one other.`;
}

export function trackIssue(region: PlanRegion, rows: TrackIssueRows, issue: number): PlanIssue {
  const first = rows.ownerStart[issue] ?? 0;
  const last = rows.ownerStart[issue + 1] ?? 0;
  const placements: PlacementKey[] = [];
  const names: string[] = [];
  for (let owner = first; owner < last; owner++) {
    placements.push({ chunkKey: rows.ownerChunkKey[owner] ?? 0, slot: rows.ownerSlot[owner] ?? 0 });
    names.push(ownerLabel(rows, owner));
  }
  const at = planPosition(region, rows, issue);
  const kind = rows.kind[issue];
  const fit = { overhangMm: 0, nearestTableMm: 0, entirelyOffTables: false, offTableMm2: 0 };
  switch (kind) {
    case TRACK_OPEN_END:
      return {
        rule: "trackOpenEnd",
        severity: "error",
        placements,
        message: `Open track end at ${at} on ${listed(names)}: nothing joins it.`,
        ...fit,
      };
    case TRACK_UNJOINED_ENDS:
      return {
        rule: "trackJoin",
        severity: "error",
        placements,
        message: unjoinedMessage(
          names,
          at,
          rows.quantity[issue] ?? 0,
          rows.headingOffset[issue] ?? NO_HEADING_OFFSET,
        ),
        ...fit,
      };
    case TRACK_UNVERIFIED:
      return {
        rule: "trackUnverified",
        severity: "warning",
        placements,
        message: `${heldParts(names, rows, issue)}, ${UNVERIFIED_POSES}`,
        ...fit,
      };
    case TRACK_LAID_UNVERIFIED:
      return {
        rule: "trackUnverified",
        severity: "warning",
        placements,
        message: `${rows.quantity[issue] ?? 0} × ${partNumber(rows.part[issue] ?? "")} ${rows.title[issue] ?? ""} laid as ${listed(names)}, ${UNVERIFIED_POSES}`,
        ...fit,
      };
    case TRACK_UNIDENTIFIED:
      return {
        rule: "trackUnidentified",
        severity: "warning",
        placements,
        message: `${heldParts(names, rows, issue)} placed where no exact track pose fits, ${UNCHECKED_ENDS}`,
        ...fit,
      };
    default:
      throw new Error(`track issue ${issue} has an unknown kind ${String(kind)}`);
  }
}
