import type {
  BillOfMaterials,
  BomScope,
  CatalogBom,
  IBomService,
  IBomSource,
  IPaletteThumbnails,
  IPlanService,
  IOwnedParts,
  PlacementRegion,
  PlanRegion,
} from "@brr/client";
import { useState } from "react";
import { useActivePlan } from "./use-plan-version.ts";
import { OwnVsBuy } from "./own-vs-buy.tsx";
import { PartsListDownloads } from "./parts-list-downloads.tsx";
import { ShoppingLines } from "./shopping-list.tsx";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

interface BomPanelProps {
  readonly service: IBomService;
  readonly ownedParts: IOwnedParts;
  readonly source: IBomSource;
  readonly region?: PlacementRegion | null;
  readonly selectionLabel: string | null;
  readonly plans: IPlanService | null;
  readonly thumbnails: IPaletteThumbnails | null;
}

const REGION_FIELDS = ["minX", "minZ", "maxX", "maxZ"] as const;
type RegionField = (typeof REGION_FIELDS)[number];
type RegionDraft = Record<RegionField, string>;

function draftOf(region: PlacementRegion | null): RegionDraft {
  return {
    minX: String(region?.minX ?? 0),
    minZ: String(region?.minZ ?? 0),
    maxX: String(region?.maxX ?? 0),
    maxZ: String(region?.maxZ ?? 0),
  };
}

function regionOf(draft: RegionDraft): PlacementRegion | string {
  const [minX, minZ, maxX, maxZ] = REGION_FIELDS.map((field) => Number(draft[field]));
  if (
    minX === undefined ||
    minZ === undefined ||
    maxX === undefined ||
    maxZ === undefined ||
    ![minX, minZ, maxX, maxZ].every(Number.isInteger) ||
    minX >= maxX ||
    minZ >= maxZ
  ) {
    return "Region bounds must be integer LDU with min < max on both axes";
  }
  return { minX, minZ, maxX, maxZ };
}

function fileStem(bom: BillOfMaterials): string {
  const { scope } = bom;
  switch (scope.kind) {
    case "world":
    case "selection":
    case "plan":
      return bom.name;
    case "region": {
      const { minX, minZ, maxX, maxZ } = scope.region;
      return `${bom.name}.region_${minX}_${minZ}_${maxX}_${maxZ}`;
    }
    default: {
      const unhandled: never = scope;
      throw new Error(`unhandled scope ${String(unhandled)}`);
    }
  }
}

function catalogText(catalog: CatalogBom): string {
  const parts = catalog.lines.reduce((sum, line) => sum + line.quantity, 0);
  const unmapped = catalog.unmapped.reduce((sum, line) => sum + line.quantity, 0);
  const keywordOnly = catalog.lines
    .filter((line) => line.fromKeywordOnly)
    .reduce((sum, line) => sum + line.quantity, 0);
  const keywordText =
    keywordOnly > 0 ? `, ${integer.format(keywordOnly)} with an id from an LDraw keyword only` : "";
  return `${integer.format(parts)} parts in ${integer.format(catalog.lines.length)} lots, ${integer.format(unmapped)} unmapped${keywordText}`;
}

function scopeOf(
  kind: BomScope["kind"],
  draft: RegionDraft,
  plan: PlanRegion | null,
): BomScope | string {
  switch (kind) {
    case "world":
      return { kind: "world" };
    case "selection":
      return { kind: "selection" };
    case "region": {
      const parsed = regionOf(draft);
      return typeof parsed === "string" ? parsed : { kind: "region", region: parsed };
    }
    case "plan":
      return plan ? { kind: "plan", planId: plan.id } : { kind: "world" };
    default: {
      const unhandled: never = kind;
      throw new Error(`unhandled scope ${String(unhandled)}`);
    }
  }
}

function UnmappedLines({ catalog, name }: { readonly catalog: CatalogBom; readonly name: string }) {
  if (catalog.unmapped.length === 0) return null;
  return (
    <details>
      <summary>
        Not in {name}'s crosswalk ({integer.format(catalog.unmapped.length)} lines)
      </summary>
      <ul>
        {catalog.unmapped.map((line) => (
          <li key={`${line.part}-${line.ldrawColor}`}>
            {line.quantity}× {line.part} colour {line.ldrawColor} (no {line.missing} id)
          </li>
        ))}
      </ul>
    </details>
  );
}

