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

function regionText(region: PlacementRegion): string {
  return `x ${region.minX}…${region.maxX}, z ${region.minZ}…${region.maxZ} LDU`;
}

function fileStem(bom: BillOfMaterials): string {
  const { scope } = bom;
  if (scope.kind === "world") return bom.name;
  const { minX, minZ, maxX, maxZ } = scope.region;
  return `${bom.name}.region_${minX}_${minZ}_${maxX}_${maxZ}`;
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

export function BomPanel({ service, source, region }: BomPanelProps) {
  const [scopeKind, setScopeKind] = useState<BomScope["kind"]>(region ? "region" : "world");
  const [bom, setBom] = useState<BillOfMaterials | null>(null);
  const [error, setError] = useState<string | null>(null);

  const build = (): void => {
    const scope: BomScope =
      scopeKind === "region" && region ? { kind: "region", region } : { kind: "world" };
    setError(null);
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
            checked={scopeKind === "world"}
            onChange={() => setScopeKind("world")}
          />
          World
        </label>
        {region && (
          <label>
            <input
              type="radio"
              name="bom-scope"
              checked={scopeKind === "region"}
              onChange={() => setScopeKind("region")}
            />
            Region ({regionText(region)})
          </label>
        )}
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
