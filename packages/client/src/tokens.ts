import type {
  ConnectionSolver,
  LatticeStudFinder,
  SnapMating,
  SnapShapes,
  SparseConnectorFinder,
  TrackEndFinder,
} from "@brr/domain";
import type { RpcPort } from "@brr/rpc";
import type { ServiceIdentifier } from "inversify";
import type { IEditorCamera } from "./camera/editor-camera.ts";
import type { IScaleBar } from "./camera/scale-bar.ts";
import type { ICatalogSearch } from "./catalog/catalog-search.ts";
import type { ILibraryPartPlacer } from "./catalog/library-part-placer.ts";
import type { ILibraryPartSearch } from "./catalog/library-part-search.ts";
import type { IPalette } from "./catalog/palette.ts";
import type { IPaletteCatalog } from "./catalog/palette-catalog.ts";
import type { IPaletteDrag } from "./catalog/palette-drag.ts";
import type { IPaletteMemory, IPaletteMemoryStore } from "./catalog/palette-memory.ts";
import type { ILibraryFilterStore } from "./catalog/library-filters.ts";
import type { IPalettePrefetch } from "./catalog/palette-prefetch.ts";
import type { IPaletteSearch } from "./catalog/palette-search.ts";
import type { IPaletteThumbnails } from "./catalog/palette-thumbnails.ts";
import type { IPlaceableCatalog } from "./catalog/placeable-catalog.ts";
import type { ICommandPaletteSearch } from "./commands/command-palette-search.ts";
import type { IHotbar } from "./commands/hotbar.ts";
import type { IConnectorTables } from "./connect/connector-tables.ts";
import type { IPlacementSearch } from "./connect/placement-search.ts";
import type { ICredits } from "./credits/credits-service.ts";
import type { IEditor } from "./edit/editor.ts";
import type { IEditorFrameLoop } from "./edit/editor-frame-loop.ts";
import type { IRoadEditSession } from "./edit/road-edit-session.ts";
import type { ITrackEditSession } from "./edit/track-edit-session.ts";
import type { ITrackPathSelection } from "./edit/track-path-selection.ts";
import type { ITrackWorld } from "./edit/track-world.ts";
import type { IWorldSession } from "./edit/world-session.ts";
import type { IEventDetails } from "./event/event-details.ts";
import type { ILayoutSize } from "./event/layout-size.ts";
import type { ITableGround } from "./ground/table-ground.ts";
import type { IUnderlayService } from "./underlay/underlay-service.ts";
import type { IImportWorkerPool, ImportWorkerFactory } from "./import/import-worker-pool.ts";
import type { IModelImporter } from "./import/worker-model-importer.ts";
import type { IPanelLayout, IPanelLayoutStore } from "./panels/panel-layout.ts";
import type { IAnnotationService } from "./notes/annotation-service.ts";
import type { IPlanService } from "./plan/plan-service.ts";
import type { IPlanSheetService } from "./plan/plan-sheet-service.ts";
import type { IPlanDrawing } from "./sheets/plan-drawing.ts";
import type { ISheetComposer } from "./sheets/sheet-composer.ts";
import type { ISheetWriter } from "./sheets/sheet-document.ts";
import type { ISheetSets } from "./sheets/sheet-sets.ts";
import type { ISheetTypeface } from "./sheets/sheet-typeface.ts";
import type { ISvgSheetWriter } from "./sheets/svg-sheet-writer.ts";
import type { ISheetTiler } from "./sheets/tile-grid.ts";
import type { IBomService } from "./bom/bom-service.ts";
import type { IOwnedParts } from "./bom/owned-parts-service.ts";
import type { IRunningGearOverrideStore } from "./running-gear/override-store.ts";
import type { IRunningGear } from "./running-gear/running-gear-editor.ts";
import type { IImportScene } from "./scene/import-scene.ts";
import type { IModelScene } from "./scene/model-scene.ts";
import type { ITrackScene } from "./scene/track-scene.ts";
import type { ISimClient } from "./sim/sim-client.ts";
import type { ITrainPlay } from "./play/train-play.ts";
import type { IRailYard } from "./trains/rail-yard.ts";
import type { ITallestTrain } from "./trains/tallest-train.ts";
import type { ITrackPiers } from "./edit/track-piers.ts";
import type { IVehicleIds } from "./trains/vehicle-ids.ts";
import type { IStarterFiles } from "./starters/starter-files.ts";
import type { IStarterWorlds } from "./starters/starter-worlds.ts";

