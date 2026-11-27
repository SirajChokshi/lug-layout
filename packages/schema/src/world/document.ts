import * as v from "valibot";
import { Count, SafeInteger, nonBlankText, strictMessage } from "./fields.ts";
import { PlanFootprintV1, PlanRecordV1, PlanTableV1 } from "./plan-region.ts";

export const BASE_LAYER_ID = 0;
export const LAYER_ID_MAX = 0xffff;
export const CONTRIBUTOR_ID_MAX = 0xffff;
export const GROUP_ID_MAX = 0xffff_ffff;
export const TABLE_TYPE_ID_MAX = 0xffff;
export const TABLE_NUMBER_MAX = 0xffff;
export const OPACITY_PERCENT_MAX = 100;
export const LABEL_MAX_LENGTH = 200;
export const LONG_TEXT_MAX_LENGTH = 4000;
export const LAYER_KINDS = ["parts", "notes", "plan"] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];

const MONTHS_IN_YEAR = 12;
const FEBRUARY = 2;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const LEAP_EVERY = 4;
const LEAP_SKIP_EVERY = 100;
const LEAP_RESTORE_EVERY = 400;
const ISO_DATE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;

function idUpTo(max: number, what: string) {
  const message = `must be ${what} id 0-${max}`;
  return v.config(v.pipe(SafeInteger, v.minValue(0, message), v.maxValue(max, message)), {
    abortPipeEarly: true,
  });
}

export const LayerId = idUpTo(LAYER_ID_MAX, "a layer");
export const ContributorId = idUpTo(CONTRIBUTOR_ID_MAX, "a contributor");
export const GroupId = idUpTo(GROUP_ID_MAX, "a group");
export const TableTypeId = idUpTo(TABLE_TYPE_ID_MAX, "a table type");

const TableNumber = v.config(
  v.pipe(
    SafeInteger,
    v.minValue(1, `must be a table number 1-${TABLE_NUMBER_MAX}`),
    v.maxValue(TABLE_NUMBER_MAX, `must be a table number 1-${TABLE_NUMBER_MAX}`),
  ),
  { abortPipeEarly: true },
);

const WholeMm = v.config(
  v.pipe(SafeInteger, v.minValue(1, "must be a whole number of mm, at least 1")),
  { abortPipeEarly: true },
);

export const Label = nonBlankText(LABEL_MAX_LENGTH);
export const LongText = nonBlankText(LONG_TEXT_MAX_LENGTH);

export const Rgb = v.pipe(
  v.string(),
  v.regex(/^#[0-9a-f]{6}$/u, "must be a colour #rrggbb in lowercase hex"),
);

const OpacityPercent = v.config(
  v.pipe(
    SafeInteger,
    v.minValue(0, `must be a percentage 0-${OPACITY_PERCENT_MAX}`),
    v.maxValue(OPACITY_PERCENT_MAX, `must be a percentage 0-${OPACITY_PERCENT_MAX}`),
  ),
  { abortPipeEarly: true },
);

function isLeapYear(year: number): boolean {
  return (
    (year % LEAP_EVERY === 0 && year % LEAP_SKIP_EVERY !== 0) || year % LEAP_RESTORE_EVERY === 0
  );
}

function isCalendarDate(text: string): boolean {
  const groups = ISO_DATE.exec(text)?.groups;
  const year = Number(groups?.["year"]);
  const month = Number(groups?.["month"]);
  const day = Number(groups?.["day"]);
  if (month < 1 || month > MONTHS_IN_YEAR) return false;
  const days = (DAYS_IN_MONTH[month - 1] ?? 0) + (month === FEBRUARY && isLeapYear(year) ? 1 : 0);
  return day >= 1 && day <= days;
}

const IsoDate = v.config(
  v.pipe(
    v.string(),
    v.regex(ISO_DATE, "must be a date YYYY-MM-DD"),
    v.check(isCalendarDate, "is not a calendar date"),
  ),
  { abortPipeEarly: true },
);

interface Identified {
  readonly id: number;
}

function uniqueIds(rows: ReadonlyArray<Identified>): boolean {
  return new Set(rows.map((row) => row.id)).size === rows.length;
}

function ascendingIds(rows: ReadonlyArray<Identified>): boolean {
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1];
    const current = rows[i];
    if (previous && current && previous.id >= current.id) return false;
  }
  return true;
}

export const LayerRecordV2 = v.strictObject(
  {
    id: LayerId,
    name: Label,
    kind: v.picklist(LAYER_KINDS, `must be ${LAYER_KINDS.map((kind) => `"${kind}"`).join(", ")}`),
    visible: v.boolean(),
    locked: v.boolean(),
    opacity: OpacityPercent,
  },
  strictMessage,
);
export type LayerRecordV2 = v.InferOutput<typeof LayerRecordV2>;

