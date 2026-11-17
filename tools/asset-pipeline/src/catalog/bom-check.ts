import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv, readGzipCsv } from "./csv.ts";
import {
  compareWithInventory,
  DIFFERENCE_KINDS,
  InventoryIndex,
  PartRelations,
  partColorKey,
  type InventoryComparison,
  type PartColorCounts,
  type SetInventory,
} from "./inventory-check.ts";

const REBRICKABLE_SUFFIX = ".rebrickable.csv";
const PLAIN_SUFFIX = ".parts.csv";

export interface BomCheckPaths {
  readonly exportDirectory: string;
  readonly out: string;
  readonly inventoryDirectory: string;
  readonly partsCsv: string;
}

interface UnmappedLine {
  readonly ldrawPart: string;
  readonly ldrawColour: string;
  readonly quantity: number;
  readonly expandedFrom: string;
}

interface CategoryResidual {
  readonly category: string;
  readonly exportOnly: number;
  readonly inventoryOnly: number;
}

interface SetReport {
  readonly setNum: string;
  readonly residualByCategory: ReadonlyArray<CategoryResidual>;
  readonly expandedTotal: number;
  readonly unmapped: ReadonlyArray<UnmappedLine>;
  readonly notCounted: ReadonlyArray<string>;
  readonly inventory: Omit<SetInventory, "parts">;
  readonly comparison: InventoryComparison;
}

async function csvRows(path: string): Promise<Array<Readonly<Record<string, string>>>> {
  const [header, ...rows] = parseCsv(await readFile(path, "utf8"));
  if (!header) throw new Error(`${path} is empty`);
  return rows
    .filter((row) => row.some((cell) => cell !== ""))
    .map((row) => Object.fromEntries(header.map((name, i) => [name, row[i] ?? ""])));
}

async function exportedCounts(path: string): Promise<PartColorCounts> {
  const counts: PartColorCounts = new Map();
  for (const row of await csvRows(path)) {
    const key = partColorKey(row["Part"] ?? "", row["Color"] ?? "");
    counts.set(key, (counts.get(key) ?? 0) + Number(row["Quantity"]));
  }
  return counts;
}

const NOT_COUNTED_NOTE = "not counted";

async function plainLines(
  path: string,
): Promise<{ expandedTotal: number; unmapped: UnmappedLine[]; notCounted: string[] }> {
  let expandedTotal = 0;
  const unmapped: UnmappedLine[] = [];
  const notCounted: string[] = [];
  for (const row of await csvRows(path)) {
    const note = row["Note"] ?? "";
    if (note.startsWith(NOT_COUNTED_NOTE)) {
      notCounted.push(`${row["Quantity"] || "?"}× ${row["LDraw part"] ?? ""}: ${note}`);
      continue;
    }
    const quantity = Number(row["Quantity"]);
    expandedTotal += quantity;
    if (row["Rebrickable part"] === "" || row["Rebrickable colour"] === "") {
      unmapped.push({
        ldrawPart: row["LDraw part"] ?? "",
        ldrawColour: row["LDraw colour"] ?? "",
        quantity,
        expandedFrom: row["Expanded from"] ?? "",
      });
    }
  }
  return { expandedTotal, unmapped, notCounted };
}

function sumPairings(comparison: InventoryComparison, kind: string): number {
  return comparison.pairings
    .filter((pairing) => pairing.kind === kind)
    .reduce((sum, pairing) => sum + pairing.quantity, 0);
}

function sumEntries(entries: ReadonlyArray<readonly [string, number]>): number {
  return entries.reduce((sum, [, quantity]) => sum + quantity, 0);
}

