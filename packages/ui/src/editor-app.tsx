import {
  meshesSettled,
  runEditorAction,
  type EditorActionId,
  type EditorOptions,
  type IBomService,
  type IEditor,
  type IEditorCamera,
  type IPaletteDrag,
  type IPaletteMemory,
  type IPalettePrefetch,
  type IPaletteSearch,
  type IPaletteThumbnails,
  type IPlanService,
  type IRunningGear,
  type IStarterWorlds,
  type ITrainPlay,
  type ShellCommandId,
} from "@brr/client";
import { useCallback, useState } from "react";
import { BomPanel } from "./bom-panel.tsx";
import { CommandPalette } from "./command-palette.tsx";
import { EditorCanvas } from "./editor-canvas.tsx";
import {
  EditorFooter,
  EditorHud,
  Inspector,
  PlacementToolbar,
  RoadJoins,
} from "./editor-panels.tsx";
import { Minimap } from "./minimap.tsx";
import { PalettePanel } from "./palette-panel.tsx";
import { PlanPanel, usePlanSnapshot } from "./plan-panel.tsx";
import { PlayPanel } from "./play-panel.tsx";
import { RoadDrawPanel } from "./road-draw-panel.tsx";
import { usePlaySnapshot } from "./use-play.ts";
import { ShortcutSheet } from "./shortcut-sheet.tsx";
import { ToolHud } from "./tool-hud.tsx";
import { TrackPanel } from "./track-panel.tsx";
import { useSafeArea } from "./safe-area.ts";
import { useCompactLayout } from "./use-compact-layout.ts";
import { useEditorSnapshot } from "./use-editor.ts";
import { useEditorKeys } from "./use-editor-keys.ts";
import { useWelcome } from "./use-welcome.ts";
import { ViewControls } from "./view-controls.tsx";
import { WelcomeCard } from "./welcome-card.tsx";
import { WorldMenu } from "./world-menu.tsx";

interface EditorAppProps {
  readonly editor: IEditor;
  readonly camera: IEditorCamera;
  readonly plans: IPlanService;
  readonly bomService: IBomService;
  readonly play: ITrainPlay;
  readonly paletteSearch: IPaletteSearch;
  readonly paletteDrag: IPaletteDrag;
  readonly palettePrefetch: IPalettePrefetch;
  readonly paletteMemory: IPaletteMemory;
  readonly paletteThumbnails: IPaletteThumbnails;
  readonly runningGear: IRunningGear;
  readonly starters: IStarterWorlds;
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
      data-measuring={snapshot.measuring ? "1" : "0"}
    >
      {JSON.stringify({
        latencies: snapshot.latencies,
        stats: snapshot.stats,
        measurement: snapshot.measurement,
        world: editor.dump(),
      })}
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
  bomService,
  play,
  paletteSearch,
  paletteDrag,
  palettePrefetch,
  paletteMemory,
  paletteThumbnails,
  runningGear,
  starters,
  options,
  disclaimer,
  showState,
}: EditorAppProps) {
  const snapshot = useEditorSnapshot(editor);
  const playSnapshot = usePlaySnapshot(play);
  const welcome = useWelcome(starters);
  const [overlay, setOverlay] = useState<ShellCommandId | null>(null);
  const closeOverlay = useCallback(() => setOverlay(null), []);
  const closeTopOverlay = useCallback(() => {
    if (overlay !== null) setOverlay(null);
    else starters.dismiss();
  }, [overlay, starters]);
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
    overlayOpen: overlay !== null || welcome.open,
    closeOverlay: closeTopOverlay,
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
        paletteDrag={paletteDrag}
        options={options}
      />
      <ToolHud snapshot={snapshot} play={playSnapshot} />
      <EditorHud snapshot={snapshot} />
      <ViewControls camera={camera} snapshot={snapshot} compact={compact} />
      <PlanPanel camera={camera} plans={plans} />
      <div className="side-panel">
        <WorldMenu editor={editor} snapshot={snapshot} starters={starters} />
        <PlacementToolbar
          editor={editor}
          snapshot={snapshot}
          play={playSnapshot}
          onEditorAction={runAction}
          onShellCommand={toggleOverlay}
        />
        <Minimap editor={editor} camera={camera} plans={plans} snapshot={snapshot} />
        <PlayPanel
          editor={editor}
          camera={camera}
          play={play}
          runningGear={runningGear}
          ready={snapshot.status === "ready"}
          checkingStuds={snapshot.studChecks > 0}
        />
        <PalettePanel
          editor={editor}
          snapshot={snapshot}
          search={paletteSearch}
          drag={paletteDrag}
          prefetch={palettePrefetch}
          memory={paletteMemory}
          thumbnails={paletteThumbnails}
        />
        <TrackPanel snapshot={snapshot} />
        <RoadDrawPanel editor={editor} snapshot={snapshot} />
        <Inspector snapshot={snapshot} />
        <RoadJoins editor={editor} snapshot={snapshot} />
        {snapshot.status === "ready" && (
          <BomPanel
            service={bomService}
            source={editor}
            region={null}
            selectionLabel={snapshot.selection?.item ?? null}
          />
        )}
      </div>
      {showState && <EditorState editor={editor} />}
      {showState && <PlanState plans={plans} />}
      <EditorFooter disclaimer={disclaimer} />
      {welcome.open && <WelcomeCard starters={starters} view={welcome} />}
      {overlay === "show-shortcuts" && <ShortcutSheet onClose={closeOverlay} />}
      {overlay === "open-palette" && (
        <CommandPalette
          editor={editor}
          camera={camera}
          play={play}
          search={paletteSearch}
          snapshot={snapshot}
          onClose={closeOverlay}
          onShellCommand={toggleOverlay}
        />
      )}
    </div>
  );
}