export const BASE_LAYER: LayerRecordV2 = {
  id: BASE_LAYER_ID,
  name: "Parts",
  kind: "parts",
  visible: true,
  locked: false,
  opacity: OPACITY_PERCENT_MAX,
};

export const LayerTableV2 = v.pipe(
  v.array(LayerRecordV2),
  v.check((layers) => uniqueIds(layers), "must not repeat a layer id"),
  v.check(
    (layers) => layers.some((layer) => layer.id === BASE_LAYER_ID && layer.kind === "parts"),
    `must hold the base layer, id ${BASE_LAYER_ID}, as a parts layer`,
  ),
);

export const GroupRecordV2 = v.strictObject(
  { id: GroupId, name: Label, parent: v.exactOptional(GroupId) },
  strictMessage,
);
export type GroupRecordV2 = v.InferOutput<typeof GroupRecordV2>;

function everyParentListed(groups: ReadonlyArray<GroupRecordV2>): boolean {
  const ids = new Set(groups.map((group) => group.id));
  return groups.every((group) => group.parent === undefined || ids.has(group.parent));
}

function noGroupInsideItself(groups: ReadonlyArray<GroupRecordV2>): boolean {
  const parentOf = new Map(groups.map((group) => [group.id, group.parent]));
  const settled = new Set<number>();
  for (const group of groups) {
    const chain = new Set<number>();
    let id: number | undefined = group.id;
    while (id !== undefined && !settled.has(id)) {
      if (chain.has(id)) return false;
      chain.add(id);
      id = parentOf.get(id);
    }
    for (const visited of chain) settled.add(visited);
  }
  return true;
}

export const GroupTableV2 = v.pipe(
  v.array(GroupRecordV2),
  v.minLength(1, "is empty: leave it out instead"),
  v.check((groups) => ascendingIds(groups), "must list group ids in strictly ascending order"),
  v.check((groups) => everyParentListed(groups), "must list every parent group"),
  v.check((groups) => noGroupInsideItself(groups), "must not nest a group inside itself"),
);

export const ContributorRecordV2 = v.strictObject(
  { id: ContributorId, name: Label, color: Rgb },
  strictMessage,
);
export type ContributorRecordV2 = v.InferOutput<typeof ContributorRecordV2>;

export const ContributorTableV2 = v.pipe(
  v.array(ContributorRecordV2),
  v.minLength(1, "is empty: leave it out instead"),
  v.check((contributors) => uniqueIds(contributors), "must not repeat a contributor id"),
);

export const EventRecordV2 = v.pipe(
  v.strictObject(
    {
      title: v.exactOptional(Label),
      author: v.exactOptional(Label),
      club: v.exactOptional(Label),
      event: v.exactOptional(Label),
      venue: v.exactOptional(Label),
      startDate: v.exactOptional(IsoDate),
      endDate: v.exactOptional(IsoDate),
      comment: v.exactOptional(LongText),
    },
    strictMessage,
  ),
  v.check((event) => Object.keys(event).length > 0, "is empty: leave it out instead"),
  v.forward(
    v.partialCheck(
      [["startDate"], ["endDate"]],
      (event) => event.endDate === undefined || event.startDate !== undefined,
      "needs a start date",
    ),
    ["endDate"],
  ),
  v.forward(
    v.partialCheck(
      [["startDate"], ["endDate"]],
      (event) =>
        event.endDate === undefined ||
        event.startDate === undefined ||
        event.startDate <= event.endDate,
      "comes before the start date",
    ),
    ["endDate"],
  ),
);
export type EventRecordV2 = v.InferOutput<typeof EventRecordV2>;

export const TableTypeRecordV2 = v.strictObject(
  {
    id: TableTypeId,
    name: Label,
    widthMm: WholeMm,
    depthMm: WholeMm,
    heightMm: WholeMm,
    color: Rgb,
    owned: Count,
  },
  strictMessage,
);
export type TableTypeRecordV2 = v.InferOutput<typeof TableTypeRecordV2>;

export const TableTypeTableV2 = v.pipe(
  v.array(TableTypeRecordV2),
  v.minLength(1, "is empty: leave it out instead"),
  v.check((types) => ascendingIds(types), "must list table type ids in strictly ascending order"),
);

export interface TableSize {
  readonly rect: { readonly width: number; readonly depth: number };
  readonly heightMm: number;
}

export interface TableTypeSize {
  readonly widthMm: number;
  readonly depthMm: number;
  readonly heightMm: number;
}

export function tableFitsType(table: TableSize, type: TableTypeSize): boolean {
  const { width, depth } = table.rect;
  const along = width === type.widthMm && depth === type.depthMm;
  const across = width === type.depthMm && depth === type.widthMm;
  return table.heightMm === type.heightMm && (along || across);
}

