import {
  heldItem,
  meshesSettled,
  runEditorAction,
  type EditorActionId,
  type EditorOptions,
  type IBomService,
  type IEditor,
  type IEditorCamera,
  type IHotbar,
  type IPalette,
  type IPanelLayout,
  type IPlanService,
  type IRunningGear,
  type IScaleBar,
  type ITrainPlay,
  type ShellCommandId,
} from "@brr/client";
import { useCallback, useState } from "react";
import { BomPanel } from "./bom-panel.tsx";
import { CommandPalette } from "./command-palette.tsx";
import { EditorCanvas } from "./editor-canvas.tsx";
import { EditorFooter, EditorHud, Inspector, PlacementToolbar } from "./editor-panels.tsx";
import { LibraryColumn } from "./library-column.tsx";
import { Minimap } from "./minimap.tsx";
import { PalettePanel } from "./palette-panel.tsx";
import { PlanPanel } from "./plan-panel.tsx";
import { PlanScaleBar } from "./plan-scale-bar.tsx";
import { PlayPanel } from "./play-panel.tsx";
import { RoadDrawPanel } from "./road-draw-panel.tsx";
import { usePlaySnapshot } from "./use-play.ts";
import { ShortcutSheet } from "./shortcut-sheet.tsx";
import { ToolHud } from "./tool-hud.tsx";
import { useSafeArea } from "./safe-area.ts";
import { useCompactLayout } from "./use-compact-layout.ts";
import { useEditorSnapshot } from "./use-editor.ts";
import { useEditorKeys } from "./use-editor-keys.ts";
import { usePlanVersion } from "./use-plan-version.ts";
import { ViewControls } from "./view-controls.tsx";
import { WorldMenu } from "./world-menu.tsx";

interface EditorAppProps {
  readonly editor: IEditor;
  readonly camera: IEditorCamera;
  readonly scaleBar: IScaleBar;
  readonly plans: IPlanService;
  readonly bomService: IBomService;
  readonly play: ITrainPlay;
  readonly palette: IPalette;
  readonly panels: IPanelLayout;
  readonly hotbar: IHotbar;
  readonly runningGear: IRunningGear;
  readonly options: EditorOptions;
  readonly disclaimer: string;
  readonly showState: boolean;
}

function EditorState({ editor }: { readonly editor: IEditor }) {
  const snapshot = useEditorSnapshot(editor);
  const held = heldItem(snapshot);
  return (
    <pre
      id="edit-state"
      data-placements={snapshot.placements}
      data-samples={snapshot.latencies.length}
      data-measuring={snapshot.measuring ? "1" : "0"}
      data-held-item={held?.item}
      data-held-tables={held?.tables}
    >
      {JSON.stringify({
        held,
        latencies: snapshot.latencies,
        stats: snapshot.stats,
        measurement: snapshot.measurement,
        world: editor.dump(),
      })}
    </pre>
  );
}

function PlanState({ plans }: { readonly plans: IPlanService }) {
  usePlanVersion(plans);
  return (
    <pre id="plan-state" data-plans={plans.plans().length}>
      {JSON.stringify(plans.materialize())}
    </pre>
  );
}

export function EditorApp({
  editor,
  camera,
  scaleBar,
  plans,
  bomService,
  play,
  palette,
  panels,
  hotbar,
  runningGear,
  options,
  disclaimer,
  showState,
}: EditorAppProps) {
  const snapshot = useEditorSnapshot(editor);
  const playSnapshot = usePlaySnapshot(play);
  const [overlay, setOverlay] = useState<ShellCommandId | null>(null);
  const closeOverlay = useCallback(() => setOverlay(null), []);
  const toggleOverlay = useCallback(
    (id: ShellCommandId) => setOverlay((open) => (open === id ? null : id)),
    [],
  );
  const runAction = useCallback(
    (id: EditorActionId, eventTimeMs: number) => runEditorAction(editor, camera, id, eventTimeMs),
    [editor, camera],
  );
  useEditorKeys(editor, camera, {
    play,
    onShellCommand: toggleOverlay,
    hotbar,
    overlayOpen: overlay !== null,
    closeOverlay,
  });
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useSafeArea(camera, root);
  const compact = useCompactLayout();
  return (
    <div
      ref={setRoot}
      className="editor"
      data-layout={compact ? "compact" : "wide"}
      data-status={snapshot.status}
      data-far-tier={snapshot.farTier}
      data-meshes={meshesSettled(snapshot.meshes) ? "settled" : "loading"}
      data-hover={snapshot.hover ? `${snapshot.hover.x},${snapshot.hover.z}` : ""}
      data-selection={snapshot.selection?.item ?? ""}
      data-ghost-rot={snapshot.ghostRot}
      data-snap={snapshot.snap?.state === "snapped" ? snapshot.snap.joinedCells : ""}
      data-snap-state={snapshot.snap?.state ?? ""}
      data-refused={snapshot.refusedClicks}
      data-road-joined={snapshot.roads.joinedCells}
      data-road-open={snapshot.roads.openCells}
      data-road-mismatch={snapshot.roads.mismatchedCells}
      data-world={snapshot.world?.id ?? ""}
      data-save={snapshot.world?.save ?? ""}
      data-road-pieces={snapshot.roads.placements}
      data-mode={snapshot.mode}
    >
      <EditorCanvas
        editor={editor}
        camera={camera}
        play={play}
        paletteDrag={palette.drag}
        options={options}
      />
      <ToolHud snapshot={snapshot} play={playSnapshot} hotbar={hotbar} />
      <ViewControls camera={camera} snapshot={snapshot} compact={compact} />
      <LibraryColumn panels={panels}>
        <PalettePanel editor={editor} snapshot={snapshot} palette={palette} />
      </LibraryColumn>
      <PlanScaleBar scaleBar={scaleBar} />
      <div className="side-panel">
        <WorldMenu editor={editor} snapshot={snapshot} />
        <PlacementToolbar
          editor={editor}
          snapshot={snapshot}
          play={playSnapshot}
          onEditorAction={runAction}
          onShellCommand={toggleOverlay}
        />
        <RoadDrawPanel editor={editor} snapshot={snapshot} />
        <Inspector editor={editor} snapshot={snapshot} />
        <Minimap editor={editor} camera={camera} plans={plans} snapshot={snapshot} />
        <PlayPanel
          editor={editor}
          camera={camera}
          play={play}
          runningGear={runningGear}
          ready={snapshot.status === "ready"}
          checkingStuds={snapshot.studChecks > 0}
        />
        <PlanPanel camera={camera} plans={plans} />
        {snapshot.status === "ready" && (
          <BomPanel
            service={bomService}
            source={editor}
            region={null}
            selectionLabel={snapshot.selection?.item ?? null}
          />
        )}
        <EditorHud editor={editor} snapshot={snapshot} panels={panels} />
      </div>
      {showState && <EditorState editor={editor} />}
      {showState && <PlanState plans={plans} />}
      <EditorFooter disclaimer={disclaimer} />
      {overlay === "show-shortcuts" && <ShortcutSheet onClose={closeOverlay} />}
      {overlay === "open-palette" && (
        <CommandPalette
          editor={editor}
          camera={camera}
          play={play}
          search={palette.search}
          snapshot={snapshot}
          onClose={closeOverlay}
          onShellCommand={toggleOverlay}
        />
      )}
    </div>
  );
}
