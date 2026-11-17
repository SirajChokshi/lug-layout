import { readFileSync } from "node:fs";
import { MilsEdgeRules, type MilsEdgeFeatureRule } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { describe, expect, it } from "vitest";
import {
  classifyModuleEdge,
  edgesJoin,
  ModuleGrid,
  NO_TOP,
  type ModuleEdge,
} from "./module-edges.ts";

const rules = decodedOrThrow(
  decode(
    MilsEdgeRules,
    JSON.parse(
      readFileSync(
        new URL("../../../../docs/verified-facts/mils-edge-rules.json", import.meta.url),
        "utf8",
      ),
    ),
  ),
  "mils-edge-rules.json",
);
const studs = rules.moduleStuds;
const surface = rules.surfacePlates;
const GREEN = 2;
const TAN = 19;

function feature(kind: MilsEdgeFeatureRule["kind"]): MilsEdgeFeatureRule {
  const found = rules.features.find((rule) => rule.kind === kind);
  if (!found) throw new Error(`no ${kind} rule`);
  return found;
}

function terrainSamples(plates = surface, color = GREEN) {
  return {
    plates: new Int16Array(studs).fill(plates),
    colors: new Int32Array(studs).fill(color),
  };
}

function featureSamples(rule: MilsEdgeFeatureRule, shift = 0, width = rule.widthStuds) {
  const samples = terrainSamples();
  const from = (studs - width) / 2 + shift;
  for (let stud = from; stud < from + width; stud++) {
    samples.plates[stud] = rule.plates;
    samples.colors[stud] = rule.ldrawColors[0] ?? 0;
  }
  for (let bank = 0; bank < rule.bankStuds; bank++) {
    const plates = rule.bankStartPlates + bank * rule.bankRisePlatesPerStud;
    samples.plates[from - 1 - bank] = plates;
    samples.plates[from + width + bank] = plates;
  }
  return samples;
}

function edge(samples: { plates: Int16Array; colors: Int32Array }): ModuleEdge {
  return { kind: classifyModuleEdge(rules, samples.plates, samples.colors), ...samples };
}

describe("classifyModuleEdge", () => {
  it("names every feature centred on the edge at its width and height, and plain ground terrain", () => {
    for (const rule of rules.features) {
      const samples = featureSamples(rule);
      expect(classifyModuleEdge(rules, samples.plates, samples.colors)).toBe(rule.kind);
    }
    const plain = terrainSamples();
    expect(classifyModuleEdge(rules, plain.plates, plain.colors)).toBe("terrain");
  });

  it("refuses a feature that is off centre, too narrow, or below its height", () => {
    const road = feature("road");
    const offCentre = featureSamples(road, 1);
    expect(classifyModuleEdge(rules, offCentre.plates, offCentre.colors)).toBe("other");
    const narrow = featureSamples(road, 0, road.widthStuds - 2);
    expect(classifyModuleEdge(rules, narrow.plates, narrow.colors)).toBe("other");
    const sunk = featureSamples(road);
    const from = (studs - road.widthStuds) / 2;
    sunk.plates.fill(road.plates - road.belowPlates - 1, from, from + road.widthStuds);
    expect(classifyModuleEdge(rules, sunk.plates, sunk.colors)).toBe("other");
  });

  it("allows the spec's one-plate unevenness on terrain but not two plates, nor a gap", () => {
    const uneven = terrainSamples();
    uneven.plates[5] = surface + rules.surfaceTolerancePlates;
    expect(classifyModuleEdge(rules, uneven.plates, uneven.colors)).toBe("terrain");
    uneven.plates[5] = surface + rules.surfaceTolerancePlates + 1;
    expect(classifyModuleEdge(rules, uneven.plates, uneven.colors)).toBe("other");
    const gap = terrainSamples();
    gap.plates[0] = NO_TOP;
    expect(classifyModuleEdge(rules, gap.plates, gap.colors)).toBe("other");
  });

  it("reads uniform tan ground as terrain, not as an earth track", () => {
    const desert = terrainSamples(surface, TAN);
    expect(classifyModuleEdge(rules, desert.plates, desert.colors)).toBe("terrain");
  });

  it("refuses a river whose banks don't step up from the water, such as a cliff at the surface", () => {
    const river = feature("river");
    const from = (studs - river.widthStuds) / 2;
    const cliff = featureSamples(river);
    for (let bank = 0; bank < river.bankStuds; bank++) {
      cliff.plates[from - 1 - bank] = surface;
      cliff.plates[from + river.widthStuds + bank] = surface;
    }
    expect(classifyModuleEdge(rules, cliff.plates, cliff.colors)).toBe("other");
    const varied = featureSamples(river);
    varied.plates[from - 1] = river.bankStartPlates + river.bankVariationPlates;
    expect(classifyModuleEdge(rules, varied.plates, varied.colors)).toBe("river");
  });
});

describe("ModuleGrid", () => {
  const terrain = edge(terrainSamples());
  const road = edge(featureSamples(feature("road")));
  const river = edge(featureSamples(feature("river")));

  it("joins matching edges, flags mismatches and counts open sides", () => {
    const straight = [road, road, terrain, terrain];
    const grid = new ModuleGrid([
      { id: 0, column: 0, row: 0, edges: straight },
      { id: 1, column: 1, row: 0, edges: straight },
      { id: 2, column: 0, row: 1, edges: [river, river, terrain, terrain] },
      { id: 3, column: 1, row: 1, edges: [terrain, terrain, terrain, terrain] },
    ]);
    const report = grid.report();
    expect(report).toMatchObject({ modules: 4, joined: 6, mismatched: 2, open: 8 });
    const between = report.edges.filter((e) => e.module === 2 && e.side === "maxX");
    expect(between).toEqual([
      { module: 2, side: "maxX", kind: "river", status: "mismatch", facing: "terrain" },
    ]);
    expect(grid.fit(2, 0, [road, terrain, terrain, terrain])).toEqual({
      joined: 1,
      mismatched: 0,
      open: 3,
      statuses: ["joined", "open", "open", "open"],
    });
  });

  it("is symmetric, and joins unclassified edges only when their geometry is identical", () => {
    const odd = terrainSamples();
    odd.plates[3] = surface + 3;
    const other = edge(odd);
    const otherTwin = edge({ plates: odd.plates.slice(), colors: odd.colors.slice() });
    const shifted = terrainSamples();
    shifted.plates[4] = surface + 3;
    const otherShifted = edge(shifted);
    const all = [terrain, road, river, other, otherTwin, otherShifted];
    for (const a of all) for (const b of all) expect(edgesJoin(a, b)).toBe(edgesJoin(b, a));
    expect(edgesJoin(other, otherTwin)).toBe(true);
    expect(edgesJoin(other, otherShifted)).toBe(false);
  });
});
