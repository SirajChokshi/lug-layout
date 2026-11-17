import {
  hotbarRecent,
  type EditorOptions,
  type IEditor,
  type IEditorCamera,
  type IPlanService,
  type ShellCommandId,
} from "@brr/client";
import { useCallback, useMemo, useState } from "react";
import { CommandPalette } from "./command-palette.tsx";
import { EditorCanvas } from "./editor-canvas.tsx";
import {
  CreditsFooter,
  EditorHud,
  Inspector,
  PlacementToolbar,
  ModuleJoins,
  RoadJoins,
} from "./editor-panels.tsx";
import { PalettePanel } from "./palette-panel.tsx";
import { PlanPanel, usePlanSnapshot } from "./plan-panel.tsx";
import { ShortcutSheet } from "./shortcut-sheet.tsx";
import { ToolHud } from "./tool-hud.tsx";
import { TrackPanel } from "./track-panel.tsx";
import { useSafeArea } from "./safe-area.ts";
import { useEditorSnapshot } from "./use-editor.ts";
import { useEditorKeys } from "./use-editor-keys.ts";
import { useHotbar } from "./use-hotbar.ts";
import { ViewControls } from "./view-controls.tsx";

interface EditorAppProps {
  readonly editor: IEditor;
  readonly camera: IEditorCamera;
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

export function EditorApp({
  editor,
  camera,
  plans,
  options,
  disclaimer,
  showState,
}: EditorAppProps) {
  const snapshot = useEditorSnapshot(editor);
  const hotbar = useHotbar(snapshot.activeItem);
  const recent = useMemo(() => hotbarRecent(hotbar), [hotbar]);
  const [overlay, setOverlay] = useState<ShellCommandId | null>(null);
  const closeOverlay = useCallback(() => setOverlay(null), []);
  const toggleOverlay = useCallback(
    (id: ShellCommandId) => setOverlay((open) => (open === id ? null : id)),
    [],
  );
  const pickSlot = useCallback(
    (slot: number) => {
      const item = hotbar.slots[slot];
      if (item !== undefined) editor.chooseItem(item);
    },
    [editor, hotbar],
  );
  useEditorKeys(editor, camera, {
    onShellCommand: toggleOverlay,
    onPickSlot: pickSlot,
    overlayOpen: overlay !== null,
    closeOverlay,
  });
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useSafeArea(camera, root);
  return (
    <div
      ref={setRoot}
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
      data-module-joined={snapshot.modules.joined}
      data-module-open={snapshot.modules.open}
      data-module-mismatch={snapshot.modules.mismatched}
      data-module-fit={
        snapshot.moduleFit
          ? `${snapshot.moduleFit.column},${snapshot.moduleFit.row},${snapshot.moduleFit.rot},${snapshot.moduleFit.joined},${snapshot.moduleFit.mismatched}`
          : ""
      }
    >
      <EditorCanvas editor={editor} camera={camera} options={options} />
      <ToolHud snapshot={snapshot} hotbar={hotbar} onPickSlot={pickSlot} />
      <EditorHud snapshot={snapshot} />
      <ViewControls camera={camera} snapshot={snapshot} />
      <PlanPanel camera={camera} plans={plans} />
      <div className="side-panel">
        <PlacementToolbar editor={editor} snapshot={snapshot} onShellCommand={toggleOverlay} />
        <PalettePanel editor={editor} snapshot={snapshot} />
        <TrackPanel snapshot={snapshot} />
        <Inspector snapshot={snapshot} />
        <ModuleJoins editor={editor} snapshot={snapshot} />
        <RoadJoins editor={editor} snapshot={snapshot} />
      </div>
      {showState && <EditorState editor={editor} />}
      {showState && <PlanState plans={plans} />}
      <CreditsFooter snapshot={snapshot} disclaimer={disclaimer} />
      {overlay === "show-shortcuts" && <ShortcutSheet onClose={closeOverlay} />}
      {overlay === "open-palette" && (
        <CommandPalette
          editor={editor}
          camera={camera}
          snapshot={snapshot}
          recent={recent}
          onClose={closeOverlay}
          onShellCommand={toggleOverlay}
        />
      )}
    </div>
  );
}
