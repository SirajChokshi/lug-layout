import type { CsvRecord } from "./csv.ts";

export type PartColorCounts = Map<string, number>;

export type DifferenceKind =
  | "mould-or-alternate"
  | "letter-suffix-revision"
  | "print-or-pattern"
  | "assembly-and-sub-part"
  | "other-colour";

export const DIFFERENCE_KINDS: ReadonlyArray<DifferenceKind> = [
  "mould-or-alternate",
  "letter-suffix-revision",
  "print-or-pattern",
  "assembly-and-sub-part",
  "other-colour",
];

export interface InventoryData {
  readonly inventories: ReadonlyArray<CsvRecord>;
  readonly inventoryParts: ReadonlyArray<CsvRecord>;
  readonly inventoryMinifigs: ReadonlyArray<CsvRecord>;
}

export interface SetInventory {
  readonly setNum: string;
  readonly inventoryId: string;
  readonly versions: number;
  readonly versionsIdentical: boolean;
  readonly parts: PartColorCounts;
  readonly minifigParts: number;
  readonly spares: number;
}

export interface Pairing {
  readonly kind: DifferenceKind;
  readonly exported: string;
  readonly inventory: string;
  readonly quantity: number;
}

export interface InventoryComparison {
  readonly exportedTotal: number;
  readonly inventoryTotal: number;
  readonly exact: number;
  readonly pairings: ReadonlyArray<Pairing>;
  readonly exportOnly: ReadonlyArray<readonly [string, number]>;
  readonly inventoryOnly: ReadonlyArray<readonly [string, number]>;
}

export function partColorKey(part: string, color: number | string): string {
  return `${part}/${color}`;
}

function splitKey(key: string): readonly [string, string] {
  const slash = key.lastIndexOf("/");
  return [key.slice(0, slash), key.slice(slash + 1)];
}

function addCount(counts: PartColorCounts, key: string, quantity: number): void {
  counts.set(key, (counts.get(key) ?? 0) + quantity);
}

function total(counts: PartColorCounts): number {
  let sum = 0;
  for (const quantity of counts.values()) sum += quantity;
  return sum;
}

function sameCounts(a: PartColorCounts, b: PartColorCounts): boolean {
  return a.size === b.size && [...a].every(([key, quantity]) => b.get(key) === quantity);
}

export class InventoryIndex {
  private readonly versionsBySet = new Map<string, Array<{ id: string; version: number }>>();
  private readonly partsByInventory = new Map<string, CsvRecord[]>();
  private readonly minifigsByInventory = new Map<string, CsvRecord[]>();

  constructor(data: InventoryData) {
    for (const row of data.inventories) {
      const list = this.versionsBySet.get(row["set_num"] ?? "") ?? [];
      list.push({ id: row["id"] ?? "", version: Number(row["version"]) });
      this.versionsBySet.set(row["set_num"] ?? "", list);
    }
    for (const row of data.inventoryParts) {
      const id = row["inventory_id"] ?? "";
      const list = this.partsByInventory.get(id) ?? [];
      list.push(row);
      this.partsByInventory.set(id, list);
    }
    for (const row of data.inventoryMinifigs) {
      const id = row["inventory_id"] ?? "";
      const list = this.minifigsByInventory.get(id) ?? [];
      list.push(row);
      this.minifigsByInventory.set(id, list);
    }
  }

  private versions(setNum: string): Array<{ id: string; version: number }> {
    return (this.versionsBySet.get(setNum) ?? []).toSorted((a, b) => a.version - b.version);
  }

  private ownParts(inventoryId: string, times: number, into: PartColorCounts): number {
    let spares = 0;
    for (const row of this.partsByInventory.get(inventoryId) ?? []) {
      const quantity = Number(row["quantity"]) * times;
      if (row["is_spare"] === "True") spares += quantity;
      else addCount(into, partColorKey(row["part_num"] ?? "", row["color_id"] ?? ""), quantity);
    }
    return spares;
  }

  private withMinifigs(inventoryId: string): {
    parts: PartColorCounts;
    minifigParts: number;
    spares: number;
  } {
    const parts: PartColorCounts = new Map();
    let spares = this.ownParts(inventoryId, 1, parts);
    const before = total(parts);
    for (const fig of this.minifigsByInventory.get(inventoryId) ?? []) {
      const figInventory = this.versions(fig["fig_num"] ?? "")[0];
      if (!figInventory) throw new Error(`minifig ${fig["fig_num"]} has no inventory`);
      spares += this.ownParts(figInventory.id, Number(fig["quantity"]), parts);
    }
    return { parts, minifigParts: total(parts) - before, spares };
  }

