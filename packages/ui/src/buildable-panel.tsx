import type {
  BuildableReport,
  BuildableSnapshot,
  IBuildableService,
  IPlanService,
  ModuleProfileId,
  PlanBomEntry,
  PlanIssue,
  PlanSnapshot,
} from "@brr/client";
import { useSyncExternalStore } from "react";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const PROFILE_LABELS: Readonly<Record<ModuleProfileId, string>> = {
  free: "Free (no module standard)",
  "lego-modular": "LEGO modular buildings",
  mils: "MILS",
};

const VERDICT_LABELS: Readonly<Record<BuildableReport["verdict"], string>> = {
  buildable: "Buildable as planned",
  draft: "Not buildable as planned",
  empty: "Nothing placed in this plan",
};

function countText(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function useBuildable(service: IBuildableService): BuildableSnapshot {
  return useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.snapshot(),
  );
}

function usePlans(service: IPlanService): PlanSnapshot {
  return useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.snapshot(),
  );
}

function isProfile(
  value: string,
  profiles: ReadonlyArray<ModuleProfileId>,
): value is ModuleProfileId {
  return profiles.some((profile) => profile === value);
}

function IssueList({ issues }: { readonly issues: ReadonlyArray<PlanIssue> }) {
  if (issues.length === 0) return null;
  return (
    <ol className="buildable-issues">
      {issues.map((issue, i) => (
        <li key={i} data-rule={issue.rule} data-severity={issue.severity}>
          <span className="issue-rule">{issue.rule}</span> {issue.message}
        </li>
      ))}
    </ol>
  );
}

function mapped(line: PlanBomEntry): boolean {
  return [line.bricklink, line.rebrickable].every(
    (ids) => ids.part !== null && (line.ldrawColor === null || ids.color !== null),
  );
}

function rowClass(line: PlanBomEntry): string | undefined {
  if (!mapped(line)) return "unmapped";
  return line.substructure > 0 ? "substructure" : undefined;
}

function colorLabel(line: PlanBomEntry, colorNames: Readonly<Record<number, string>>): string {
  if (line.ldrawColor === null) return "any colour";
  return colorNames[line.ldrawColor] ?? `colour ${line.ldrawColor}`;
}

function BomTable({
  report,
  colorNames,
}: {
  readonly report: BuildableReport;
  readonly colorNames: Readonly<Record<number, string>>;
}) {
  const { bom } = report;
  const substructure = bom.lines.reduce((sum, line) => sum + line.substructure, 0);
  return (
    <details className="buildable-bom" data-total={bom.totalParts} data-lines={bom.lines.length}>
      <summary>
        Parts list: {integer.format(bom.totalParts)} parts in {integer.format(bom.lines.length)}{" "}
        lines
        {substructure > 0 ? `, ${integer.format(substructure)} of them module substructure` : ""}
      </summary>
      <table>
        <thead>
          <tr>
            <th>LDraw</th>
            <th>BrickLink</th>
            <th>Colour</th>
            <th>Qty</th>
          </tr>
        </thead>
        <tbody>
          {bom.lines.map((line) => (
            <tr key={`${line.part} ${line.ldrawColor ?? "any"}`} className={rowClass(line)}>
              <td>{line.part.replace("ldraw:", "")}</td>
              <td>{line.bricklink.part ?? "none"}</td>
              <td>{colorLabel(line, colorNames)}</td>
              <td>{integer.format(line.quantity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

interface BuildablePanelProps {
  readonly plans: IPlanService;
  readonly buildable: IBuildableService;
}

export function BuildablePanel({ plans, buildable }: BuildablePanelProps) {
  const planState = usePlans(plans);
  const state = useBuildable(buildable);
  const planId = planState.activePlanId;
  const region = planState.plans.find((plan) => plan.id === planId);
  const report = state.reports.find((r) => r.regionId === planId);
  if (!region || !report || !planId) return null;
  const settings = state.settings[planId];
  return (
    <section
      className="buildable"
      aria-label="Buildable as planned"
      data-verdict={report.verdict}
      data-errors={report.errors}
      data-warnings={report.warnings}
      data-profile={report.profile}
    >
      <h2>{region.name}</h2>
      <p className={`buildable-verdict ${report.verdict}`}>
        {VERDICT_LABELS[report.verdict]}
        {report.verdict === "draft" ? ` — ${countText(report.errors, "error")}` : ""}
        {report.verdict === "draft" && report.warnings > 0
          ? `, ${countText(report.warnings, "warning")}`
          : ""}
      </p>
      <label className="buildable-field">
        Module standard
        <select
          value={report.profile}
          onChange={(event) => {
            const value = event.target.value;
            if (isProfile(value, state.profiles)) buildable.setProfile(planId, value);
          }}
        >
          {state.profiles.map((profile) => (
            <option key={profile} value={profile}>
              {PROFILE_LABELS[profile]}
            </option>
          ))}
        </select>
      </label>
      <label className="buildable-field">
        Reach from a free table edge (mm)
        <input
          type="number"
          min={0}
          step={10}
          value={settings?.maxReachMm ?? 0}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isInteger(value) && value >= 0) buildable.setMaxReach(planId, value);
          }}
        />
      </label>
      <IssueList issues={report.issues} />
      <BomTable report={report} colorNames={state.colorNames} />
    </section>
  );
}

export function BuildableState({ buildable }: { readonly buildable: IBuildableService }) {
  const state = useBuildable(buildable);
  return <pre id="buildable-state">{JSON.stringify(state.reports)}</pre>;
}
