import type { BomLine } from "./bom-counter.ts";
import { resolveLines, type CatalogLine, type Crosswalk } from "./catalog-ids.ts";

const CSV_SPECIAL = /[",\r\n]/u;
const BRICKLINK_PART_ITEM_TYPE = "P";

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  return CSV_SPECIAL.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function xmlText(value: string | number): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function rebrickableCsv(lines: ReadonlyArray<CatalogLine>): string {
  return csv([["Part", "Color", "Quantity"], ...lines.map((l) => [l.part, l.color, l.quantity])]);
}

export function brickLinkWantedListXml(lines: ReadonlyArray<CatalogLine>): string {
  const items = lines.map((line) =>
    [
      "  <ITEM>",
      `    <ITEMTYPE>${BRICKLINK_PART_ITEM_TYPE}</ITEMTYPE>`,
      `    <ITEMID>${xmlText(line.part)}</ITEMID>`,
      `    <COLOR>${xmlText(line.color)}</COLOR>`,
      `    <MINQTY>${xmlText(line.quantity)}</MINQTY>`,
      "  </ITEM>",
    ].join("\n"),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<INVENTORY>",
    ...items,
    "</INVENTORY>",
    "",
  ].join("\n");
}

export function plainBomCsv(lines: ReadonlyArray<BomLine>, crosswalk: Crosswalk): string {
  return csv([
    [
      "LDraw part",
      "LDraw colour",
      "Quantity",
      "Rebrickable part",
      "Rebrickable colour",
      "BrickLink part",
      "BrickLink colour",
      "Expanded from",
    ],
    ...resolveLines(lines, crosswalk).map((line) => {
      const part = crosswalk.parts.get(line.part);
      const color = crosswalk.colors.get(line.ldrawColor);
      return [
        line.part,
        line.ldrawColor,
        line.quantity,
        part?.rebrickable ?? null,
        color?.rebrickable ?? null,
        part?.bricklink ?? null,
        color?.bricklink ?? null,
        line.expandedFrom,
      ];
    }),
  ]);
}
