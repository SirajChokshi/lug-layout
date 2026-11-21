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
import type { IWorldSession } from "./edit/world-session.ts";
import type { ITableGround } from "./ground/table-ground.ts";
import type { IImportWorkerPool, ImportWorkerFactory } from "./import/import-worker-pool.ts";
import type { IModelImporter } from "./import/worker-model-importer.ts";
import type { IPanelLayout, IPanelLayoutStore } from "./panels/panel-layout.ts";
import type { IPlanService } from "./plan/plan-service.ts";
import type { IBomService } from "./bom/bom-service.ts";
import type { IRunningGearOverrideStore } from "./running-gear/override-store.ts";
import type { IRunningGear } from "./running-gear/running-gear-editor.ts";
import type { IImportScene } from "./scene/import-scene.ts";
import type { IModelScene } from "./scene/model-scene.ts";
import type { ITrackScene } from "./scene/track-scene.ts";
import type { ISimClient } from "./sim/sim-client.ts";
import type { ITrainPlay } from "./play/train-play.ts";
import type { IRailYard } from "./trains/rail-yard.ts";
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
export const RUNNING_GEAR_OVERRIDES: ServiceIdentifier<IRunningGearOverrideStore> = Symbol.for(
  "brr.client.RunningGearOverrides",
);
export const RUNNING_GEAR: ServiceIdentifier<IRunningGear> = Symbol.for("brr.client.RunningGear");
export const TRADEMARK_DISCLAIMER: ServiceIdentifier<string> = Symbol.for(
  "brr.client.TrademarkDisclaimer",
);
export const BOM_SERVICE: ServiceIdentifier<IBomService> = Symbol.for("brr.client.BomService");
export const TRAIN_PLAY: ServiceIdentifier<ITrainPlay> = Symbol.for("brr.client.TrainPlay");
export const RAIL_YARD: ServiceIdentifier<IRailYard> = Symbol.for("brr.client.RailYard");
export const VEHICLE_IDS: ServiceIdentifier<IVehicleIds> = Symbol.for("brr.client.VehicleIds");
export const PALETTE_MEMORY_STORE: ServiceIdentifier<IPaletteMemoryStore> = Symbol.for(
  "brr.client.PaletteMemoryStore",
);
export const PALETTE_MEMORY: ServiceIdentifier<IPaletteMemory> = Symbol.for(
  "brr.client.PaletteMemory",
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
