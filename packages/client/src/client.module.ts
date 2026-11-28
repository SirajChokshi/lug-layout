import {
  ASSET_FETCHER,
  BUNDLE_BASE_URL,
  BUNDLE_MANIFEST_FILE,
  CATALOG_API,
  CATALOG_API_BASE_URL,
  catalogModule,
  DEFAULT_BUNDLE_MANIFEST_FILE,
  LINK_PROGRESS_SHARE,
  PART_BUNDLE_LOADER,
  RETRIED_ASSET_FETCHER,
  RetryingAssetFetcher,
} from "@brr/catalog";
import {
  ConnectionSolver,
  LatticeStudFinder,
  SnapMating,
  SnapShapes,
  SparseConnectorFinder,
  TrackEndFinder,
} from "@brr/domain";
import { renderModule } from "@brr/render";
import { openLinkProgressBroadcast, type RpcPort } from "@brr/rpc";
import { storageModule } from "@brr/storage";
import { ContainerModule, type ResolutionContext } from "inversify";
import { EditorCamera } from "./camera/editor-camera.ts";
import { ScaleBar } from "./camera/scale-bar.ts";
import { CachingAssetFetcher } from "./catalog/caching-asset-fetcher.ts";
import { CatalogSearch } from "./catalog/catalog-search.ts";
import { LibraryPartPlacer } from "./catalog/library-part-placer.ts";
import { LibraryPartSearch } from "./catalog/library-part-search.ts";
import { Palette } from "./catalog/palette.ts";
import { PaletteCatalog } from "./catalog/palette-catalog.ts";
import { PaletteDrag } from "./catalog/palette-drag.ts";
import { LocalStoragePaletteMemoryStore, PaletteMemoryService } from "./catalog/palette-memory.ts";
import { LocalStorageLibraryFilterStore } from "./catalog/library-filters.ts";
import { PalettePrefetch } from "./catalog/palette-prefetch.ts";
import { PaletteSearch } from "./catalog/palette-search.ts";
import { PaletteThumbnails } from "./catalog/palette-thumbnails.ts";
import { PlaceableCatalog } from "./catalog/placeable-catalog.ts";
import { CommandPaletteSearch } from "./commands/command-palette-search.ts";
import { HotbarService } from "./commands/hotbar.ts";
import { solverFinders } from "./connect/finders.ts";
import { PlacementSearch } from "./connect/placement-search.ts";
import { ConnectorTables } from "./connect/connector-tables.ts";
import { CreditsService } from "./credits/credits-service.ts";
import { Editor } from "./edit/editor.ts";
import { EditorFrameLoop } from "./edit/editor-frame-loop.ts";
import { RoadEditSession } from "./edit/road-edit-session.ts";
import { TrackEditSession } from "./edit/track-edit-session.ts";
import { TrackPathSelection } from "./edit/track-path-selection.ts";
import { TrackWorld } from "./edit/track-world.ts";
import { WorldSession } from "./edit/world-session.ts";
import { TableGround } from "./ground/table-ground.ts";
import { ImportWorkerPool, type ImportWorkerFactory } from "./import/import-worker-pool.ts";
import { WorkerModelImporter } from "./import/worker-model-importer.ts";
import { LocalStoragePanelLayoutStore, PanelLayoutService } from "./panels/panel-layout.ts";
import { PlanService } from "./plan/plan-service.ts";
import { PlanSheetService } from "./plan/plan-sheet-service.ts";
import { PdfSheetWriter } from "./sheets/pdf-sheet-writer.ts";
import { PlanDrawing } from "./sheets/plan-drawing.ts";
import { SheetComposer } from "./sheets/sheet-composer.ts";
import { SheetSets } from "./sheets/sheet-sets.ts";
import { CourierTypeface } from "./sheets/sheet-typeface.ts";
import { SvgSheetWriter } from "./sheets/svg-sheet-writer.ts";
import { SheetTiler } from "./sheets/tile-grid.ts";
import { BomService } from "./bom/bom-service.ts";
import { OwnedPartsService } from "./bom/owned-parts-service.ts";
import { ImportScene } from "./scene/import-scene.ts";
import { ModelScene } from "./scene/model-scene.ts";
import { IndexedDbRunningGearOverrideStore } from "./running-gear/override-store.ts";
import { RunningGearEditor } from "./running-gear/running-gear-editor.ts";
import { TrackScene } from "./scene/track-scene.ts";
import { SimWorkerProxy } from "./sim/sim-client.ts";
import { TrainPlay } from "./play/train-play.ts";
import { RailYard } from "./trains/rail-yard.ts";
import { TallestTrainMeter } from "./trains/tallest-train.ts";
import { TrackPiers } from "./edit/track-piers.ts";
import { VehicleIds } from "./trains/vehicle-ids.ts";
import { FetchedStarterFiles } from "./starters/starter-files.ts";
import { StarterWorlds } from "./starters/starter-worlds.ts";
import {
  BOM_SERVICE,
  OWNED_PARTS,
  CATALOG_SEARCH,
  COMMAND_CATALOG_SEARCH,
  COMMAND_PALETTE_SEARCH,
  CONNECTION_SOLVER,
  LATTICE_STUD_FINDER,
  PLACEMENT_SEARCH,
  CONNECTOR_TABLES,
  SNAP_MATING,
  SNAP_SHAPES,
  SPARSE_CONNECTOR_FINDER,
  TRACK_END_FINDER,
  CREDITS,
  EDITOR,
  EDITOR_CAMERA,
  SCALE_BAR,
  TABLE_GROUND,
  IMPORT_SCENE,
  IMPORT_BAKE_HELPERS,
  IMPORT_WORKER_FACTORY,
  LDRAW_LIBRARY_BASE_URL,
  LIBRARY_BAKE_BASE_URL,
  LIBRARY_CONNECTORS_BASE_URL,
  SHADOW_LIBRARY_BASE_URL,
  LIBRARY_PART_PLACER,
  LIBRARY_PART_SEARCH,
  IMPORT_WORKER_POOL,
  MODEL_IMPORTER,
  MODEL_SCENE,
  PALETTE,
  PALETTE_CATALOG,
  PALETTE_DRAG,
  HOTBAR,
  PALETTE_MEMORY,
  PALETTE_MEMORY_STORE,
  LIBRARY_FILTER_STORE,
  PALETTE_PREFETCH,
  PALETTE_SEARCH,
  PALETTE_THUMBNAILS,
  PANEL_LAYOUT,
  PANEL_LAYOUT_STORE,
  RUNNING_GEAR,
  RUNNING_GEAR_OVERRIDES,
  SIM_CLIENT,
  SIM_WORKER_PORT,
  TRACK_SCENE,
  TRAIN_PLAY,
  RAIL_YARD,
  TALLEST_TRAIN,
  TRACK_PIERS,
  VEHICLE_IDS,
  PLAN_SERVICE,
  PLAN_SHEET_SERVICE,
  PLAN_DRAWING,
  SHEET_COMPOSER,
  SHEET_TILER,
  SHEET_TYPEFACE,
  SVG_SHEET_WRITER,
  PDF_SHEET_WRITER,
  SHEET_SETS,
  TRADEMARK_DISCLAIMER,
  PLACEABLE_CATALOG,
  EDITOR_FRAME_LOOP,
  ROAD_EDIT_SESSION,
  TRACK_EDIT_SESSION,
  TRACK_PATH_SELECTION,
  TRACK_WORLD,
  STARTER_FILE_URLS,
  STARTER_FILES,
  STARTER_WORLDS,
  WORLD_SESSION,
} from "./tokens.ts";

