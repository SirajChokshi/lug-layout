import type {
  IImportScene,
  ImportedModule,
  ImportReport,
  PartResolution,
  StudioPart,
  StudioReport,
} from "@brr/client";
import { useState, type ChangeEvent } from "react";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const SHORT_COMMIT = 7;
const KIBIBYTE = 1024;
const STUDIO_EXTENSION = /\.io$/iu;

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
      return `The file's inline copy ${part.inline} differs from the official part by up to ${part.maxVertexDistanceLdu.toFixed(3)} LDU (weld tolerance ${part.weldEpsilonLdu} LDU).`;
    case "failed":
      return part.message;
    default: {
      const unhandled: never = part;
      throw new Error(`unhandled part resolution ${String(unhandled)}`);
    }
  }
}

function studioReason(part: StudioPart): string {
  const id = `Studio's BrickLink id ${part.bricklinkId}`;
  switch (part.outcome.kind) {
    case "kept":
      return `${id} has no LDraw part in the crosswalk.`;
    case "bricklinkCrosswalk":
      return `${id} maps to ldraw:${part.outcome.ldraw}.`;
    case "crosswalkTargetMissing":
      return `${id} maps only to ldraw:${part.outcome.ldraw}, which is not in the pinned library.`;
    case "ambiguous":
      return `${id} has ${part.outcome.candidates.length} LDraw candidates (${part.outcome.candidates.join(", ")}), so nothing is substituted.`;
    case "custom":
      return "A Studio CustomParts file: custom geometry stays in the user's file and is never drawn.";
    default: {
      const unhandled: never = part.outcome;
      throw new Error(`unhandled Studio outcome ${JSON.stringify(unhandled)}`);
    }
  }
}

function studioPartFor(reference: string, studio: StudioReport): StudioPart | undefined {
  return studio.parts.find((part) =>
    part.outcome.kind === "bricklinkCrosswalk"
      ? `${part.outcome.ldraw}.dat` === reference
      : part.studio === reference,
  );
}

function StudioSummary({ studio }: { readonly studio: StudioReport }) {
  const sum = (kind: StudioPart["outcome"]["kind"]): number =>
    studio.parts
      .filter((part) => part.outcome.kind === kind)
      .reduce((total, part) => total + part.instances, 0);
  const rewritten = studio.parts.flatMap((part) =>
    part.outcome.kind === "bricklinkCrosswalk"
      ? [{ studio: part.studio, ldraw: part.outcome.ldraw, instances: part.instances }]
      : [],
  );
  return (
    <>
      <div>
        <dt>Studio file</dt>
        <dd>
          {studio.entry}
          {studio.studioVersion ? ` from Studio ${studio.studioVersion}` : ""},{" "}
          {integer.format(studio.convertedLines)} Studio part lines read as LDraw
        </dd>
      </div>
      <div>
        <dt>Mapped to LDraw</dt>
        <dd className="studio-mapping">
          {integer.format(sum("kept"))} instances kept under Studio&apos;s name,{" "}
          {integer.format(sum("bricklinkCrosswalk"))} renamed through the BrickLink crosswalk
          {rewritten.map((part) => (
            <span key={part.studio} className="studio-rewrite">
              {" "}
              <code>{part.studio}</code> → <code>ldraw:{part.ldraw}</code> ×{part.instances}
            </span>
          ))}
        </dd>
      </div>
    </>
  );
}

function uniqueText(values: ReadonlyArray<string | null>): string {
  return [...new Set(values.filter((v): v is string => v !== null && v !== ""))].join("; ");
}

function ModuleReport({ module }: { readonly module: ImportedModule }) {
  const { report } = module.result;
  const bundled = report.parts.filter((p) => p.kind === "bundle");
  const compiled = report.parts.filter((p) => p.kind === "compiled");
  const { studio } = module.result;
  const notDrawn = report.parts.flatMap((part) => {
    const reason = notDrawnReason(part, report);
    if (reason === null) return [];
    const studioPart = studio && studioPartFor(part.reference, studio);
    return [{ part, reason: studioPart ? `${reason} ${studioReason(studioPart)}` : reason }];
  });
  const flexible = studio?.flexibleSections ?? [];
  const notDrawnInstances = notDrawn.reduce((sum, { part }) => sum + part.instances, 0);
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
        {studio && <StudioSummary studio={studio} />}
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
      {(notDrawn.length > 0 || report.unknownColors.length > 0 || flexible.length > 0) && (
        <>
          <h3>
            Not drawn: {integer.format(notDrawnInstances)} instances of {notDrawn.length} parts
            {report.unknownColors.length > 0 ? ", plus unknown colours" : ""}
          </h3>
          <ul className="not-drawn">
            {notDrawn.map(({ part, reason }) => (
              <li key={part.reference} data-kind={part.kind}>
                <code>{part.reference}</code> ×{part.instances}: {reason}
              </li>
            ))}
            {report.unknownColors.map((color) => (
              <li key={`color-${color.code}`} data-kind="unknownColor">
                Colour <code>{color.code}</code> ×{color.instances}: not in LDConfig, so these
                instances are not drawn.
                {studio ? " It is a Studio colour code and the file carries no RGB for it." : ""}
              </li>
            ))}
            {flexible.map((section) => (
              <li key={`flexible-${section.name}`} data-kind="studioFlexible">
                <code>{section.name}</code> ×{section.instances}: Studio-generated flexible geometry
                with no LDraw part line, so it is not drawn.
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
        const module = STUDIO_EXTENSION.test(file.name)
          ? await scene.importStudio(file.name, new Uint8Array(await file.arrayBuffer()))
          : await scene.importText(file.name, await file.text());
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
        Import .ldr / .mpd / .io
        <input
          type="file"
          accept=".ldr,.mpd,.io"
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
              studio: m.result.studio ?? null,
              importMs: m.importMs,
              sceneMs: m.sceneMs,
            })),
          })}
        </pre>
      )}
    </aside>
  );
}
