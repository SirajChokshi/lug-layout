import type { PlanRegion } from "./plan-region.ts";
import { WRITE_ADD, WRITE_UPDATE, type PlanDelta } from "./plan-delta.ts";
import {
  FACT_CUSTOM_PARTS,
  FACT_FLAGS,
  FACT_OVERLAP_SEGMENT,
  FACT_OVERLAP_SOURCE,
  FACT_ROAD_JOINED,
  FACT_ROAD_MISMATCHED,
  FACT_STRIDE,
  FACT_UNMAPPED_BRICKLINK,
  FACT_UNMAPPED_REBRICKABLE,
  FLAG_UNMEASURED,
  copyFacts,
  type PlacementFacts,
} from "./plan-facts.ts";
import {
  BOX_MAX_X,
  BOX_MAX_Z,
  BOX_MIN_X,
  BOX_MIN_Z,
  BOX_STRIDE,
  CoverageScratch,
  bomMappingIssueCount,
  bomMappingIssues,
  placementInside,
  placementIssueCount,
  placementIssues,
  regionContext,
  type PlanIssue,
  type PlanPlacement,
  type PlanRegionContext,
} from "./plan-rules.ts";
import {
  BOX_PLAN_UNREADABLE,
  CARRIED_TRACK_NOT_HELD,
  HELD,
  NOT_HELD,
  NO_ROW,
  PlanRows,
  RowList,
} from "./plan-rows.ts";
import { trackIssue, TrackIssueRows } from "./track-issue-rows.ts";

const BOM_SUMS = 2;
const NO_SOURCES: ReadonlySet<number> = new Set();

interface UnsupportedSources {
  readonly itself: ReadonlySet<number>;
  readonly carriedTrack: ReadonlySet<number>;
}

function sameMembers(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const member of b) if (!a.has(member)) return false;
  return true;
}

const NO_TRACK_ISSUES = new TrackIssueRows();

function grownUint32(array: Uint32Array<ArrayBuffer>, length: number): Uint32Array<ArrayBuffer> {
  const grown = new Uint32Array(length);
  grown.set(array);
  return grown;
}

function grownUint8(array: Uint8Array<ArrayBuffer>, length: number): Uint8Array<ArrayBuffer> {
  const grown = new Uint8Array(length);
  grown.set(array);
  return grown;
}

function roomUint8(array: Uint8Array<ArrayBuffer>, length: number): Uint8Array<ArrayBuffer> {
  return array.length >= length ? array : new Uint8Array(Math.max(length, array.length * 2));
}

class RegionState {
  inside: Uint8Array<ArrayBuffer>;
  issues: Uint32Array<ArrayBuffer>;
  readonly flagged: RowList;
  insideCount = 0;
  rowIssueCount = 0;
  trackInside = new Uint8Array(0);
  nextTrackInside = new Uint8Array(0);
  trackCount = 0;
  issueVersion = 0;
  roadJoined = 0;
  roadMismatched = 0;
  unmeasured = 0;
  unmappedRebrickable = 0;
  unmappedBrickLink = 0;
  customParts = 0;
  ctx: PlanRegionContext;
  private cached: ReadonlyArray<PlanIssue> = [];
  private cachedAt = -1;

  constructor(ctx: PlanRegionContext, capacity: number) {
    this.ctx = ctx;
    this.inside = new Uint8Array(capacity);
    this.issues = new Uint32Array(capacity);
    this.flagged = new RowList(capacity);
  }

  grow(capacity: number): void {
    if (this.inside.length >= capacity) return;
    this.inside = grownUint8(this.inside, capacity);
    this.issues = grownUint32(this.issues, capacity);
    this.flagged.grow(capacity);
  }

  clearSums(): void {
    this.roadJoined = 0;
    this.roadMismatched = 0;
    this.unmeasured = 0;
    this.unmappedRebrickable = 0;
    this.unmappedBrickLink = 0;
    this.customParts = 0;
  }

