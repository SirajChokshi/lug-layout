import { SIXTEENTHS_PER_LDU, STUD_LDU } from "@brr/math";
import { describe, expect, it } from "vitest";
import {
  AXIS_POS_Y,
  ConnectorTable,
  GENDER_MALE,
  SOURCE_SHADOW,
  STATUS_VERIFIED,
} from "./connector-table.ts";
import { ModelCache } from "./model-cache.ts";
import { SnapMating } from "./mating.ts";
import { ModelConnectors } from "./model-connectors.ts";
import { CAP_ROOT, SECTION_ROUND, SnapShapes } from "./snap-shapes.ts";

const shapes = new SnapShapes();
const mating = new SnapMating(shapes);
const STUD = shapes.intern(CAP_ROOT, false, [SECTION_ROUND], [6], [4]);
const IDENTITY = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);
const CONNECTORS = 10;
const MODELS = 3;

function studs(count: number): ModelConnectors {
  const origins = Array.from({ length: count }, (_, k) => [k * STUD_LDU, 0, 0]).flat();
  return ModelConnectors.fromParts(
    [
      new ConnectorTable(
        new Uint16Array(count).fill(STUD),
        new Uint8Array(count).fill(GENDER_MALE),
        new Uint8Array(count).fill(SOURCE_SHADOW),
        new Uint8Array(count).fill(STATUS_VERIFIED),
        Int32Array.from(origins, (ldu) => ldu * SIXTEENTHS_PER_LDU),
        new Int8Array(count).fill(AXIS_POS_Y),
        new Float64Array(count * 3),
        new Uint16Array(count),
        new Float64Array(count * 3),
        [],
      ),
    ],
    { count: 1, partIndex: [0], matrices: IDENTITY },
    mating,
  );
}

function held(cache: ModelCache<string>, models: ReadonlyArray<ModelConnectors>): string[] {
  return models.flatMap((model) => cache.get(model) ?? []);
}

describe("ModelCache", () => {
  it("evicts the least recently used model once it holds more connectors or more models than its bounds, never the one just set, so a model larger than the budget is kept alone", () => {
    const [a, b, c] = [studs(4), studs(4), studs(4)] as const;
    const byConnectors = new ModelCache<string>(CONNECTORS, MODELS);
    byConnectors.set(a, "a");
    byConnectors.set(b, "b");
    byConnectors.get(a);
    byConnectors.set(c, "c");
    const resetNotCountedTwice = new ModelCache<string>(CONNECTORS, MODELS);
    resetNotCountedTwice.set(a, "a");
    resetNotCountedTwice.set(a, "a again");
    resetNotCountedTwice.set(b, "b");
    const ones = [studs(1), studs(1), studs(1), studs(1)];
    const byModels = new ModelCache<string>(CONNECTORS, MODELS);
    ones.forEach((one, k) => byModels.set(one, `one ${k}`));
    const big = studs(CONNECTORS + 2);
    const overBudget = new ModelCache<string>(CONNECTORS, MODELS);
    overBudget.set(a, "a");
    overBudget.set(big, "big");
    const bigAlone = held(overBudget, [a, big]);
    overBudget.set(b, "b");
    expect({
      byConnectors: held(byConnectors, [a, b, c]),
      resetNotCountedTwice: held(resetNotCountedTwice, [a, b]),
      byModels: held(byModels, ones),
      bigAlone,
      afterBig: held(overBudget, [a, b, big]),
    }).toEqual({
      byConnectors: ["a", "c"],
      resetNotCountedTwice: ["a again", "b"],
      byModels: ["one 1", "one 2", "one 3"],
      bigAlone: ["big"],
      afterBig: ["b"],
    });
  });
});
