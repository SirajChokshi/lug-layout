import type {
  BillOfMaterials,
  BomScope,
  CatalogBom,
  IBomService,
  IBomSource,
  PlacementRegion,
} from "@brr/client";
import { useState } from "react";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

interface BomPanelProps {
  readonly service: IBomService;
  readonly source: IBomSource;
  readonly region: PlacementRegion | null;
  readonly selectionLabel: string | null;
}

interface Download {
  readonly label: string;
  readonly suffix: string;
  readonly type: string;
  readonly body: (bom: BillOfMaterials) => string;
}

const DOWNLOADS: ReadonlyArray<Download> = [
  {
    label: "Rebrickable CSV",
    suffix: "rebrickable.csv",
    type: "text/csv",
    body: (bom) => bom.files.rebrickableCsv,
  },
  {
    label: "BrickLink XML",
    suffix: "bricklink.xml",
    type: "application/xml",
    body: (bom) => bom.files.brickLinkXml,
  },
  { label: "Plain CSV", suffix: "parts.csv", type: "text/csv", body: (bom) => bom.files.plainCsv },
];

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

function save(bom: BillOfMaterials, download: Download): void {
  const url = URL.createObjectURL(new Blob([download.body(bom)], { type: download.type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${fileStem(bom)}.${download.suffix}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function catalogText(catalog: CatalogBom): string {
  const parts = catalog.lines.reduce((sum, line) => sum + line.quantity, 0);
  const unmapped = catalog.unmapped.reduce((sum, line) => sum + line.quantity, 0);
  return `${integer.format(parts)} parts in ${integer.format(catalog.lines.length)} lots, ${integer.format(unmapped)} unmapped`;
}

export function BomPanel({ service, source, region, selectionLabel }: BomPanelProps) {
  const [scopeKind, setScopeKind] = useState<BomScope["kind"]>(region ? "region" : "world");
  const [draft, setDraft] = useState<RegionDraft>(() => draftOf(region));
  const [bom, setBom] = useState<BillOfMaterials | null>(null);
  const [error, setError] = useState<string | null>(null);

  const build = (): void => {
    setError(null);
    let scope: BomScope = { kind: scopeKind === "selection" ? "selection" : "world" };
    if (scopeKind === "region") {
      const parsed = regionOf(draft);
      if (typeof parsed === "string") {
        setError(parsed);
        return;
      }
      scope = { kind: "region", region: parsed };
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
          <div className="bom-downloads">
            {DOWNLOADS.map((download) => (
              <button key={download.suffix} type="button" onClick={() => save(bom, download)}>
                {download.label}
              </button>
            ))}
          </div>
          {bom.rebrickable.unmapped.length > 0 && (
            <details>
              <summary>
                Not in Rebrickable's crosswalk ({integer.format(bom.rebrickable.unmapped.length)}{" "}
                lines)
              </summary>
              <ul>
                {bom.rebrickable.unmapped.map((line) => (
                  <li key={`${line.part}-${line.ldrawColor}`}>
                    {line.quantity}× {line.part} colour {line.ldrawColor} (no {line.missing} id)
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
