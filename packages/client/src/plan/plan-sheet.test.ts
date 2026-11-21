import { mmRectInWorld, studsInside, type PlanRegion, type TableTop } from "@brr/domain";
import { describe, expect, it } from "vitest";
import { planSheetSvg, type PlanSheet } from "./plan-sheet.ts";

const ORIGIN_X = -1280;
const ORIGIN_Z = 640;

const REGION: PlanRegion = {
  id: "plan-1",
  name: "Attic & loft <east>",
  originChunkX: ORIGIN_X / 640,
  originChunkZ: ORIGIN_Z / 640,
  footprint: {
    roomWidthMm: 2999,
    roomDepthMm: 1801,
    tables: [
      {
        id: "table-1",
        name: "Door top",
        rect: { x: 89, z: 41, width: 1234, depth: 567 },
        heightMm: 733,
      },
    ],
    obstacles: [],
  },
  maxOverhangMm: 0,
  maxReachMm: 700,
};

function tableTop(): TableTop {
  const table = REGION.footprint.tables[0];
  if (!table) throw new Error("the region has a table");
  return {
    id: table.id,
    name: table.name,
    heightMm: table.heightMm,
    surface: mmRectInWorld(REGION, table.rect),
    studs: studsInside(REGION, table.rect),
  };
}

const SHEET: PlanSheet = {
  name: REGION.name,
  originX: ORIGIN_X,
  originZ: ORIGIN_Z,
  room: mmRectInWorld(REGION, { x: 0, z: 0, width: 2999, depth: 1801 }),
  tables: [tableTop()],
  obstacles: [],
  roadway: [],
  ramps: [],
  placements: [
    {
      number: 1,
      label: "my-cottage.ldr at -1000, 900",
      parts: 13,
      segment: "model",
      rings: [
        [
          [-1060, 840],
          [-940, 840],
          [-940, 960],
          [-1060, 960],
        ],
      ],
      flagged: false,
    },
    {
      number: 2,
      label: "Train Track 9V Curve #1",
      parts: 1,
      segment: "track",
      rings: [
        [
          [-700.1234567, 1000],
          [-560.5, 1012.25],
          [-610, 1100.0004],
        ],
      ],
      flagged: true,
    },
  ],
  partsList: { placements: 2, parts: 14, lines: 3, uncounted: 1 },
  verdict: {
    buildable: false,
    issues: 1,
    unmeasured: 2,
    notChecked: ["Open and unjoined track ends (#47)"],
    unchecked: null,
  },
  disclaimer: "Not affiliated with any brick maker.",
};

function texts(svg: string): string[] {
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/gu)].map((match) =>
    (match[1] ?? "")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&amp;", "&"),
  );
}

function attribute(element: string, name: string): string {
  const value = new RegExp(`\\s${name}="([^"]*)"`, "u").exec(element)?.[1];
  if (value === undefined) throw new Error(`${element} has no ${name}`);
  return value;
}