function catalogSearch(context: ResolutionContext): CatalogSearch {
  return new CatalogSearch(
    context.get(CATALOG_API_BASE_URL, { optional: true }) === undefined
      ? null
      : context.get(CATALOG_API),
    context.get(PART_BUNDLE_LOADER),
  );
}

const clientModule = new ContainerModule(({ bind }) => {
  bind(RETRIED_ASSET_FETCHER).to(CachingAssetFetcher).inSingletonScope();
  bind(ASSET_FETCHER).to(RetryingAssetFetcher).inSingletonScope();
  bind(MODEL_SCENE).to(ModelScene).inSingletonScope();
  bind(EDITOR).to(Editor).inSingletonScope();
  bind(WORLD_SESSION).to(WorldSession).inSingletonScope();
  bind(PLACEABLE_CATALOG).to(PlaceableCatalog).inSingletonScope();
  bind(EDITOR_FRAME_LOOP).to(EditorFrameLoop).inSingletonScope();
  bind(TRACK_WORLD).to(TrackWorld).inSingletonScope();
  bind(TRACK_EDIT_SESSION).to(TrackEditSession).inSingletonScope();
  bind(TRACK_PATH_SELECTION).to(TrackPathSelection).inSingletonScope();
  bind(ROAD_EDIT_SESSION).to(RoadEditSession).inSingletonScope();
  bind(EDITOR_CAMERA).to(EditorCamera).inSingletonScope();
  bind(SCALE_BAR).to(ScaleBar).inSingletonScope();
  bind(TABLE_GROUND).to(TableGround).inSingletonScope();
  bind(IMPORT_WORKER_POOL).to(ImportWorkerPool).inSingletonScope();
  bind(MODEL_IMPORTER).to(WorkerModelImporter).inSingletonScope();
  bind(IMPORT_SCENE).to(ImportScene).inSingletonScope();
  bind(CREDITS).to(CreditsService).inSingletonScope();
  bind(TRACK_SCENE).to(TrackScene).inSingletonScope();
  bind(SIM_CLIENT).to(SimWorkerProxy).inSingletonScope();
  bind(PLAN_SERVICE).to(PlanService).inSingletonScope();
  bind(PLAN_SHEET_SERVICE).to(PlanSheetService).inSingletonScope();
  bind(SHEET_TYPEFACE).to(CourierTypeface).inSingletonScope();
  bind(SHEET_TILER).to(SheetTiler).inSingletonScope();
  bind(PLAN_DRAWING).to(PlanDrawing).inSingletonScope();
  bind(SHEET_COMPOSER).to(SheetComposer).inSingletonScope();
  bind(SVG_SHEET_WRITER).to(SvgSheetWriter).inSingletonScope();
  bind(PDF_SHEET_WRITER).to(PdfSheetWriter).inSingletonScope();
  bind(SHEET_SETS).to(SheetSets).inSingletonScope();
  bind(RUNNING_GEAR_OVERRIDES).to(IndexedDbRunningGearOverrideStore).inSingletonScope();
  bind(RUNNING_GEAR).to(RunningGearEditor).inSingletonScope();
  bind(BOM_SERVICE).to(BomService).inSingletonScope();
  bind(OWNED_PARTS).to(OwnedPartsService).inSingletonScope();
  bind(TRAIN_PLAY).to(TrainPlay).inSingletonScope();
  bind(RAIL_YARD).to(RailYard).inSingletonScope();
  bind(TALLEST_TRAIN).to(TallestTrainMeter).inSingletonScope();
  bind(TRACK_PIERS).to(TrackPiers).inSingletonScope();
  bind(VEHICLE_IDS).to(VehicleIds).inSingletonScope();
  bind(SNAP_SHAPES)
    .toDynamicValue(() => new SnapShapes())
    .inSingletonScope();
  bind(SNAP_MATING)
    .toDynamicValue((context) => new SnapMating(context.get(SNAP_SHAPES)))
    .inSingletonScope();
  bind(LATTICE_STUD_FINDER)
    .toDynamicValue((context) => new LatticeStudFinder(context.get(SNAP_MATING)))
    .inSingletonScope();
  bind(SPARSE_CONNECTOR_FINDER)
    .toDynamicValue((context) => new SparseConnectorFinder(context.get(SNAP_MATING)))
    .inSingletonScope();
  bind(TRACK_END_FINDER)
    .toDynamicValue(() => new TrackEndFinder())
    .inSingletonScope();
  bind(CONNECTION_SOLVER)
    .toDynamicValue(
      (context) =>
        new ConnectionSolver(
          solverFinders(
            context.get(LATTICE_STUD_FINDER),
            context.get(SPARSE_CONNECTOR_FINDER),
            context.get(TRACK_END_FINDER),
          ),
        ),
    )
    .inSingletonScope();
  bind(PLACEMENT_SEARCH).to(PlacementSearch).inSingletonScope();
  bind(CONNECTOR_TABLES).to(ConnectorTables).inSingletonScope();
  bind(CATALOG_SEARCH).toDynamicValue(catalogSearch).inSingletonScope();
  bind(COMMAND_CATALOG_SEARCH).toDynamicValue(catalogSearch).inSingletonScope();
  bind(PALETTE_MEMORY_STORE).to(LocalStoragePaletteMemoryStore).inSingletonScope();
  bind(PALETTE_MEMORY).to(PaletteMemoryService).inSingletonScope();
  bind(LIBRARY_FILTER_STORE).to(LocalStorageLibraryFilterStore).inSingletonScope();
  bind(HOTBAR).to(HotbarService).inSingletonScope();
  bind(PALETTE_THUMBNAILS).to(PaletteThumbnails).inSingletonScope();
  bind(LIBRARY_PART_SEARCH).to(LibraryPartSearch).inSingletonScope();
  bind(LIBRARY_PART_PLACER).to(LibraryPartPlacer).inSingletonScope();
  bind(PALETTE_CATALOG).to(PaletteCatalog).inSingletonScope();
  bind(PALETTE_SEARCH).to(PaletteSearch).inSingletonScope();
  bind(COMMAND_PALETTE_SEARCH).to(CommandPaletteSearch).inSingletonScope();
  bind(PALETTE_DRAG).to(PaletteDrag).inSingletonScope();
  bind(PALETTE_PREFETCH).to(PalettePrefetch).inSingletonScope();
  bind(PALETTE).to(Palette).inSingletonScope();
  bind(PANEL_LAYOUT_STORE).to(LocalStoragePanelLayoutStore).inSingletonScope();
  bind(PANEL_LAYOUT).to(PanelLayoutService).inSingletonScope();
  bind(STARTER_FILES).to(FetchedStarterFiles).inSingletonScope();
  bind(STARTER_WORLDS).to(StarterWorlds).inSingletonScope();
});