function summaryTable(reports: ReadonlyArray<SetReport>): string {
  const header = [
    "Set",
    "Parts, shortcuts expanded",
    "Exported (Rebrickable CSV)",
    "Unmapped",
    "Not counted (items)",
    "Inventory (non-spare, minifigs included)",
    "Exact",
    ...DIFFERENCE_KINDS,
    "Export only",
    "Inventory only",
  ];
  const rows = reports.map((report) => {
    const { comparison } = report;
    return [
      report.setNum,
      report.expandedTotal,
      comparison.exportedTotal,
      sumEntries(report.unmapped.map((line) => [line.ldrawPart, line.quantity] as const)),
      report.notCounted.length,
      comparison.inventoryTotal,
      comparison.exact,
      ...DIFFERENCE_KINDS.map((kind) => sumPairings(comparison, kind)),
      sumEntries(comparison.exportOnly),
      sumEntries(comparison.inventoryOnly),
    ];
  });
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function residualByCategory(
  comparison: InventoryComparison,
  categoryOf: (part: string) => string,
): CategoryResidual[] {
  const totals = new Map<string, { exportOnly: number; inventoryOnly: number }>();
  const add = (key: string, quantity: number, side: "exportOnly" | "inventoryOnly"): void => {
    const category = categoryOf(key.slice(0, key.lastIndexOf("/")));
    const entry = totals.get(category) ?? { exportOnly: 0, inventoryOnly: 0 };
    entry[side] += quantity;
    totals.set(category, entry);
  };
  for (const [key, quantity] of comparison.exportOnly) add(key, quantity, "exportOnly");
  for (const [key, quantity] of comparison.inventoryOnly) add(key, quantity, "inventoryOnly");
  return [...totals]
    .map(([category, entry]) => ({ category, ...entry }))
    .toSorted((a, b) => b.exportOnly + b.inventoryOnly - (a.exportOnly + a.inventoryOnly));
}

function categoryTable(reports: ReadonlyArray<SetReport>): string {
  const totals = new Map<string, { exportOnly: number; inventoryOnly: number }>();
  for (const report of reports) {
    for (const row of report.residualByCategory) {
      const entry = totals.get(row.category) ?? { exportOnly: 0, inventoryOnly: 0 };
      entry.exportOnly += row.exportOnly;
      entry.inventoryOnly += row.inventoryOnly;
      totals.set(row.category, entry);
    }
  }
  const rows = [...totals].toSorted(
    ([, a], [, b]) => b.exportOnly + b.inventoryOnly - (a.exportOnly + a.inventoryOnly),
  );
  return [
    "| Rebrickable part category | Export only | Inventory only |",
    "|---|---|---|",
    ...rows.map(
      ([category, entry]) => `| ${category} | ${entry.exportOnly} | ${entry.inventoryOnly} |`,
    ),
  ].join("\n");
}

export async function bomCheck(paths: BomCheckPaths): Promise<string> {
  const [inventories, inventoryParts, inventoryMinifigs, relationships, categories, parts] =
    await Promise.all(
      [
        "inventories.csv.gz",
        "inventory_parts.csv.gz",
        "inventory_minifigs.csv.gz",
        "part_relationships.csv.gz",
        "part_categories.csv.gz",
      ]
        .map((file) => readGzipCsv(join(paths.inventoryDirectory, file)))
        .concat(readGzipCsv(paths.partsCsv)),
    );
  const index = new InventoryIndex({
    inventories: inventories ?? [],
    inventoryParts: inventoryParts ?? [],
    inventoryMinifigs: inventoryMinifigs ?? [],
  });
  const relations = new PartRelations(relationships ?? []);
  const names = Object.fromEntries((parts ?? []).map((row) => [row["part_num"], row["name"]]));
  const categoryNames = new Map((categories ?? []).map((row) => [row["id"], row["name"]]));
  const partCategory = new Map((parts ?? []).map((row) => [row["part_num"], row["part_cat_id"]]));
  const categoryOf = (part: string): string =>
    categoryNames.get(partCategory.get(part) ?? "") ?? "not in Rebrickable parts";
  const files = (await readdir(paths.exportDirectory))
    .filter((file) => file.endsWith(REBRICKABLE_SUFFIX))
    .toSorted();
  const reports: SetReport[] = [];
  for (const file of files) {
    const setNum = file.slice(0, -REBRICKABLE_SUFFIX.length);
    const { parts: inventory, ...inventoryFacts } = index.setInventory(setNum);
    const exported = await exportedCounts(join(paths.exportDirectory, file));
    const plain = await plainLines(join(paths.exportDirectory, setNum + PLAIN_SUFFIX));
    const comparison = compareWithInventory(exported, inventory, relations);
    reports.push({
      setNum,
      residualByCategory: residualByCategory(comparison, categoryOf),
      ...plain,
      inventory: inventoryFacts,
      comparison,
    });
  }
  const differing = new Set(
    reports.flatMap(({ comparison }) =>
      [
        ...comparison.pairings.flatMap((pairing) => [pairing.exported, pairing.inventory]),
        ...comparison.exportOnly.map(([key]) => key),
        ...comparison.inventoryOnly.map(([key]) => key),
      ].map((key) => key.slice(0, key.lastIndexOf("/"))),
    ),
  );
  const partNames = Object.fromEntries(
    [...differing].toSorted().map((part) => [part, names[part] ?? null]),
  );
  await writeFile(paths.out, `${JSON.stringify({ reports, partNames }, null, 1)}\n`);
  return `${summaryTable(reports)}\n\n${categoryTable(reports)}\n`;
}
