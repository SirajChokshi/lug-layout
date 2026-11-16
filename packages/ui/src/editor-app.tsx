import type { EditorOptions, IBuildableService, IEditor, IPlanService } from "@brr/client";
import { BuildablePanel, BuildableState } from "./buildable-panel.tsx";
import { EditorCanvas } from "./editor-canvas.tsx";
import {
  CatalogList,
  CreditsFooter,
  EditorHud,
  Inspector,
  PlacementToolbar,
} from "./editor-panels.tsx";
import { PlanPanel, usePlanSnapshot } from "./plan-panel.tsx";
import { useEditorSnapshot } from "./use-editor.ts";

interface EditorAppProps {
  readonly editor: IEditor;
  readonly plans: IPlanService;
  readonly buildable: IBuildableService;
  readonly options: EditorOptions;
  readonly disclaimer: string;
  readonly showState: boolean;
}

function EditorState({ editor }: { readonly editor: IEditor }) {
  const snapshot = useEditorSnapshot(editor);
  return (
    <pre
      id="edit-state"
      data-placements={snapshot.placements}
      data-samples={snapshot.latencies.length}
    >
      {JSON.stringify({ latencies: snapshot.latencies, world: editor.dump() })}
    </pre>
  );
}

function PlanState({ plans }: { readonly plans: IPlanService }) {
  const snapshot = usePlanSnapshot(plans);
  return (
    <pre id="plan-state" data-plans={snapshot.plans.length}>
      {JSON.stringify({
        plans: snapshot.plans,
        checks: snapshot.checks,
        placements: snapshot.placements,
        sandboxPlacements: snapshot.sandboxPlacements,
        tableTopY: snapshot.tableTopY,
      })}
    </pre>
  );
}

export function EditorApp({
  editor,
  plans,
  buildable,
  options,
  disclaimer,
  showState,
}: EditorAppProps) {
  const snapshot = useEditorSnapshot(editor);
  return (
    <div
      className="editor"
      data-status={snapshot.status}
      data-hover={snapshot.hover ? `${snapshot.hover.x},${snapshot.hover.z}` : ""}
      data-selection={snapshot.selection?.item ?? ""}
      data-ghost-rot={snapshot.ghostRot}
    >
      <EditorCanvas editor={editor} options={options} />
      <EditorHud snapshot={snapshot} />
      <PlanPanel editor={editor} plans={plans} />
      <div className="side-panel">
        <PlacementToolbar editor={editor} snapshot={snapshot} />
        <CatalogList editor={editor} snapshot={snapshot} />
        <Inspector snapshot={snapshot} />
      </div>
      <div className="buildable-dock">
        <BuildablePanel plans={plans} buildable={buildable} />
      </div>
      {showState && <EditorState editor={editor} />}
      {showState && <BuildableState buildable={buildable} />}
      {showState && <PlanState plans={plans} />}
      <CreditsFooter snapshot={snapshot} disclaimer={disclaimer} />
    </div>
  );
}
