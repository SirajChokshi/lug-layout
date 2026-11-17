import type { EditorOptions, IEditor, IPlanService } from "@brr/client";
import { EditorCanvas } from "./editor-canvas.tsx";
import {
  CreditsFooter,
  EditorHud,
  Inspector,
  PlacementToolbar,
  PlacementRules,
  RoadJoins,
} from "./editor-panels.tsx";
import { PalettePanel } from "./palette-panel.tsx";
import { PlanPanel, usePlanSnapshot } from "./plan-panel.tsx";
import { TrackPanel } from "./track-panel.tsx";
import { useEditorSnapshot } from "./use-editor.ts";
import { WelcomePanel } from "./welcome-panel.tsx";

interface EditorAppProps {
  readonly editor: IEditor;
  readonly plans: IPlanService;
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

export function EditorApp({ editor, plans, options, disclaimer, showState }: EditorAppProps) {
  const snapshot = useEditorSnapshot(editor);
  return (
    <div
      className="editor"
      data-status={snapshot.status}
      data-hover={snapshot.hover ? `${snapshot.hover.x},${snapshot.hover.z}` : ""}
      data-selection={snapshot.selection?.item ?? ""}
      data-ghost-rot={snapshot.ghostRot}
      data-snap={snapshot.snap?.state === "snapped" ? snapshot.snap.joinedCells : ""}
      data-snap-state={snapshot.snap?.state ?? ""}
      data-refused={snapshot.refusals}
      data-road-joined={snapshot.roads.joinedCells}
      data-road-open={snapshot.roads.openCells}
      data-road-mismatch={snapshot.roads.mismatchedCells}
    >
      <EditorCanvas editor={editor} options={options} />
      <EditorHud snapshot={snapshot} />
      <WelcomePanel editor={editor} snapshot={snapshot} />
      <PlanPanel editor={editor} plans={plans} />
      <div className="side-panel">
        <PlacementToolbar editor={editor} snapshot={snapshot} />
        <PalettePanel editor={editor} snapshot={snapshot} />
        <TrackPanel snapshot={snapshot} />
        <PlacementRules snapshot={snapshot} />
        <Inspector snapshot={snapshot} />
        <RoadJoins editor={editor} snapshot={snapshot} />
      </div>
      {showState && <EditorState editor={editor} />}
      {showState && <PlanState plans={plans} />}
      <CreditsFooter snapshot={snapshot} disclaimer={disclaimer} />
    </div>
  );
}
