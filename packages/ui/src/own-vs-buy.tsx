import {
  inventoryParts,
  type BillOfMaterials,
  type IBomService,
  type IContributorService,
  type Inventory,
  type IOwnedParts,
  type OwnedParts,
  type OwnVsBuyReport,
  type Roster,
  type UnknownOwnedPart,
} from "@brr/client";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { PartsListDownloads } from "./parts-list-downloads.tsx";
import { useOwnedParts } from "./use-owned-parts.ts";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const MINE = "mine";
const EVENT = "event";
const NO_ROSTER: Roster = [];

interface Comparison {
  readonly bom: BillOfMaterials;
  readonly owned: Inventory;
  readonly report: OwnVsBuyReport | null;
  readonly error: string | null;
}

interface Budget {
  readonly key: string;
  readonly inventory: Inventory | null;
  readonly holder: string;
}

function useRoster(contributors: IContributorService | null): Roster {
  const subscribe = useCallback(
    (listener: () => void) => contributors?.subscribe(listener) ?? (() => undefined),
    [contributors],
  );
  return useSyncExternalStore(subscribe, () => contributors?.roster() ?? NO_ROSTER);
}

function budgetOf(
  chosen: string,
  mine: Inventory | null,
  roster: Roster,
  contributors: IContributorService | null,
): Budget {
  if (chosen === EVENT && contributors) {
    return { key: EVENT, inventory: contributors.eventBudget(), holder: "The event budget holds" };
  }
  const contributor = roster.find((row) => String(row.id) === chosen);
  if (contributor) {
    return {
      key: chosen,
      inventory: contributor.inventory ?? null,
      holder: `"${contributor.name}" brings`,
    };
  }
  return { key: MINE, inventory: mine, holder: "You own" };
}

function useComparison(
  service: IBomService,
  bom: BillOfMaterials | null,
  owned: Inventory | null,
): Comparison | null {
  const [comparison, setComparison] = useState<Comparison | null>(null);
  useEffect(() => {
    if (!bom || !owned) return;
    let current = true;
    service.ownVsBuy(bom, owned).then(
      (report) => current && setComparison({ bom, owned, report, error: null }),
      (error: unknown) =>
        current && setComparison({ bom, owned, report: null, error: String(error) }),
    );
    return () => {
      current = false;
    };
  }, [service, bom, owned]);
  return comparison?.bom === bom && comparison.owned === owned ? comparison : null;
}

function missingText(row: UnknownOwnedPart): string {
  switch (row.missing) {
    case "part":
      return "no LDraw part has this Rebrickable part id";
    case "color":
      return "no LDraw colour has this Rebrickable colour id";
    case "part-and-color":
      return "neither id is in the crosswalk";
    default: {
      const unhandled: never = row.missing;
      throw new Error(`unhandled missing mapping ${String(unhandled)}`);
    }
  }
}

