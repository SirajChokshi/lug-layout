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
export type { CityCamera, CityRequest, ICityScene } from "./scene/city-scene.ts";
export type { ILayoutScene, LayoutRequest } from "./scene/layout-scene.ts";
export type { PlacementDump } from "./scene/placements.ts";
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
  type DataSourceCredit,
  type GeneratedModelCredit,
  type LicenseGroup,
  type SetCredit,
} from "./credits/credits-view.ts";
export type {
  CatalogColorView,
  CatalogItemView,
  CatalogPartView,
  EditAction,
  EditorCredits,
  EditorDump,
  EditorMode,
  EditorOptions,
  EditorSnapshot,
  EditorStats,
  EditorStatus,
  HistoryView,
  HoverView,
  ExportedWorld,
  FrameMeasurement,
  IEditor,
  LatencySample,
  ModuleFitView,
  ModuleIssueView,
  ModuleJoinView,
  RoadIssueView,
  RoadJoinView,
  RoadPlacementDump,
  RefusedClick,
  RoadSnapState,
  RoadSnapView,
  PlaceableCoverView,
  SaveState,
  SelectionView,
  SkippedCatalogModel,
  TrackBomLine,
  TrackCommitResult,
  TrackPieceView,
  TrackSolveStats,
  TrackView,
  WorldFileView,
} from "./edit/editor.ts";
export type { IModelImporter, ImportWorkerFactory } from "./import/worker-model-importer.ts";
export type { IImportScene, ImportedModule, ModulePlacement } from "./scene/import-scene.ts";
export type { ImportReport, ImportResult, PartResolution, PartResolutionKind } from "@brr/import";
export type {
  IRunScene,
  RunRequest,
  RunStatus,
  RunVehicleStatus,
  TrainRequest,
} from "./scene/run-scene.ts";
export type { ConsistEntry } from "./sim/consist.ts";
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
export type { ISimClient, SimTickCost } from "./sim/sim-client.ts";
export type { RpcPort } from "@brr/rpc";
export type { SimBenchResult } from "@brr/sim";
export { MM_PER_STUD } from "@brr/math";
export {
  DEFAULT_MAX_OVERHANG_MM,
  PLAN_GRID_MM,
  type IPlanService,
  type NewPlan,
  type ObstacleInput,
  type PlacedForPlan,
  type PlanPatch,
  type PlanSnapshot,
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
  CITY_SCENE,
  CREDITS,
  EDITOR,
  EDITOR_CAMERA,
  IMPORT_SCENE,
  LAYOUT_SCENE,
  MODEL_IMPORTER,
  MODEL_SCENE,
  PART_DISPLAY_SCENE,
  RUN_SCENE,
  SIM_CLIENT,
  TRACK_SCENE,
  PLAN_SERVICE,
} from "./tokens.ts";
export { TRACK_ITEM_ID, TRACK_PIECE_PREFIX } from "./edit/editor.ts";
export {
  COMMAND_GROUPS,
  COMMANDS,
  POINTER_GESTURES,
  commandActive,
  commandEnabled,
  commandForKey,
  commandSpec,
  isShellCommand,
  runEditorAction,
  type CommandGroup,
  type CommandId,
  type CommandSpec,
  type EditorActionId,
  type PointerGesture,
  type ShellCommandId,
} from "./commands/editor-commands.ts";
export {
  toolHints,
  type ToolHint,
  type ToolHintView,
  type ToolTone,
} from "./commands/tool-hints.ts";
export {
  searchPalette,
  type CommandResult,
  type ItemResult,
  type PaletteResult,
  type PaletteSources,
} from "./commands/command-search.ts";
export {
  chordKeys,
  chordText,
  keyPlatform,
  type KeyChord,
  type KeyInput,
  type KeyPlatform,
} from "./commands/key-chord.ts";
export { FOOTPRINT_FLOATS } from "./camera/editor-camera.ts";
export { overviewOf, type OverviewItem, type OverviewView } from "./camera/overview.ts";
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
export {
  CATEGORY_LABEL,
  PALETTE_CATEGORIES,
  PaletteIndex,
  colorChoices,
  colorDisplayName,
  inColorOrder,
  itemInColor,
} from "./catalog/palette-index.ts";
export type {
  PaletteCategory,
  PaletteColorChoice,
  PaletteEntry,
  PaletteFilter,
  PaletteHit,
  PaletteTerms,
} from "./catalog/palette-index.ts";
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