  addSums(facts: Int32Array, row: number, sign: number): void {
    const at = row * FACT_STRIDE;
    this.roadJoined += sign * (facts[at + FACT_ROAD_JOINED] ?? 0);
    this.roadMismatched += sign * (facts[at + FACT_ROAD_MISMATCHED] ?? 0);
    this.unmeasured += sign * ((facts[at + FACT_FLAGS] ?? 0) & FLAG_UNMEASURED);
    this.unmappedRebrickable += sign * (facts[at + FACT_UNMAPPED_REBRICKABLE] ?? 0);
    this.unmappedBrickLink += sign * (facts[at + FACT_UNMAPPED_BRICKLINK] ?? 0);
    this.customParts += sign * (facts[at + FACT_CUSTOM_PARTS] ?? 0);
  }

  bomIssueCount(): number {
    return bomMappingIssueCount(this.unmappedRebrickable, this.unmappedBrickLink);
  }

  issueList(rows: PlanRows, track: TrackIssueRows): ReadonlyArray<PlanIssue> {
    if (this.cachedAt === this.issueVersion) return this.cached;
    const issues = [...this.ctx.footprintIssues];
    bomMappingIssues(this.unmappedRebrickable, this.unmappedBrickLink, issues);
    for (let row = this.flagged.first(); row !== NO_ROW; row = this.flagged.after(rows, row)) {
      placementIssues(this.ctx, placementOf(rows, row), issues);
    }
    for (let i = 0; i < track.count; i++) {
      if (this.trackInside[i] === 1) issues.push(trackIssue(this.ctx.region, track, i));
    }
    this.cached = issues;
    this.cachedAt = this.issueVersion;
    return issues;
  }
}

function factsOf(rows: PlanRows, row: number): PlacementFacts {
  const { facts } = rows;
  const at = row * FACT_STRIDE;
  const segment = facts[at + FACT_OVERLAP_SEGMENT] ?? -1;
  const partner = segment < 0 ? NO_ROW : rows.find(segment, facts[at + FACT_OVERLAP_SOURCE] ?? -1);
  return {
    unmeasured: ((facts[at + FACT_FLAGS] ?? 0) & FLAG_UNMEASURED) !== 0,
    overlapWith:
      segment < 0 ? null : partner === NO_ROW ? "another placement" : rows.labelOf(partner),
    roadJoinedCells: facts[at + FACT_ROAD_JOINED] ?? 0,
    roadMismatchedCells: facts[at + FACT_ROAD_MISMATCHED] ?? 0,
    unmappedRebrickable: facts[at + FACT_UNMAPPED_REBRICKABLE] ?? 0,
    unmappedBrickLink: facts[at + FACT_UNMAPPED_BRICKLINK] ?? 0,
  };
}

function placementOf(rows: PlanRows, row: number): PlanPlacement {
  const at = row * BOX_STRIDE;
  return {
    key: rows.keyOf(row),
    ref: rows.refOf(row),
    label: rows.labelOf(row),
    unsupported: rows.unsupported[row] === NOT_HELD,
    carriedTrackUnsupported: rows.unsupported[row] === CARRIED_TRACK_NOT_HELD,
    shape: rows.shapeOf(row),
    outline: rows.outline[row] ?? null,
    carried: rows.carried[row] ?? null,
    anchor: { x: rows.labelA[row] ?? 0, z: rows.labelB[row] ?? 0 },
    facts: factsOf(rows, row),
    box: {
      minX: rows.box[at + BOX_MIN_X] ?? Number.NaN,
      minZ: rows.box[at + BOX_MIN_Z] ?? Number.NaN,
      maxX: rows.box[at + BOX_MAX_X] ?? Number.NaN,
      maxZ: rows.box[at + BOX_MAX_Z] ?? Number.NaN,
    },
  };
}

export class PlanEvaluation {
  readonly rows = new PlanRows();
  version = 0;
  sandboxCount = 0;
  planUnreadableCount = 0;
  firstPlanUnreadable = NO_ROW;
  flaggedMembershipChanged = false;
  flaggedBoxChanged = false;
  uncheckedChanged = false;
  trackIssuesChanged = false;
  private currentTrackIssues = new TrackIssueRows();
  private spareTrackIssues = new TrackIssueRows();
  private trackRegionsIn = new Uint32Array(0);
  private readonly regions: RegionState[] = [];
  private capacity = 0;
  private regionsIn = new Uint32Array(0);
  private flagged = new Uint32Array(0);
  private readonly flaggedRows = new RowList(0);
  private readonly unsupportedRows = new Set<number>();
  private readonly unsupportedSources = new Map<number, UnsupportedSources>();
  private before = new Uint32Array(4);
  private bomBefore = new Float64Array(4 * BOM_SUMS);
  private readonly scratch = new CoverageScratch();
  private flaggedBefore = 0;

