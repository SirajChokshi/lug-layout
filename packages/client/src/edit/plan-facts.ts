import { isCustomPartId } from "@brr/schema/bundle";
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
  MODEL_SEGMENT,
  NO_OVERLAP_PARTNER,
  PLACEMENT_CELL_INTS,
  PLACEMENT_JOINED,
  PLACEMENT_MISMATCHED,
  toCatalog,
  type BomLine,
  type CatalogSystem,
  type Crosswalk,
  type RoadJoinReport,
} from "@brr/domain";
import type { IPlaceableCatalog } from "../catalog/placeable-catalog.ts";
import type { IPlacementSearch } from "../connect/placement-search.ts";
import type { Placeable } from "./placeable.ts";
import type { PlacedChunks, PlacedModel } from "./placed-chunks.ts";

const NOT_PLACED = -1;

export interface SearchedModels {
  idOf(model: PlacedModel): number | undefined;
  modelAt(id: number): PlacedModel | undefined;
}

interface UnmappedParts {
  readonly rebrickable: number;
  readonly bricklink: number;
}

function unmappedIn(
  lines: ReadonlyArray<BomLine>,
  crosswalk: Crosswalk,
  system: CatalogSystem,
): number {
  let parts = 0;
  for (const line of toCatalog(lines, crosswalk, system).unmapped) parts += line.quantity;
  return parts;
}

export class PlanFacts {
  private readonly dirty = new Set<PlacedModel>();
  private readonly fresh = new Set<PlacedModel>();
  private readonly rewritten = new Set<PlacedModel>();
  private readonly unsupportedIds = new Set<number>();
  private readonly near: PlacedModel[] = [];
  private readonly before = new Int32Array(FACT_STRIDE);
  private unmapped = new WeakMap<Placeable, UnmappedParts>();
  private readonly customParts = new WeakMap<Placeable, number>();
  private crosswalk: Crosswalk | null = null;

  constructor(
    private readonly placed: PlacedChunks,
    private readonly search: IPlacementSearch,
    private readonly searched: SearchedModels,
    private readonly catalog: IPlaceableCatalog,
    private readonly tableYPlates: number,
  ) {}

  get unsupported(): ReadonlySet<number> {
    return this.unsupportedIds;
  }

  mapWith(crosswalk: Crosswalk): void {
    this.crosswalk = crosswalk;
    this.unmapped = new WeakMap();
    for (const model of this.placed.models()) this.dirty.add(model);
  }

  noteAdded(models: ReadonlyArray<PlacedModel>): void {
    for (const model of models) {
      this.fresh.add(model);
      this.dirtyAround(model);
    }
  }

  noteWorld(models: ReadonlyArray<PlacedModel>): void {
    this.dirty.clear();
    this.fresh.clear();
    this.rewritten.clear();
    this.unsupportedIds.clear();
    for (const model of models) {
      this.fresh.add(model);
      this.dirty.add(model);
    }
  }

  noteRemoved(models: ReadonlyArray<PlacedModel>): void {
    for (const model of models) {
      this.unsupportedIds.delete(model.id);
      this.dirtyAround(model);
    }
  }

  noteSearchable(model: PlacedModel): void {
    this.dirtyAround(model);
  }

  noteRoads(report: RoadJoinReport, roadModels: ReadonlyArray<PlacedModel>): void {
    const cells = report.placementCells;
    for (let p = 0; p < roadModels.length; p++) {
      const model = roadModels[p];
      if (!model) continue;
      const at = p * PLACEMENT_CELL_INTS;
      const joined = cells[at + PLACEMENT_JOINED] ?? 0;
      const mismatched = cells[at + PLACEMENT_MISMATCHED] ?? 0;
      const facts = model.facts;
      if (facts[FACT_ROAD_JOINED] === joined && facts[FACT_ROAD_MISMATCHED] === mismatched)
        continue;
      facts[FACT_ROAD_JOINED] = joined;
      facts[FACT_ROAD_MISMATCHED] = mismatched;
      this.rewritten.add(model);
    }
  }

  flush(out: PlacedModel[]): number {
    out.length = 0;
    for (const model of this.dirty) {
      if (this.placed.contains(model) && this.measure(model)) this.rewritten.add(model);
    }
    for (const model of this.rewritten) {
      if (!this.fresh.has(model) && this.placed.contains(model)) out.push(model);
    }
    this.dirty.clear();
    this.fresh.clear();
    this.rewritten.clear();
    return out.length;
  }

