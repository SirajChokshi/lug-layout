import { expect, it } from "vitest";
import { producedColors } from "./produced-colors.ts";

const LDCONFIG = [
  "0 !COLOUR Green CODE 2 VALUE #00852B EDGE #333333",
  "0 !COLOUR Dark_Bluish_Grey CODE 72 VALUE #646464 EDGE #333333",
  "0 !COLOUR Yellowish_Green CODE 326 VALUE #E2F99A EDGE #333333",
].join("\n");

const COLORS_CSV = [
  "id,name,rgb,is_trans,num_parts,num_sets,y1,y2",
  "2,Green,237841,False,1,1,1990,2026",
  "72,Dark Bluish Gray,6C6E68,False,1,1,2004,2026",
  "326,Olive Green,9B9A5A,False,1,1,2013,2026",
  "999,Unlisted,000000,False,1,1,2013,2026",
].join("\n");

const ELEMENTS_CSV = [
  "element_id,part_num,color_id,design_id",
  "100,69958,72,69958",
  "101,69958,326,69958",
  "102,69958,999,69958",
  "200,44336pr0001,2,",
  "201,44336pr0001,2,",
].join("\n");

it("keeps only colours whose Rebrickable id and name match an LDConfig colour, and reads printed parts by their Rebrickable keyword", () => {
  const report = producedColors({
    elementsCsv: ELEMENTS_CSV,
    colorsCsv: COLORS_CSV,
    ldconfig: LDCONFIG,
    parts: [
      { id: "69958", datText: "0 Plate 16 x 16 x 0.667 with Cutouts and Recessed Studs\n" },
      {
        id: "44336p01",
        datText: "0 Baseplate 32 x 32 Road\n0 !KEYWORDS Rebrickable 44336pr0001, set 7280\n",
      },
    ],
  });

  expect(report.parts.get("69958")).toEqual({
    rebrickable: "69958",
    colors: [{ ldraw: 72, elements: ["100"] }],
  });
  expect(report.parts.get("44336p01")).toEqual({
    rebrickable: "44336pr0001",
    colors: [{ ldraw: 2, elements: ["200", "201"] }],
  });
  expect(report.excluded.map(({ part, rebrickableColor }) => [part, rebrickableColor])).toEqual([
    ["69958", 326],
    ["69958", 999],
  ]);
});