  constructor() {
    this.fit();
  }

  get regionCount(): number {
    return this.regions.length;
  }

  get trackIssues(): TrackIssueRows {
    return this.currentTrackIssues;
  }

  context(region: number): PlanRegionContext {
    return this.state(region).ctx;
  }

  unchecked(): boolean {
    return this.planUnreadableCount > 0;
  }

  insideCount(region: number): number {
    return this.state(region).insideCount;
  }

  issueCount(region: number): number {
    const state = this.state(region);
    return (
      state.ctx.footprintIssues.length +
      state.bomIssueCount() +
      state.rowIssueCount +
      state.trackCount
    );
  }

  joinedRoadCells(region: number): number {
    return this.state(region).roadJoined;
  }

  unmeasuredCount(region: number): number {
    return this.state(region).unmeasured;
  }

  customParts(region: number): number {
    return this.state(region).customParts;
  }

  issueVersion(region: number): number {
    return this.state(region).issueVersion;
  }

  issues(region: number): ReadonlyArray<PlanIssue> {
    return this.state(region).issueList(this.rows, this.trackIssues);
  }

  trackIssueInRegions(issue: number): boolean {
    return (this.trackRegionsIn[issue] ?? 0) > 0;
  }

  isInside(region: number, row: number): boolean {
    return this.state(region).inside[row] === 1;
  }

  regionsInOf(row: number): number {
    return this.regionsIn[row] ?? 0;
  }

  flaggedOf(row: number): number {
    return this.flagged[row] ?? 0;
  }

  firstFlagged(): number {
    return this.flaggedRows.first();
  }

  nextFlagged(row: number): number {
    return this.flaggedRows.after(this.rows, row);
  }

  resetChanges(): void {
    this.flaggedMembershipChanged = false;
    this.flaggedBoxChanged = false;
    this.uncheckedChanged = false;
    this.trackIssuesChanged = false;
  }

  apply(delta: PlanDelta): void {
    this.recordBomSums();
    if (delta.cleared) this.clearRows();
    for (let k = 0; k < delta.removalCount; k++) {
      const row = this.rows.find(delta.removalSegment[k] ?? 0, delta.removalSource[k] ?? 0);
      if (row === NO_ROW) throw new Error("plan delta removes a row that isn't there");
      this.removeRow(row);
    }
    for (let e = 0; e < delta.writeCount; e++) {
      if (delta.writeKind[e] === WRITE_ADD) this.addRow(delta, e);
    }
    for (let e = 0; e < delta.writeCount; e++) {
      if (delta.writeKind[e] === WRITE_UPDATE) this.updateRow(delta, e);
    }
    this.bumpChangedBomSums();
    if (delta.trackIssuesWritten) this.replaceTrackIssues(delta.trackIssues);
    else if (delta.cleared) this.replaceTrackIssues(NO_TRACK_ISSUES);
    this.version++;
  }

  private recordBomSums(): void {
    const regions = this.regions;
    if (this.bomBefore.length < regions.length * BOM_SUMS) {
      this.bomBefore = new Float64Array(regions.length * BOM_SUMS * 2);
    }
    for (let r = 0; r < regions.length; r++) {
      const state = regions[r];
      this.bomBefore[r * BOM_SUMS] = state?.unmappedRebrickable ?? 0;
      this.bomBefore[r * BOM_SUMS + 1] = state?.unmappedBrickLink ?? 0;
    }
  }

  private bumpChangedBomSums(): void {
    const regions = this.regions;
    for (let r = 0; r < regions.length; r++) {
      const state = regions[r];
      if (!state) continue;
      if (
        this.bomBefore[r * BOM_SUMS] !== state.unmappedRebrickable ||
        this.bomBefore[r * BOM_SUMS + 1] !== state.unmappedBrickLink
      ) {
        state.issueVersion++;
      }
    }
  }

