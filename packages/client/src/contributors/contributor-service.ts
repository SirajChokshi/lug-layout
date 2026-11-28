import {
  NO_INVENTORY,
  canonicalLines,
  readOwnedPartsCsv,
  sumInventories,
  type BomLine,
  type Contributor,
  type Inventory,
  type OwnedPartsRead,
  type Roster,
  type RosterAction,
  type RosterChange,
} from "@brr/domain";
import { isCustomPartId } from "@brr/schema/bundle";
import { decode, issueText, type Decoded, type Issue } from "@brr/schema/decode";
import {
  CONTRIBUTOR_ID_MAX,
  ContributorRecordV2,
  InventoryV2,
  canonicalJson,
  inventoryFile,
} from "@brr/schema/world";
import { injectable } from "inversify";
import type { TextFile } from "../bom/owned-parts-service.ts";

export type ContributorRemovalGuard = (contributor: number) => string | null;

export interface IContributorService {
  subscribe(listener: () => void): () => void;
  roster(): Roster;
  coloured(): boolean;
  setColoured(coloured: boolean): void;
  create(name: string): Decoded<number>;
  rename(id: number, name: string): ReadonlyArray<Issue>;
  recolour(id: number, color: string): ReadonlyArray<Issue>;
  remove(id: number): ReadonlyArray<Issue>;
  importCollection(id: number, file: TextFile): Promise<OwnedPartsRead>;
  countParts(id: number, lines: ReadonlyArray<BomLine>): ReadonlyArray<Issue>;
  setCount(id: number, part: string, color: number, quantity: number): ReadonlyArray<Issue>;
  clearInventory(id: number): ReadonlyArray<Issue>;
  eventBudget(): Inventory;
  guardRemoval(guard: ContributorRemovalGuard): () => void;
  onEdit(listener: (change: RosterChange) => void): () => void;
  restore(roster: Roster): void;
}

const GOLDEN_ANGLE_DEGREES = 137.508;
const FULL_TURN_DEGREES = 360;
const HUE_SECTOR_DEGREES = 30;
const HUE_SECTORS = 12;
const LIGHTNESS = 0.45;
const CHROMA_HALF = 0.3;
const CHANNEL_MAX = 255;
const HEX = 16;
const RED_OFFSET = 0;
const GREEN_OFFSET = 8;
const BLUE_OFFSET = 4;

function hueColor(hueDegrees: number): string {
  const channel = (offset: number): string => {
    const k = (offset + hueDegrees / HUE_SECTOR_DEGREES) % HUE_SECTORS;
    const value = LIGHTNESS - CHROMA_HALF * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * CHANNEL_MAX)
      .toString(HEX)
      .padStart(2, "0");
  };
  return `#${channel(RED_OFFSET)}${channel(GREEN_OFFSET)}${channel(BLUE_OFFSET)}`;
}

function contributorPath(id: number): string {
  return `contributor ${id}`;
}

function unlisted(id: number): Issue {
  return { path: contributorPath(id), message: "isn't on the roster" };
}

function freeId(roster: Roster): number | null {
  let highest = -1;
  for (const row of roster) highest = Math.max(highest, row.id);
  if (highest < CONTRIBUTOR_ID_MAX) return highest + 1;
  for (let id = 0; id <= CONTRIBUTOR_ID_MAX; id++) {
    if (!roster.some((row) => row.id === id)) return id;
  }
  return null;
}

function holding(record: ContributorRecordV2, inventory: Inventory | undefined): Contributor {
  return inventory && inventory.rebrickable.length + inventory.ldraw.length > 0
    ? { ...record, inventory }
    : record;
}

@injectable()
export class ContributorService implements IContributorService {
  private readonly listeners = new Set<() => void>();
  private readonly editListeners = new Set<(change: RosterChange) => void>();
  private readonly removalGuards = new Set<ContributorRemovalGuard>();
  private current: Roster = [];
  private colouring = false;
  private budget: { readonly roster: Roster; readonly inventory: Inventory } | null = null;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onEdit(listener: (change: RosterChange) => void): () => void {
    this.editListeners.add(listener);
    return () => this.editListeners.delete(listener);
  }

  roster(): Roster {
    return this.current;
  }

  coloured(): boolean {
    return this.colouring;
  }

  setColoured(coloured: boolean): void {
    if (coloured === this.colouring) return;
    this.colouring = coloured;
    this.changed();
  }

