import type { GearBox, GearModelView, GearView, IRunningGear } from "@brr/client";
import type { ConnectorRef, UnresolvedRunningGearReason } from "@brr/schema/bundle";
import { memo, useState, useSyncExternalStore, type ReactNode } from "react";

const GROUP_FILLS = ["#f2a541", "#4a90d9", "#5cb85c", "#b06ab3"];
const BODY_FILL = "#c9ced6";
const END_STROKE = "#c0392b";
const MARGIN_LDU = 24;
const MARKER_LDU = 6;
const SHA_PREFIX = 10;
const SPEC_DIGITS = 2;

const UNRESOLVED_TEXT: Readonly<Record<UnresolvedRunningGearReason, string>> = {
  fewerThanTwoGuides: "a body rests on fewer than two guides",
  sharedBogie: "one bogie carries more than one body",
  pivotInsideSupportSpan: "a link pivots inside a body's support span",
  wheelsetSpansPivot: "a wheelset spans a pivot",
  supportPlaneUnidentified: "two wheelsets' axle heights can't be compared exactly",
};

function fillOf(box: GearBox): string {
  return box.bogie === null
    ? BODY_FILL
    : (GROUP_FILLS[box.bogie % GROUP_FILLS.length] ?? BODY_FILL);
}

function strokeOf(box: GearBox): string {
  if (box.endCandidate) return END_STROKE;
  return box.wheelset ? "#1b2a34" : "#55606e";
}

function byAreaDescending(view: GearView, area: (b: GearBox) => number): ReadonlyArray<GearBox> {
  return view.boxes.toSorted((a, b) => area(b) - area(a));
}

function boxTitle(box: GearBox): string {
  const role = box.bogie === null ? "body" : `bogie ${box.bogie + 1}`;
  return `part ${box.instance}: ${role}${box.wheelset ? ", wheelset" : ""}${box.endCandidate ? ", end candidate" : ""}`;
}