export const MODEL_SCENE: ServiceIdentifier<IModelScene> = Symbol.for("brr.client.ModelScene");
export const TRACK_SCENE: ServiceIdentifier<ITrackScene> = Symbol.for("brr.client.TrackScene");
export const EDITOR: ServiceIdentifier<IEditor> = Symbol.for("brr.client.Editor");
export const WORLD_SESSION: ServiceIdentifier<IWorldSession> =
  Symbol.for("brr.client.WorldSession");
export const PLACEABLE_CATALOG: ServiceIdentifier<IPlaceableCatalog> = Symbol.for(
  "brr.client.PlaceableCatalog",
);
export const EDITOR_FRAME_LOOP: ServiceIdentifier<IEditorFrameLoop> = Symbol.for(
  "brr.client.EditorFrameLoop",
);
export const TRACK_WORLD: ServiceIdentifier<ITrackWorld> = Symbol.for("brr.client.TrackWorld");
export const TRACK_EDIT_SESSION: ServiceIdentifier<ITrackEditSession> = Symbol.for(
  "brr.client.TrackEditSession",
);
export const TRACK_PATH_SELECTION: ServiceIdentifier<ITrackPathSelection> = Symbol.for(
  "brr.client.TrackPathSelection",
);
export const ROAD_EDIT_SESSION: ServiceIdentifier<IRoadEditSession> = Symbol.for(
  "brr.client.RoadEditSession",
);
export const EDITOR_CAMERA: ServiceIdentifier<IEditorCamera> =
  Symbol.for("brr.client.EditorCamera");