export const PlanTableV2 = v.strictObject(
  { ...PlanTableV1.entries, number: TableNumber, type: v.exactOptional(TableTypeId) },
  strictMessage,
);
export type PlanTableV2 = v.InferOutput<typeof PlanTableV2>;

function uniqueNumbers(tables: ReadonlyArray<PlanTableV2>): boolean {
  return new Set(tables.map((table) => table.number)).size === tables.length;
}

export const PlanFootprintV2 = v.strictObject(
  {
    ...PlanFootprintV1.entries,
    tables: v.pipe(
      v.array(PlanTableV2),
      v.check((tables) => uniqueNumbers(tables), "must not repeat a table number"),
    ),
  },
  strictMessage,
);

export const PlanRegionRecordV2 = v.strictObject(
  { ...PlanRecordV1.entries, footprint: PlanFootprintV2, layer: LayerId },
  strictMessage,
);
export type PlanRegionRecordV2 = v.InferOutput<typeof PlanRegionRecordV2>;

export const PlanListV2 = v.pipe(
  v.array(PlanRegionRecordV2),
  v.minLength(1, "is empty: leave it out instead"),
);

export const WorldDocumentEntries = {
  layers: LayerTableV2,
  groups: v.exactOptional(GroupTableV2),
  contributors: v.exactOptional(ContributorTableV2),
  plans: v.exactOptional(PlanListV2),
  activePlan: v.exactOptional(Count),
  tableTypes: v.exactOptional(TableTypeTableV2),
  event: v.exactOptional(EventRecordV2),
};

export const WorldDocument = v.strictObject(WorldDocumentEntries, strictMessage);
export type WorldDocument = v.InferOutput<typeof WorldDocument>;

export const DEFAULT_WORLD_DOCUMENT: WorldDocument = { layers: [BASE_LAYER] };

export function worldDocument(source: WorldDocument): WorldDocument {
  return {
    layers: source.layers,
    ...(source.groups ? { groups: source.groups } : {}),
    ...(source.contributors ? { contributors: source.contributors } : {}),
    ...(source.plans ? { plans: source.plans } : {}),
    ...(source.activePlan === undefined ? {} : { activePlan: source.activePlan }),
    ...(source.tableTypes ? { tableTypes: source.tableTypes } : {}),
    ...(source.event ? { event: source.event } : {}),
  };
}

export class WorldDocumentIndex {
  private readonly layers: ReadonlyMap<number, LayerRecordV2>;
  private readonly contributors: ReadonlySet<number>;
  private readonly groups: ReadonlySet<number>;

  constructor(document: Pick<WorldDocument, "layers" | "contributors" | "groups">) {
    this.layers = new Map(document.layers.map((layer) => [layer.id, layer]));
    this.contributors = new Set((document.contributors ?? []).map((contributor) => contributor.id));
    this.groups = new Set((document.groups ?? []).map((group) => group.id));
  }

  layerIssue(id: number, kind: LayerKind): string | null {
    const layer = this.layers.get(id);
    if (!layer) return `names layer ${id}, which the manifest doesn't list`;
    return layer.kind === kind
      ? null
      : `names layer ${id}, a ${layer.kind} layer, not a ${kind} one`;
  }

  ownerIssue(id: number): string | null {
    return this.contributors.has(id)
      ? null
      : `names contributor ${id}, whom the manifest doesn't list`;
  }

  groupIssue(id: number): string | null {
    return this.groups.has(id) ? null : `names group ${id}, which the manifest doesn't list`;
  }
}

export function plansOnPlanLayers(document: Pick<WorldDocument, "layers" | "plans">): boolean {
  const index = new WorldDocumentIndex({ layers: document.layers });
  return (document.plans ?? []).every((plan) => index.layerIssue(plan.layer, "plan") === null);
}

export function activePlanListed(document: Pick<WorldDocument, "plans" | "activePlan">): boolean {
  return document.activePlan === undefined || document.activePlan < (document.plans?.length ?? 0);
}

type TypedTablesDocument = Pick<WorldDocument, "plans" | "tableTypes">;

function everyTypedTable(
  document: TypedTablesDocument,
  test: (table: PlanTableV2, type: TableTypeRecordV2 | undefined) => boolean,
): boolean {
  const types = new Map((document.tableTypes ?? []).map((type) => [type.id, type]));
  return (document.plans ?? []).every((plan) =>
    plan.footprint.tables.every(
      (table) => table.type === undefined || test(table, types.get(table.type)),
    ),
  );
}

export function typedTablesListed(document: TypedTablesDocument): boolean {
  return everyTypedTable(document, (_table, type) => type !== undefined);
}

export function typedTablesFit(document: TypedTablesDocument): boolean {
  return everyTypedTable(document, (table, type) => !type || tableFitsType(table, type));
}