  private dirtyAround(model: PlacedModel): void {
    this.dirty.add(model);
    this.placed.touching(model.box, this.near);
    for (const other of this.near) this.dirty.add(other);
  }

  private measure(model: PlacedModel): boolean {
    const facts = model.facts;
    const before = this.before;
    before.set(facts);
    const id = this.measurableIdOf(model);
    const searchable = id !== NOT_PLACED;
    const unmapped = this.unmappedOf(model.placeable);
    facts[FACT_FLAGS] = searchable && unmapped !== null ? 0 : FLAG_UNMEASURED;
    const partner = searchable ? this.partnerOf(id) : NOT_PLACED;
    facts[FACT_OVERLAP_SEGMENT] = partner === NOT_PLACED ? NO_OVERLAP_PARTNER : MODEL_SEGMENT;
    facts[FACT_OVERLAP_SOURCE] = partner === NOT_PLACED ? NO_OVERLAP_PARTNER : partner;
    facts[FACT_UNMAPPED_REBRICKABLE] = unmapped?.rebrickable ?? 0;
    facts[FACT_UNMAPPED_BRICKLINK] = unmapped?.bricklink ?? 0;
    facts[FACT_CUSTOM_PARTS] = this.customPartsOf(model.placeable);
    if (searchable && !this.held(id)) this.unsupportedIds.add(model.id);
    else this.unsupportedIds.delete(model.id);
    for (let k = 0; k < FACT_STRIDE; k++) {
      if (facts[k] !== before[k]) return true;
    }
    return false;
  }

  private partnerOf(id: number): number {
    const owner = this.search.overlapOf(id);
    if (owner === NOT_PLACED) return NOT_PLACED;
    const partner = this.searched.modelAt(owner);
    if (!partner) throw new RangeError(`search owner ${owner} names no placed model`);
    return partner.id;
  }

  private held(id: number): boolean {
    return this.search.holdingMates(id) > 0 || this.search.standsOnTable(id, this.tableYPlates);
  }

  private measurableIdOf(model: PlacedModel): number {
    const id = this.placedIdOf(model);
    if (id === NOT_PLACED) return NOT_PLACED;
    this.placed.touching(model.box, this.near);
    for (const other of this.near) {
      if (this.placedIdOf(other) === NOT_PLACED) return NOT_PLACED;
    }
    return id;
  }

  private placedIdOf(model: PlacedModel): number {
    const id = this.searched.idOf(model);
    return id !== undefined && this.search.has(id) ? id : NOT_PLACED;
  }

  private unmappedOf(placeable: Placeable): UnmappedParts | null {
    const crosswalk = this.crosswalk;
    if (!crosswalk) return null;
    const known = this.unmapped.get(placeable);
    if (known) return known;
    const lines = this.linesOf(placeable);
    const counted = {
      rebrickable: unmappedIn(lines, crosswalk, "rebrickable"),
      bricklink: unmappedIn(lines, crosswalk, "bricklink"),
    };
    this.unmapped.set(placeable, counted);
    return counted;
  }

  private customPartsOf(placeable: Placeable): number {
    const known = this.customParts.get(placeable);
    if (known !== undefined) return known;
    const assets = this.catalog.parts();
    const { parts } = placeable;
    let custom = 0;
    for (let i = 0; i < parts.count; i++) {
      const part = assets[parts.partIndex[i] ?? 0]?.id;
      if (part !== undefined && isCustomPartId(part)) custom++;
    }
    this.customParts.set(placeable, custom);
    return custom;
  }

  private linesOf(placeable: Placeable): BomLine[] {
    const assets = this.catalog.parts();
    const colors = this.catalog.colors();
    const { parts } = placeable;
    const lines = new Map<string, BomLine>();
    for (let i = 0; i < parts.count; i++) {
      const partIndex = parts.partIndex[i] ?? 0;
      const part = assets[partIndex]?.id;
      if (part === undefined)
        throw new RangeError(`part index ${partIndex} is not in the part table`);
      const ldrawColor = colors.codeAt(parts.colorIndex[i] ?? 0);
      const key = `${part}\u0000${ldrawColor}`;
      lines.set(key, { part, ldrawColor, quantity: (lines.get(key)?.quantity ?? 0) + 1 });
    }
    return [...lines.values()];
  }
}
