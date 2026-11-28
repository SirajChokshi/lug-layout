import type { PlanRegion, PlanState, PlanVenue, VenueList } from "@brr/domain";
import type { Decoded, Issue } from "@brr/schema/decode";
import {
  BASE_LAYER_ID,
  OPACITY_PERCENT_MAX,
  UNSTATED_OBSTACLE_KIND,
  type LayerRecordV2,
  type PlanRecordV2,
  type PlanRegionRecordV2,
  type WorldDocument,
} from "@brr/schema/world";

export const PLAN_LAYER_NAME = "Tables";
export const NO_PLANS: PlanState = { regions: [], activePlanId: null, tableTypes: [] };

const SAVED_PLAN_ID = "saved-plan";
const PLAN_LAYERS_UNKEPT =
  "lies on another plan layer than the first plan, which this editor can't keep yet";

export function planRecord(region: PlanRegion): PlanRecordV2 {
  const { rooms, tables, obstacles, aisles, roomWidthMm, roomDepthMm } = region.footprint;
  return {
    name: region.name,
    originChunkX: region.originChunkX,
    originChunkZ: region.originChunkZ,
    maxOverhangMm: region.maxOverhangMm,
    maxReachMm: region.maxReachMm,
    footprint: {
      roomWidthMm,
      roomDepthMm,
      tables: tables.map(({ name, rect, heightMm }) => ({ name, rect, heightMm })),
      obstacles: obstacles.map(({ name, rect, kind }) => ({
        name,
        rect,
        ...(kind === UNSTATED_OBSTACLE_KIND ? {} : { kind }),
      })),
      ...(rooms.length === 0 ? {} : { rooms: rooms.map(({ name, rect }) => ({ name, rect })) }),
      ...(aisles.length === 0
        ? {}
        : { aisles: aisles.map(({ name, rect, side }) => ({ name, rect, side })) }),
    },
  };
}

export function venueOf(
  footprint: PlanRecordV2["footprint"],
  idOf: (list: VenueList, index: number) => string,
): PlanVenue {
  return {
    rooms: (footprint.rooms ?? []).map((room, i) => ({ id: idOf("rooms", i), ...room })),
    obstacles: footprint.obstacles.map(({ name, rect, kind }, i) => ({
      id: idOf("obstacles", i),
      name,
      rect,
      kind: kind ?? UNSTATED_OBSTACLE_KIND,
    })),
    aisles: (footprint.aisles ?? []).map((aisle, i) => ({ id: idOf("aisles", i), ...aisle })),
  };
}

function planRegionRecord(region: PlanRegion, layer: number): PlanRegionRecordV2 {
  const record = planRecord(region);
  return {
    ...record,
    footprint: {
      ...record.footprint,
      tables: region.footprint.tables.map(({ id: _id, typeId, ...table }) => ({
        ...table,
        ...(typeId === undefined ? {} : { type: typeId }),
      })),
    },
    layer,
  };
}

function savedRegion(record: PlanRegionRecordV2, index: number): PlanRegion {
  const id = `${SAVED_PLAN_ID}-${index}`;
  const { footprint } = record;
  return {
    id,
    name: record.name,
    originChunkX: record.originChunkX,
    originChunkZ: record.originChunkZ,
    footprint: {
      roomWidthMm: footprint.roomWidthMm,
      roomDepthMm: footprint.roomDepthMm,
      tables: footprint.tables.map(({ type, ...table }, i) => ({
        id: `${id}-table-${i}`,
        ...table,
        ...(type === undefined ? {} : { typeId: type }),
      })),
      ...venueOf(footprint, (list, i) => `${id}-${list}-${i}`),
    },
    maxOverhangMm: record.maxOverhangMm,
    maxReachMm: record.maxReachMm,
  };
}

function planLayerIssues(plans: ReadonlyArray<PlanRegionRecordV2>): Issue[] {
  const first = plans[0]?.layer;
  return plans.flatMap((plan, i) =>
    plan.layer === first ? [] : [{ path: `plans.${i}.layer`, message: PLAN_LAYERS_UNKEPT }],
  );
}

export function planStateOf(document: WorldDocument): Decoded<PlanState> {
  const plans = document.plans ?? [];
  const issues = planLayerIssues(plans);
  if (issues.length > 0) return { ok: false, issues };
  const regions = plans.map(savedRegion);
  const active = document.activePlan === undefined ? undefined : regions[document.activePlan];
  return {
    ok: true,
    value: {
      regions,
      activePlanId: active?.id ?? null,
      tableTypes: document.tableTypes ?? [],
    },
  };
}

function isPlanLayer(layer: LayerRecordV2): boolean {
  return layer.kind === "plan";
}

function freeLayerId(layers: ReadonlyArray<LayerRecordV2>): number {
  const used = new Set(layers.map((layer) => layer.id));
  let id = BASE_LAYER_ID + 1;
  while (used.has(id)) id++;
  return id;
}

function withPlanLayer(layers: ReadonlyArray<LayerRecordV2>): LayerRecordV2[] {
  if (layers.some(isPlanLayer)) return [...layers];
  const layer: LayerRecordV2 = {
    id: freeLayerId(layers),
    name: PLAN_LAYER_NAME,
    kind: "plan",
    visible: true,
    locked: false,
    opacity: OPACITY_PERCENT_MAX,
  };
  return [layer, ...layers];
}

export function withPlanState(document: WorldDocument, state: PlanState): WorldDocument {
  const { plans: stored, activePlan: _storedActive, tableTypes: _storedTypes, ...kept } = document;
  const typed = state.tableTypes.length === 0 ? {} : { tableTypes: [...state.tableTypes] };
  if (state.regions.length === 0) return { ...kept, ...typed };
  const layers = withPlanLayer(document.layers);
  const layer = stored?.[0]?.layer ?? layers.find(isPlanLayer)?.id ?? BASE_LAYER_ID;
  const activePlan = state.regions.findIndex((region) => region.id === state.activePlanId);
  return {
    ...kept,
    layers,
    plans: state.regions.map((region) => planRegionRecord(region, layer)),
    ...(activePlan < 0 ? {} : { activePlan }),
    ...typed,
  };
}