export const SCALE_BAR: ServiceIdentifier<IScaleBar> = Symbol.for("brr.client.ScaleBar");
export const TABLE_GROUND: ServiceIdentifier<ITableGround> = Symbol.for("brr.client.TableGround");
export const CREDITS: ServiceIdentifier<ICredits> = Symbol.for("brr.client.Credits");
export const CATALOG_SEARCH: ServiceIdentifier<ICatalogSearch> = Symbol.for(
  "brr.client.CatalogSearch",
);
export const COMMAND_CATALOG_SEARCH: ServiceIdentifier<ICatalogSearch> = Symbol.for(
  "brr.client.CommandCatalogSearch",
);
export const PALETTE_CATALOG: ServiceIdentifier<IPaletteCatalog> = Symbol.for(
  "brr.client.PaletteCatalog",
);
export const PALETTE_SEARCH: ServiceIdentifier<IPaletteSearch> = Symbol.for(
  "brr.client.PaletteSearch",
);
export const COMMAND_PALETTE_SEARCH: ServiceIdentifier<ICommandPaletteSearch> = Symbol.for(
  "brr.client.CommandPaletteSearch",
);
export const LIBRARY_PART_SEARCH: ServiceIdentifier<ILibraryPartSearch> = Symbol.for(
  "brr.client.LibraryPartSearch",
);
export const LIBRARY_PART_PLACER: ServiceIdentifier<ILibraryPartPlacer> = Symbol.for(
  "brr.client.LibraryPartPlacer",
);
export const PALETTE_DRAG: ServiceIdentifier<IPaletteDrag> = Symbol.for("brr.client.PaletteDrag");
export const PALETTE_PREFETCH: ServiceIdentifier<IPalettePrefetch> = Symbol.for(
  "brr.client.PalettePrefetch",
);
export const IMPORT_WORKER_FACTORY: ServiceIdentifier<ImportWorkerFactory> = Symbol.for(
  "brr.client.ImportWorkerFactory",
);
export const LIBRARY_BAKE_BASE_URL: ServiceIdentifier<string | null> = Symbol.for(
  "brr.client.LibraryBakeBaseUrl",
);
export const LIBRARY_CONNECTORS_BASE_URL: ServiceIdentifier<string | null> = Symbol.for(
  "brr.client.LibraryConnectorsBaseUrl",
);
export const SHADOW_LIBRARY_BASE_URL: ServiceIdentifier<string | null> = Symbol.for(
  "brr.client.ShadowLibraryBaseUrl",
);
export const LDRAW_LIBRARY_BASE_URL: ServiceIdentifier<string | null> = Symbol.for(
  "brr.client.LdrawLibraryBaseUrl",
);
export const IMPORT_BAKE_HELPERS: ServiceIdentifier<number> = Symbol.for(
  "brr.client.ImportBakeHelpers",
);
export const IMPORT_WORKER_POOL: ServiceIdentifier<IImportWorkerPool> = Symbol.for(
  "brr.client.ImportWorkerPool",
);
export const MODEL_IMPORTER: ServiceIdentifier<IModelImporter> = Symbol.for(
  "brr.client.ModelImporter",
);
export const IMPORT_SCENE: ServiceIdentifier<IImportScene> = Symbol.for("brr.client.ImportScene");
export const SIM_CLIENT: ServiceIdentifier<ISimClient> = Symbol.for("brr.client.SimClient");
export const SIM_WORKER_PORT: ServiceIdentifier<RpcPort> = Symbol.for("brr.client.SimWorkerPort");
export const PLAN_SERVICE: ServiceIdentifier<IPlanService> = Symbol.for("brr.client.PlanService");
export const ANNOTATION_SERVICE: ServiceIdentifier<IAnnotationService> = Symbol.for(
  "brr.client.AnnotationService",
);
export const PLAN_SHEET_SERVICE: ServiceIdentifier<IPlanSheetService> = Symbol.for(
  "brr.client.PlanSheetService",
);
export const SHEET_TYPEFACE: ServiceIdentifier<ISheetTypeface> = Symbol.for(
  "brr.client.SheetTypeface",
);
export const SHEET_TILER: ServiceIdentifier<ISheetTiler> = Symbol.for("brr.client.SheetTiler");
export const PLAN_DRAWING: ServiceIdentifier<IPlanDrawing> = Symbol.for("brr.client.PlanDrawing");
export const SHEET_COMPOSER: ServiceIdentifier<ISheetComposer> = Symbol.for(
  "brr.client.SheetComposer",
);
export const SVG_SHEET_WRITER: ServiceIdentifier<ISvgSheetWriter> = Symbol.for(
  "brr.client.SvgSheetWriter",
);
export const PDF_SHEET_WRITER: ServiceIdentifier<ISheetWriter> = Symbol.for(
  "brr.client.PdfSheetWriter",
);
export const PNG_SHEET_WRITER: ServiceIdentifier<ISheetWriter> = Symbol.for(
  "brr.client.PngSheetWriter",
);
export const SHEET_SETS: ServiceIdentifier<ISheetSets> = Symbol.for("brr.client.SheetSets");
export const EVENT_DETAILS: ServiceIdentifier<IEventDetails> =
  Symbol.for("brr.client.EventDetails");
