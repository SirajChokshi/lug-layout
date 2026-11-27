import type { BlueBrickBrickLayer, BlueBrickMap } from "@brr/schema/bluebrick";
import { expect, it } from "vitest";
import { BUNDLE_TIMEOUT_MS, blueBrickBundle, readFixture } from "./bluebrick.test-support.ts";

function brickLayerOf(map: BlueBrickMap): BlueBrickBrickLayer {
  const layer = map.layers.find((candidate) => candidate.kind === "brick");
  if (layer?.kind !== "brick") throw new Error("the map has no brick layer");
  return layer;
}

function withItems(
  map: BlueBrickMap,
  parts: ReadonlyArray<string>,
  groupParts: ReadonlyArray<string>,
): BlueBrickMap {
  const layer = brickLayerOf(map);
  const [template] = layer.bricks;
  if (template === undefined) throw new Error("the brick layer has no brick");
  const bricks = parts.map((part) => ({ ...template, part, group: null, connections: [] }));
  const groups = groupParts.map((part, index) => ({ id: String(index + 1), part, parent: null }));
  return { ...map, layers: [{ ...layer, bricks, groups }] };
}

function ldrawPart(part: string, color: number, redirects: ReadonlyArray<string> = []) {
  return { kind: "part", part, color, via: "ldraw", redirects };
}

it(
  "maps a real show layout's ids to LDraw parts and colours and reports what isn't one",
  async () => {
    const { compiler, mapper } = await blueBrickBundle();
    const fordyce = await readFixture(compiler, "fordyce-2026.bbm");
    expect(await mapper.map(fordyce)).toEqual([
      { id: "2865.8", bricks: 440, groups: 0, outcome: ldrawPart("74746", 8, ["2865"]) },
      { id: "3811.19", bricks: 54, groups: 0, outcome: ldrawPart("3811", 19) },
      { id: "3811.2", bricks: 252, groups: 0, outcome: ldrawPart("3811", 2) },
      { id: "3811.4", bricks: 3, groups: 0, outcome: ldrawPart("3811", 4) },
      { id: "3857.0", bricks: 72, groups: 0, outcome: ldrawPart("3857", 0) },
      { id: "4186.7", bricks: 32, groups: 0, outcome: ldrawPart("4186", 7) },
      { id: "BT R104.8", bricks: 32, groups: 0, outcome: { kind: "notInLibrary" } },
      { id: "BT R120.8", bricks: 32, groups: 0, outcome: { kind: "notInLibrary" } },
      { id: "TABLE96X190", bricks: 23, groups: 0, outcome: { kind: "table" } },
    ]);
  },
  BUNDLE_TIMEOUT_MS,
);

it(
  "reads each id of a synthetic map as an LDraw part, a BrickLink number, a set or a table, and reports every id it can't map",
  async () => {
    const { compiler, mapper } = await blueBrickBundle();
    const yard = await readFixture(compiler, "synthetic-yard.bbm");
    const synthetic = withItems(
      yard,
      [
        "3811.2",
        "3811.2",
        "2865.8",
        "63325.4",
        "44342PX2.2",
        "3464.7",
        "4093C.0",
        "60616.15",
        "2859.8",
        "3811.9999",
        "9VHALFCURVE.8",
        "TB CT R104BC.8",
        "TABLE96X96",
        "4532-1.SET",
        "4565-1.LOCO",
      ],
      ["10014-1.SET", "YARD-LEAD.KIT"],
    );
    expect(await mapper.map(synthetic)).toEqual([
      {
        id: "10014-1.SET",
        bricks: 0,
        groups: 1,
        outcome: { kind: "model", model: "10014-1" },
      },
      {
        id: "2859.8",
        bricks: 1,
        groups: 0,
        outcome: { kind: "component", part: "2859" },
      },
      {
        id: "2865.8",
        bricks: 1,
        groups: 0,
        outcome: ldrawPart("74746", 8, ["2865"]),
      },
      {
        id: "3464.7",
        bricks: 1,
        groups: 0,
        outcome: { kind: "ambiguous", ldraw: "3464", bricklink: ["3464b"] },
      },
      {
        id: "3811.2",
        bricks: 2,
        groups: 0,
        outcome: ldrawPart("3811", 2),
      },
      {
        id: "3811.9999",
        bricks: 1,
        groups: 0,
        outcome: { kind: "unknownColor", part: "3811", color: 9999 },
      },
      {
        id: "4093C.0",
        bricks: 1,
        groups: 0,
        outcome: { kind: "ambiguous", ldraw: "4093c", bricklink: ["4093b"] },
      },
      {
        id: "44342PX2.2",
        bricks: 1,
        groups: 0,
        outcome: { kind: "part", part: "44342p02", color: 2, via: "bricklink", redirects: [] },
      },
      {
        id: "4532-1.SET",
        bricks: 1,
        groups: 0,
        outcome: { kind: "noModel" },
      },
      {
        id: "4565-1.LOCO",
        bricks: 1,
        groups: 0,
        outcome: { kind: "notAPart" },
      },
      {
        id: "60616.15",
        bricks: 1,
        groups: 0,
        outcome: { kind: "ambiguous", ldraw: null, bricklink: ["60616a", "60616b"] },
      },
      {
        id: "63325.4",
        bricks: 1,
        groups: 0,
        outcome: ldrawPart("2420", 4, ["63325"]),
      },
      {
        id: "9VHALFCURVE.8",
        bricks: 1,
        groups: 0,
        outcome: { kind: "notInLibrary" },
      },
      {
        id: "TABLE96X96",
        bricks: 1,
        groups: 0,
        outcome: { kind: "table" },
      },
      {
        id: "TB CT R104BC.8",
        bricks: 1,
        groups: 0,
        outcome: { kind: "notInLibrary" },
      },
    ]);
  },
  BUNDLE_TIMEOUT_MS,
);
