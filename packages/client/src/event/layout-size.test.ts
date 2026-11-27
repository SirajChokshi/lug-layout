import { emptyFacts, PlanDelta } from "@brr/domain";
import type { WorldBox } from "@brr/render";
import { Container } from "inversify";
import { expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { writeFullRebuild, type PlanModelSource } from "../plan/plan-producer.ts";
import { LAYOUT_SIZE, PLAN_SERVICE } from "../tokens.ts";
import { sizeMeasures } from "./layout-size.ts";

function placed(id: number, ref: string, box: WorldBox): PlanModelSource {
  return {
    id,
    handle: { chunkKey: id, slot: 0, x: box.minX, z: box.minZ },
    placeable: { id: ref, label: ref },
    box,
    shape: null,
    carried: null,
    facts: emptyFacts(),
  };
}

const BASEPLATE: WorldBox = { minX: -320, minY: -4, minZ: -320, maxX: 320, maxY: 0, maxZ: 320 };
const USERS_MODULE: WorldBox = { minX: 320, minY: -4, minZ: -320, maxX: 960, maxY: 52, maxZ: 320 };
const UNREAD: WorldBox = {
  minX: Number.NaN,
  minY: 0,
  minZ: Number.NaN,
  maxX: Number.NaN,
  maxY: 0,
  maxZ: Number.NaN,
};

it("measures the plan extent of every placement, follows the layout as it changes, and never guesses past a box it can't read", () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  const plans = container.get(PLAN_SERVICE);
  const meter = container.get(LAYOUT_SIZE);
  const delta = new PlanDelta();
  const sizeWith = (models: ReadonlyArray<PlanModelSource>) => {
    writeFullRebuild(delta, models, null);
    plans.apply(delta);
    return meter.size();
  };

  expect([
    meter.size(),
    sizeWith([placed(1, "ldraw:3811", BASEPLATE)]),
    sizeWith([placed(1, "ldraw:3811", BASEPLATE), placed(2, "import:module", USERS_MODULE)]),
    sizeWith([placed(1, "ldraw:3811", BASEPLATE), placed(2, "import:module", UNREAD)]),
    sizeWith([]),
  ]).toEqual([
    { kind: "empty" },
    { kind: "measured", widthLdu: 640, depthLdu: 640 },
    { kind: "measured", widthLdu: 1280, depthLdu: 640 },
    { kind: "unmeasured" },
    { kind: "empty" },
  ]);
});

it.each([
  {
    extent: "two 32-stud baseplates side by side",
    widthLdu: 1280,
    depthLdu: 640,
    measures: [
      ["studs", "64", "32"],
      ["modules", "0.67", "0.33"],
      ["metres", "0.51", "0.26"],
      ["feet", "1.68", "0.84"],
    ],
  },
  {
    extent: "a show 25 modules wide and 2 deep",
    widthLdu: 48_000,
    depthLdu: 3840,
    measures: [
      ["studs", "2,400", "192"],
      ["modules", "25.00", "2.00"],
      ["metres", "19.20", "1.54"],
      ["feet", "62.99", "5.04"],
    ],
  },
  {
    extent: "a curve's outline reaching half a stud past the lattice",
    widthLdu: 650,
    depthLdu: 330.5,
    measures: [
      ["studs", "32.5", "16.5"],
      ["modules", "0.34", "0.17"],
      ["metres", "0.26", "0.13"],
      ["feet", "0.85", "0.43"],
    ],
  },
])(
  "writes $extent in studs, 96-stud modules, metres and feet",
  ({ widthLdu, depthLdu, measures }) => {
    expect(
      sizeMeasures(widthLdu, depthLdu).map(({ unit, width, depth }) => [unit, width, depth]),
    ).toEqual(measures);
  },
);