export interface MainThreadConfig {
  readonly bundleBaseUrl: string;
  readonly createImportWorker?: ImportWorkerFactory;
  readonly importBakeHelpers?: number;
  readonly bundleManifestFile?: string;
  readonly ldrawLibraryBaseUrl?: string;
  readonly libraryBakeBaseUrl?: string;
  readonly libraryConnectorsBaseUrl?: string;
  readonly shadowLibraryBaseUrl?: string;
  readonly catalogApiBaseUrl?: string;
  readonly startSimWorker?: () => RpcPort;
  readonly starterFileUrls?: ReadonlyMap<string, string>;
  readonly disclaimer: string;
}

export function mainThreadModules(config: MainThreadConfig): ContainerModule[] {
  const configModule = new ContainerModule(({ bind }) => {
    bind(BUNDLE_BASE_URL).toConstantValue(config.bundleBaseUrl);
    bind(IMPORT_WORKER_FACTORY).toConstantValue(() => {
      if (!config.createImportWorker) {
        throw new Error("this composition root starts no import worker");
      }
      return config.createImportWorker();
    });
    bind(IMPORT_BAKE_HELPERS).toConstantValue(config.importBakeHelpers ?? 0);
    bind(BUNDLE_MANIFEST_FILE).toConstantValue(
      config.bundleManifestFile ?? DEFAULT_BUNDLE_MANIFEST_FILE,
    );
    bind(LDRAW_LIBRARY_BASE_URL).toConstantValue(config.ldrawLibraryBaseUrl ?? null);
    bind(LIBRARY_BAKE_BASE_URL).toConstantValue(config.libraryBakeBaseUrl ?? null);
    bind(LIBRARY_CONNECTORS_BASE_URL).toConstantValue(config.libraryConnectorsBaseUrl ?? null);
    bind(SHADOW_LIBRARY_BASE_URL).toConstantValue(config.shadowLibraryBaseUrl ?? null);
    if (config.catalogApiBaseUrl !== undefined) {
      bind(CATALOG_API_BASE_URL).toConstantValue(config.catalogApiBaseUrl);
    }
    bind(SIM_WORKER_PORT)
      .toDynamicValue(() => {
        if (!config.startSimWorker) throw new Error("this composition root starts no sim worker");
        return config.startSimWorker();
      })
      .inSingletonScope();
    bind(LINK_PROGRESS_SHARE).toDynamicValue(openLinkProgressBroadcast).inSingletonScope();
    bind(TRADEMARK_DISCLAIMER).toConstantValue(config.disclaimer);
    bind(STARTER_FILE_URLS).toConstantValue(config.starterFileUrls ?? new Map());
  });
  return [configModule, catalogModule, renderModule, storageModule, clientModule];
}
