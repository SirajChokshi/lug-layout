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
export { DEFAULT_LOOK_FEATURES, LOOK_FEATURES } from "@brr/render";
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
  CatalogPartView,
  EditAction,
  EditorCredits,
  EditorDump,
  EditorMode,
  EditorOptions,
  EditorSnapshot,
  EditorStatus,
  HistoryView,
  HoverView,
  IEditor,
  LatencySample,
  ModelBakeView,
  ModelImportStatus,
  ModelImportView,
  RoadIssueView,
  RoadJoinView,
  RoadStrokeResult,
  RoadPlacementDump,
  RefusedClick,
  RoadSnapState,
  RoadSnapView,
  PlaceableCoverView,
  SelectionView,
  TrackBomLine,
  TrackCommitResult,
  TrackPieceView,
  TrackSolveStats,
  TrackView,
} from "./edit/editor.ts";
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
export { MM_PER_STUD, STUD_LDU } from "@brr/math";
export { NO_ROW } from "@brr/domain";
export {
  DEFAULT_MAX_OVERHANG_MM,
  PLAN_GRID_MM,
  type IPlanService,
  type NewPlan,
  type ObstacleInput,
  type PlanPatch,
  type PlanPlacementsView,
  type TableInput,
} from "./plan/plan-service.ts";
export type {
  IssueSeverity,
  LduRect,
  MmRect,
  PlacementKey,
  PlanCheck,
  PlanIssue,
  PlanObstacle,
  PlanPlacement,
  PlanRegion,
  PlanRuleId,
  PlanTable,
  TableTop,
} from "@brr/domain";
export {
  RUNNING_GEAR,
  BOM_SERVICE,
  CATALOG_SEARCH,
  CREDITS,
  EDITOR,
  EDITOR_CAMERA,
  IMPORT_SCENE,
  IMPORT_WORKER_POOL,
  MODEL_IMPORTER,
  MODEL_SCENE,
  PALETTE_DRAG,
  PALETTE_PREFETCH,
  PALETTE_SEARCH,
  SIM_CLIENT,
  TRACK_SCENE,
  TRAIN_PLAY,
  PLAN_SERVICE,
  PALETTE_MEMORY,
  PALETTE_THUMBNAILS,
} from "./tokens.ts";
export type { ITrainPlay, PlaySnapshot, PlayStatus, PlaySwitchView } from "./play/train-play.ts";
export type { PlaySetup } from "./play/play-models.ts";
export { TRACK_ITEM_ID } from "./edit/editor.ts";
export { meshesSettled, type MeshCounts, type MeshProgress } from "./edit/mesh-progress.ts";
export {
  COMMAND_GROUPS,
  COMMANDS,
  POINTER_GESTURES,
  commandActive,
  commandEnabled,
  commandForKey,
  commandSpec,
  isPlayCommand,
  isShellCommand,
  playCommandEnabled,
  runsDuringPlay,
  PLAY_THROTTLE_STEP_LDU_PER_S,
  runEditorAction,
  runPlayAction,
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
  toolHints,
  type ToolHint,
  type ToolHintView,
  type ToolTone,
} from "./commands/tool-hints.ts";
export type { CommandResult, ItemResult, PaletteResult } from "./commands/command-search.ts";
export {
  chordKeys,
  chordText,
  keyPlatform,
  type KeyChord,
  type KeyInput,
  type KeyPlatform,
} from "./commands/key-chord.ts";
export { FOOTPRINT_FLOATS } from "./camera/editor-camera.ts";
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
  TrackDragView,
  SwitchLeverView,
  TrackEndView,
  TrackGapView,
  TrackRouteView,
} from "./edit/track-drawing.ts";
export type { StudTotals } from "./edit/placed-chunks.ts";
export { CATEGORY_LABEL, PALETTE_CATEGORIES, colorDisplayName } from "./catalog/palette-index.ts";
export type {
  PaletteCategory,
  PaletteColorChoice,
  PaletteEntry,
  PaletteFilter,
} from "./catalog/palette-index.ts";
export type {
  IPaletteSearch,
  PaletteColors,
  PaletteRow,
  PaletteSearchSnapshot,
  PaletteSection,
  PaletteTab,
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
} from "./bom/bom-service.ts";
export type { CatalogBom, CatalogLine, PlacementRegion, UnmappedLine } from "@brr/domain";
export type { IPaletteMemory } from "./catalog/palette-memory.ts";
export type { IPaletteThumbnails } from "./catalog/palette-thumbnails.ts";
