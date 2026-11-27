import {
  heldItem,
  meshesSettled,
  placementFeedback,
  runEditorAction,
  type EditorActionId,
  type EditorOptions,
  type IAnnotationService,
  type IBomService,
  type IEditor,
  type IEditorCamera,
  type IEventDetails,
  type IHotbar,
  type ILayoutSize,
  type IOwnedParts,
  type IPalette,
  type IPanelLayout,
  type IPlanService,
  type IPlanSheetService,
  type ISheetSets,
  type ITableLibrary,
  type IRunningGear,
  type IScaleBar,
  type IStarterWorlds,
  type ITrainPlay,
  tallyText,
  type SelectionView,
  type ShellCommandId,
} from "@brr/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { BomPanel } from "./bom-panel.tsx";
import { CommandPalette } from "./command-palette.tsx";
import { EditorCanvas } from "./editor-canvas.tsx";
import { EditorFooter, EditorHud, PlacementToolbar, SelectionPanel } from "./editor-panels.tsx";
import { EventPanel } from "./event-panel.tsx";
import { LibraryColumn } from "./library-column.tsx";
import { Minimap } from "./minimap.tsx";
import { PalettePanel } from "./palette-panel.tsx";
import { PlacementChip } from "./placement-chip.tsx";
import { PlanPanel } from "./plan-panel.tsx";
import { PlanScaleBar } from "./plan-scale-bar.tsx";
import { SceneLabels } from "./scene-labels.tsx";
import { PlayPanel } from "./play-panel.tsx";
import { RoadDrawPanel } from "./road-draw-panel.tsx";
import { TrackExtendPanel, TrackHeightPanel, TrackLoopsPanel } from "./track-panel.tsx";
import { usePlaySnapshot } from "./use-play.ts";
import { ShortcutSheet } from "./shortcut-sheet.tsx";
import { ToolHud } from "./tool-hud.tsx";
import { useSafeArea } from "./safe-area.ts";
import { useCompactLayout } from "./use-compact-layout.ts";
import { useEditorSnapshot } from "./use-editor.ts";
import { useEditorKeys } from "./use-editor-keys.ts";
import { useAnnotationVersion } from "./use-annotation-version.ts";
import { usePlanVersion } from "./use-plan-version.ts";
import { useWelcome } from "./use-welcome.ts";
import { ViewControls } from "./view-controls.tsx";
import { WelcomeCard } from "./welcome-card.tsx";
import { WorldMenu } from "./world-menu.tsx";

function selectionLabel(selection: SelectionView | null): string | null {
  if (!selection) return null;
  const { members, primary } = selection;
  return members.length === 1 ? primary.item : tallyText(selection.tally);
}

interface EditorAppProps {
  readonly editor: IEditor;
  readonly camera: IEditorCamera;
  readonly scaleBar: IScaleBar;
  readonly plans: IPlanService;
  readonly annotations: IAnnotationService;
  readonly sheets: IPlanSheetService;
  readonly sheetSets: ISheetSets;
  readonly events: IEventDetails;
  readonly layoutSize: ILayoutSize;
  readonly tables: ITableLibrary;
  readonly bomService: IBomService;
  readonly ownedParts: IOwnedParts;
  readonly play: ITrainPlay;
  readonly palette: IPalette;
  readonly panels: IPanelLayout;
  readonly hotbar: IHotbar;
  readonly runningGear: IRunningGear;
  readonly starters: IStarterWorlds;
  readonly options: EditorOptions;
  readonly disclaimer: string;
  readonly showState: boolean;
}

function setsAsArrays(_key: string, value: unknown): unknown {
  return value instanceof Set ? [...value] : value;
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
      {JSON.stringify(
        {
          held,
          hover: snapshot.hover,
          placementMode: snapshot.placementMode,
          placementModeOverride: snapshot.placementModeOverride,
          latencies: snapshot.latencies,
          stats: snapshot.stats,
          measurement: snapshot.measurement,
          world: editor.dump(),
          routes: editor.trackRoutes(),
        },
        setsAsArrays,
      )}
    </pre>
  );
}

function NoteState({ annotations }: { readonly annotations: IAnnotationService }) {
  useAnnotationVersion(annotations);
  const notes = annotations.notes();
  return (
    <pre id="note-state" data-notes={notes.length}>
      {JSON.stringify(notes.map(({ id, note }) => ({ id, note, span: annotations.rulerSpan(id) })))}
    </pre>
  );
}

