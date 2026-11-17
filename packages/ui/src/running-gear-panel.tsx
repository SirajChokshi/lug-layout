import type { GearBox, GearSnapshot, GearView, IRunningGear, RunningGearSource } from "@brr/client";
import { useSyncExternalStore, type ReactNode } from "react";

const GROUP_FILLS = ["#f2a541", "#4a90d9", "#5cb85c", "#b06ab3"];
const BODY_FILL = "#c9ced6";
const MARGIN_LDU = 24;
const MARKER_LDU = 6;
const SHA_PREFIX = 10;
const SPEC_DIGITS = 2;

function fillOf(box: GearBox): string {
  return box.bogie === null
    ? BODY_FILL
    : (GROUP_FILLS[box.bogie % GROUP_FILLS.length] ?? BODY_FILL);
}

function nextGroup(box: GearBox, bogies: number): number | null {
  if (box.bogie === null) return bogies > 0 ? 0 : null;
  return box.bogie + 1 < bogies ? box.bogie + 1 : null;
}

function byAreaDescending(view: GearView, area: (b: GearBox) => number): ReadonlyArray<GearBox> {
  return view.boxes.toSorted((a, b) => area(b) - area(a));
}

function PlanView({ gear, view }: { readonly gear: IRunningGear; readonly view: GearView }) {
  const finite = view.boxes.filter((b) => Number.isFinite(b.minX));
  const minX = Math.min(...finite.map((b) => b.minX)) - MARGIN_LDU;
  const maxX = Math.max(...finite.map((b) => b.maxX)) + MARGIN_LDU;
  const minZ = Math.min(...finite.map((b) => b.minZ)) - MARGIN_LDU;
  const maxZ = Math.max(...finite.map((b) => b.maxZ)) + MARGIN_LDU;
  const bogies = view.pivots.length;
  return (
    <svg
      className="gear-view"
      viewBox={`${minX} ${minZ} ${maxX - minX} ${maxZ - minZ}`}
      aria-label="Plan view of the running gear"
    >
      {byAreaDescending(view, (b) => (b.maxX - b.minX) * (b.maxZ - b.minZ)).map((box) => (
        <rect
          key={box.instance}
          data-instance={box.instance}
          x={box.minX}
          y={box.minZ}
          width={box.maxX - box.minX}
          height={box.maxZ - box.minZ}
          fill={fillOf(box)}
          fillOpacity={0.55}
          stroke={box.coupler ? "#c0392b" : box.wheelset ? "#1b2a34" : "#55606e"}
          strokeWidth={box.coupler || box.wheelset ? 1.5 : 0.4}
          onClick={() => gear.assignPart(box.instance, nextGroup(box, bogies))}
        >
          <title>{`part ${box.instance}: ${box.bogie === null ? "body" : `bogie ${box.bogie + 1}`}${box.wheelset ? ", wheelset" : ""}${box.coupler ? ", coupler" : ""} (click to move)`}</title>
        </rect>
      ))}
      {view.axles.map((axle, a) => (
        <line
          key={`axle-${a}`}
          x1={axle[0]}
          x2={axle[0]}
          y1={axle[2] - 60}
          y2={axle[2] + 60}
          stroke="#1b2a34"
          strokeWidth={2}
          strokeDasharray="4 3"
        />
      ))}
      {view.pivots.map((pivot, p) => (
        <g key={`pivot-${p}`} className="gear-pivot">
          <circle
            cx={pivot[0]}
            cy={pivot[2]}
            r={MARKER_LDU * 1.6}
            fill="none"
            stroke="#000"
            strokeWidth={2}
          />
          <line
            x1={pivot[0] - MARKER_LDU * 2}
            x2={pivot[0] + MARKER_LDU * 2}
            y1={pivot[2]}
            y2={pivot[2]}
            stroke="#000"
            strokeWidth={2}
          />
          <line
            x1={pivot[0]}
            x2={pivot[0]}
            y1={pivot[2] - MARKER_LDU * 2}
            y2={pivot[2] + MARKER_LDU * 2}
            stroke="#000"
            strokeWidth={2}
          />
        </g>
      ))}
      {view.couplers.map((coupler) => (
        <line
          key={`coupler-${coupler.instance}`}
          x1={coupler.face[0]}
          x2={coupler.face[0]}
          y1={coupler.face[2] - 12}
          y2={coupler.face[2] + 12}
          stroke="#c0392b"
          strokeWidth={5}
        />
      ))}
    </svg>
  );
}