export const LAYOUT_SIZE: ServiceIdentifier<ILayoutSize> = Symbol.for("brr.client.LayoutSize");
export const UNDERLAY_SERVICE: ServiceIdentifier<IUnderlayService> = Symbol.for(
  "brr.client.UnderlayService",
);
export const RUNNING_GEAR_OVERRIDES: ServiceIdentifier<IRunningGearOverrideStore> = Symbol.for(
  "brr.client.RunningGearOverrides",
);
export const RUNNING_GEAR: ServiceIdentifier<IRunningGear> = Symbol.for("brr.client.RunningGear");
export const TRADEMARK_DISCLAIMER: ServiceIdentifier<string> = Symbol.for(
  "brr.client.TrademarkDisclaimer",
);
export const BOM_SERVICE: ServiceIdentifier<IBomService> = Symbol.for("brr.client.BomService");
export const OWNED_PARTS: ServiceIdentifier<IOwnedParts> = Symbol.for("brr.client.OwnedParts");
export const TRAIN_PLAY: ServiceIdentifier<ITrainPlay> = Symbol.for("brr.client.TrainPlay");
export const RAIL_YARD: ServiceIdentifier<IRailYard> = Symbol.for("brr.client.RailYard");
export const TALLEST_TRAIN: ServiceIdentifier<ITallestTrain> =
  Symbol.for("brr.client.TallestTrain");
export const TRACK_PIERS: ServiceIdentifier<ITrackPiers> = Symbol.for("brr.client.TrackPiers");
export const VEHICLE_IDS: ServiceIdentifier<IVehicleIds> = Symbol.for("brr.client.VehicleIds");
export const PALETTE_MEMORY_STORE: ServiceIdentifier<IPaletteMemoryStore> = Symbol.for(
  "brr.client.PaletteMemoryStore",
);
export const PALETTE_MEMORY: ServiceIdentifier<IPaletteMemory> = Symbol.for(
  "brr.client.PaletteMemory",
);
export const LIBRARY_FILTER_STORE: ServiceIdentifier<ILibraryFilterStore> = Symbol.for(
  "brr.client.LibraryFilterStore",
);
export const HOTBAR: ServiceIdentifier<IHotbar> = Symbol.for("brr.client.Hotbar");
export const PALETTE_THUMBNAILS: ServiceIdentifier<IPaletteThumbnails> = Symbol.for(
  "brr.client.PaletteThumbnails",
);
export const PALETTE: ServiceIdentifier<IPalette> = Symbol.for("brr.client.Palette");
export const PANEL_LAYOUT_STORE: ServiceIdentifier<IPanelLayoutStore> = Symbol.for(
  "brr.client.PanelLayoutStore",
);
export const PANEL_LAYOUT: ServiceIdentifier<IPanelLayout> = Symbol.for("brr.client.PanelLayout");
export const SNAP_SHAPES: ServiceIdentifier<SnapShapes> = Symbol.for("brr.client.SnapShapes");
export const CONNECTOR_TABLES: ServiceIdentifier<IConnectorTables> = Symbol.for(
  "brr.client.ConnectorTables",
);
export const SNAP_MATING: ServiceIdentifier<SnapMating> = Symbol.for("brr.client.SnapMating");
export const LATTICE_STUD_FINDER: ServiceIdentifier<LatticeStudFinder> = Symbol.for(
  "brr.client.LatticeStudFinder",
);
export const SPARSE_CONNECTOR_FINDER: ServiceIdentifier<SparseConnectorFinder> = Symbol.for(
  "brr.client.SparseConnectorFinder",
);
export const TRACK_END_FINDER: ServiceIdentifier<TrackEndFinder> = Symbol.for(
  "brr.client.TrackEndFinder",
);
export const CONNECTION_SOLVER: ServiceIdentifier<ConnectionSolver> = Symbol.for(
  "brr.client.ConnectionSolver",
);
export const PLACEMENT_SEARCH: ServiceIdentifier<IPlacementSearch> = Symbol.for(
  "brr.client.PlacementSearch",
);
export const STARTER_FILE_URLS: ServiceIdentifier<ReadonlyMap<string, string>> = Symbol.for(
  "brr.client.StarterFileUrls",
);
export const STARTER_FILES: ServiceIdentifier<IStarterFiles> =
  Symbol.for("brr.client.StarterFiles");
export const STARTER_WORLDS: ServiceIdentifier<IStarterWorlds> = Symbol.for(
  "brr.client.StarterWorlds",
);