function CameraState({ camera }: { readonly camera: IEditorCamera }) {
  const dump = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const element = dump.current;
    if (!element) return;
    const view = camera.savedView();
    element.textContent = JSON.stringify(view);
    let frame = 0;
    const publish = (): void => {
      if (!camera.matchesView(view)) {
        camera.copyView(view);
        element.textContent = JSON.stringify(view);
      }
      frame = requestAnimationFrame(publish);
    };
    frame = requestAnimationFrame(publish);
    return () => cancelAnimationFrame(frame);
  }, [camera]);
  return <pre id="camera-state" ref={dump} />;
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
  annotations,
  sheets,
  sheetSets,
  events,
  layoutSize,
  tables,
  bomService,
  ownedParts,
  play,
  palette,
  panels,
  hotbar,
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
    hotbar,
    overlayOpen: overlay !== null || welcome.open,
    closeOverlay: closeTopOverlay,
  });
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useSafeArea(camera, root);
  const compact = useCompactLayout();
  const ghostTone = placementFeedback(snapshot)?.tone ?? "";
  return (
    <div
      ref={setRoot}
      className="editor"
      data-layout={compact ? "compact" : "wide"}
      data-status={snapshot.status}
      data-far-tier={snapshot.farTier}
      data-meshes={meshesSettled(snapshot.meshes) ? "settled" : "loading"}
      data-hover={snapshot.hover ? `${snapshot.hover.x},${snapshot.hover.z}` : ""}
      data-selection={snapshot.selection?.primary.item ?? ""}
      data-selection-count={snapshot.selection?.members.length ?? 0}
      data-gesture={snapshot.gesture?.kind ?? ""}
      data-ghost-rot={snapshot.ghostRot}
      data-ghost={ghostTone}
      data-snap={snapshot.snap?.state === "snapped" ? snapshot.snap.joinedCells : ""}
      data-snap-state={snapshot.snap?.state ?? ""}
      data-refused={snapshot.refusedClicks}
      data-road-joined={snapshot.roads.joinedCells}
      data-road-open={snapshot.roads.openCells}
      data-road-mismatch={snapshot.roads.mismatchedCells}
      data-world={snapshot.world?.id ?? ""}
      data-save={snapshot.world?.save ?? ""}
      data-unsaved={snapshot.unsavedEdits ? "1" : "0"}
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
      <SceneLabels editor={editor} snapshot={snapshot} />
      <ToolHud snapshot={snapshot} play={playSnapshot} hotbar={hotbar} />
      <PlacementChip snapshot={snapshot} />
      <ViewControls camera={camera} snapshot={snapshot} compact={compact} />
      <LibraryColumn panels={panels}>
        <PalettePanel editor={editor} snapshot={snapshot} palette={palette} />
      </LibraryColumn>
      <PlanScaleBar scaleBar={scaleBar} />
      <div className="side-panel">
        <WorldMenu editor={editor} snapshot={snapshot} starters={starters} />
        <PlacementToolbar
          editor={editor}
          snapshot={snapshot}
          play={playSnapshot}
          onEditorAction={runAction}
          onShellCommand={toggleOverlay}
        />
        <RoadDrawPanel editor={editor} snapshot={snapshot} />
        <TrackHeightPanel editor={editor} snapshot={snapshot} />
        <TrackExtendPanel editor={editor} snapshot={snapshot} />
        <TrackLoopsPanel editor={editor} snapshot={snapshot} />
        <SelectionPanel
          editor={editor}
          snapshot={snapshot}
          play={playSnapshot}
          onEditorAction={runAction}
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
        <EventPanel
          events={events}
          size={layoutSize}
          editable={snapshot.status === "ready" && !snapshot.readOnly}
        />
        <PlanPanel
          camera={camera}
          editor={editor}
          drawing={snapshot.mode === "table"}
          held={heldItem(snapshot)}
          fillGridStuds={snapshot.fillGridStuds}
          plans={plans}
          sheets={sheets}
          sheetSets={sheetSets}
          ready={snapshot.status === "ready"}
          readOnly={snapshot.readOnly}
          library={tables}
          armedType={snapshot.armedTable?.typeId ?? null}
        />
        {snapshot.status === "ready" && (
          <BomPanel
            service={bomService}
            ownedParts={ownedParts}
            source={editor}
            region={null}
            selectionLabel={selectionLabel(snapshot.selection)}
            plans={plans}
          />
        )}
        <EditorHud editor={editor} snapshot={snapshot} panels={panels} />
      </div>
      {showState && <EditorState editor={editor} />}
      {showState && <PlanState plans={plans} />}
      {showState && <NoteState annotations={annotations} />}
      {showState && <CameraState camera={camera} />}
      <EditorFooter disclaimer={disclaimer} />
      {welcome.open && <WelcomeCard starters={starters} view={welcome} />}
      {overlay === "show-shortcuts" && <ShortcutSheet onClose={closeOverlay} />}
      {overlay === "open-palette" && (
        <CommandPalette
          editor={editor}
          camera={camera}
          play={play}
          search={palette.commandSearch}
          snapshot={snapshot}
          onClose={closeOverlay}
          onShellCommand={toggleOverlay}
        />
      )}
    </div>
  );
}
