export type {
  BackendInfo,
  BufferMemory,
  ChunkTier,
  FrameStats,
  GraphicsApi,
  LookFeature,
  LookSettings,
  RebaseEvent,
  SceneBackendConfig,
} from "@brr/render";
export {
  DEFAULT_LOOK_FEATURES,
  LOOK_FEATURES,
  PROJECTED_IN_VIEW,
  PROJECTED_NDC_X,
  PROJECTED_NDC_Y,
  PROJECTION_FLOATS,
} from "@brr/render";
export { mainThreadModules, type MainThreadConfig } from "./client.module.ts";
export type {
  FarModelSummary,
  IViewerScene,
  ModelCredit,
  SceneSummary,
  TrackSummary,
} from "./scene/viewer-scene.ts";
export type { ITrackScene } from "./scene/track-scene.ts";
export type { IModelScene, ModelCamera, ModelView } from "./scene/model-scene.ts";
export type { ICredits } from "./credits/credits-service.ts";
export {
  licenseText,
  setTitle,
  sourceText,
  type AuthorCredit,
  type BundleBuild,
  type CreditCounts,
  type CreditedFile,
  type CreditsView,
  type DataPackageCredit,
  type DataSourceCredit,
  type GeneratedModelCredit,
  type LicenseGroup,
  type SetCredit,
} from "./credits/credits-view.ts";
export type {
  CatalogColorView,
  CatalogItemModel,
  CatalogItemView,
  ICatalogAssets,
  IPlaceableCatalog,
  ImportOutcome,
  SkippedCatalogModel,
  StartedCatalog,
} from "./catalog/placeable-catalog.ts";
export type {
  EditorStats,
  FrameLoopView,
  FrameMeasurement,
  FrameTimes,
  IEditorFrameLoop,
} from "./edit/editor-frame-loop.ts";
export type {
  EditAction,
  EditorCredits,
  EditorDump,
  EditorMode,
  EditorOptions,
  EditorSnapshot,
  EditorStatus,
  FillResult,
  GestureView,
  HistoryView,
  HoverView,
  IEditor,
  LatencySample,
  ModelBakeView,
  ModelImportStatus,
  ModelImportView,
  ModelSelectionView,
  RailTrainView,
  RoadIssueView,
  RoadJoinView,
  RoadPlacementDump,
  RefusedClick,
  RoadSnapState,
  RoadSnapView,
  PlaceableCoverView,
  QueuedPlacement,
  SelectDragKind,
  SelectionItemView,
  SelectionTally,
  SelectionView,
  TrackSelectionView,
  TrainSelectionView,
} from "./edit/editor.ts";
export type {
  CatalogPartView,
  TrackCommitResult,
  TrackHeightView,
  TrackPieceView,
  TrackView,
} from "./edit/track-edit-session.ts";
export type { TrackBomLine } from "./edit/track-drawing.ts";
export type { TrackPathScope } from "./edit/track-path-selection.ts";
export type { TrackSolveStats } from "./edit/solve-samples.ts";
export type {
  CrossingRampView,
  CrossingView,
  TrackLowClearanceView,
  TrackUnsupportedView,
} from "./edit/track-world.ts";
export type { RoadStrokeResult } from "./edit/road-edit-session.ts";
export { heldItem, type HeldItemView, type HeldTables } from "./edit/held-item.ts";
export type { FillView } from "./edit/fill-tool.ts";
export type {
  ExportedWorld,
  ModelFileInput,
  SaveState,
  WorldFileView,
} from "./edit/world-session.ts";
export type { RoadShape } from "@brr/domain";
export type {
  RoadKitView,
  RoadStrandedTile,
  RoadStrokeView,
  RoadTileIssue,
  RoadTileProblem,
} from "./edit/road-drawing.ts";
export type { IModelImporter } from "./import/worker-model-importer.ts";
export type {
  IImportWorkerPool,
  ImportRun,
  ImportWorkerFactory,
} from "./import/import-worker-pool.ts";
export type { IImportScene, ImportedModule, ModulePlacement } from "./scene/import-scene.ts";
export type {
  ImportReport,
  ImportResult,
  PartResolution,
  StudioPart,
  StudioReport,
} from "@brr/import";
export type {
  GearBox,
  GearCoupler,
  GearModelView,
  GearSnapshot,
  GearView,
  IRunningGear,
  RunningGearSource,
} from "./running-gear/running-gear-editor.ts";
export { exactLduText } from "./running-gear/running-gear-editor.ts";
export type { ISimClient } from "./sim/sim-client.ts";
export type { RpcPort } from "@brr/rpc";
export { MM_PER_STUD, STUD_LDU, ZETA16_ORDER, lduFromMm } from "@brr/math";
export { NO_ROW, lowestFreeTableNumber, placedTableCounts, tableName } from "@brr/domain";
export {
  DEFAULT_MAX_OVERHANG_MM,
  DEFAULT_MAX_REACH_MM,
  DEFAULT_TABLE_HEIGHT_MM,
  type IPlanService,
  type NewPlan,
  type PlanPatch,
  type PlanPlacementsView,
  type PlanRowSegment,
  type TableInput,
  type TableTypeInput,
  type VenueInput,
} from "./plan/plan-service.ts";
export type { IAnnotationService, NoteContents, NoteDocument } from "./notes/annotation-service.ts";
export {
  DEFAULT_NOTE_STYLE,
  TEXT_ALONG_OFFSET,
  TEXT_PROJECTION_FLOATS,
  TEXT_UP_OFFSET,
  type INoteEditSession,
  type NoteEditView,
  type NoteTextView,
  type NoteToolView,
  type RulerEndView,
  type SelectedNoteView,
} from "./notes/note-edit-session.ts";
export {
  NOTE_TOOL_KINDS,
  noteToolOf,
  type NoteDraftKind,
  type NoteStyle,
  type NoteToolKind,
} from "./notes/note-tool.ts";
export { TEXT_LINE_HEIGHT_EM } from "./notes/text-frame.ts";
export type { NoteBody, NoteEntry, NoteSpan, NoteState } from "@brr/domain";
export { AISLE_SIDES, OBSTACLE_KINDS, UNSTATED_OBSTACLE_KIND } from "@brr/schema/world";
export type { ILayerService } from "./layers/layer-service.ts";
export type { LayerTable } from "@brr/domain";
export {
  NOT_YET_ASSIGNED,
  UNCHECKED_PLAN_RULES,
  buildableAsPlanned,
  type UncheckedPlanRule,
} from "./plan/plan-verdict.ts";
export type {
  IPlanSheetService,
  IPlanSheetSource,
  PlanSheetShapes,
} from "./plan/plan-sheet-service.ts";
export {
  DEFAULT_OVERLAP_MM,
  DEFAULT_PIXELS_PER_STUD,
  MAX_OVERLAP_MM,
  MAX_PIXELS_PER_STUD,
  MIN_OVERLAP_MM,
  MIN_PIXELS_PER_STUD,
  sheetLayoutProblems,
  type SheetContent,
  type SheetFile,
  type SheetFormat,
  type SheetLayout,
  type SheetRequest,
  type SheetSelection,
} from "./sheets/sheet-document.ts";
export { SHEET_LAYER_IDS, type SheetLayerId } from "./sheets/plan-drawing.ts";
export type { ISheetSets, SheetSet, SheetSetPatch } from "./sheets/sheet-sets.ts";
export { TILED_SCALE_DENOMINATORS, scaleText } from "./sheets/drawing-scale.ts";
export {
  PAPER_SIZES,
  type OrientationChoice,
  type PaperId,
  type PaperSize,
} from "./sheets/paper.ts";
export {
  EVENT_COMMENT_MAX_LENGTH,
  EVENT_FIELDS,
  EVENT_LABEL_MAX_LENGTH,
  eventDraft,
  type EventDraft,
  type EventEdit,
  type EventField,
  type EventFieldIssue,
  type IEventDetails,
} from "./event/event-details.ts";
export {
  STUDS_PER_MODULE,
  sizeMeasures,
  type ILayoutSize,
  type LayoutSize,
  type SizeMeasure,
  type SizeUnit,
} from "./event/layout-size.ts";
export type {
  IssueSeverity,
  LduRect,
  MmRect,
  PlacementKey,
  PlanCheck,
  PlanAisle,
  PlanArea,
  PlanIssue,
  PlanObstacle,
  PlanPlacement,
  PlanRegion,
  PlanRuleId,
  PlanTable,
  TableTop,
  TableTurn,
  TableType,
  VenueItems,
  VenueList,
} from "@brr/domain";
export {
  ANNOTATION_SERVICE,
  NOTE_EDIT_SESSION,
  RUNNING_GEAR,
  BOM_SERVICE,
  OWNED_PARTS,
  CATALOG_SEARCH,
  CREDITS,
  EDITOR,
  EDITOR_CAMERA,
  IMPORT_SCENE,
  IMPORT_WORKER_POOL,
  LIBRARY_PART_PLACER,
  LIBRARY_PART_SEARCH,
  MODEL_IMPORTER,
  MODEL_SCENE,
  PALETTE,
  PANEL_LAYOUT,
  SIM_CLIENT,
  TRACK_SCENE,
  TRAIN_PLAY,
  PLAN_SERVICE,
  PLAN_SHEET_SERVICE,
  SHEET_SETS,
  EVENT_DETAILS,
  LAYOUT_SIZE,
  LAYER_SERVICE,
  HOTBAR,
  NOTICES,
  SCALE_BAR,
  STARTER_WORLDS,
} from "./tokens.ts";
export type {
  ITrainPlay,
  PlaySnapshot,
  PlayStatus,
  PlaySwitchView,
  PlayTrainView,
} from "./play/train-play.ts";
export type {
  IStarterWorlds,
  StarterShelfStatus,
  StarterWorldView,
  WelcomeView,
} from "./starters/starter-worlds.ts";
export { TRACK_BLUEPRINT_GROUP, TRACK_ITEM_ID } from "./edit/track-edit-session.ts";
export type {
  RollingDiagnosticsPanel,
  RollingDiagnosticsPartView,
  RollingDiagnosticsRowView,
} from "./inspect/rolling-diagnostics.ts";
export type {
  AssistNeighbourhood,
  ConnectorGender,
  ConnectorKindView,
  ConnectorSectionView,
  HoverMateCount,
  HoverRefusalHit,
  HoverWait,
  MagnetOffset,
  PlacedModelView,
  PlacementHover,
  PlacementMode,
  SectionProfile,
} from "./edit/placement-hover.ts";
export { distinctJoints } from "./edit/placement-hover.ts";
export {
  effectivePlacementMode,
  holdPlacementModeOverride,
  otherPlacementMode,
  placementModeSwitchEnabled,
  togglePlacementMode,
  type PlacementModeView,
} from "./edit/placement-mode.ts";
export {
  badgeText,
  placementFeedback,
  showsLate,
  type BadgeCount,
  type ConnectorBadge,
  type PlacementFeedback,
  type PlacementLine,
  type PlacementLineKind,
  type PlacementTone,
} from "./edit/placement-feedback.ts";
export {
  meshesSettled,
  type MeshCounts,
  type MeshProgress,
  type UndrawnPart,
} from "./edit/mesh-progress.ts";
export {
  COMMAND_GROUPS,
  COMMANDS,
  POINTER_GESTURES,
  commandActive,
  commandEnabled,
  commandForKey,
  commandSpec,
  isHotbarCommand,
  isPlayCommand,
  isShellCommand,
  playCommandEnabled,
  runsDuringPlay,
  PLAY_THROTTLE_STEP_LDU_PER_S,
  runEditorAction,
  runPlayAction,
  shellModeCommand,
  startPlay,
  type CommandGroup,
  type CommandId,
  type CommandSpec,
  type EditorActionId,
  type PlayCommandId,
  type PointerGesture,
  type ShellCommandId,
} from "./commands/editor-commands.ts";
export {
  SHELL_MODES,
  enterShellMode,
  shellModeForTool,
  shellModeOffered,
  shownShellMode,
  type ShellMode,
} from "./commands/shell-mode.ts";
export { PINNED_SLOTS, type Hotbar, type IHotbar } from "./commands/hotbar.ts";
export {
  modelImportText,
  modelImportWarns,
  type INotices,
  type Notice,
  type NoticeTone,
} from "./edit/notices.ts";
export { hotbarView, type HotbarFootprint, type HotbarSlotView } from "./commands/hotbar-view.ts";
export { trackBlockText } from "./edit/track-drag.ts";
export type { TallestTrain } from "./trains/tallest-train.ts";
export {
  TOO_STEEP,
  libraryPieceEndText,
  lowClearanceText,
  tallyText,
  toolHints,
  unjoinedText,
  type ToolHint,
  type ToolHintView,
  type ToolSpeech,
  type ToolTone,
} from "./commands/tool-hints.ts";
export type { CommandResult, ItemResult, PaletteResult } from "./commands/command-search.ts";
export type {
  CommandPaletteSnapshot,
  ICommandPaletteSearch,
} from "./commands/command-palette-search.ts";
export {
  altKeyName,
  chordKeys,
  chordText,
  keyPlatform,
  type KeyChord,
  type KeyInput,
  type KeyPlatform,
} from "./commands/key-chord.ts";
export { FOOTPRINT_FLOATS } from "./camera/editor-camera.ts";
export type { IScaleBar, ScaleBarView } from "./camera/scale-bar.ts";
export { overviewOf, type OverviewView } from "./camera/overview.ts";
export {
  PANEL_GAP_PX,
  safeInsets,
  type SafeInsets,
  type ScreenRect,
} from "./camera/safe-insets.ts";
export type {
  CameraSnapshot,
  IEditorCamera,
  ScrollGesture,
  ViewMode,
  WheelInput,
} from "./camera/editor-camera.ts";
export type {
  ClosureState,
  TrackBlockView,
  TrackDragView,
  SwitchLeverView,
  TrackEndView,
  TrackGapView,
  TrackRouteView,
  LoopClosureView,
  LoopPartCount,
  TrackLoopsView,
} from "./edit/track-drawing.ts";
export { MM_PER_CM, cmText, heightText, studsText } from "./edit/size-labels.ts";
export type { LabelKind, LabelView } from "./edit/size-labels.ts";
export type {
  ExtensionKind,
  ExtensionTurn,
  TrackChoicePiece,
  TrackChoiceView,
  TrackExtendView,
  UnjoinedEndView,
} from "./edit/track-extension.ts";
export type { StudTotals } from "./edit/placed-chunks.ts";
export {
  CATEGORY_LABEL,
  PALETTE_CATEGORIES,
  PALETTE_TABS,
  colorDisplayName,
} from "./catalog/palette-index.ts";
export type {
  PaletteCategory,
  PaletteColorChoice,
  PaletteEntry,
  PaletteFilter,
  PaletteTab,
} from "./catalog/palette-index.ts";
export type { LibraryFilterScope } from "./catalog/library-filters.ts";
export type {
  IPaletteSearch,
  PaletteColors,
  PaletteRow,
  PaletteSearchSnapshot,
  PaletteSection,
  PaletteShelf,
} from "./catalog/palette-search.ts";
export type { IPaletteDrag } from "./catalog/palette-drag.ts";
export type { IPalettePrefetch } from "./catalog/palette-prefetch.ts";
export { CATALOG_SEARCH_DEBOUNCE_MS } from "./catalog/catalog-search.ts";
export type {
  CatalogSearchStatus,
  CatalogSearchView,
  ICatalogSearch,
} from "./catalog/catalog-search.ts";
export type { Lever } from "./edit/track-pieces.ts";
export type {
  BillOfMaterials,
  BomFiles,
  BomInput,
  BomScope,
  IBomService,
  IBomSource,
  OwnVsBuyReport,
} from "./bom/bom-service.ts";
export { SHOPPING_SECTION_LABEL } from "./bom/shopping-list.ts";
export type {
  ShoppingGroup,
  ShoppingLine,
  ShoppingList,
  ShoppingSection,
} from "./bom/shopping-list.ts";
export type { IOwnedParts, OwnedPartsView, TextFile } from "./bom/owned-parts-service.ts";
export type {
  CatalogBom,
  CatalogLine,
  OwnedParts,
  PlacementRegion,
  UnknownOwnedPart,
  UnmappedLine,
} from "@brr/domain";
export type { IPaletteMemory } from "./catalog/palette-memory.ts";
export type { LibraryPartHit, LibraryPartView } from "./catalog/library-part-index.ts";
export type {
  ILibraryPartSearch,
  LibrarySearchStatus,
  LibrarySearchView,
} from "./catalog/library-part-search.ts";
export type {
  ILibraryPartPlacer,
  LibraryPlacementRefusal,
  LibraryPlacementTarget,
  LibraryPlacementView,
} from "./catalog/library-part-placer.ts";
export type { OmrModelView, OmrSetView } from "./catalog/omr-set-index.ts";
export type { OmrSetSearchView } from "./catalog/omr-set-search.ts";
export type { IOmrSetPlacer, OmrPlacementView } from "./catalog/omr-set-placer.ts";
export type { IPaletteThumbnails } from "./catalog/palette-thumbnails.ts";
export type { IPalette } from "./catalog/palette.ts";
export type { IPanelLayout, PanelId } from "./panels/panel-layout.ts";
