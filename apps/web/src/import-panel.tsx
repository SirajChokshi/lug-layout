import type { IImportScene, ImportedModule } from "@brr/client";
import { ImportReportDetails } from "@brr/ui";
import { useState, type ChangeEvent } from "react";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const STUDIO_EXTENSION = /\.io$/iu;

interface ImportPanelProps {
  readonly scene: IImportScene;
  readonly onImported: (module: ImportedModule) => void;
}

function ModuleReport({ module }: { readonly module: ImportedModule }) {
  return (
    <ImportReportDetails report={module.result.report} studio={module.result.studio ?? null}>
      <div>
        <dt>Placed in the world at</dt>
        <dd>
          x {module.placement.x}, z {module.placement.z} LDU, {module.placement.yPlates} plates, rot{" "}
          {module.placement.rot}, scene {integer.format(module.sceneMs)} ms
        </dd>
      </div>
    </ImportReportDetails>
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
        setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
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