describe("planSheetSvg", () => {
  const svg = planSheetSvg(SHEET);

  it("draws at 1:1: the page is in millimetres, LDU geometry is scaled by 0.4, and the check bar is 8 studs = 64 mm", () => {
    const root = /<svg[^>]*>/u.exec(svg)?.[0] ?? "";
    const width = attribute(root, "width");
    const height = attribute(root, "height");
    const bar = /<g class="check-bar">(<line[^>]*>)/u.exec(svg)?.[1] ?? "";
    const geometry = /<g transform="([^"]*)">/u.exec(svg)?.[1] ?? "";
    const table = /<rect class="table"[^>]*>/u.exec(svg)?.[0] ?? "";

    expect({
      viewBox: attribute(root, "viewBox"),
      barMm: Number(attribute(bar, "x2")) - Number(attribute(bar, "x1")),
      scale: /scale\(([^)]*)\)/u.exec(geometry)?.[1],
      tableMm: [Number(attribute(table, "width")) * 0.4, Number(attribute(table, "height")) * 0.4],
    }).toEqual({
      viewBox: `0 0 ${width.replace("mm", "")} ${height.replace("mm", "")}`,
      barMm: 64,
      scale: "0.4",
      tableMm: [1234, 567],
    });
    expect(width).toMatch(/^\d+(\.\d+)?mm$/u);
  });

  it("dimensions each table and the room in studs and cm, off the 8-stud grid too", () => {
    expect(texts(svg)).toEqual(
      expect.arrayContaining([
        "154.3 studs · 123.4 cm",
        "70.9 studs · 56.7 cm",
        "room 374.9 studs · 299.9 cm",
        "room 225.1 studs · 180.1 cm",
        "Door top · 73.3 cm high · 153 × 70 studs on the lattice",
      ]),
    );
  });

  it("draws a track piece by its own outline, relative to the plan origin, and a model by its footprint", () => {
    const paths = [...svg.matchAll(/<path class="([^"]*)" d="([^"]*)"\/>/gu)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(paths).toEqual([
      ["model", "M220 200L340 200L340 320L220 320Z"],
      ["track flagged", "M579.877 360L719.5 372.25L670 460Z"],
    ]);
  });

  it("numbers every placement on the plan and lists it in the key with its parts, and totals them", () => {
    const all = texts(svg);
    const key = all.slice(all.indexOf("Key: numbers on the plan"));
    expect(key.slice(0, 13)).toEqual([
      "Key: numbers on the plan",
      "No.",
      "Parts",
      "Placement",
      "1",
      "13",
      "my-cottage.ldr at -1000, 900",
      "2",
      "1",
      "Train Track 9V Curve #1 · plan issue",
      "14",
      "Total: 2 placements",
      expect.stringContaining("blue, a placed model's footprint"),
    ]);
    expect(all).toEqual(
      expect.arrayContaining(["1", "2", "Attic & loft <east>", SHEET.disclaimer]),
    );
  });

  it("never writes a non-finite number: a placement with no finite footprint is listed, not drawn", () => {
    const degenerate = planSheetSvg({
      ...SHEET,
      placements: [
        {
          number: 1,
          label: "a stored model at an unreadable pose",
          parts: 4,
          segment: "model",
          rings: [
            [
              [Number.NaN, 0],
              [Number.POSITIVE_INFINITY, 0],
              [0, Number.NEGATIVE_INFINITY],
            ],
          ],
          flagged: false,
        },
      ],
    });
    expect({
      nonFinite: /NaN|Infinity/u.test(degenerate),
      paths: degenerate.includes("<path"),
      listed: texts(degenerate).includes(
        "a stored model at an unreadable pose · not drawn: no finite footprint",
      ),
    }).toEqual({ nonFinite: false, paths: false, listed: true });
  });

  it("states the verdict and the parts list it's given, and lists the checks not made yet under the key", () => {
    const all = texts(svg);
    const buildable = texts(
      planSheetSvg({ ...SHEET, verdict: { ...SHEET.verdict, buildable: true, notChecked: [] } }),
    );
    const unchecked = texts(
      planSheetSvg({
        ...SHEET,
        partsList: null,
        verdict: { ...SHEET.verdict, unchecked: "a box can't be read" },
      }),
    );
    expect({
      verdict: all.find((line) => line.includes("buildable as planned")),
      partsList: all.find((line) => line.startsWith("Parts list")),
      notChecked: all.slice(all.indexOf("Not checked yet:"), all.indexOf("Not checked yet:") + 2),
      buildable:
        buildable.includes("Buildable as planned") && !buildable.includes("Not checked yet:"),
      unchecked: unchecked.filter((line) => /^(Plan rules|Parts list)/u.test(line)),
    }).toEqual({
      verdict:
        "Not buildable as planned yet: 1 error, 2 placements not measured yet, 1 check not made yet (see the key)",
      partsList:
        "Parts list: 14 parts in 3 part and colour lines, from 2 placements, and 1 item it can't count",
      notChecked: ["Not checked yet:", "· Open and unjoined track ends (#47)"],
      buildable: true,
      unchecked: [
        "Plan rules couldn't be checked: a box can't be read",
        "Parts list: not counted while the plan rules can't be checked",
      ],
    });
  });
});
