import {
  MM_PER_STUD,
  type IEditorCamera,
  type IPlanService,
  type MmRect,
  type PlanCheck,
  type PlanRegion,
  type PlanSnapshot,
} from "@brr/client";
import { useState, useSyncExternalStore } from "react";

const DEFAULT_ROOM_MM = { width: 4000, depth: 3000 } as const;
const DEFAULT_TABLE: MmRect = { x: 800, z: 800, width: 2400, depth: 1200 };
const DEFAULT_TABLE_HEIGHT_MM = 750;
const DEFAULT_OBSTACLE: MmRect = { x: 0, z: 0, width: 400, depth: 400 };

export function usePlanSnapshot(plans: IPlanService): PlanSnapshot {
  return useSyncExternalStore(
    (listener) => plans.subscribe(listener),
    () => plans.snapshot(),
  );
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
  const [draft, setDraft] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(String(value));
  }
  return (
    <label className="mm-field">
      <span>{label}</span>
      <input
        type="number"
        step={1}
        name={name}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          const parsed = Number(event.target.value);
          if (event.target.value.trim() !== "" && Number.isInteger(parsed)) onCommit(parsed);
        }}
      />
    </label>
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

function planGlance(active: PlanRegion | null, snapshot: PlanSnapshot): string {
  if (!active) return "No plan yet";
  const issues = snapshot.checks.find((c) => c.regionId === active.id)?.issues.length ?? 0;
  const verdict = issues === 0 ? "no errors" : `${issues} ${issues === 1 ? "error" : "errors"}`;
  return `${active.name} · ${verdict}`;
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
  plan,
  check,
  plans,
}: {
  readonly plan: PlanRegion;
  readonly check: PlanCheck | undefined;
  readonly plans: IPlanService;
}) {
  return (
    <section className="plan-section">
      <h3>Tables</h3>
      {plan.footprint.tables.map((table) => (
        <div className="plan-item" key={table.id} data-table={table.id}>
          <div className="plan-item-head">
            <strong>{table.name}</strong>
            <button type="button" onClick={() => plans.removeTable(plan.id, table.id)}>
              Remove
            </button>
          </div>
          <div className="plan-grid">
            <RectFields
              prefix={table.id}
              rect={table.rect}
              onChange={(rect) => plans.updateTable(plan.id, table.id, { rect })}
            />
            <MmField
              name={`${table.id}-height`}
              label="height mm"
              value={table.heightMm}
              onCommit={(heightMm) => plans.updateTable(plan.id, table.id, { heightMm })}
            />
          </div>
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
  plans,
  snapshot,
  plan,
}: {
  readonly camera: IEditorCamera;
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
      <TablesEditor plan={plan} check={check} plans={plans} />
      <ObstaclesEditor plan={plan} plans={plans} />
      <IssueList check={check} />
    </>
  );
}

export function PlanPanel({
  camera,
  plans,
}: {
  readonly camera: IEditorCamera;
  readonly plans: IPlanService;
}) {
  const snapshot = usePlanSnapshot(plans);
  const active = snapshot.plans.find((p) => p.id === snapshot.activePlanId) ?? null;
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
        <span className="plan-glance">{planGlance(active, snapshot)}</span>
      </summary>
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
        <ActivePlan camera={camera} plans={plans} snapshot={snapshot} plan={active} />
      ) : (
        <p className="plan-meta">
          No plan yet. Outside plans the world is a sandbox and plan rules don't apply.
        </p>
      )}
      <NewPlanForm camera={camera} plans={plans} />
    </details>
  );
}
