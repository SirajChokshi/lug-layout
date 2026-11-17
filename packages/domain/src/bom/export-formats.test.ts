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