  setInventory(setNum: string): SetInventory {
    const versions = this.versions(setNum);
    const first = versions[0];
    if (!first) throw new Error(`set ${setNum} has no Rebrickable inventory`);
    const chosen = this.withMinifigs(first.id);
    const versionsIdentical = versions.every((v) =>
      sameCounts(this.withMinifigs(v.id).parts, chosen.parts),
    );
    return {
      setNum,
      inventoryId: first.id,
      versions: versions.length,
      versionsIdentical,
      ...chosen,
    };
  }
}

const LETTER_SUFFIX = /^(\d+)[a-z]$/u;

export class PartRelations {
  private readonly neighbours = new Map<string, Map<string, string>>();
  private readonly printBase = new Map<string, string>();

  constructor(relationships: ReadonlyArray<CsvRecord>) {
    for (const row of relationships) {
      const type = row["rel_type"] ?? "";
      const child = row["child_part_num"] ?? "";
      const parent = row["parent_part_num"] ?? "";
      this.link(child, parent, type);
      this.link(parent, child, type);
      if (type === "P" || type === "T") this.printBase.set(child, parent);
    }
  }

  private link(a: string, b: string, type: string): void {
    const map = this.neighbours.get(a) ?? new Map<string, string>();
    map.set(b, `${map.get(b) ?? ""}${type}`);
    this.neighbours.set(a, map);
  }

  private types(a: string, b: string): string {
    return this.neighbours.get(a)?.get(b) ?? "";
  }

  private base(part: string): string {
    return this.printBase.get(part) ?? part;
  }

  related(kind: DifferenceKind, a: string, b: string): boolean {
    switch (kind) {
      case "mould-or-alternate":
        return /[MA]/u.test(this.types(a, b));
      case "letter-suffix-revision": {
        const left = LETTER_SUFFIX.exec(a)?.[1] ?? a;
        const right = LETTER_SUFFIX.exec(b)?.[1] ?? b;
        return a !== b && left === right;
      }
      case "print-or-pattern":
        return a !== b && this.base(a) === this.base(b);
      case "assembly-and-sub-part":
        return this.types(a, b).includes("B");
      case "other-colour":
        return a === b;
      default: {
        const unhandled: never = kind;
        throw new Error(`unhandled difference kind ${String(unhandled)}`);
      }
    }
  }
}

function sameColourRequired(kind: DifferenceKind): boolean {
  return kind !== "assembly-and-sub-part" && kind !== "other-colour";
}

function sortedEntries(counts: PartColorCounts): Array<[string, number]> {
  return [...counts].filter(([, q]) => q > 0).toSorted(([a], [b]) => (a < b ? -1 : 1));
}

export function compareWithInventory(
  exported: PartColorCounts,
  inventory: PartColorCounts,
  relations: PartRelations,
): InventoryComparison {
  const left = new Map(exported);
  const right = new Map(inventory);
  let exact = 0;
  for (const [key, quantity] of left) {
    const matched = Math.min(quantity, right.get(key) ?? 0);
    if (matched === 0) continue;
    exact += matched;
    left.set(key, quantity - matched);
    right.set(key, (right.get(key) ?? 0) - matched);
  }
  const pairings: Pairing[] = [];
  for (const kind of DIFFERENCE_KINDS) {
    for (const [exportedKey] of sortedEntries(left)) {
      const [exportedPart, exportedColour] = splitKey(exportedKey);
      for (const [inventoryKey] of sortedEntries(right)) {
        const [inventoryPart, inventoryColour] = splitKey(inventoryKey);
        if (sameColourRequired(kind) && exportedColour !== inventoryColour) continue;
        if (kind === "other-colour" && exportedColour === inventoryColour) continue;
        if (!relations.related(kind, exportedPart, inventoryPart)) continue;
        const quantity = Math.min(left.get(exportedKey) ?? 0, right.get(inventoryKey) ?? 0);
        if (quantity === 0) continue;
        pairings.push({ kind, exported: exportedKey, inventory: inventoryKey, quantity });
        left.set(exportedKey, (left.get(exportedKey) ?? 0) - quantity);
        right.set(inventoryKey, (right.get(inventoryKey) ?? 0) - quantity);
      }
    }
  }
  return {
    exportedTotal: total(exported),
    inventoryTotal: total(inventory),
    exact,
    pairings,
    exportOnly: sortedEntries(left),
    inventoryOnly: sortedEntries(right),
  };
}
