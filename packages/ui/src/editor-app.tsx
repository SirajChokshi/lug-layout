import type { EditorOptions, IEditor, IPlanService, ShellCommandId } from "@brr/client";
import { useCallback, useState } from "react";
import { CommandPalette } from "./command-palette.tsx";
import { EditorCanvas } from "./editor-canvas.tsx";
import {
  CreditsFooter,
  EditorHud,
  Inspector,
  PlacementToolbar,
  RoadJoins,
} from "./editor-panels.tsx";
import { PalettePanel } from "./palette-panel.tsx";
import { PlanPanel, usePlanSnapshot } from "./plan-panel.tsx";
import { ShortcutSheet } from "./shortcut-sheet.tsx";
import { ToolHud } from "./tool-hud.tsx";
import { TrackPanel } from "./track-panel.tsx";
import { useEditorSnapshot } from "./use-editor.ts";
import { useEditorKeys } from "./use-editor-keys.ts";
import { useRecentItems } from "./use-recent-items.ts";

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
  const recent = useRecentItems(snapshot.activeItem);
  const [overlay, setOverlay] = useState<ShellCommandId | null>(null);
  const closeOverlay = useCallback(() => setOverlay(null), []);
  const toggleOverlay = useCallback(
    (id: ShellCommandId) => setOverlay((open) => (open === id ? null : id)),
    [],
  );
  useEditorKeys(editor, {
    onShellCommand: toggleOverlay,
    overlayOpen: overlay !== null,
    closeOverlay,
  });
  return (
    <div
      className="editor"
      data-status={snapshot.status}
      data-hover={snapshot.hover ? `${snapshot.hover.x},${snapshot.hover.z}` : ""}
      data-selection={snapshot.selection?.item ?? ""}
      data-ghost-rot={snapshot.ghostRot}
      data-snap={snapshot.snap?.state === "snapped" ? snapshot.snap.joinedCells : ""}
      data-snap-state={snapshot.snap?.state ?? ""}
      data-refused={snapshot.refusedClicks}
      data-road-joined={snapshot.roads.joinedCells}
      data-road-open={snapshot.roads.openCells}
      data-road-mismatch={snapshot.roads.mismatchedCells}
    >
      <EditorCanvas editor={editor} options={options} />
      <ToolHud snapshot={snapshot} />
      <EditorHud snapshot={snapshot} />
      <PlanPanel editor={editor} plans={plans} />
      <div className="side-panel">
        <PlacementToolbar editor={editor} snapshot={snapshot} onShellCommand={toggleOverlay} />
        <PalettePanel editor={editor} snapshot={snapshot} />
        <TrackPanel snapshot={snapshot} />
        <Inspector snapshot={snapshot} />
        <RoadJoins editor={editor} snapshot={snapshot} />
      </div>
      {showState && <EditorState editor={editor} />}
      {showState && <PlanState plans={plans} />}
      <CreditsFooter snapshot={snapshot} disclaimer={disclaimer} />
      {overlay === "show-shortcuts" && <ShortcutSheet onClose={closeOverlay} />}
      {overlay === "open-palette" && (
        <CommandPalette
          editor={editor}
          snapshot={snapshot}
          recent={recent}
          onClose={closeOverlay}
          onShellCommand={toggleOverlay}
        />
      )}
    </div>
  );
}