function PlanView({ view }: { readonly view: GearView }) {
  const finite = view.boxes.filter((b) => Number.isFinite(b.minX));
  const minX = Math.min(...finite.map((b) => b.minX)) - MARGIN_LDU;
  const maxX = Math.max(...finite.map((b) => b.maxX)) + MARGIN_LDU;
  const minZ = Math.min(...finite.map((b) => b.minZ)) - MARGIN_LDU;
  const maxZ = Math.max(...finite.map((b) => b.maxZ)) + MARGIN_LDU;
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
          stroke={strokeOf(box)}
          strokeWidth={box.endCandidate || box.wheelset ? 1.5 : 0.4}
        >
          <title>{boxTitle(box)}</title>
        </rect>
      ))}
      {view.axisLines.map(([near, far], a) => (
        <line
          key={`axis-${a}`}
          x1={near[0]}
          x2={far[0]}
          y1={near[2]}
          y2={far[2]}
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
          stroke={box.endCandidate ? END_STROKE : "#55606e"}
          strokeWidth={box.endCandidate ? 1.5 : 0.4}
        />
      ))}
      {view.axisLines.map(([near, far], a) => (
        <circle
          key={`axis-${a}`}
          cx={(near[0] + far[0]) / 2}
          cy={-(near[1] + far[1]) / 2}
          r={MARKER_LDU}
          fill="#1b2a34"
        />
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
    </svg>
  );
}

function specText(spec: GearView["spec"]): string {
  return `length ${spec.lengthLdu.toFixed(SPEC_DIGITS)}, guides at ${spec.frontBogieLdu.toFixed(SPEC_DIGITS)} and ${spec.rearBogieLdu.toFixed(SPEC_DIGITS)}`;
}

function endsText(ends: ReadonlyArray<ConnectorRef>): string {
  if (ends.length === 0) return "none";
  return ends.map((end) => `part ${end.instance} connector ${end.connector}`).join(", ");
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

function VehicleView({ view }: { readonly view: GearView }) {
  return (
    <div className="gear-vehicle" data-vehicle={view.vehicle}>
      <Rows
        rows={[
          ["Model sha256", view.sha256.slice(0, SHA_PREFIX)],
          ["Consist span", specText(view.spec)],
          ["Front end candidates", endsText(view.frontEndCandidates)],
          ["Rear end candidates", endsText(view.rearEndCandidates)],
        ]}
      />
      <PlanView view={view} />
      <SideView view={view} />
    </div>
  );
}

function UnreadRows({
  model,
  rows,
}: {
  readonly model: GearModelView;
  readonly rows: Uint32Array;
}) {
  const { instance, band, reason } = model.unreadRollingBands;
  return (
    <table className="gear-unread-rows">
      <thead>
        <tr>
          <th>Part</th>
          <th>Band</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        {Array.from(rows, (row) => (
          <tr key={row}>
            <td>{instance[row]}</td>
            <td>{band[row]}</td>
            <td>{reason[row]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UnreadBands({ model }: { readonly model: GearModelView }) {
  const [showAll, setShowAll] = useState(false);
  const { counts, listed, others } = model.unread;
  if (counts.length === 0) return null;
  return (
    <div className="gear-unread" aria-label="Unread rolling bands">
      <p>Rolling bands the detector could not read:</p>
      <ul className="gear-unread-counts">
        {counts.map((count) => (
          <li key={count.reason} data-reason={count.reason}>
            {count.reason}: {count.rows}
          </li>
        ))}
      </ul>
      {listed.length > 0 && <UnreadRows model={model} rows={listed} />}
      {others.length > 0 && (
        <button type="button" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
          {showAll ? "Hide" : "Show all"} {others.length} rows off the running gear
        </button>
      )}
      {showAll && <UnreadRows model={model} rows={others} />}
    </div>
  );
}

function ModelGear({
  gear,
  model,
  selected,
  view,
}: {
  readonly gear: IRunningGear;
  readonly model: GearModelView;
  readonly selected: number | null;
  readonly view: GearView | null;
}) {
  const status = model.playable
    ? `${model.vehicles} ${model.vehicles === 1 ? "vehicle" : "vehicles"}`
    : model.unresolved.length > 0
      ? "placeable, not playable"
      : "no running gear";
  return (
    <section className="gear-model" data-model={model.name} data-playable={model.playable}>
      <h3>
        {model.name} <span className="gear-status">{status}</span>
      </h3>
      {model.unresolved.map((report, r) => (
        <p key={`unresolved-${r}`} className="error" data-reason={report.reason}>
          Unresolved: {UNRESOLVED_TEXT[report.reason]} ({report.instances.length} parts,{" "}
          {report.wheelsets.length} wheelsets, {report.mates.length} mates,{" "}
          {report.unreadRows.length} unread bands)
        </p>
      ))}
      {model.vehicles > 0 && (
        <div className="toolbar">
          {Array.from({ length: model.vehicles }, (_, v) => (
            <button
              key={v}
              type="button"
              aria-pressed={selected === v}
              onClick={() => gear.select(model.name, v)}
            >
              Vehicle {v + 1}
            </button>
          ))}
        </div>
      )}
      {view && <VehicleView view={view} />}
      <UnreadBands model={model} />
    </section>
  );
}

export const RunningGearPanel = memo(function RunningGearPanel({
  gear,
}: {
  readonly gear: IRunningGear;
}) {
  const snapshot = useSyncExternalStore(
    (listener) => gear.subscribe(listener),
    () => gear.snapshot(),
  );
  return (
    <details className="gear-panel">
      <summary>Running gear</summary>
      {snapshot.models.length === 0 && (
        <p className="toolbar-hint">Place a model to see the running gear read from its parts.</p>
      )}
      {snapshot.models.map((model) => {
        const selected = snapshot.selected?.model === model.name ? snapshot.selected.vehicle : null;
        return (
          <ModelGear
            key={model.sha256}
            gear={gear}
            model={model}
            selected={selected}
            view={selected === null ? null : snapshot.view}
          />
        );
      })}
    </details>
  );
});