  create(name: string): Decoded<number> {
    const id = freeId(this.current);
    if (id === null) {
      return {
        ok: false,
        issues: [{ path: "contributors", message: `already use every id 0-${CONTRIBUTOR_ID_MAX}` }],
      };
    }
    const color = hueColor((id * GOLDEN_ANGLE_DEGREES) % FULL_TURN_DEGREES);
    const record = decode(
      ContributorRecordV2,
      { id, name: name.trim(), color },
      contributorPath(id),
    );
    if (!record.ok) return record;
    this.edit("add", id, [...this.current, record.value]);
    return { ok: true, value: id };
  }

  rename(id: number, name: string): ReadonlyArray<Issue> {
    return this.patch("rename", id, { name: name.trim() });
  }

  recolour(id: number, color: string): ReadonlyArray<Issue> {
    return this.patch("recolour", id, { color: color.toLowerCase() });
  }

  remove(id: number): ReadonlyArray<Issue> {
    if (!this.current.some((row) => row.id === id)) return [unlisted(id)];
    for (const guard of this.removalGuards) {
      const refusal = guard(id);
      if (refusal !== null) return [{ path: contributorPath(id), message: refusal }];
    }
    this.edit(
      "remove",
      id,
      this.current.filter((row) => row.id !== id),
    );
    return [];
  }

  async importCollection(id: number, file: TextFile): Promise<OwnedPartsRead> {
    const read = readOwnedPartsCsv(file.name, await file.text());
    if (!read.ok) return read;
    const issues = this.stock(id, (inventory) => ({
      rebrickable: canonicalLines(read.owned.parts),
      ldraw: inventory.ldraw,
    }));
    return issues.length === 0 ? read : { ok: false, problem: issueText(issues) };
  }

  countParts(id: number, lines: ReadonlyArray<BomLine>): ReadonlyArray<Issue> {
    const ldraw = lines.flatMap((line) =>
      isCustomPartId(line.part)
        ? []
        : [{ part: line.part, color: line.ldrawColor, quantity: line.quantity }],
    );
    return this.stock(id, (inventory) => sumInventories([inventory, { rebrickable: [], ldraw }]));
  }

  setCount(id: number, part: string, color: number, quantity: number): ReadonlyArray<Issue> {
    return this.stock(id, (inventory) => ({
      rebrickable: inventory.rebrickable,
      ldraw: canonicalLines([
        ...inventory.ldraw.filter((line) => line.part !== part || line.color !== color),
        { part, color, quantity },
      ]),
    }));
  }

  clearInventory(id: number): ReadonlyArray<Issue> {
    return this.stock(id, () => NO_INVENTORY);
  }

  eventBudget(): Inventory {
    if (this.budget?.roster !== this.current) {
      const inventories = this.current.flatMap((row) => (row.inventory ? [row.inventory] : []));
      this.budget = { roster: this.current, inventory: sumInventories(inventories) };
    }
    return this.budget.inventory;
  }

  guardRemoval(guard: ContributorRemovalGuard): () => void {
    this.removalGuards.add(guard);
    return () => this.removalGuards.delete(guard);
  }

  restore(roster: Roster): void {
    if (roster === this.current) return;
    this.current = roster;
    this.changed();
  }

  private patch(
    action: RosterAction,
    id: number,
    patch: Partial<Pick<ContributorRecordV2, "name" | "color">>,
  ): ReadonlyArray<Issue> {
    const row = this.current.find((candidate) => candidate.id === id);
    if (!row) return [unlisted(id)];
    const { inventory, ...record } = row;
    const decoded = decode(ContributorRecordV2, { ...record, ...patch }, contributorPath(id));
    if (!decoded.ok) return decoded.issues;
    const changed = decoded.value;
    if (changed.name === row.name && changed.color === row.color) return [];
    this.edit(
      action,
      id,
      this.current.map((candidate) =>
        candidate === row ? holding(changed, inventory) : candidate,
      ),
    );
    return [];
  }

  private stock(id: number, change: (inventory: Inventory) => Inventory): ReadonlyArray<Issue> {
    const row = this.current.find((candidate) => candidate.id === id);
    if (!row) return [unlisted(id)];
    const { inventory: before = NO_INVENTORY, ...record } = row;
    const after = change(before);
    if (canonicalJson(after) === canonicalJson(before)) return [];
    if (after.rebrickable.length + after.ldraw.length > 0) {
      const checked = decode(
        InventoryV2,
        inventoryFile(id, after),
        `inventory of ${contributorPath(id)}`,
      );
      if (!checked.ok) return checked.issues;
    }
    this.edit(
      "inventory",
      id,
      this.current.map((candidate) => (candidate === row ? holding(record, after) : candidate)),
    );
    return [];
  }

  private edit(action: RosterAction, contributor: number, after: Roster): void {
    const before = this.current;
    this.current = after;
    this.changed();
    const change: RosterChange = { action, contributor, before, after };
    for (const listener of this.editListeners) listener(change);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