function OwnedSummary({
  owned,
  ownedParts,
}: {
  readonly owned: OwnedParts;
  readonly ownedParts: IOwnedParts;
}) {
  return (
    <>
      <p>
        {owned.name}: {integer.format(owned.total)} parts in {integer.format(owned.parts.length)}{" "}
        lines.{" "}
        <button type="button" onClick={() => void ownedParts.clear()}>
          Forget these parts
        </button>
      </p>
      {owned.rejected.length > 0 && (
        <details>
          <summary>Rows not read ({integer.format(owned.rejected.length)})</summary>
          <ul>
            {owned.rejected.map((row) => (
              <li key={row.line}>
                line {row.line}: "{row.text}" is not a part id, a colour id and a whole quantity
                above 0
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function Report({
  report,
  stem,
  holder,
}: {
  readonly report: OwnVsBuyReport;
  readonly stem: string;
  readonly holder: string;
}) {
  const needed = report.own + report.buy;
  return (
    <>
      <p>
        {holder} {integer.format(report.own)} of the {integer.format(needed)} parts in this list;{" "}
        {integer.format(report.buy)} to buy.
        {report.unmatched > 0 &&
          ` ${integer.format(report.unmatched)} of them have no Rebrickable part or colour id, so they count as to buy.`}
        {report.custom > 0 &&
          ` ${integer.format(report.custom)} custom ${report.custom === 1 ? "part isn't" : "parts aren't"} buyable, so own and buy leave ${report.custom === 1 ? "it" : "them"} out.`}
      </p>
      {report.unknown.length > 0 && (
        <details>
          <summary>
            Owned rows not in the catalog's crosswalk ({integer.format(report.unknown.length)})
          </summary>
          <ul>
            {report.unknown.map((row) => (
              <li key={`${row.part} ${row.color}`}>
                {row.quantity}× part {row.part} colour {row.color}: {missingText(row)}
              </li>
            ))}
          </ul>
        </details>
      )}
      <details>
        <summary>Own and buy per line ({integer.format(report.lines.length)})</summary>
        <table className="own-buy-lines">
          <thead>
            <tr>
              <th>LDraw part</th>
              <th>Colour</th>
              <th>Rebrickable</th>
              <th>Need</th>
              <th>Own</th>
              <th>Buy</th>
            </tr>
          </thead>
          <tbody>
            {report.lines.map((line, i) => (
              <tr key={`${i} ${line.part} ${line.ldrawColor}`} data-buy={line.buy}>
                <td>{line.part.replace("ldraw:", "")}</td>
                <td>{line.ldrawColor}</td>
                <td>
                  {line.rebrickable
                    ? `${line.rebrickable.part} / ${line.rebrickable.color}`
                    : "none"}
                </td>
                <td>{integer.format(line.quantity)}</td>
                <td>{integer.format(line.own)}</td>
                <td>{integer.format(line.buy)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      {report.buy > 0 && (
        <PartsListDownloads title="To buy" files={report.shortfall} stem={`${stem}.to-buy`} />
      )}
    </>
  );
}

export function OwnVsBuy({
  service,
  ownedParts,
  contributors,
  bom,
  stem,
}: {
  readonly service: IBomService;
  readonly ownedParts: IOwnedParts;
  readonly contributors: IContributorService | null;
  readonly bom: BillOfMaterials | null;
  readonly stem: string;
}) {
  const view = useOwnedParts(ownedParts);
  const roster = useRoster(contributors);
  const [chosen, setChosen] = useState(MINE);
  const mine = useMemo<Inventory | null>(
    () => (view.owned ? { rebrickable: view.owned.parts, ldraw: [] } : null),
    [view.owned],
  );
  const budget = budgetOf(chosen, mine, roster, contributors);
  const comparison = useComparison(service, bom, budget.inventory);
  const report = comparison?.report ?? null;
  const holders = roster.filter((row) => row.inventory);
  return (
    <div
      className="own-vs-buy"
      data-loaded={view.loaded ? "1" : "0"}
      data-owned={view.owned?.total ?? 0}
      data-rejected={view.owned?.rejected.length ?? 0}
      data-budget={budget.key}
      data-budget-parts={budget.inventory ? inventoryParts(budget.inventory) : 0}
      data-own={report?.own ?? ""}
      data-buy={report?.buy ?? ""}
      data-unknown={report?.unknown.length ?? ""}
    >
      <h3>Own vs buy</h3>
      {contributors && (
        <label>
          Compare with
          <select value={budget.key} onChange={(event) => setChosen(event.currentTarget.value)}>
            <option value={MINE}>Parts I own (this browser)</option>
            <option value={EVENT}>Event budget (every contributor's inventory)</option>
            {holders.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}'s inventory
              </option>
            ))}
          </select>
        </label>
      )}
      {budget.key === MINE ? (
        <>
          <label>
            Parts I own: a CSV with Part, Color and Quantity columns in Rebrickable ids
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => {
                const input = event.currentTarget;
                const file = input.files?.[0];
                if (!file) return;
                void ownedParts.importFile(file);
                input.value = "";
              }}
            />
          </label>
          {view.owned && <OwnedSummary owned={view.owned} ownedParts={ownedParts} />}
          {view.problem && <p className="error">{view.problem}</p>}
        </>
      ) : (
        budget.inventory === null && (
          <p>No inventory yet: import a collection or count parts in the Contributors panel.</p>
        )
      )}
      {comparison?.error && <p className="error">{comparison.error}</p>}
      {report && <Report report={report} stem={stem} holder={budget.holder} />}
    </div>
  );
}