function SideView({ view }: { readonly view: GearView }) {
  const finite = view.boxes.filter((b) => Number.isFinite(b.minX));
  const minX = Math.min(...finite.map((b) => b.minX)) - MARGIN_LDU;
  const maxX = Math.max(...finite.map((b) => b.maxX)) + MARGIN_LDU;
  const minY = Math.min(...finite.map((b) => b.minY)) - MARGIN_LDU;
  const maxY = Math.max(...finite.map((b) => b.maxY)) + MARGIN_LDU;
  return (
    <svg
      className="gear-view"
      viewBox={`${minX} ${-maxY} ${maxX - minX} ${maxY - minY}`}
      aria-label="Side view of the running gear"
    >
      {byAreaDescending(view, (b) => (b.maxX - b.minX) * (b.maxY - b.minY)).map((box) => (
        <rect
          key={box.instance}
          x={box.minX}
          y={-box.maxY}
          width={box.maxX - box.minX}
          height={box.maxY - box.minY}
          fill={fillOf(box)}
          fillOpacity={0.55}
          stroke={box.coupler ? "#c0392b" : "#55606e"}
          strokeWidth={box.coupler ? 1.5 : 0.4}
        />
      ))}
      {view.axles.map((axle, a) => (
        <circle key={`axle-${a}`} cx={axle[0]} cy={-axle[1]} r={MARKER_LDU} fill="#1b2a34" />
      ))}
      {view.pivots.map((pivot, p) => (
        <line
          key={`pivot-${p}`}
          x1={pivot[0]}
          x2={pivot[0]}
          y1={-pivot[1] - 30}
          y2={-pivot[1] + 30}
          stroke="#000"
          strokeWidth={2}
        />
      ))}
      {view.couplers.map((coupler) => (
        <line
          key={`coupler-${coupler.instance}`}
          x1={coupler.face[0]}
          x2={coupler.face[0]}
          y1={-coupler.face[1] - 12}
          y2={-coupler.face[1] + 12}
          stroke="#c0392b"
          strokeWidth={5}
        />
      ))}
    </svg>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <label className="gear-field">
      {label}
      <input
        type="number"
        step={0.25}
        value={Number(value.toFixed(SPEC_DIGITS))}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
      />
    </label>
  );
}

function specText(spec: GearView["spec"]): string {
  if (!spec) return "invalid";
  return `length ${spec.lengthLdu.toFixed(SPEC_DIGITS)}, guides at ${spec.frontBogieLdu.toFixed(SPEC_DIGITS)} and ${spec.rearBogieLdu.toFixed(SPEC_DIGITS)}`;
}

