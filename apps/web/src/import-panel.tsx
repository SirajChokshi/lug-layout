import type { IImportScene, ImportedModule, ImportReport, PartResolution } from "@brr/client";
import { useState, type ChangeEvent } from "react";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const SHORT_COMMIT = 7;
const KIBIBYTE = 1024;

interface ImportPanelProps {
  readonly scene: IImportScene;
  readonly onImported: (module: ImportedModule) => void;
}

function commitOf(report: ImportReport): string {
  return `${report.mirror.repo}@${report.mirror.commit.slice(0, SHORT_COMMIT)}`;
}

function notDrawnReason(part: PartResolution, report: ImportReport): string | null {
  switch (part.kind) {
    case "bundle":
    case "compiled":
      return null;
    case "notInLibrary":
      return `Not in the official LDraw library at ${commitOf(report)}: unofficial, custom or unknown part${part.definedInline ? " (the file defines it inline)" : ""}.`;
    case "missingSubfile":
      return `LDraw part found, but its sub-file ${part.missing} (used by ${part.from}) is not in the library.`;
    case "rejected":
      return `Rejected by the ${part.gate === "license" ? "license" : "unofficial-part"} gate: ${part.path}.`;
    case "inlineDiffers":
      if (!part.colorsMatch) {
        return `The file's inline copy uses colours ${part.inlineColors.join(", ")} where official ${part.official} uses ${part.officialColors.join(", ")}.`;
      }
      return `The file's inline copy differs from official ${part.official} by up to ${Math.max(part.maxVertexDistanceLdu, part.maxFaceDistanceLdu).toFixed(3)} LDU (weld tolerance ${part.weldEpsilonLdu} LDU).`;
    case "failed":
      return part.message;
    default: {
      const unhandled: never = part;
      throw new Error(`unhandled part resolution ${String(unhandled)}`);
    }
  }
}

function uniqueText(values: ReadonlyArray<string | null>): string {
  return [...new Set(values.filter((v): v is string => v !== null && v !== ""))].join("; ");
}

function ModuleReport({ module }: { readonly module: ImportedModule }) {
  const { report } = module.result;
  const bundled = report.parts.filter((p) => p.kind === "bundle");
  const compiled = report.parts.filter((p) => p.kind === "compiled");
  const notDrawn = report.parts.flatMap((part) => {
    const reason = notDrawnReason(part, report);
    return reason === null ? [] : [{ part, reason }];
  });
  const notDrawnInstances = notDrawn.reduce((sum, { part }) => sum + part.instances, 0);
  const hasLooseGeometry = report.looseGeometry.length > 0;
  const title = report.sections[0]?.title ?? report.fileName;
  return (
    <section className="module-report" data-file={report.fileName}>
      <h2>{report.fileName}</h2>
      <p className="module-title">{title}</p>
      <dl>
        <div>
          <dt>Authors</dt>
          <dd>{uniqueText(report.sections.map((s) => s.author)) || "none given"}</dd>
        </div>
        <div>
          <dt>Section licenses</dt>
          <dd>{uniqueText(report.sections.map((s) => s.license)) || "none given"}</dd>
        </div>
        <div>
          <dt>Placed in the world at</dt>
          <dd>
            x {module.placement.x}, z {module.placement.z} LDU, {module.placement.yPlates} plates,
            rot {module.placement.rot}
          </dd>
        </div>
        <div>
          <dt>Instances drawn</dt>
          <dd>
            {integer.format(report.drawnInstanceCount)} of {integer.format(report.instanceCount)}
          </dd>
        </div>
        <div>
          <dt>Unique parts</dt>
          <dd>
            {report.parts.length}: {bundled.length} from the bundle, {compiled.length} compiled from
            LDraw {commitOf(report)}, {notDrawn.length} not drawn
          </dd>
        </div>
        <div>
          <dt>Import</dt>
          <dd>
            {integer.format(report.timings.totalMs)} ms ({report.compileRounds} compile rounds,{" "}
            {report.fetched.found} LDraw files, {integer.format(report.fetched.bytes / KIBIBYTE)}{" "}
            KiB fetched), scene {integer.format(module.sceneMs)} ms
          </dd>
        </div>
      </dl>
      {(notDrawn.length > 0 || report.unknownColors.length > 0 || hasLooseGeometry) && (
        <>
          <h3>
            Not drawn: {integer.format(notDrawnInstances)} instances of {notDrawn.length} parts
            {report.unknownColors.length > 0 ? ", plus unknown colours" : ""}
            {hasLooseGeometry ? ", plus loose geometry" : ""}
          </h3>
          <ul className="not-drawn">
            {notDrawn.map(({ part, reason }) => (
              <li key={part.reference} data-kind={part.kind}>
                <code>{part.reference}</code> ×{part.instances}: {reason}
              </li>
            ))}
            {report.looseGeometry.map((loose) => (
              <li key={`loose-${loose.section}`} data-kind="looseGeometry">
                <code>{loose.section}</code> ×{loose.occurrences}: {loose.triangles} triangles and{" "}
                {loose.quads} quads drawn directly in a model section, outside any part.
              </li>
            ))}
            {report.unknownColors.map((color) => (
              <li key={`color-${color.code}`} data-kind="unknownColor">
                Colour <code>{color.code}</code> ×{color.instances}: not in LDConfig, so these
                instances are not drawn.
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function ImportPanel({ scene, onImported }: ImportPanelProps) {
  const [modules, setModules] = useState<ReadonlyArray<ImportedModule>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const importFiles = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    setError(null);
    for (const file of files) {
      setBusy(`Importing ${file.name}…`);
      try {
        const module = await scene.importText(file.name, await file.text());
        setModules((previous) => [...previous, module]);
        onImported(module);
      } catch (e) {
        setError(`${file.name}: ${String(e)}`);
      }
    }
    setBusy(null);
  };

  return (
    <aside className="import-panel">
      <label className="import-button">
        Import .ldr / .mpd
        <input
          type="file"
          accept=".ldr,.mpd"
          multiple
          disabled={busy !== null}
          onChange={(event) => void importFiles(event)}
        />
      </label>
      {busy && <p className="busy">{busy}</p>}
      {error && <p className="error">{error}</p>}
      {modules.length === 0 && !busy && (
        <p className="hint">
          Each file is placed as one whole module on the stud lattice. Parts not in the bundle are
          compiled from the pinned LDraw library; anything that isn't an official LDraw part is
          listed here and never drawn.
        </p>
      )}
      {modules.map((module) => (
        <ModuleReport key={module.placement.module} module={module} />
      ))}
      {modules.length > 0 && (
        <pre id="import-result" data-modules={modules.length}>
          {JSON.stringify({
            placements: scene.placements(),
            reports: modules.map((m) => ({
              ...m.result.report,
              importMs: m.importMs,
              sceneMs: m.sceneMs,
            })),
          })}
        </pre>
      )}
    </aside>
  );
}
