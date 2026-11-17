import { readFileSync } from "node:fs";
import { MilsEdgeRules } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { STUD_LDU } from "@brr/math";
import { describe, expect, it } from "vitest";
import { ModuleLayout } from "./module-layout.ts";
import type { ModuleSurface } from "./module-surface.ts";

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
const GREEN = 2;
const studs = rules.moduleStuds;
const road = rules.features.find((feature) => feature.kind === "road");

function roadAlongLocalX(minX: number, minZ: number): ModuleSurface {
  if (!road) throw new Error("no road rule");
  const plates = new Int16Array(studs * studs).fill(rules.surfacePlates);
  const colors = new Int32Array(studs * studs).fill(GREEN);
  const from = (studs - road.widthStuds) / 2;
  for (let row = from; row < from + road.widthStuds; row++) {
    for (let column = 0; column < studs; column++) {
      plates[row * studs + column] = road.plates;
      colors[row * studs + column] = road.ldrawColors[0] ?? 0;
    }
  }
  return { studs, minX, minZ, plates, colors };
}

describe("ModuleLayout", () => {
  it("lands every quarter turn of an off-centre module exactly on the module grid cell under the cursor", () => {
    const layout = new ModuleLayout(rules);
    const surface = roadAlongLocalX(-100, -540);
    const size = studs * STUD_LDU;
    for (let rot = 0; rot < 4; rot++) {
      const pose = layout.pose(surface, rot, 3 * size + 1, -2 * size + size - 1);
      expect({ column: pose.column, row: pose.row }).toEqual({ column: 3, row: -2 });
      const kinds = layout.edges(surface, pose.x, pose.z, rot).map((edge) => edge.kind);
      expect(kinds).toEqual(
        rot % 2 === 0
          ? ["road", "road", "terrain", "terrain"]
          : ["terrain", "terrain", "road", "road"],
      );
    }
  });

  it("turns a module to the quarter turn whose sides fit, keeping the preferred turn on ties", () => {
    const layout = new ModuleLayout(rules);
    const surface = roadAlongLocalX(-320, -320);
    const size = studs * STUD_LDU;
    const alone = layout.bestCandidate(surface, 1, size / 2, size / 2);
    expect(alone.rot).toBe(1);
    expect(alone.fit.mismatched).toBe(0);
  });
});
