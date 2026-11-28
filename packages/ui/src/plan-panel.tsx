import {
  AISLE_SIDES,
  DEFAULT_TABLE_HEIGHT_MM,
  MM_PER_CM,
  MM_PER_STUD,
  OBSTACLE_KINDS,
  UNCHECKED_PLAN_RULES,
  UNSTATED_OBSTACLE_KIND,
  buildableAsPlanned,
  cmText,
  lduFromMm,
  lowestFreeTableNumber,
  placedTableCounts,
  studsText,
  tableName,
  type HeldItemView,
  type IEditor,
  type IEditorCamera,
  type IPlanService,
  type IPlanSheetService,
  type ISheetSets,
  type MmRect,
  type PlanIssue,
  type PlanRegion,
  type PlanRuleId,
  type PlanTable,
  type TableTop,
  type TableType,
  type TableTypeInput,
  type VenueInput,
  type VenueItems,
  type VenueList,
} from "@brr/client";
import { useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { downloadBlob } from "./download.ts";
import { PrintSheets } from "./print-sheets.tsx";
import { usePlanVersion } from "./use-plan-version.ts";

const DEFAULT_ROOM_MM = { width: 4000, depth: 3000 } as const;
const DEFAULT_TABLE: MmRect = { x: 800, z: 800, width: 2400, depth: 1200 };
const DEFAULT_OBSTACLE: MmRect = { x: 0, z: 0, width: 400, depth: 400 };
const DEFAULT_AISLE: MmRect = { x: 0, z: 0, width: 1200, depth: 1200 };

function CommitInput({
  value,
  name,
  step,
  ariaLabel,
  parse,
  onCommit,
}: {
  readonly value: string;
  readonly name: string;
  readonly step: string;
  readonly ariaLabel?: string;
  readonly parse: (text: string) => number | null;
  readonly onCommit: (parsed: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  const [typing, setTyping] = useState(false);
  if (shown !== value) {
    setShown(value);
    if (!typing) setDraft(value);
  }
  const revert = (): void => {
    setTyping(false);
    setDraft(value);
  };
  const commit = (): void => {
    if (!typing) return;
    const parsed = draft.trim() === "" ? null : parse(draft);
    revert();
    if (parsed !== null && draft !== value) onCommit(parsed);
  };
  return (
    <input
      type="number"
      step={step}
      name={name}
      aria-label={ariaLabel}
      value={draft}
      onChange={(event) => {
        setTyping(true);
        setDraft(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") revert();
      }}
    />
  );
}

function wholeNumber(text: string): number | null {
  const parsed = Number(text);
  return Number.isInteger(parsed) ? parsed : null;
}

function MmField({
  label,
  value,
  onCommit,
  name,
}: {
  readonly label: string;
  readonly value: number;
  readonly onCommit: (mm: number) => void;
  readonly name: string;
}) {
  return (
    <label className="mm-field">
      <span>{label}</span>
      <CommitInput
        value={String(value)}
        name={name}
        step="1"
        parse={wholeNumber}
        onCommit={onCommit}
      />
    </label>
  );
}

function ScaledField({
  label,
  unit,
  text,
  mmPerUnit,
  name,
  onCommit,
}: {
  readonly label: string;
  readonly unit: string;
  readonly text: string;
  readonly mmPerUnit: number;
  readonly name: string;
  readonly onCommit: (mm: number) => void;
}) {
  return (
    <label className="scaled-field">
      <CommitInput
        value={text}
        name={name}
        step="any"
        ariaLabel={`${label} in ${unit}`}
        parse={(typed) => {
          const parsed = Number(typed);
          return Number.isFinite(parsed) ? Math.round(parsed * mmPerUnit) : null;
        }}
        onCommit={onCommit}
      />
      <span className="scaled-unit">{unit}</span>
    </label>
  );
}

function StudCmFields({
  label,
  name,
  mm,
  onCommit,
}: {
  readonly label: string;
  readonly name: string;
  readonly mm: number;
  readonly onCommit: (mm: number) => void;
}) {
  const ldu = lduFromMm(mm);
  return (
    <div className="stud-cm" data-field={name}>
      <span className="stud-cm-label">{label}</span>
      <ScaledField
        label={label}
        unit="studs"
        text={studsText(ldu)}
        name={`${name}-studs`}
        mmPerUnit={MM_PER_STUD}
        onCommit={onCommit}
      />
      <ScaledField
        label={label}
        unit="cm"
        text={cmText(ldu)}
        name={`${name}-cm`}
        mmPerUnit={MM_PER_CM}
        onCommit={onCommit}
      />
    </div>
  );
}

function positive(mm: number): boolean {
  return mm > 0;
}

function TableFields({
  table,
  typed,
  onChange,
}: {
  readonly table: PlanTable;
  readonly typed: boolean;
  readonly onChange: (patch: Partial<Pick<PlanTable, "rect" | "heightMm">>) => void;
}) {
  const { rect } = table;
  return (
    <div className="table-fields">
      <fieldset className="plan-edits" disabled={typed}>
        <StudCmFields
          label="Width"
          name={`${table.id}-width`}
          mm={rect.width}
          onCommit={(width) => positive(width) && onChange({ rect: { ...rect, width } })}
        />
        <StudCmFields
          label="Depth"
          name={`${table.id}-depth`}
          mm={rect.depth}
          onCommit={(depth) => positive(depth) && onChange({ rect: { ...rect, depth } })}
        />
      </fieldset>
      <StudCmFields
        label="From left wall"
        name={`${table.id}-x`}
        mm={rect.x}
        onCommit={(x) => onChange({ rect: { ...rect, x } })}
      />
      <StudCmFields
        label="From back wall"
        name={`${table.id}-z`}
        mm={rect.z}
        onCommit={(z) => onChange({ rect: { ...rect, z } })}
      />
      <fieldset className="plan-edits" disabled={typed}>
        <div className="stud-cm">
          <span className="stud-cm-label">Height</span>
          <ScaledField
            label="Height"
            unit="cm"
            text={cmText(lduFromMm(table.heightMm))}
            name={`${table.id}-height`}
            mmPerUnit={MM_PER_CM}
            onCommit={(heightMm) => positive(heightMm) && onChange({ heightMm })}
          />
        </div>
      </fieldset>
    </div>
  );
}

function DrawTablesButton({
  editor,
  drawing,
  label,
}: {
  readonly editor: IEditor;
  readonly drawing: boolean;
  readonly label: string;
}) {
  return (
    <button
      type="button"
      data-action="draw-table"
      aria-pressed={drawing}
      onClick={() => editor.setTableTool(!drawing)}
    >
      {drawing ? "Done drawing tables (B)" : label}
    </button>
  );
}

function RectFields({
  prefix,
  rect,
  onChange,
}: {
  readonly prefix: string;
  readonly rect: MmRect;
  readonly onChange: (rect: MmRect) => void;
}) {
  return (
    <>
      <MmField
        name={`${prefix}-x`}
        label="x mm"
        value={rect.x}
        onCommit={(x) => onChange({ ...rect, x })}
      />
      <MmField
        name={`${prefix}-z`}
        label="z mm"
        value={rect.z}
        onCommit={(z) => onChange({ ...rect, z })}
      />
      <MmField
        name={`${prefix}-width`}
        label="width mm"
        value={rect.width}
        onCommit={(width) => onChange({ ...rect, width })}
      />
      <MmField
        name={`${prefix}-depth`}
        label="depth mm"
        value={rect.depth}
        onCommit={(depth) => onChange({ ...rect, depth })}
      />
    </>
  );
}

interface IssueTally {
  readonly errors: number;
  readonly warnings: number;
}

function tallyOf(issues: ReadonlyArray<PlanIssue>): IssueTally {
  let warnings = 0;
  for (const issue of issues) if (issue.severity === "warning") warnings++;
  return { errors: issues.length - warnings, warnings };
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function tallyText({ errors, warnings }: IssueTally): string {
  if (warnings === 0) return errors === 0 ? "ok" : counted(errors, "error", "errors");
  const warned = counted(warnings, "warning", "warnings");
  return errors === 0 ? warned : `${counted(errors, "error", "errors")}, ${warned}`;
}

function tallyClass({ errors, warnings }: IssueTally): string {
  if (errors > 0) return "plan-errors";
  return warnings > 0 ? "plan-warnings" : "plan-ok";
}

function planGlance(active: PlanRegion | null, plans: IPlanService): string {
  if (!active) return "No plan yet";
  return `${active.name} · ${verdictText(plans, active.id, tallyOf(plans.issues(active.id)))}`;
}

function NewPlanForm({
  camera,
  plans,
}: {
  readonly camera: IEditorCamera;
  readonly plans: IPlanService;
}) {
  const [width, setWidth] = useState<number>(DEFAULT_ROOM_MM.width);
  const [depth, setDepth] = useState<number>(DEFAULT_ROOM_MM.depth);
  return (
    <div className="plan-new">
      <MmField name="room-width" label="Room width mm" value={width} onCommit={setWidth} />
      <MmField name="room-depth" label="Room depth mm" value={depth} onCommit={setDepth} />
      <button
        type="button"
        data-action="new-plan"
        onClick={() => {
          const origin = camera.targetChunk();
          const id = plans.createPlan({
            name: `Plan ${plans.plans().length + 1}`,
            roomWidthMm: width,
            roomDepthMm: depth,
            originChunkX: origin.chunkX,
            originChunkZ: origin.chunkZ,
          });
          camera.viewPlan(id);
        }}
      >
        New plan here
      </button>
    </div>
  );
}

function latticeText(tables: ReadonlyArray<TableTop>, tableId: string): string {
  const top = tables.find((t) => t.id === tableId);
  if (!top) return "";
  return `${top.studs.studsWide} × ${top.studs.studsDeep} studs (${top.studs.studsWide * MM_PER_STUD} × ${top.studs.studsDeep * MM_PER_STUD} mm on the lattice)`;
}

function fillTablesText(held: HeldItemView | null, fillGridStuds: number): string {
  if (held === null) return "Pick a part to fill the tables with";
  if (held.tables === "loading") return "Loading the part in hand…";
  return `Fill the tables with the part in hand, on the ${fillGridStuds}-stud grid`;
}

function FillTablesButton({
  editor,
  held,
  fillGridStuds,
  tables,
}: {
  readonly editor: IEditor;
  readonly held: HeldItemView | null;
  readonly fillGridStuds: number;
  readonly tables: number;
}) {
  const ready = held?.tables === "ready";
  return (
    <button
      type="button"
      data-action="fill-tables"
      disabled={!ready || tables === 0}
      onClick={(event) => editor.fillTables(event.timeStamp)}
    >
      {fillTablesText(held, fillGridStuds)}
    </button>
  );
}

function TablesEditor({
  editor,
  drawing,
  held,
  fillGridStuds,
  plan,
  tops,
  plans,
}: {
  readonly editor: IEditor;
  readonly drawing: boolean;
  readonly held: HeldItemView | null;
  readonly fillGridStuds: number;
  readonly plan: PlanRegion;
  readonly tops: ReadonlyArray<TableTop>;
  readonly plans: IPlanService;
}) {
  return (
    <section className="plan-section">
      <h3>Tables</h3>
      <p className="plan-meta">
        Draw a table on the canvas, or drag its edges and corners to resize it. Drawn edges land on
        the 8-stud grid; type any size in studs or cm below. Library tables keep their type&apos;s
        size.
      </p>
      <DrawTablesButton editor={editor} drawing={drawing} label="Draw tables (B)" />
      <FillTablesButton
        editor={editor}
        held={held}
        fillGridStuds={fillGridStuds}
        tables={plan.footprint.tables.length}
      />
      {plan.footprint.tables.map((table) => {
        const type = plans.tableTypes().find((t) => t.id === table.typeId);
        return (
          <div className="plan-item" key={table.id} data-table={table.id}>
            <div className="plan-item-head">
              <strong data-table-number={table.number}>
                {type && <span className="table-swatch" style={{ background: type.color }} />}
                {table.number} · {table.name}
              </strong>
              <button
                type="button"
                data-action="turn-table"
                title="Turn 90° about its back-left corner"
                onClick={() => plans.turnTable(plan.id, table.id)}
              >
                Turn
              </button>
              <button type="button" onClick={() => plans.removeTable(plan.id, table.id)}>
                Remove
              </button>
            </div>
            <TableFields
              table={table}
              typed={type !== undefined}
              onChange={(patch) => plans.updateTable(plan.id, table.id, patch)}
            />
            <p className="plan-meta" data-table-studs={table.id}>
              {latticeText(tops, table.id)}
            </p>
          </div>
        );
      })}
      <button
        type="button"
        data-action="add-table"
        onClick={() =>
          plans.addTable(plan.id, {
            name: tableName(lowestFreeTableNumber(plan.footprint.tables)),
            rect: DEFAULT_TABLE,
            heightMm: plan.footprint.tables[0]?.heightMm ?? DEFAULT_TABLE_HEIGHT_MM,
          })
        }
      >
        Add table
      </button>
    </section>
  );
}

const TABLE_TYPE_FIELDS = [
  ["name", "Name", "text", ""],
  ["widthMm", "Width mm", "number", ""],
  ["depthMm", "Depth mm", "number", ""],
  ["heightMm", "Height mm", "number", String(DEFAULT_TABLE_HEIGHT_MM)],
  ["owned", "Owned", "number", "1"],
  ["color", "Colour", "color", "#b58b5a"],
] as const;

function issuesText(issues: ReadonlyArray<{ readonly path: string; readonly message: string }>) {
  return issues
    .map((issue) => {
      const key = issue.path.split(".").at(-1);
      const label = TABLE_TYPE_FIELDS.find(([field]) => field === key)?.[1] ?? "The library";
      return `${label} ${issue.message}`;
    })
    .join("; ");
}

function newTableType(form: HTMLFormElement): TableTypeInput {
  const data = new FormData(form);
  const text = (key: string): string => String(data.get(`new-table-type-${key}`) ?? "");
  const mm = (key: string): number => (text(key).trim() === "" ? Number.NaN : Number(text(key)));
  return {
    name: text("name"),
    widthMm: mm("widthMm"),
    depthMm: mm("depthMm"),
    heightMm: mm("heightMm"),
    owned: mm("owned"),
    color: text("color"),
  };
}

function placedText(type: TableType, placed: number | null): string {
  if (placed === null) return `${type.owned} owned`;
  const short = placed - type.owned;
  return short > 0
    ? `${placed} placed, ${short} more than the ${type.owned} owned`
    : `${placed} of ${type.owned} owned placed in this plan`;
}

function TableLibrary({
  editor,
  plans,
  planId,
  armedType,
}: {
  readonly editor: IEditor;
  readonly plans: IPlanService;
  readonly planId: string | null;
  readonly armedType: number | null;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const report = (issues: Parameters<typeof issuesText>[0]): void =>
    setProblem(issues.length === 0 ? null : issuesText(issues));
  const region = plans.plans().find((plan) => plan.id === planId);
  const counts = region ? placedTableCounts(region) : null;
  return (
    <section className="plan-section" aria-label="Table library">
      <h3>Table library</h3>
      <p className="plan-meta">
        The tables your club owns. A placed table keeps its type&apos;s size and height, lands with
        its back-left corner on the 8-stud grid and turns in quarter turns (R).
      </p>
      {plans.tableTypes().map((type) => {
        const placed = counts ? (counts.get(type.id) ?? 0) : null;
        const armed = armedType === type.id;
        const field = (key: string): string => `table-type-${type.id}-${key}`;
        const update = (patch: Partial<TableTypeInput>): void =>
          report(plans.updateTableType(type.id, patch));
        return (
          <div className="plan-item" key={type.id} data-table-type={type.id}>
            <div className="plan-item-head">
              <input
                key={type.color}
                type="color"
                name={field("color")}
                aria-label="Table type colour"
                defaultValue={type.color}
                onBlur={(event) =>
                  event.target.value !== type.color && update({ color: event.target.value })
                }
              />
              <input
                key={type.name}
                className="table-type-name"
                name={field("name")}
                aria-label="Table type name"
                defaultValue={type.name}
                onBlur={(event) =>
                  event.target.value !== type.name && update({ name: event.target.value })
                }
              />
              <button
                type="button"
                data-action="place-table-type"
                aria-pressed={armed}
                onClick={() => editor.armTableType(armed ? null : type.id)}
              >
                {armed ? "Placing (Esc)" : "Place"}
              </button>
            </div>
            <div className="plan-grid">
              <MmField
                name={field("widthMm")}
                label="Width mm"
                value={type.widthMm}
                onCommit={(widthMm) => update({ widthMm })}
              />
              <MmField
                name={field("depthMm")}
                label="Depth mm"
                value={type.depthMm}
                onCommit={(depthMm) => update({ depthMm })}
              />
              <MmField
                name={field("heightMm")}
                label="Height mm"
                value={type.heightMm}
                onCommit={(heightMm) => update({ heightMm })}
              />
              <MmField
                name={field("owned")}
                label="Owned"
                value={type.owned}
                onCommit={(owned) => update({ owned })}
              />
            </div>
            <div className="plan-item-head">
              <span
                className={placed !== null && placed > type.owned ? "plan-warnings" : "plan-meta"}
                data-placed={placed ?? 0}
              >
                {placedText(type, placed)}
              </span>
              <button
                type="button"
                title="Its placed tables stay, at their size, as plain tables"
                onClick={() => plans.removeTableType(type.id)}
              >
                Remove
              </button>
            </div>
          </div>
        );
      })}
      <form
        className="table-type-new"
        aria-label="New table type"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const added = plans.addTableType(newTableType(form));
          report(added.ok ? [] : added.issues);
          if (added.ok) form.reset();
        }}
      >
        {TABLE_TYPE_FIELDS.map(([key, label, type, initial]) => (
          <label className="mm-field" key={key}>
            <span>{label}</span>
            <input type={type} name={`new-table-type-${key}`} defaultValue={initial} />
          </label>
        ))}
        <button type="submit" data-action="add-table-type">
          Add table type
        </button>
      </form>
      {problem && (
        <p className="plan-errors" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

function Choice<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
}: {
  readonly name: string;
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<T>;
  readonly onChange: (value: T) => void;
}) {
  return (
    <label className="mm-field">
      <span>{label}</span>
      <select
        name={name}
        value={value}
        onChange={(event) => {
          const picked = options.find((option) => option === event.target.value);
          if (picked !== undefined) onChange(picked);
        }}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

interface VenueChoice<L extends VenueList, T extends string> {
  readonly label: string;
  readonly options: ReadonlyArray<T>;
  readonly of: (item: VenueItems[L]) => T;
  readonly patch: (value: T) => Partial<VenueInput<L>>;
}

function VenueSection<L extends VenueList, T extends string>({
  plan,
  plans,
  list,
  items,
  title,
  hint,
  noun,
  newItem,
  choice,
}: {
  readonly plan: PlanRegion;
  readonly plans: IPlanService;
  readonly list: L;
  readonly items: ReadonlyArray<VenueItems[L]>;
  readonly title: string;
  readonly hint: string;
  readonly noun: string;
  readonly newItem: (name: string) => VenueInput<L>;
  readonly choice?: VenueChoice<L, T>;
}) {
  return (
    <section className="plan-section" aria-label={title}>
      <h3>{title}</h3>
      <p className="plan-meta">{hint}</p>
      {items.map((item) => (
        <div className="plan-item" key={item.id} data-venue={list} data-venue-item={item.id}>
          <div className="plan-item-head">
            <strong>{item.name}</strong>
            <button type="button" onClick={() => plans.removeVenueItem(plan.id, list, item.id)}>
              Remove
            </button>
          </div>
          <div className="plan-grid">
            {choice && (
              <Choice
                name={`${item.id}-${choice.label.toLowerCase()}`}
                label={choice.label}
                value={choice.of(item)}
                options={choice.options}
                onChange={(value) =>
                  plans.updateVenueItem(plan.id, list, item.id, choice.patch(value))
                }
              />
            )}
            <RectFields
              prefix={item.id}
              rect={item.rect}
              onChange={(rect) =>
                plans.updateVenueItem<VenueList>(plan.id, list, item.id, { rect })
              }
            />
          </div>
        </div>
      ))}
      <button
        type="button"
        data-action={`add-${list}`}
        onClick={() => plans.addVenueItem(plan.id, list, newItem(`${noun} ${items.length + 1}`))}
      >
        Add {noun.toLowerCase()}
      </button>
    </section>
  );
}

function VenueEditors({
  plan,
  plans,
}: {
  readonly plan: PlanRegion;
  readonly plans: IPlanService;
}) {
  const { rooms, obstacles, aisles, roomWidthMm, roomDepthMm } = plan.footprint;
  return (
    <>
      <VenueSection
        plan={plan}
        plans={plans}
        list="rooms"
        items={rooms}
        title="Rooms"
        noun="Room"
        hint="The room is the floor these rectangles cover; with none, it's the whole plan. A room past the plan grows the plan."
        newItem={(name) => ({ name, rect: { x: 0, z: 0, width: roomWidthMm, depth: roomDepthMm } })}
      />
      <VenueSection
        plan={plan}
        plans={plans}
        list="obstacles"
        items={obstacles}
        title="Obstacles"
        noun="Obstacle"
        hint="Pillars and doors keep tables and placements off them, and nobody stands where they meet a table or aisle edge. Power points are markers: they block nothing."
        newItem={(name) => ({ name, rect: DEFAULT_OBSTACLE, kind: UNSTATED_OBSTACLE_KIND })}
        choice={{
          label: "Kind",
          options: OBSTACLE_KINDS,
          of: (obstacle) => obstacle.kind,
          patch: (kind) => ({ kind }),
        }}
      />
      <VenueSection
        plan={plan}
        plans={plans}
        list="aisles"
        items={aisles}
        title="Aisles"
        noun="Aisle"
        hint="Crew aisles are where you stand to reach in: once the plan has one, reach is measured from crew aisles alone. Public aisles mark where visitors watch."
        newItem={(name) => ({ name, rect: DEFAULT_AISLE, side: "crew" as const })}
        choice={{
          label: "Side",
          options: AISLE_SIDES,
          of: (aisle) => aisle.side,
          patch: (side) => ({ side }),
        }}
      />
    </>
  );
}

type CheckedRule = Exclude<PlanRuleId, "unchecked">;

const PLAN_CHECKS = {
  footprint: "Rooms, tables, obstacles and aisles are well formed, and tables stay out of aisles",
  crossesRegion: "Placements stay inside the plan",
  fit: "Placements stand on the tables, clear of obstacles",
  unsupported: "Placements are held: on studs or on the table",
  clearance: "Bridges leave room for the tallest train",
  seam: "No placement stands across a table seam",
  reach: "Every part is within reach of a crew aisle, or of a table edge when there's none",
  overlap: "Placements don't overlap",
  roadJoin: "Roads continue into their neighbours",
  bomMapping: "Every part has a Rebrickable and BrickLink id",
  trackOpenEnd: "Every track end joins another",
  trackJoin: "Track ends that meet join exactly",
  trackUnverified: "Every track part's connector poses are verified",
  trackUnidentified: "Every model's track sits on exact track poses",
  trackReversing: "No reversing loop or wye, which would short two-rail powered track",
  trackOffTable: "Track, laid or a model's own, stands on the tables, by its outline",
  trackSeam:
    "No track piece's body, laid or a model's own, spans a table seam; a joint may sit on one",
} satisfies Record<CheckedRule, string>;

function isCheckedRule(rule: string): rule is CheckedRule {
  return rule in PLAN_CHECKS;
}

const CHECKED_RULES: ReadonlyArray<CheckedRule> = Object.keys(PLAN_CHECKS).filter(isCheckedRule);

const NO_ISSUES: ReadonlyArray<PlanIssue> = [];

type IssuesByRule = ReadonlyMap<PlanRuleId, ReadonlyArray<PlanIssue>>;

function failingFirst(byRule: IssuesByRule): ReadonlyArray<CheckedRule> {
  const rank = (rule: CheckedRule): number => {
    const { errors, warnings } = tallyOf(byRule.get(rule) ?? NO_ISSUES);
    if (errors > 0) return 0;
    return warnings > 0 ? 1 : 2;
  };
  return CHECKED_RULES.toSorted((a, b) => rank(a) - rank(b));
}

function verdictText(plans: IPlanService, planId: string, tally: IssueTally): string {
  if (buildableAsPlanned(plans, planId)) return "Buildable as planned";
  if (tally.errors + tally.warnings === 0) return "No errors in the checks so far";
  return tallyText(tally);
}

function IssueRows({
  issues,
  onShow,
}: {
  readonly issues: ReadonlyArray<PlanIssue>;
  readonly onShow: (issue: PlanIssue) => void;
}) {
  if (issues.length === 0) return null;
  return (
    <ul className="plan-issues">
      {issues.map((issue, i) => (
        <li key={i} data-rule={issue.rule} data-severity={issue.severity}>
          {issue.placements.length === 0 ? (
            <span className="plan-issue">{issue.message}</span>
          ) : (
            <button
              type="button"
              className="plan-issue"
              title="Select its parts and frame them"
              onClick={() => onShow(issue)}
            >
              {issue.message}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function PlanChecks({
  camera,
  editor,
  plans,
  planId,
}: {
  readonly camera: IEditorCamera;
  readonly editor: IEditor;
  readonly plans: IPlanService;
  readonly planId: string;
}) {
  const issues = plans.issues(planId);
  const tally = tallyOf(issues);
  const unmeasured = plans.unmeasuredCount(planId);
  const customParts = plans.customParts(planId);
  const byRule: IssuesByRule = Map.groupBy(issues, (issue) => issue.rule);
  const show = (issue: PlanIssue): void => {
    editor.selectPlacements(issue.placements);
    const selection = editor.snapshot().selection;
    if (selection) camera.focus(selection.box);
  };
  return (
    <section className="plan-section" aria-label="Plan issues">
      <h3>
        Plan rules:{" "}
        <span
          className={tallyClass(tally)}
          data-plan-errors={tally.errors}
          data-plan-warnings={tally.warnings}
        >
          {verdictText(plans, planId, tally)}
        </span>
      </h3>
      <IssueRows issues={byRule.get("unchecked") ?? NO_ISSUES} onShow={show} />
      <ul className="plan-checks">
        {failingFirst(byRule).map((rule) => {
          const ruleIssues = byRule.get(rule) ?? NO_ISSUES;
          const counts = tallyOf(ruleIssues);
          return (
            <li
              key={rule}
              data-check={rule}
              data-check-errors={counts.errors}
              data-check-warnings={counts.warnings}
            >
              <span className={tallyClass(counts)}>{tallyText(counts)}</span> {PLAN_CHECKS[rule]}
              <IssueRows issues={ruleIssues} onShow={show} />
            </li>
          );
        })}
        <li className="plan-note" data-custom-parts={customParts}>
          {customParts} custom {customParts === 1 ? "part isn't" : "parts aren't"} buyable; that's
          not an error
        </li>
      </ul>
      <p className="plan-meta" data-joined-road-cells={plans.joinedRoadCells(planId)}>
        {plans.joinedRoadCells(planId)} road edge cells join their neighbours.
      </p>
      {unmeasured > 0 && (
        <p className="plan-errors" data-unmeasured={unmeasured}>
          {unmeasured} {unmeasured === 1 ? "placement isn't" : "placements aren't"} fully checked
          yet: their connector records or part mappings are loading or didn't load.
        </p>
      )}
      <details className="plan-unchecked">
        <summary>Not checked yet ({UNCHECKED_PLAN_RULES.length})</summary>
        <ul>
          {UNCHECKED_PLAN_RULES.map((rule) => (
            <li key={rule.id} data-unchecked={rule.id}>
              {rule.text} ({rule.owner})
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function PlanEdits({
  readOnly,
  children,
}: {
  readonly readOnly: boolean;
  readonly children: ReactNode;
}) {
  return (
    <fieldset className="plan-edits" disabled={readOnly}>
      {children}
    </fieldset>
  );
}

function ActivePlan({
  camera,
  editor,
  drawing,
  held,
  fillGridStuds,
  plans,
  sheets,
  sheetSets,
  plan,
  readOnly,
  armedType,
}: {
  readonly camera: IEditorCamera;
  readonly editor: IEditor;
  readonly drawing: boolean;
  readonly held: HeldItemView | null;
  readonly fillGridStuds: number;
  readonly plans: IPlanService;
  readonly sheets: IPlanSheetService;
  readonly sheetSets: ISheetSets;
  readonly plan: PlanRegion;
  readonly readOnly: boolean;
  readonly armedType: number | null;
}) {
  return (
    <>
      <PlanEdits readOnly={readOnly}>
        <div className="plan-grid">
          <MmField
            name="room-width"
            label="Room width mm"
            value={plan.footprint.roomWidthMm}
            onCommit={(roomWidthMm) => plans.updatePlan(plan.id, { roomWidthMm })}
          />
          <MmField
            name="room-depth"
            label="Room depth mm"
            value={plan.footprint.roomDepthMm}
            onCommit={(roomDepthMm) => plans.updatePlan(plan.id, { roomDepthMm })}
          />
          <MmField
            name="max-overhang"
            label="Overhang limit mm"
            value={plan.maxOverhangMm}
            onCommit={(maxOverhangMm) => plans.updatePlan(plan.id, { maxOverhangMm })}
          />
          <MmField
            name="max-reach"
            label="Reach limit mm"
            value={plan.maxReachMm}
            onCommit={(maxReachMm) => plans.updatePlan(plan.id, { maxReachMm })}
          />
        </div>
      </PlanEdits>
      <p className="plan-meta">
        {counted(plans.insideCount(plan.id), "placement", "placements")} in this plan ·{" "}
        {plans.sandboxCount()} in the sandbox
      </p>
      <div className="plan-actions">
        <button type="button" data-action="view-plan" onClick={() => camera.viewPlan(plan.id)}>
          View from above
        </button>
        <button type="button" disabled={readOnly} onClick={() => plans.removePlan(plan.id)}>
          Delete plan
        </button>
      </div>
      <PlanEdits readOnly={readOnly}>
        <TableLibrary editor={editor} plans={plans} planId={plan.id} armedType={armedType} />
        <TablesEditor
          editor={editor}
          drawing={drawing}
          held={held}
          fillGridStuds={fillGridStuds}
          plan={plan}
          tops={plans.regionView(plan.id).tables}
          plans={plans}
        />
        <VenueEditors plan={plan} plans={plans} />
      </PlanEdits>
      <PrintSheets editor={editor} sheets={sheets} sheetSets={sheetSets} plan={plan} />
      <PlanChecks camera={camera} editor={editor} plans={plans} planId={plan.id} />
    </>
  );
}

function PlanFiles({
  editor,
  plan,
  ready,
  readOnly,
}: {
  readonly editor: IEditor;
  readonly plan: PlanRegion | null;
  readonly ready: boolean;
  readonly readOnly: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const onSave = (planId: string): void => {
    void editor.exportPlan(planId).then((file) => {
      if (file) {
        downloadBlob(file.fileName, new Blob([file.bytes.slice()], { type: "application/zip" }));
      }
    });
  };
  const onOpen = (event: ChangeEvent<HTMLInputElement>): void => {
    const field = event.currentTarget;
    const file = field.files?.[0];
    if (!file) return;
    void file
      .arrayBuffer()
      .then((buffer) => editor.openPlan(new Uint8Array(buffer)))
      .finally(() => {
        field.value = "";
      });
  };
  return (
    <div className="plan-actions" aria-label="Plan files">
      {plan && (
        <button
          type="button"
          data-action="save-plan"
          disabled={!ready}
          onClick={() => onSave(plan.id)}
        >
          Save plan file
        </button>
      )}
      <button
        type="button"
        data-action="open-plan"
        disabled={!ready || readOnly}
        onClick={() => input.current?.click()}
      >
        Open plan file
      </button>
      <input
        ref={input}
        className="world-import"
        type="file"
        accept=".zip,application/zip"
        aria-label="Open a .brrplan.zip plan file"
        onChange={onOpen}
      />
    </div>
  );
}

export function PlanPanel({
  camera,
  editor,
  drawing,
  held,
  fillGridStuds,
  plans,
  sheets,
  sheetSets,
  ready,
  readOnly,
  armedType,
}: {
  readonly camera: IEditorCamera;
  readonly editor: IEditor;
  readonly drawing: boolean;
  readonly held: HeldItemView | null;
  readonly fillGridStuds: number;
  readonly plans: IPlanService;
  readonly sheets: IPlanSheetService;
  readonly sheetSets: ISheetSets;
  readonly ready: boolean;
  readonly readOnly: boolean;
  readonly armedType: number | null;
}) {
  usePlanVersion(plans);
  const regions = plans.plans();
  const activePlanId = plans.activePlanId();
  const active = regions.find((p) => p.id === activePlanId) ?? null;
  const [open, setOpen] = useState(false);
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const activeId = active?.id ?? null;
  if (activeId !== openedFor) {
    setOpenedFor(activeId);
    if (activeId !== null) setOpen(true);
  }
  return (
    <details
      className="plan-panel"
      aria-label="Plan"
      data-active-plan={active?.id ?? ""}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary title={open ? "Fold the plan away" : "Plan a real table layout in millimetres"}>
        <h2>Plan (mm, true scale)</h2>
        <span className="plan-glance">{planGlance(active, plans)}</span>
      </summary>
      {regions.length > 1 && (
        <select
          value={activePlanId ?? ""}
          onChange={(event) => plans.activatePlan(event.target.value)}
        >
          {regions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      {active ? (
        <ActivePlan
          camera={camera}
          editor={editor}
          drawing={drawing}
          held={held}
          fillGridStuds={fillGridStuds}
          plans={plans}
          sheets={sheets}
          sheetSets={sheetSets}
          plan={active}
          readOnly={readOnly}
          armedType={armedType}
        />
      ) : (
        <>
          <p className="plan-meta">
            No plan yet. Outside plans the world is a sandbox and plan rules don't apply. Check this
            layout to plan it on one table under everything laid, or draw a table to start a plan
            around it.
          </p>
          <PlanEdits readOnly={readOnly}>
            <button
              type="button"
              data-action="check-layout"
              disabled={!ready || plans.placementCount() === 0}
              onClick={() => editor.checkLayout()}
            >
              Check this layout
            </button>
            <DrawTablesButton editor={editor} drawing={drawing} label="Draw a table (B)" />
            <TableLibrary editor={editor} plans={plans} planId={null} armedType={armedType} />
          </PlanEdits>
        </>
      )}
      <PlanFiles editor={editor} plan={active} ready={ready} readOnly={readOnly} />
      <PlanEdits readOnly={readOnly}>
        <NewPlanForm camera={camera} plans={plans} />
      </PlanEdits>
    </details>
  );
}
