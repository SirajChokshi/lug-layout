import type { IEditor, IPlanService } from "@brr/client";
import { useState, useSyncExternalStore } from "react";

interface PlanArchiveControlsProps {
  readonly editor: IEditor;
  readonly plans: IPlanService;
  readonly disclaimer: string;
}

function fileName(planName: string): string {
  return `${planName.trim().replaceAll(/[^A-Za-z0-9-]+/gu, "-")}.brrplan.zip`;
}

function save(bytes: Uint8Array, name: string): void {
  const copy = new Uint8Array(bytes);
  const url = URL.createObjectURL(new Blob([copy.buffer], { type: "application/zip" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function PlanArchiveControls({ editor, plans, disclaimer }: PlanArchiveControlsProps) {
  const planState = useSyncExternalStore(
    (listener) => plans.subscribe(listener),
    () => plans.snapshot(),
  );
  const [message, setMessage] = useState<string | null>(null);
  const active = planState.plans.find((plan) => plan.id === planState.activePlanId);
  return (
    <section className="plan-archive" aria-label="Plan files" data-message={message ?? ""}>
      {active && (
        <button
          type="button"
          data-download="brrplan.zip"
          onClick={() => {
            const bytes = editor.planArchive(active.id, disclaimer);
            if (bytes) save(bytes, fileName(active.name));
          }}
        >
          Save plan (.brrplan.zip)
        </button>
      )}
      <label>
        Open plan (.brrplan.zip)
        <input
          type="file"
          accept=".zip,application/zip"
          data-action="open-plan"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void file.arrayBuffer().then(
              (buffer) => {
                try {
                  editor.openPlanArchive(new Uint8Array(buffer));
                  setMessage(`Opened ${file.name}`);
                } catch (error) {
                  setMessage(`${file.name}: ${String(error)}`);
                }
              },
              (error: unknown) => setMessage(String(error)),
            );
          }}
        />
      </label>
      {message && <p className="plan-meta">{message}</p>}
    </section>
  );
}
