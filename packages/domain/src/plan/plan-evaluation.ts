import type { PlanRegion } from "./plan-region.ts";
import { WRITE_ADD, WRITE_UPDATE, type PlanDelta } from "./plan-delta.ts";
import {
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
import { BOX_PLAN_UNREADABLE, NO_ROW, PlanRows, RowList } from "./plan-rows.ts";

const BOM_SUMS = 2;

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

class RegionState {
  inside: Uint8Array<ArrayBuffer>;
  issues: Uint32Array<ArrayBuffer>;
  readonly flagged: RowList;
  insideCount = 0;
  rowIssueCount = 0;
  issueVersion = 0;
  roadJoined = 0;
  roadMismatched = 0;
  unmeasured = 0;
  unmappedRebrickable = 0;
  unmappedBrickLink = 0;
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
  }

  addSums(facts: Int32Array, row: number, sign: number): void {
    const at = row * FACT_STRIDE;
    this.roadJoined += sign * (facts[at + FACT_ROAD_JOINED] ?? 0);
    this.roadMismatched += sign * (facts[at + FACT_ROAD_MISMATCHED] ?? 0);
    this.unmeasured += sign * ((facts[at + FACT_FLAGS] ?? 0) & FLAG_UNMEASURED);
    this.unmappedRebrickable += sign * (facts[at + FACT_UNMAPPED_REBRICKABLE] ?? 0);
    this.unmappedBrickLink += sign * (facts[at + FACT_UNMAPPED_BRICKLINK] ?? 0);
  }

  bomIssueCount(): number {
    return bomMappingIssueCount(this.unmappedRebrickable, this.unmappedBrickLink);
  }

  issueList(rows: PlanRows): ReadonlyArray<PlanIssue> {
    if (this.cachedAt === this.issueVersion) return this.cached;
    const issues = [...this.ctx.footprintIssues];
    bomMappingIssues(this.unmappedRebrickable, this.unmappedBrickLink, issues);
    for (let row = this.flagged.first(); row !== NO_ROW; row = this.flagged.after(rows, row)) {
      placementIssues(this.ctx, placementOf(rows, row), issues);
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
    overlapWith: segment < 0 ? null : partner === NO_ROW ? "another placement" : rows.labelOf(partner),
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
    unsupported: rows.unsupported[row] === 1,
    shape: rows.shapeOf(row),
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
  private readonly regions: RegionState[] = [];
  private capacity = 0;
  private regionsIn = new Uint32Array(0);
  private flagged = new Uint32Array(0);
  private readonly flaggedRows = new RowList(0);
  private readonly unsupportedRows = new Set<number>();
  private readonly unsupportedSources = new Map<number, ReadonlySet<number>>();
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
    return state.ctx.footprintIssues.length + state.bomIssueCount() + state.rowIssueCount;
  }

  joinedRoadCells(region: number): number {
    return this.state(region).roadJoined;
  }

  unmeasuredCount(region: number): number {
    return this.state(region).unmeasured;
  }

  issueVersion(region: number): number {
    return this.state(region).issueVersion;
  }

  issues(region: number): ReadonlyArray<PlanIssue> {
    return this.state(region).issueList(this.rows);
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

  setUnsupported(segment: number, sources: ReadonlySet<number>): void {
    this.unsupportedSources.set(segment, new Set(sources));
    const rows = this.rows;
    const wanted = new Set<number>();
    for (const source of sources) {
      const row = rows.find(segment, source);
      if (row !== NO_ROW) wanted.add(row);
    }
    for (const row of this.unsupportedRows) {
      if (rows.segment[row] !== segment || wanted.has(row)) continue;
      this.reflag(row, 0);
    }
    for (const row of wanted) {
      if (rows.unsupported[row] === 1) continue;
      this.reflag(row, 1);
    }
    this.version++;
  }

  private reflag(row: number, unsupported: number): void {
    if (unsupported === 1) this.unsupportedRows.add(row);
    else this.unsupportedRows.delete(row);
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
    this.rebuildLists(state);
    state.issueVersion++;
    this.version++;
  }

  replaceRegion(index: number, region: PlanRegion): void {
    const state = this.state(index);
    this.withdrawRegion(state);
    state.ctx = regionContext(region);
    this.evaluateRegion(state);
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
    this.regions.splice(index, 1);
    this.rebuildLists(null);
    this.version++;
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
    copyFacts(delta.facts, entry * FACT_STRIDE, rows.facts, row * FACT_STRIDE);
  }

  private addRow(delta: PlanDelta, entry: number): void {
    const segment = delta.writeSegment[entry] ?? 0;
    const source = delta.writeSource[entry] ?? 0;
    const row = this.rows.add(segment, source);
    this.fit();
    this.copyRow(delta, entry, row);
    if (this.unsupportedSources.get(segment)?.has(source) === true) {
      this.rows.unsupported[row] = 1;
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