  setUnsupported(
    segment: number,
    itself: ReadonlySet<number>,
    carriedTrack: ReadonlySet<number>,
  ): boolean {
    const known = this.unsupportedSources.get(segment);
    if (
      sameMembers(known?.itself ?? NO_SOURCES, itself) &&
      sameMembers(known?.carriedTrack ?? NO_SOURCES, carriedTrack)
    ) {
      return false;
    }
    this.unsupportedSources.set(segment, {
      itself: new Set(itself),
      carriedTrack: new Set(carriedTrack),
    });
    const rows = this.rows;
    const wanted = new Map<number, number>();
    for (const source of carriedTrack) {
      const row = rows.find(segment, source);
      if (row !== NO_ROW) wanted.set(row, CARRIED_TRACK_NOT_HELD);
    }
    for (const source of itself) {
      const row = rows.find(segment, source);
      if (row !== NO_ROW) wanted.set(row, NOT_HELD);
    }
    for (const row of this.unsupportedRows) {
      if (rows.segment[row] !== segment || wanted.has(row)) continue;
      this.reflag(row, HELD);
    }
    for (const [row, held] of wanted) {
      if (rows.unsupported[row] !== held) this.reflag(row, held);
    }
    this.version++;
    return true;
  }

  private unsupportedOf(segment: number, source: number): number {
    const sources = this.unsupportedSources.get(segment);
    if (!sources) return HELD;
    if (sources.itself.has(source)) return NOT_HELD;
    return sources.carriedTrack.has(source) ? CARRIED_TRACK_NOT_HELD : HELD;
  }

  private reflag(row: number, unsupported: number): void {
    if (unsupported === HELD) this.unsupportedRows.delete(row);
    else this.unsupportedRows.add(row);
    const wasUnreadable = this.beginRewrite(row);
    this.rows.unsupported[row] = unsupported;
    this.endRewrite(row, wasUnreadable);
  }

  addRegion(region: PlanRegion): void {
    const state = new RegionState(regionContext(region), this.capacity);
    this.regions.push(state);
    if (this.before.length < this.regions.length)
      this.before = new Uint32Array(this.before.length * 2);
    this.evaluateRegion(state);
    this.evaluateTrack(state);
    this.rebuildLists(state);
    state.issueVersion++;
    this.version++;
  }

  replaceRegion(index: number, region: PlanRegion): void {
    const state = this.state(index);
    this.withdrawRegion(state);
    this.withdrawTrack(state);
    state.ctx = regionContext(region);
    this.evaluateRegion(state);
    this.evaluateTrack(state);
    this.rebuildLists(state);
    state.issueVersion++;
    this.version++;
  }

  renameRegion(index: number, region: PlanRegion): void {
    const state = this.state(index);
    state.ctx = regionContext(region);
    state.issueVersion++;
    this.version++;
  }

  removeRegion(index: number): void {
    const state = this.state(index);
    this.withdrawRegion(state);
    this.withdrawTrack(state);
    this.regions.splice(index, 1);
    this.rebuildLists(null);
    this.version++;
  }

  private replaceTrackIssues(next: TrackIssueRows): void {
    const before = this.currentTrackIssues;
    if (before.sameAs(next)) return;
    const after = this.spareTrackIssues;
    after.copyFrom(next);
    if (this.trackRegionsIn.length < after.count) {
      this.trackRegionsIn = new Uint32Array(Math.max(after.count, this.trackRegionsIn.length * 2));
    }
    this.trackRegionsIn.fill(0, 0, Math.max(before.count, after.count));
    let shown = false;
    for (let r = 0; r < this.regions.length; r++) {
      const state = this.state(r);
      state.nextTrackInside = roomUint8(state.nextTrackInside, after.count);
      const count = this.insideTrack(state.ctx, after, state.nextTrackInside);
      if (this.trackSubsetChanged(state, before, after, count)) {
        state.issueVersion++;
        shown = true;
      }
      const swap = state.trackInside;
      state.trackInside = state.nextTrackInside;
      state.nextTrackInside = swap;
      state.trackCount = count;
    }
    this.currentTrackIssues = after;
    this.spareTrackIssues = before;
    if (shown) this.trackIssuesChanged = true;
  }

