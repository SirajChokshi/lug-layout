import {
  BUNDLE_BASE_URL,
  BUNDLE_MANIFEST_FILE,
  CATALOG_API,
  CATALOG_API_BASE_URL,
  catalogModule,
  DEFAULT_BUNDLE_MANIFEST_FILE,
  PART_BUNDLE_LOADER,
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
import type { RpcPort } from "@brr/rpc";
import { storageModule } from "@brr/storage";
import { ContainerModule } from "inversify";
import { EditorCamera } from "./camera/editor-camera.ts";
import { CatalogSearch } from "./catalog/catalog-search.ts";
import { PaletteDrag } from "./catalog/palette-drag.ts";
import { LocalStoragePaletteMemoryStore, PaletteMemoryService } from "./catalog/palette-memory.ts";
import { PalettePrefetch } from "./catalog/palette-prefetch.ts";
import { PaletteSearch } from "./catalog/palette-search.ts";
import { PaletteThumbnails } from "./catalog/palette-thumbnails.ts";
import { PlaceableCatalog } from "./catalog/placeable-catalog.ts";
import { HotbarService } from "./commands/hotbar.ts";
import { solverFinders } from "./connect/finders.ts";
import { PlacementSearch } from "./connect/placement-search.ts";
import { ConnectorTables } from "./connect/connector-tables.ts";
import { CreditsService } from "./credits/credits-service.ts";
import { Editor } from "./edit/editor.ts";
import { EditorFrameLoop } from "./edit/editor-frame-loop.ts";
import { WorldSession } from "./edit/world-session.ts";
import { ImportWorkerPool, type ImportWorkerFactory } from "./import/import-worker-pool.ts";
import { WorkerModelImporter } from "./import/worker-model-importer.ts";
import { PlanService } from "./plan/plan-service.ts";
import { BomService } from "./bom/bom-service.ts";
import { ImportScene } from "./scene/import-scene.ts";
import { ModelScene } from "./scene/model-scene.ts";
import { IndexedDbRunningGearOverrideStore } from "./running-gear/override-store.ts";
import { RunningGearEditor } from "./running-gear/running-gear-editor.ts";
import { TrackScene } from "./scene/track-scene.ts";
import { SimWorkerProxy } from "./sim/sim-client.ts";
import { TrainPlay } from "./play/train-play.ts";
import {
  BOM_SERVICE,
  CATALOG_SEARCH,
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
  IMPORT_SCENE,
  IMPORT_BAKE_HELPERS,
  IMPORT_WORKER_FACTORY,
  LDRAW_LIBRARY_BASE_URL,
  LIBRARY_BAKE_BASE_URL,
  LIBRARY_CONNECTORS_BASE_URL,
  IMPORT_WORKER_POOL,
  MODEL_IMPORTER,
  MODEL_SCENE,
  PALETTE_DRAG,
  HOTBAR,
  PALETTE_MEMORY,
  PALETTE_MEMORY_STORE,
  PALETTE_PREFETCH,
  PALETTE_SEARCH,
  PALETTE_THUMBNAILS,
  RUNNING_GEAR,
  RUNNING_GEAR_OVERRIDES,
  SIM_CLIENT,
  SIM_WORKER_PORT,
  TRACK_SCENE,
  TRAIN_PLAY,
  PLAN_SERVICE,
  TRADEMARK_DISCLAIMER,
  PLACEABLE_CATALOG,
  EDITOR_FRAME_LOOP,
  WORLD_SESSION,
} from "./tokens.ts";

const clientModule = new ContainerModule(({ bind }) => {
  bind(MODEL_SCENE).to(ModelScene).inSingletonScope();
  bind(EDITOR).to(Editor).inSingletonScope();
  bind(WORLD_SESSION).to(WorldSession).inSingletonScope();
  bind(PLACEABLE_CATALOG).to(PlaceableCatalog).inSingletonScope();
  bind(EDITOR_FRAME_LOOP).to(EditorFrameLoop).inSingletonScope();
  bind(EDITOR_CAMERA).to(EditorCamera).inSingletonScope();
  bind(IMPORT_WORKER_POOL).to(ImportWorkerPool).inSingletonScope();
  bind(MODEL_IMPORTER).to(WorkerModelImporter).inSingletonScope();
  bind(IMPORT_SCENE).to(ImportScene).inSingletonScope();
  bind(CREDITS).to(CreditsService).inSingletonScope();
  bind(TRACK_SCENE).to(TrackScene).inSingletonScope();
  bind(SIM_CLIENT).to(SimWorkerProxy).inSingletonScope();
  bind(PLAN_SERVICE).to(PlanService).inSingletonScope();
  bind(RUNNING_GEAR_OVERRIDES).to(IndexedDbRunningGearOverrideStore).inSingletonScope();
  bind(RUNNING_GEAR).to(RunningGearEditor).inSingletonScope();
  bind(BOM_SERVICE).to(BomService).inSingletonScope();
  bind(TRAIN_PLAY).to(TrainPlay).inSingletonScope();
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
  bind(CATALOG_SEARCH)
    .toDynamicValue(
      (context) =>
        new CatalogSearch(
          context.get(CATALOG_API_BASE_URL, { optional: true }) === undefined
            ? null
            : context.get(CATALOG_API),
          context.get(PART_BUNDLE_LOADER),
        ),
    )
    .inSingletonScope();
  bind(PALETTE_MEMORY_STORE).to(LocalStoragePaletteMemoryStore).inSingletonScope();
  bind(PALETTE_MEMORY).to(PaletteMemoryService).inSingletonScope();
  bind(HOTBAR).to(HotbarService).inSingletonScope();
  bind(PALETTE_THUMBNAILS).to(PaletteThumbnails).inSingletonScope();
  bind(PALETTE_SEARCH).to(PaletteSearch).inSingletonScope();
  bind(PALETTE_DRAG).to(PaletteDrag).inSingletonScope();
  bind(PALETTE_PREFETCH).to(PalettePrefetch).inSingletonScope();
});

export interface MainThreadConfig {
  readonly bundleBaseUrl: string;
  readonly createImportWorker?: ImportWorkerFactory;
  readonly importBakeHelpers?: number;
  readonly bundleManifestFile?: string;
  readonly ldrawLibraryBaseUrl?: string;
  readonly libraryBakeBaseUrl?: string;
  readonly libraryConnectorsBaseUrl?: string;
  readonly catalogApiBaseUrl?: string;
  readonly startSimWorker?: () => RpcPort;
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
    if (config.catalogApiBaseUrl !== undefined) {
      bind(CATALOG_API_BASE_URL).toConstantValue(config.catalogApiBaseUrl);
    }
    bind(SIM_WORKER_PORT)
      .toDynamicValue(() => {
        if (!config.startSimWorker) throw new Error("this composition root starts no sim worker");
        return config.startSimWorker();
      })
      .inSingletonScope();
    bind(TRADEMARK_DISCLAIMER).toConstantValue(config.disclaimer);
  });
  return [configModule, catalogModule, renderModule, storageModule, clientModule];
}
