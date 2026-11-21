import { expect, it } from "vitest";
import { BomCounter } from "./bom-counter.ts";
import { toCatalog, type Crosswalk } from "./catalog-ids.ts";
import { brickLinkWantedListXml, plainBomCsv } from "./export-formats.ts";

const DISCLAIMER = "LEGO® is a trademark of the LEGO Group, which does not endorse this project.";

const crosswalk: Crosswalk = {
  parts: new Map([["ldraw:3001", { rebrickable: "3001", bricklink: "3001" }]]),
  colors: new Map([[4, { rebrickable: 4, bricklink: 5 }]]),
};

function lines() {
  const counter = new BomCounter(["ldraw:3001"], [4]);
  counter.add(0, 4, 2);
  return counter.lines();
}

it("carries the trademark disclaimer in the exports that can hold free text", () => {
  const xml = brickLinkWantedListXml(toCatalog(lines(), crosswalk, "bricklink").lines, DISCLAIMER);
  expect(xml.split("\n").slice(0, 3)).toEqual([
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- ${DISCLAIMER} -->`,
    "<INVENTORY>",
  ]);
  const rows = plainBomCsv(lines(), crosswalk, [], DISCLAIMER).trimEnd().split("\r\n");
  expect(rows.at(-1)).toBe(`,,,,,,,,"${DISCLAIMER}"`);
});

it("refuses text that would end the XML comment early", () => {
  expect(() => brickLinkWantedListXml([], "not -- allowed")).toThrow("XML comment");
});

it("keeps a custom part from an imported file out of the buyable and unmapped lines, and notes it in the plain CSV", () => {
  const custom = "custom:0123456789ab/mybrick.dat";
  const counter = new BomCounter(["ldraw:3001", custom], [4]);
  counter.add(0, 4, 2);
  counter.add(1, 4, 3);

  const rebrickable = toCatalog(counter.lines(), crosswalk, "rebrickable");

  expect(rebrickable.lines).toEqual([
    { part: "3001", color: 4, quantity: 2, fromKeywordOnly: false },
  ]);
  expect(rebrickable.unmapped).toEqual([]);
  expect(rebrickable.custom).toEqual([
    { part: custom, ldrawColor: 4, quantity: 3, expandedFrom: null },
  ]);
  const rows = plainBomCsv(counter.lines(), crosswalk, [], DISCLAIMER).split("\r\n");
  expect(rows).toContain(`${custom},4,3,,4,,5,,"custom part from an imported file, not buyable"`);
});