  private trackSubsetChanged(
    state: RegionState,
    before: TrackIssueRows,
    after: TrackIssueRows,
    count: number,
  ): boolean {
    if (count !== state.trackCount) return true;
    let j = 0;
    for (let i = 0; i < before.count; i++) {
      if (state.trackInside[i] !== 1) continue;
      while (j < after.count && state.nextTrackInside[j] !== 1) j++;
      if (j === after.count || !before.sameIssue(i, after, j)) return true;
      j++;
    }
    return false;
  }

  private insideTrack(ctx: PlanRegionContext, track: TrackIssueRows, inside: Uint8Array): number {
    let count = 0;
    for (let i = 0; i < track.count; i++) {
      let holds = false;
      const last = track.ownerStart[i + 1] ?? 0;
      for (let owner = track.ownerStart[i] ?? 0; owner < last && !holds; owner++) {
        holds = placementInside(ctx, track.ownerBox, owner * BOX_STRIDE);
      }
      inside[i] = holds ? 1 : 0;
      if (!holds) continue;
      count++;
      this.trackRegionsIn[i] = (this.trackRegionsIn[i] ?? 0) + 1;
    }
    return count;
  }

  private evaluateTrack(state: RegionState): void {
    const track = this.currentTrackIssues;
    state.trackInside = roomUint8(state.trackInside, track.count);
    state.trackCount = this.insideTrack(state.ctx, track, state.trackInside);
  }

  private withdrawTrack(state: RegionState): void {
    const track = this.currentTrackIssues;
    for (let i = 0; i < track.count; i++) {
      if (state.trackInside[i] !== 1) continue;
      state.trackInside[i] = 0;
      this.trackRegionsIn[i] = (this.trackRegionsIn[i] ?? 0) - 1;
    }
    state.trackCount = 0;
  }

  private state(region: number): RegionState {
    const state = this.regions[region];
    if (!state) throw new Error(`no plan region at ${region}`);
    return state;
  }

  private fit(): void {
    const capacity = this.rows.capacity;
    if (capacity === this.capacity) return;
    this.regionsIn = grownUint32(this.regionsIn, capacity);
    this.flagged = grownUint32(this.flagged, capacity);
    this.flaggedRows.grow(capacity);
    for (let r = 0; r < this.regions.length; r++) this.regions[r]?.grow(capacity);
    this.capacity = capacity;
  }

  private clearRows(): void {
    this.rows.clear();
    this.unsupportedRows.clear();
    for (let r = 0; r < this.regions.length; r++) {
      const state = this.state(r);
      state.insideCount = 0;
      state.rowIssueCount = 0;
      state.clearSums();
      state.flagged.clear();
      state.issueVersion++;
    }
    if (this.flaggedRows.first() !== NO_ROW) this.flaggedMembershipChanged = true;
    this.flaggedRows.clear();
    this.sandboxCount = 0;
    this.planUnreadableCount = 0;
    this.refreshFirstUnreadable();
  }

  private copyRow(delta: PlanDelta, entry: number, row: number): void {
    const rows = this.rows;
    rows.write(
      row,
      delta.slot[entry] ?? 0,
      delta.ref[entry] ?? "",
      delta.labelKind[entry] ?? 0,
      delta.labelBase[entry] ?? "",
    );
    rows.chunkKey[row] = delta.chunkKey[entry] ?? 0;
    rows.labelA[row] = delta.labelA[entry] ?? 0;
    rows.labelB[row] = delta.labelB[entry] ?? 0;
    const from = entry * BOX_STRIDE;
    const to = row * BOX_STRIDE;
    for (let k = 0; k < BOX_STRIDE; k++) rows.box[to + k] = delta.box[from + k] ?? 0;
    rows.boxState[row] = delta.boxState[entry] ?? 0;
    rows.shape[row] = rows.shapes.intern(delta.shape[entry] ?? null);
    rows.outline[row] = delta.outline[entry] ?? null;
    rows.carried[row] = delta.carried[entry] ?? null;
    copyFacts(delta.facts, entry * FACT_STRIDE, rows.facts, row * FACT_STRIDE);
  }

