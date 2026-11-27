import {
  BASE_LAYER,
  decodeWorldManifest,
  worldDocument,
  type WorldDocument,
} from "@brr/schema/world";
import { describe, expect, it } from "vitest";
import goldenManifest from "../../../test-fixtures/world-schema/v2/manifest.json" with { type: "json" };
import {
  NO_PLANS,
  PLAN_LAYER_NAME,
  planRecord,
  planStateOf,
  withPlanState,
} from "./plan-document.ts";

function goldenDocument(): WorldDocument {
  const manifest = decodeWorldManifest(goldenManifest, "manifest");
  if (!manifest.ok) throw new Error("the golden v2 manifest doesn't decode");
  return worldDocument(manifest.value);
}

const NOTES_LAYER = {
  id: 1,
  name: "Labels",
  kind: "notes",
  visible: true,
  locked: false,
  opacity: 80,
} as const;

const SHOW_FLOOR = {
  id: "plan-1",
  name: "Show floor",
  originChunkX: -2,
  originChunkZ: 0,
  maxOverhangMm: 0,
  maxReachMm: 700,
  footprint: {
    roomWidthMm: 4800,
    roomDepthMm: 3000,
    rooms: [],
    tables: [
      {
        id: "table-2",
        number: 1,
        name: "Table 1",
        rect: { x: 0, z: 0, width: 1524, depth: 762 },
        heightMm: 750,
      },
    ],
    obstacles: [],
    aisles: [],
  },
};

describe("plan document", () => {
  it("writes the golden v2 world's plans, plan layer and active plan back exactly as it read them", () => {
    const document = goldenDocument();
    const state = planStateOf(document);
    if (!state.ok) throw new Error("the golden world's plans don't read");

    expect(withPlanState(document, state.value)).toEqual(document);
  });

  it("puts a world's first plan on a new Tables layer under the others with the lowest free id, and keeps that layer once its plans are gone", () => {
    const document: WorldDocument = { layers: [BASE_LAYER, NOTES_LAYER] };

    const planned = withPlanState(document, {
      regions: [SHOW_FLOOR],
      activePlanId: null,
      tableTypes: [],
    });
    const cleared = withPlanState(planned, NO_PLANS);

    expect({ planned, cleared }).toEqual({
      planned: {
        layers: [
          {
            id: 2,
            name: PLAN_LAYER_NAME,
            kind: "plan",
            visible: true,
            locked: false,
            opacity: 100,
          },
          BASE_LAYER,
          NOTES_LAYER,
        ],
        plans: [
          {
            name: "Show floor",
            originChunkX: -2,
            originChunkZ: 0,
            maxOverhangMm: 0,
            maxReachMm: 700,
            footprint: {
              roomWidthMm: 4800,
              roomDepthMm: 3000,
              tables: [
                {
                  name: "Table 1",
                  number: 1,
                  rect: { x: 0, z: 0, width: 1524, depth: 762 },
                  heightMm: 750,
                },
              ],
              obstacles: [],
            },
            layer: 2,
          },
        ],
      },
      cleared: { layers: planned.layers },
    });
  });

  it("keeps a table library in a world with no plans, and leaves it out once the library is empty", () => {
    const document: WorldDocument = { layers: [BASE_LAYER] };
    const club = {
      id: 3,
      name: "Club 6ft",
      widthMm: 1830,
      depthMm: 760,
      heightMm: 750,
      color: "#c8a165",
      owned: 4,
    };

    const kept = withPlanState(document, { ...NO_PLANS, tableTypes: [club] });

    expect(kept).toEqual({ layers: [BASE_LAYER], tableTypes: [club] });
    expect(planStateOf(kept)).toEqual({ ok: true, value: { ...NO_PLANS, tableTypes: [club] } });
    expect(withPlanState(kept, NO_PLANS)).toEqual(document);
  });

  it("reads an obstacle with no kind as a pillar, and gives a v1 plan file only the obstacles that block", () => {
    const state = planStateOf(goldenDocument());
    const region = state.ok ? state.value.regions[0] : undefined;
    if (!region) throw new Error("the golden world's plan doesn't read");

    expect(region.footprint.obstacles.map((obstacle) => obstacle.kind)).toEqual([
      "pillar",
      "door",
      "power",
    ]);
    expect(planRecord(region).footprint.obstacles.map((obstacle) => obstacle.name)).toEqual([
      "Pillar",
      "Fire door",
    ]);
  });

  it("refuses plans that lie on more than one plan layer, which the editor would merge on its next save", () => {
    const document = goldenDocument();
    const [plan] = document.plans ?? [];
    if (!plan) throw new Error("the golden world has no plan");
    const split: WorldDocument = {
      ...document,
      layers: [...document.layers, { ...NOTES_LAYER, id: 7, kind: "plan" }],
      plans: [plan, { ...plan, name: "Yard", layer: 7 }],
    };

    expect(planStateOf(split)).toEqual({
      ok: false,
      issues: [
        {
          path: "plans.1.layer",
          message:
            "lies on another plan layer than the first plan, which this editor can't keep yet",
        },
      ],
    });
  });
});
