import {
  DEFAULT_TABLE_HEIGHT_MM,
  MM_PER_STUD,
  type EditorSnapshot,
  type IEditor,
  type IEditorCamera,
  type IPlanService,
  type MmRect,
  type PlanCheck,
  type PlanRegion,
  type PlanSnapshot,
  type PlanTable,
} from "@brr/client";
import { useState, useSyncExternalStore } from "react";

const DEFAULT_ROOM_MM = { width: 4000, depth: 3000 } as const;
const DEFAULT_TABLE: MmRect = { x: 800, z: 800, width: 2400, depth: 1200 };
const MM_PER_CM = 10;
const DEFAULT_OBSTACLE: MmRect = { x: 0, z: 0, width: 400, depth: 400 };

export function usePlanSnapshot(plans: IPlanService): PlanSnapshot {
  return useSyncExternalStore(
    (listener) => plans.subscribe(listener),
    () => plans.snapshot(),
  );
}

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
  if (shown !== value) {
    setShown(value);
    setDraft(value);
  }
  const commit = (): void => {
    const parsed = draft.trim() === "" ? null : parse(draft);
    setDraft(value);
    if (parsed !== null && draft !== value) onCommit(parsed);
  };
  return (
    <input
      type="number"
      step={step}
      name={name}
      aria-label={ariaLabel}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setDraft(value);
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
  mm,
  mmPerUnit,
  name,
  onCommit,
}: {
  readonly label: string;
  readonly unit: string;
  readonly mm: number;
  readonly mmPerUnit: number;
  readonly name: string;
  readonly onCommit: (mm: number) => void;
}) {
  return (
    <label className="scaled-field">
      <CommitInput
        value={String(Math.round((mm / mmPerUnit) * 100) / 100)}
        name={name}
        step="any"
        ariaLabel={`${label} in ${unit}`}
        parse={(text) => {
          const parsed = Number(text);
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
  return (
    <div className="stud-cm" data-field={name}>
      <span className="stud-cm-label">{label}</span>
      <ScaledField
        label={label}
        unit="studs"
        name={`${name}-studs`}
        mm={mm}
        mmPerUnit={MM_PER_STUD}
        onCommit={onCommit}
      />
      <ScaledField
        label={label}
        unit="cm"
        name={`${name}-cm`}
        mm={mm}
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
  onChange,
}: {
  readonly table: PlanTable;
  readonly onChange: (patch: Partial<Pick<PlanTable, "rect" | "heightMm">>) => void;
}) {
  const { rect } = table;
  return (
    <div className="table-fields">
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
      <div className="stud-cm">
        <span className="stud-cm-label">Height</span>
        <ScaledField
          label="Height"
          unit="cm"
          name={`${table.id}-height`}
          mm={table.heightMm}
          mmPerUnit={MM_PER_CM}
          onCommit={(heightMm) => positive(heightMm) && onChange({ heightMm })}
        />
      </div>
    </div>
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
            name: `Plan ${plans.snapshot().plans.length + 1}`,
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

function studsText(check: PlanCheck | undefined, tableId: string): string {
  const top = check?.tables.find((t) => t.id === tableId);
  if (!top) return "";
  return `${top.studs.studsWide} × ${top.studs.studsDeep} studs (${top.studs.studsWide * MM_PER_STUD} × ${top.studs.studsDeep * MM_PER_STUD} mm on the lattice)`;
}

function TablesEditor({
  editor,
  snapshot,
  plan,
  check,
  plans,
}: {
  readonly editor: IEditor;
  readonly snapshot: EditorSnapshot;
  readonly plan: PlanRegion;
  readonly check: PlanCheck | undefined;
  readonly plans: IPlanService;
}) {
  const drawing = snapshot.mode === "table";
  return (
    <section className="plan-section">
      <h3>Tables</h3>
      <p className="plan-meta">
        Draw a table on the canvas, or drag its edges and corners to resize it. Sizes snap to the
        8-stud grid; type any size in studs or cm below.
      </p>
      <button
        type="button"
        data-action="draw-table"
        aria-pressed={drawing}
        onClick={() => editor.setTableTool(!drawing)}
      >
        {drawing ? "Done drawing tables (B)" : "Draw tables (B)"}
      </button>
      {plan.footprint.tables.map((table) => (
        <div className="plan-item" key={table.id} data-table={table.id}>
          <div className="plan-item-head">
            <strong>{table.name}</strong>
            <button type="button" onClick={() => plans.removeTable(plan.id, table.id)}>
              Remove
            </button>
          </div>
          <TableFields
            table={table}
            onChange={(patch) => plans.updateTable(plan.id, table.id, patch)}
          />
          <p className="plan-meta" data-table-studs={table.id}>
            {studsText(check, table.id)}
          </p>
        </div>
      ))}
      <button
        type="button"
        data-action="add-table"
        onClick={() =>
          plans.addTable(plan.id, {
            name: `Table ${plan.footprint.tables.length + 1}`,
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

function ObstaclesEditor({
  plan,
  plans,
}: {
  readonly plan: PlanRegion;
  readonly plans: IPlanService;
}) {
  return (
    <section className="plan-section">
      <h3>Obstacles</h3>
      {plan.footprint.obstacles.map((obstacle) => (
        <div className="plan-item" key={obstacle.id} data-obstacle={obstacle.id}>
          <div className="plan-item-head">
            <strong>{obstacle.name}</strong>
            <button type="button" onClick={() => plans.removeObstacle(plan.id, obstacle.id)}>
              Remove
            </button>
          </div>
          <div className="plan-grid">
            <RectFields
              prefix={obstacle.id}
              rect={obstacle.rect}
              onChange={(rect) => plans.updateObstacle(plan.id, obstacle.id, { rect })}
            />
          </div>
        </div>
      ))}
      <button
        type="button"
        data-action="add-obstacle"
        onClick={() =>
          plans.addObstacle(plan.id, {
            name: `Obstacle ${plan.footprint.obstacles.length + 1}`,
            rect: DEFAULT_OBSTACLE,
          })
        }
      >
        Add obstacle
      </button>
    </section>
  );
}

function IssueList({ check }: { readonly check: PlanCheck | undefined }) {
  const issues = check?.issues ?? [];
  return (
    <section className="plan-section" aria-label="Plan issues">
      <h3>
        Plan rules:{" "}
        <span
          className={issues.length === 0 ? "plan-ok" : "plan-errors"}
          data-plan-errors={issues.length}
        >
          {issues.length === 0
            ? "no errors"
            : `${issues.length} ${issues.length === 1 ? "error" : "errors"}`}
        </span>
      </h3>
      <p className="plan-meta">
        Checked: footprint, fits the tables, inside the plan. Not checked yet: reach, seams,
        complete BOM, so "Buildable as planned" is not shown.
      </p>
      <ul className="plan-issues">
        {issues.map((issue, i) => (
          <li key={i} data-rule={issue.rule}>
            {issue.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ActivePlan({
  camera,
  editor,
  editorSnapshot,
  plans,
  snapshot,
  plan,
}: {
  readonly camera: IEditorCamera;
  readonly editor: IEditor;
  readonly editorSnapshot: EditorSnapshot;
  readonly plans: IPlanService;
  readonly snapshot: PlanSnapshot;
  readonly plan: PlanRegion;
}) {
  const check = snapshot.checks.find((c) => c.regionId === plan.id);
  return (
    <>
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
      </div>
      <p className="plan-meta">
        Origin chunk {plan.originChunkX}, {plan.originChunkZ} · {check?.inside.length ?? 0}{" "}
        placements in this plan · {snapshot.sandboxPlacements.length} in the sandbox
      </p>
      <div className="plan-actions">
        <button type="button" data-action="view-plan" onClick={() => camera.viewPlan(plan.id)}>
          View from above
        </button>
        <button type="button" onClick={() => plans.removePlan(plan.id)}>
          Delete plan
        </button>
      </div>
      <TablesEditor
        editor={editor}
        snapshot={editorSnapshot}
        plan={plan}
        check={check}
        plans={plans}
      />
      <ObstaclesEditor plan={plan} plans={plans} />
      <IssueList check={check} />
    </>
  );
}

export function PlanPanel({
  camera,
  editor,
  editorSnapshot,
  plans,
}: {
  readonly camera: IEditorCamera;
  readonly editor: IEditor;
  readonly editorSnapshot: EditorSnapshot;
  readonly plans: IPlanService;
}) {
  const snapshot = usePlanSnapshot(plans);
  const active = snapshot.plans.find((p) => p.id === snapshot.activePlanId) ?? null;
  return (
    <section className="plan-panel" aria-label="Plan" data-active-plan={active?.id ?? ""}>
      <h2>Plan (mm, true scale)</h2>
      {snapshot.plans.length > 1 && (
        <select
          value={snapshot.activePlanId ?? ""}
          onChange={(event) => plans.activatePlan(event.target.value)}
        >
          {snapshot.plans.map((p) => (
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
          editorSnapshot={editorSnapshot}
          plans={plans}
          snapshot={snapshot}
          plan={active}
        />
      ) : (
        <>
          <p className="plan-meta">
            No plan yet. Outside plans the world is a sandbox and plan rules don't apply. Draw a
            table to start one around it.
          </p>
          <button
            type="button"
            data-action="draw-table"
            aria-pressed={editorSnapshot.mode === "table"}
            onClick={() => editor.setTableTool(editorSnapshot.mode !== "table")}
          >
            Draw a table (B)
          </button>
        </>
      )}
      <NewPlanForm camera={camera} plans={plans} />
    </section>
  );
}