  private addRow(delta: PlanDelta, entry: number): void {
    const segment = delta.writeSegment[entry] ?? 0;
    const source = delta.writeSource[entry] ?? 0;
    const row = this.rows.add(segment, source);
    this.fit();
    this.copyRow(delta, entry, row);
    const held = this.unsupportedOf(segment, source);
    if (held !== HELD) {
      this.rows.unsupported[row] = held;
      this.unsupportedRows.add(row);
    }
    this.regionsIn[row] = 0;
    this.flagged[row] = 0;
    for (let r = 0; r < this.regions.length; r++) {
      const state = this.state(r);
      state.inside[row] = 0;
      state.issues[row] = 0;
    }
    if (this.rows.boxState[row] === BOX_PLAN_UNREADABLE) {
      this.planUnreadableCount++;
      this.refreshFirstUnreadable();
      return;
    }
    this.contribute(row);
    for (let r = 0; r < this.regions.length; r++) {
      const state = this.state(r);
      if ((state.issues[row] ?? 0) > 0) state.flagged.link(this.rows, row);
    }
    if ((this.flagged[row] ?? 0) > 0) {
      this.flaggedRows.link(this.rows, row);
      this.flaggedMembershipChanged = true;
    }
  }

  private removeRow(row: number): void {
    if (this.rows.boxState[row] === BOX_PLAN_UNREADABLE) {
      this.planUnreadableCount--;
      this.rows.remove(row);
      this.refreshFirstUnreadable();
      return;
    }
    for (let r = 0; r < this.regions.length; r++) {
      const state = this.state(r);
      if ((state.issues[row] ?? 0) > 0) state.flagged.unlink(this.rows, row);
    }
    if ((this.flagged[row] ?? 0) > 0) {
      this.flaggedRows.unlink(this.rows, row);
      this.flaggedMembershipChanged = true;
    }
    this.withdraw(row);
    this.unsupportedRows.delete(row);
    this.rows.remove(row);
  }

  private updateRow(delta: PlanDelta, entry: number): void {
    const row = this.rows.find(delta.writeSegment[entry] ?? 0, delta.writeSource[entry] ?? 0);
    if (row === NO_ROW) throw new Error("plan delta updates a row that isn't there");
    const wasUnreadable = this.beginRewrite(row);
    this.copyRow(delta, entry, row);
    this.endRewrite(row, wasUnreadable);
  }

  private beginRewrite(row: number): boolean {
    const wasUnreadable = this.rows.boxState[row] === BOX_PLAN_UNREADABLE;
    for (let r = 0; r < this.regions.length; r++) {
      this.before[r] = this.regions[r]?.issues[row] ?? 0;
    }
    this.flaggedBefore = this.flagged[row] ?? 0;
    if (wasUnreadable) this.planUnreadableCount--;
    else this.withdraw(row);
    return wasUnreadable;
  }

  private endRewrite(row: number, wasUnreadable: boolean): void {
    const flaggedBefore = this.flaggedBefore;
    const isUnreadable = this.rows.boxState[row] === BOX_PLAN_UNREADABLE;
    if (isUnreadable) this.planUnreadableCount++;
    else this.contribute(row);
    for (let r = 0; r < this.regions.length; r++) {
      const state = this.state(r);
      const was = this.before[r] ?? 0;
      const now = state.issues[row] ?? 0;
      if (was > 0 && now === 0) state.flagged.unlink(this.rows, row);
      else if (was === 0 && now > 0) state.flagged.linkInOrder(this.rows, row);
      if (was > 0 || now > 0) state.issueVersion++;
    }
    const flaggedNow = this.flagged[row] ?? 0;
    if (flaggedBefore > 0 && flaggedNow === 0) {
      this.flaggedRows.unlink(this.rows, row);
      this.flaggedMembershipChanged = true;
    } else if (flaggedBefore === 0 && flaggedNow > 0) {
      this.flaggedRows.linkInOrder(this.rows, row);
      this.flaggedMembershipChanged = true;
    } else if (flaggedBefore > 0) {
      this.flaggedBoxChanged = true;
    }
    if (wasUnreadable || isUnreadable) this.refreshFirstUnreadable();
  }

