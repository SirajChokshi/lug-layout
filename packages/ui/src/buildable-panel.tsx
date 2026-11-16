import type {
  BuildableReport,
  OwnBuy,
  PlanPurchase,
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

interface PlanDownload {
  readonly label: string;
  readonly suffix: string;
  readonly type: string;
  readonly body: (purchase: PlanPurchase) => string;
}

const PLAN_DOWNLOADS: ReadonlyArray<PlanDownload> = [
  {
    label: "BrickLink Wanted List XML",
    suffix: "bricklink.xml",
    type: "application/xml",
    body: (purchase) => purchase.files.brickLinkXml,
  },
  {
    label: "Rebrickable CSV",
    suffix: "rebrickable.csv",
    type: "text/csv",
    body: (purchase) => purchase.files.rebrickableCsv,
  },
  {
    label: "Plain CSV",
    suffix: "parts.csv",
    type: "text/csv",
    body: (purchase) => purchase.files.plainCsv,
  },
];

function fileStem(planName: string, purchase: PlanPurchase): string {
  const stem = planName.trim().replaceAll(/[^A-Za-z0-9-]+/gu, "-");
  return purchase.ownBuy ? `${stem}.to-buy` : stem;
}

function save(planName: string, purchase: PlanPurchase, download: PlanDownload): void {
  const url = URL.createObjectURL(new Blob([download.body(purchase)], { type: download.type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${fileStem(planName, purchase)}.${download.suffix}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function OwnVsBuy({
  buildable,
  state,
  purchase,
  planName,
}: {
  readonly buildable: IBuildableService;
  readonly state: BuildableSnapshot;
  readonly purchase: PlanPurchase | undefined;
  readonly planName: string;
}) {
  const { collection, collectionProblems } = state;
  const ownBuy = purchase?.ownBuy ?? null;
  return (
    <div
      className="own-vs-buy"
      data-collection-parts={collection?.parts ?? 0}
      data-own={ownBuy?.ownParts ?? 0}
      data-buy={ownBuy?.buyParts ?? 0}
    >
      <h3>Own vs buy</h3>
      <label className="buildable-field">
        Parts I own: CSV with Part, Color, Quantity in Rebrickable ids
        <input
          type="file"
          accept=".csv,text/csv"
          data-action="import-collection"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void file.text().then((text) => buildable.importCollection(file.name, text));
          }}
        />
      </label>
      {collection && (
        <p className="own-summary">
          {collection.name}: {integer.format(collection.parts)} parts in{" "}
          {integer.format(collection.lines.length)} lines.{" "}
          {ownBuy
            ? `This plan uses ${integer.format(ownBuy.ownParts)} of them; ${integer.format(ownBuy.buyParts)} parts to buy.`
            : ""}{" "}
          <button type="button" onClick={() => buildable.clearCollection()}>
            Clear
          </button>
        </p>
      )}
      {collectionProblems.length > 0 && (
        <ul className="buildable-issues">
          {collectionProblems.slice(0, 5).map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {purchase && (
        <div className="plan-downloads">
          <span>{ownBuy ? "Shortfall to buy:" : "Whole plan:"}</span>
          {PLAN_DOWNLOADS.map((download) => (
            <button
              key={download.suffix}
              type="button"
              data-download={download.suffix}
              onClick={() => save(planName, purchase, download)}
            >
              {download.label}
            </button>
          ))}
          {purchase.files.anyColourParts + purchase.files.unmappedParts > 0 && (
            <p className="plan-meta">
              Not in the BrickLink and Rebrickable files:{" "}
              {integer.format(purchase.files.anyColourParts)} substructure parts in any colour and{" "}
              {integer.format(purchase.files.unmappedParts)} parts with no catalog id. The plain CSV
              lists them.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function BomTable({
  report,
  colorNames,
  ownBuy,
}: {
  readonly report: BuildableReport;
  readonly colorNames: Readonly<Record<number, string>>;
  readonly ownBuy: OwnBuy | null;
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
            {ownBuy && <th>Own</th>}
            {ownBuy && <th>Buy</th>}
          </tr>
        </thead>
        <tbody>
          {bom.lines.map((line, i) => (
            <tr key={`${line.part} ${line.ldrawColor ?? "any"}`} className={rowClass(line)}>
              <td>{line.part.replace("ldraw:", "")}</td>
              <td>{line.bricklink.part ?? "none"}</td>
              <td>{colorLabel(line, colorNames)}</td>
              <td>{integer.format(line.quantity)}</td>
              {ownBuy && <td>{integer.format(ownBuy.lines[i]?.own ?? 0)}</td>}
              {ownBuy && <td>{integer.format(ownBuy.lines[i]?.buy ?? line.quantity)}</td>}
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
  readonly disclaimer: string;
}

function savePrintablePlan(svg: string, planName: string): void {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${planName.trim().replaceAll(/[^A-Za-z0-9-]+/gu, "-")}.plan.svg`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function BuildablePanel({ plans, buildable, disclaimer }: BuildablePanelProps) {
  const planState = usePlans(plans);
  const state = useBuildable(buildable);
  const planId = planState.activePlanId;
  const region = planState.plans.find((plan) => plan.id === planId);
  const report = state.reports.find((r) => r.regionId === planId);
  if (!region || !report || !planId) return null;
  const settings = state.settings[planId];
  const purchase = state.purchases.find((p) => p.regionId === planId);
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
        {report.verdict === "draft"
          ? ` — ${report.errors} ${report.errors === 1 ? "error" : "errors"}`
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
      <button
        type="button"
        className="printable-plan"
        data-download="plan.svg"
        onClick={() => {
          const svg = buildable.printablePlan(planId, disclaimer);
          if (svg) savePrintablePlan(svg, region.name);
        }}
      >
        Printable plan (SVG)
      </button>
      <IssueList issues={report.issues} />
      <OwnVsBuy buildable={buildable} state={state} purchase={purchase} planName={region.name} />
      <BomTable report={report} colorNames={state.colorNames} ownBuy={purchase?.ownBuy ?? null} />
    </section>
  );
}

export function BuildableState({ buildable }: { readonly buildable: IBuildableService }) {
  const state = useBuildable(buildable);
  return <pre id="buildable-state">{JSON.stringify(state.reports)}</pre>;
}