function Rows({ rows }: { readonly rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl>
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Editor({
  gear,
  snapshot,
  view,
}: {
  readonly gear: IRunningGear;
  readonly snapshot: GearSnapshot;
  readonly view: GearView;
}) {
  const obsolete = [...new Set(view.couplers.flatMap((c) => c.obsoleteSources))];
  const valid = view.spec !== null && view.issues.length === 0;
  return (
    <>
      <Rows
        rows={[
          ["Model sha256", view.sha256.slice(0, SHA_PREFIX)],
          [
            "Running gear",
            view.source === "override"
              ? snapshot.dirty
                ? "override (unsaved)"
                : view.savedOverrideRefused
                  ? "override (saved, refused)"
                  : "override (saved)"
              : "detected from geometry",
          ],
          ["Detected", specText(view.detectedSpec)],
          ["Effective", specText(view.spec)],
        ]}
      />
      <p className="gear-hint">
        Click a part in the plan view to move it between the body and the bogies.
      </p>
      <PlanView gear={gear} view={view} />
      <SideView view={view} />
      {view.pivots.map((pivot, b) => (
        <div key={`bogie-${b}`} className="gear-row">
          <span
            className="gear-swatch"
            style={{ background: GROUP_FILLS[b % GROUP_FILLS.length] }}
          />
          Bogie {b + 1} pivot
          <NumberField label="x" value={pivot[0]} onChange={(x) => gear.setPivot(b, x, pivot[2])} />
          <NumberField label="z" value={pivot[2]} onChange={(z) => gear.setPivot(b, pivot[0], z)} />
          <button type="button" onClick={() => gear.removeBogie(b)}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => gear.addBogie()}>
        Add bogie
      </button>
      {view.couplers.map((coupler) => (
        <div key={`coupler-${coupler.instance}`} className="gear-row">
          Coupling face (part {coupler.instance}
          {coupler.bogie === null ? ", body" : `, bogie ${coupler.bogie + 1}`})
          <NumberField
            label="x"
            value={coupler.face[0]}
            onChange={(x) => gear.setCouplerFace(coupler.instance, x, coupler.face[2])}
          />
          <NumberField
            label="z"
            value={coupler.face[2]}
            onChange={(z) => gear.setCouplerFace(coupler.instance, coupler.face[0], z)}
          />
        </div>
      ))}
      {obsolete.length > 0 && (
        <p className="gear-note">
          The coupling magnets come from parts LDraw marks obsolete: {obsolete.join(", ")}.
        </p>
      )}
      {view.savedOverrideRefused && (
        <p className="error">
          The saved override for this vehicle cannot run, so the run uses the detected gear instead.
        </p>
      )}
      {view.issues.map((issue) => (
        <p key={issue} className="error">
          {issue}
        </p>
      ))}
      <div className="gear-actions">
        <button
          type="button"
          disabled={!snapshot.dirty || !valid || snapshot.busy}
          onClick={() => void gear.save()}
        >
          Save override
        </button>
        <button
          type="button"
          disabled={
            snapshot.busy ||
            snapshot.models.find((m) => m.sha256 === view.sha256)?.sources[view.vehicle] ===
              "detected"
          }
          onClick={() => void gear.reset()}
        >
          Reset this vehicle to detected
        </button>
        <button
          type="button"
          disabled={snapshot.dirty || snapshot.busy}
          onClick={() => window.location.reload()}
        >
          Apply and restart run
        </button>
      </div>
    </>
  );
}

const SOURCE_LABELS: Readonly<Record<RunningGearSource, string>> = {
  detected: "",
  override: " (override)",
  "override refused": " (override refused, running detected gear)",
};

export function RunningGearPanel({ gear }: { readonly gear: IRunningGear }) {
  const snapshot = useSyncExternalStore(
    (listener) => gear.subscribe(listener),
    () => gear.snapshot(),
  );
  const options = snapshot.models.flatMap((model) =>
    Array.from({ length: model.vehicles }, (_, v) => ({
      key: `${model.name}#${v}`,
      model: model.name,
      vehicle: v,
      label: `${model.name}${model.vehicles > 1 ? ` vehicle ${v + 1}` : ""}${SOURCE_LABELS[model.sources[v] ?? "detected"]}`,
    })),
  );
  const selectedKey = snapshot.selected
    ? `${snapshot.selected.model}#${snapshot.selected.vehicle}`
    : "";
  return (
    <aside className="gear-panel" aria-label="Running gear">
      <h2>Running gear</h2>
      <select
        value={selectedKey}
        onChange={(event) => {
          const option = options.find((o) => o.key === event.target.value);
          if (option) gear.select(option.model, option.vehicle);
        }}
      >
        <option value="" disabled>
          Choose a vehicle
        </option>
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
      {snapshot.storeProblem && <p className="error">{snapshot.storeProblem}</p>}
      {snapshot.error && <p className="error">{snapshot.error}</p>}
      {snapshot.view && <Editor gear={gear} snapshot={snapshot} view={snapshot.view} />}
    </aside>
  );
}
