import { isCustomPartId } from "@brr/schema/bundle";
import type { CatalogLine, Crosswalk, PartCrosswalkEntry, ResolvedLine } from "./catalog-ids.ts";

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

const NOT_ALLOWED_IN_XML_COMMENT = /--|-$/u;

function xmlComment(text: string): string {
  if (NOT_ALLOWED_IN_XML_COMMENT.test(text)) {
    throw new Error(`text cannot be written as an XML comment: ${text}`);
  }
  return `<!-- ${text} -->`;
}

export function rebrickableCsv(lines: ReadonlyArray<CatalogLine>): string {
  return csv([["Part", "Color", "Quantity"], ...lines.map((l) => [l.part, l.color, l.quantity])]);
}

export function brickLinkWantedListXml(
  lines: ReadonlyArray<CatalogLine>,
  disclaimer: string,
): string {
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
    xmlComment(disclaimer),
    "<INVENTORY>",
    ...items,
    "</INVENTORY>",
    "",
  ].join("\n");
}

export interface UncountedItem {
  readonly source: string;
  readonly item: string;
  readonly ldrawColor: number | null;
  readonly quantity: number | null;
  readonly reason: string;
}

const KEYWORD_ONLY_NOTE = "BrickLink id from an LDraw keyword only";
const CUSTOM_PART_NOTE = "custom part from an imported file, not buyable";

function lineNote(
  partId: string,
  part: PartCrosswalkEntry | undefined,
  vendor: string | undefined,
): string | null {
  if (isCustomPartId(partId)) return CUSTOM_PART_NOTE;
  if (vendor !== undefined)
    return `third-party part from ${vendor}, not on Rebrickable or BrickLink`;
  return part?.bricklink && part.bricklinkFromKeywordOnly ? KEYWORD_ONLY_NOTE : null;
}

export function plainBomCsv(
  resolved: ReadonlyArray<ResolvedLine>,
  crosswalk: Crosswalk,
  uncounted: ReadonlyArray<UncountedItem>,
  disclaimer: string,
): string {
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
      "Note",
    ],
    ...resolved.map((line) => {
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
        lineNote(line.part, part, crosswalk.thirdParty?.get(line.part)),
      ];
    }),
    ...uncounted.map((item) => [
      item.item,
      item.ldrawColor,
      item.quantity,
      null,
      null,
      null,
      null,
      null,
      `not counted (${item.source}): ${item.reason}`,
    ]),
    [null, null, null, null, null, null, null, null, disclaimer],
  ]);
}