  private contribute(row: number): void {
    const box = this.rows.box;
    const at = row * BOX_STRIDE;
    let regionsIn = 0;
    let flagged = 0;
    for (let r = 0; r < this.regions.length; r++) {
      const state = this.state(r);
      if (!placementInside(state.ctx, box, at)) continue;
      state.inside[row] = 1;
      state.insideCount++;
      state.addSums(this.rows.facts, row, 1);
      regionsIn++;
      const count = this.issueCountOf(state, row);
      if (count === 0) continue;
      state.issues[row] = count;
      state.rowIssueCount += count;
      state.issueVersion++;
      flagged += count;
    }
    this.regionsIn[row] = regionsIn;
    this.flagged[row] = flagged;
    if (regionsIn === 0) this.sandboxCount++;
  }

  private issueCountOf(state: RegionState, row: number): number {
    return placementIssueCount(state.ctx, this.rows, row, this.scratch);
  }

  private withdraw(row: number): void {
    for (let r = 0; r < this.regions.length; r++) {
      const state = this.state(r);
      if (state.inside[row] === 1) {
        state.inside[row] = 0;
        state.insideCount--;
        state.addSums(this.rows.facts, row, -1);
      }
      const count = state.issues[row] ?? 0;
      if (count > 0) {
        state.issues[row] = 0;
        state.rowIssueCount -= count;
        state.issueVersion++;
      }
    }
    if (this.regionsIn[row] === 0) this.sandboxCount--;
    this.regionsIn[row] = 0;
    this.flagged[row] = 0;
  }

  private evaluateRegion(state: RegionState): void {
    const rows = this.rows;
    const box = rows.box;
    for (let row = rows.first(); row !== NO_ROW; row = rows.after(row)) {
      if (rows.boxState[row] === BOX_PLAN_UNREADABLE) continue;
      const at = row * BOX_STRIDE;
      if (!placementInside(state.ctx, box, at)) continue;
      state.inside[row] = 1;
      state.insideCount++;
      state.addSums(rows.facts, row, 1);
      const regionsIn = this.regionsIn[row] ?? 0;
      if (regionsIn === 0) this.sandboxCount--;
      this.regionsIn[row] = regionsIn + 1;
      const count = this.issueCountOf(state, row);
      if (count === 0) continue;
      state.issues[row] = count;
      state.rowIssueCount += count;
      this.flagged[row] = (this.flagged[row] ?? 0) + count;
    }
  }

  private withdrawRegion(state: RegionState): void {
    const rows = this.rows;
    for (let row = rows.first(); row !== NO_ROW; row = rows.after(row)) {
      if (rows.boxState[row] === BOX_PLAN_UNREADABLE) continue;
      if (state.inside[row] === 1) {
        state.inside[row] = 0;
        const regionsIn = (this.regionsIn[row] ?? 0) - 1;
        this.regionsIn[row] = regionsIn;
        if (regionsIn === 0) this.sandboxCount++;
      }
      const count = state.issues[row] ?? 0;
      if (count > 0) {
        state.issues[row] = 0;
        this.flagged[row] = (this.flagged[row] ?? 0) - count;
      }
    }
    state.insideCount = 0;
    state.rowIssueCount = 0;
    state.clearSums();
  }

  private rebuildLists(state: RegionState | null): void {
    const rows = this.rows;
    state?.flagged.clear();
    this.flaggedRows.clear();
    for (let row = rows.first(); row !== NO_ROW; row = rows.after(row)) {
      if (state && (state.issues[row] ?? 0) > 0) state.flagged.link(rows, row);
      if ((this.flagged[row] ?? 0) > 0) this.flaggedRows.link(rows, row);
    }
    this.flaggedMembershipChanged = true;
  }

  private refreshFirstUnreadable(): void {
    const previous = this.firstPlanUnreadable;
    let first = NO_ROW;
    if (this.planUnreadableCount > 0) {
      const rows = this.rows;
      for (let row = rows.first(); row !== NO_ROW; row = rows.after(row)) {
        if (rows.boxState[row] === BOX_PLAN_UNREADABLE) {
          first = row;
          break;
        }
      }
    }
    this.firstPlanUnreadable = first;
    if (first === NO_ROW && previous === NO_ROW) return;
    for (let r = 0; r < this.regions.length; r++) this.state(r).issueVersion++;
    if ((previous === NO_ROW) !== (first === NO_ROW)) this.uncheckedChanged = true;
  }
}