export function BomPanel({
  service,
  ownedParts,
  source,
  region,
  selectionLabel,
  plans,
  thumbnails,
}: BomPanelProps) {
  const plan = useActivePlan(plans);
  const offersRegion = region !== undefined;
  const [chosenKind, setScopeKind] = useState<BomScope["kind"]>(region ? "region" : "world");
  const scopeKind = chosenKind === "plan" && !plan ? "world" : chosenKind;
  const [draft, setDraft] = useState<RegionDraft>(() => draftOf(region ?? null));
  const [bom, setBom] = useState<BillOfMaterials | null>(null);
  const [error, setError] = useState<string | null>(null);

  const build = (): void => {
    setError(null);
    const scope = scopeOf(scopeKind, draft, plan);
    if (typeof scope === "string") {
      setError(scope);
      return;
    }
    service.billOfMaterials(source, scope).then(setBom, (e: unknown) => setError(String(e)));
  };

  return (
    <section className="bom" aria-label="Parts list">
      <h2>Parts list</h2>
      <div className="bom-controls">
        <label>
          <input
            type="radio"
            name="bom-scope"
            value="world"
            checked={scopeKind === "world"}
            onChange={() => setScopeKind("world")}
          />
          World
        </label>
        {offersRegion && (
          <label>
            <input
              type="radio"
              name="bom-scope"
              value="region"
              checked={scopeKind === "region"}
              onChange={() => setScopeKind("region")}
            />
            Region (LDU, placement origins)
          </label>
        )}
        {selectionLabel !== null && (
          <label>
            <input
              type="radio"
              name="bom-scope"
              value="selection"
              checked={scopeKind === "selection"}
              onChange={() => setScopeKind("selection")}
            />
            Selection ({selectionLabel})
          </label>
        )}
        {plan !== null && (
          <label>
            <input
              type="radio"
              name="bom-scope"
              value="plan"
              checked={scopeKind === "plan"}
              onChange={() => setScopeKind("plan")}
            />
            Plan ({plan.name})
          </label>
        )}
      </div>
      {scopeKind === "region" && (
        <div className="bom-region">
          {REGION_FIELDS.map((field) => (
            <label key={field}>
              {field}
              <input
                name={field}
                inputMode="numeric"
                value={draft[field]}
                onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
              />
            </label>
          ))}
        </div>
      )}
      <div className="bom-controls">
        <button type="button" onClick={build}>
          Build parts list
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {bom && (
        <>
          {bom.shopping && <ShoppingLines list={bom.shopping} thumbnails={thumbnails} />}
          <dl>
            <div>
              <dt>Placements</dt>
              <dd>{integer.format(bom.placements)}</dd>
            </div>
            <div>
              <dt>Parts (LDraw part × colour lines)</dt>
              <dd>
                {integer.format(bom.parts)} ({integer.format(bom.ldraw.length)})
              </dd>
            </div>
            <div>
              <dt>Rebrickable</dt>
              <dd>{catalogText(bom.rebrickable)}</dd>
            </div>
            <div>
              <dt>BrickLink</dt>
              <dd>{catalogText(bom.bricklink)}</dd>
            </div>
          </dl>
          <PartsListDownloads title="Whole list" files={bom.files} stem={fileStem(bom)} />
          {bom.rebrickable.custom.length > 0 && (
            <details data-kind="customParts" open>
              <summary>
                Custom parts, not buyable ({integer.format(bom.rebrickable.custom.length)} lines)
              </summary>
              <ul>
                {bom.rebrickable.custom.map((line) => (
                  <li key={`${line.part}-${line.ldrawColor}`} data-part={line.part}>
                    <span className="part-badge" data-badge="custom">
                      custom
                    </span>{" "}
                    {line.quantity}× {line.part} colour {line.ldrawColor}: from an imported file,
                    left out of the Rebrickable and BrickLink lists
                  </li>
                ))}
              </ul>
            </details>
          )}
          {bom.rebrickable.thirdParty.length > 0 && (
            <details data-kind="thirdPartyParts" open>
              <summary>
                Third-party parts ({integer.format(bom.rebrickable.thirdParty.length)} lines)
              </summary>
              <ul>
                {bom.rebrickable.thirdParty.map((line) => (
                  <li key={`${line.part}-${line.ldrawColor}`} data-part={line.part}>
                    <span className="part-badge" data-badge="third-party">
                      third-party
                    </span>{" "}
                    {line.quantity}× {line.part}: from {line.vendor}, not LEGO. Left out of the
                    Rebrickable and BrickLink lists; buy it from {line.vendor}.
                  </li>
                ))}
              </ul>
            </details>
          )}
          <UnmappedLines catalog={bom.rebrickable} name="Rebrickable" />
          <UnmappedLines catalog={bom.bricklink} name="BrickLink" />
          {bom.uncounted.length > 0 && (
            <details>
              <summary>Not counted ({integer.format(bom.uncounted.length)} items)</summary>
              <ul>
                {bom.uncounted.map((item) => (
                  <li key={`${item.source}-${item.item}-${item.ldrawColor ?? ""}`}>
                    {item.quantity === null ? "" : `${item.quantity}× `}
                    {item.item}
                    {item.ldrawColor === null ? "" : ` colour ${item.ldrawColor}`} ({item.source}:{" "}
                    {item.reason})
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <OwnVsBuy
        service={service}
        ownedParts={ownedParts}
        bom={bom}
        stem={bom ? fileStem(bom) : ""}
      />
    </section>
  );
}
