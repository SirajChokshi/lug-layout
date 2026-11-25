import { PLATE_LDU, STUD_LDU } from "@brr/math";
import {
  RoadNetwork,
  type RoadEdgeSegment,
  type RoadJoinReport,
  type RoadPlacement,
  type RoadSurface,
} from "@brr/domain";
import type { PlacedModel } from "./placed-chunks.ts";
import {
  NearbyRoadNetwork,
  RoadIndex,
  cellExtent,
  placedRoadsOf,
  type CellExtent,
  type PlacedRoads,
} from "./road-snap.ts";

const CARRY_LDU = 64 * STUD_LDU;

export function roadPlacementOf(
  id: number,
  model: PlacedModel,
  surface: RoadSurface,
): RoadPlacement {
  const { handle } = model;
  return {
    id,
    x: handle.x,
    z: handle.z,
    yLdu: handle.yPlates * PLATE_LDU,
    rot: handle.rot,
    surface,
  };
}

function keptThenAdded(
  before: ReadonlyArray<PlacedModel>,
  after: ReadonlyArray<PlacedModel>,
  removed: ReadonlySet<PlacedModel>,
): number {
  let b = 0;
  let a = 0;
  while (b < before.length) {
    const model = before[b++];
    if (!model || removed.has(model)) continue;
    if (after[a] !== model) return -1;
    a++;
  }
  return a;
}

export class LiveRoads {
  private readonly network = new RoadNetwork([]);
  private readonly placementOf = new WeakMap<PlacedModel, RoadPlacement>();
  private readonly extentOf = new WeakMap<RoadPlacement, CellExtent>();
  private roadModels: ReadonlyArray<PlacedModel> = [];
  private livePlacements: ReadonlyArray<RoadPlacement> = [];
  private live: PlacedRoads = placedRoadsOf(this.network, []);
  private latest: RoadJoinReport = this.network.report();

  get models(): ReadonlyArray<PlacedModel> {
    return this.roadModels;
  }

  get placements(): ReadonlyArray<RoadPlacement> {
    return this.livePlacements;
  }

  get placedRoads(): PlacedRoads {
    return this.live;
  }

  get report(): RoadJoinReport {
    return this.latest;
  }

  refresh(roadModels: ReadonlyArray<PlacedModel>): void {
    const kept = new Set(roadModels);
    const removed = new Set(this.roadModels.filter((model) => !kept.has(model)));
    const keptCount = keptThenAdded(this.roadModels, roadModels, removed);
    if (keptCount <= 0) {
      this.network.clear();
      for (const model of roadModels) this.network.add(this.placementFor(model));
    } else {
      for (const model of removed) this.network.remove(model.id);
      for (let i = keptCount; i < roadModels.length; i++) {
        const model = roadModels[i];
        if (model) this.network.add(this.placementFor(model));
      }
    }
    this.roadModels = roadModels;
    this.livePlacements = roadModels.map((model) => this.placementFor(model));
    this.live = placedRoadsOf(
      this.network,
      this.livePlacements,
      this.livePlacements.map((placement) => this.extentFor(placement)),
    );
    this.latest = this.network.report();
  }

  excluding(exempt: ReadonlySet<PlacedModel>): PlacedRoads {
    if (!this.roadModels.some((model) => exempt.has(model))) return this.live;
    const placements: RoadPlacement[] = [];
    const extents: CellExtent[] = [];
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    let largestSide = 0;
    for (const model of this.roadModels) {
      const placement = this.placementFor(model);
      const extent = this.extentFor(placement);
      if (!exempt.has(model)) {
        placements.push(placement);
        extents.push(extent);
        continue;
      }
      minX = Math.min(minX, placement.x);
      maxX = Math.max(maxX, placement.x);
      minZ = Math.min(minZ, placement.z);
      maxZ = Math.max(maxZ, placement.z);
      largestSide = Math.max(largestSide, extent.maxX - extent.minX, extent.maxZ - extent.minZ);
    }
    const originSpan = Math.max(maxX - minX, maxZ - minZ);
    const index = RoadIndex.of(extents);
    const margin = originSpan + largestSide + CARRY_LDU;
    return {
      network: new NearbyRoadNetwork(placements, extents, index, margin),
      placements,
      extents,
      index,
    };
  }

  modelOf(id: number): PlacedModel | undefined {
    const rank = this.rankOf(id);
    return rank < 0 ? undefined : this.roadModels[rank];
  }

  rankOf(id: number): number {
    let low = 0;
    let high = this.roadModels.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const at = this.roadModels[mid]?.id ?? 0;
      if (at === id) return mid;
      if (at < id) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  }

  reportByRank(): RoadJoinReport {
    const report = this.latest;
    const rankOf = (id: number): number => this.rankOf(id);
    return {
      ...report,
      overlaps: report.overlaps.map(([a, b]) => [rankOf(a), rankOf(b)] as const),
      segments: report.segments.map((segment): RoadEdgeSegment => ({
        ...segment,
        placement: rankOf(segment.placement),
      })),
    };
  }

  private placementFor(model: PlacedModel): RoadPlacement {
    let placement = this.placementOf.get(model);
    if (!placement) {
      const surface = model.placeable.road;
      if (!surface) throw new Error(`model ${model.id} has no road surface`);
      placement = roadPlacementOf(model.id, model, surface);
      this.placementOf.set(model, placement);
    }
    return placement;
  }

  private extentFor(placement: RoadPlacement): CellExtent {
    let extent = this.extentOf.get(placement);
    if (!extent) {
      extent = cellExtent(placement);
      this.extentOf.set(placement, extent);
    }
    return extent;
  }
}
