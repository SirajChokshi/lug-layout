import type {
  BillOfMaterials,
  IBomService,
  IOwnedParts,
  OwnedParts,
  OwnVsBuyReport,
  UnknownOwnedPart,
} from "@brr/client";
import { useEffect, useState } from "react";
import { PartsListDownloads } from "./parts-list-downloads.tsx";
import { useOwnedParts } from "./use-owned-parts.ts";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

interface Comparison {
  readonly bom: BillOfMaterials;
  readonly owned: OwnedParts;
  readonly report: OwnVsBuyReport | null;
  readonly error: string | null;
}

function useComparison(
  service: IBomService,
  bom: BillOfMaterials | null,
  owned: OwnedParts | null,
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

function Report({ report, stem }: { readonly report: OwnVsBuyReport; readonly stem: string }) {
  const needed = report.own + report.buy;
  return (
    <>
      <p>
        You own {integer.format(report.own)} of the {integer.format(needed)} parts in this list;{" "}
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
  bom,
  stem,
}: {
  readonly service: IBomService;
  readonly ownedParts: IOwnedParts;
  readonly bom: BillOfMaterials | null;
  readonly stem: string;
}) {
  const view = useOwnedParts(ownedParts);
  const comparison = useComparison(service, bom, view.owned);
  const report = comparison?.report ?? null;
  return (
    <div
      className="own-vs-buy"
      data-loaded={view.loaded ? "1" : "0"}
      data-owned={view.owned?.total ?? 0}
      data-rejected={view.owned?.rejected.length ?? 0}
      data-own={report?.own ?? ""}
      data-buy={report?.buy ?? ""}
      data-unknown={report?.unknown.length ?? ""}
    >
      <h3>Own vs buy</h3>
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
      {comparison?.error && <p className="error">{comparison.error}</p>}
      {report && <Report report={report} stem={stem} />}
    </div>
  );
}
