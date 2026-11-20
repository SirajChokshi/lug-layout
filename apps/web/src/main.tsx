import {
  BOM_SERVICE,
  CREDITS,
  EDITOR,
  EDITOR_CAMERA,
  IMPORT_SCENE,
  LIBRARY_PART_PLACER,
  mainThreadModules,
  MODEL_SCENE,
  PALETTE_DRAG,
  PALETTE_MEMORY,
  PALETTE_PREFETCH,
  PALETTE_SEARCH,
  PALETTE_THUMBNAILS,
  RUNNING_GEAR,
  TRACK_SCENE,
  TRAIN_PLAY,
  type IBomSource,
  type IImportScene,
  PLAN_SERVICE,
  type IViewerScene,
} from "@brr/client";
import { AboutPage, CreditsPage, EditorApp } from "@brr/ui";
import { Container } from "inversify";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { TRADEMARK_DISCLAIMER } from "./disclaimer.ts";
import { readSitePage } from "./site-page.ts";
import { readViewerParams, type ViewerParams } from "./viewer/viewer-params.ts";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element");

const container = new Container();
const bundleBaseUrl = new URL(import.meta.env.VITE_BUNDLE_BASE_URL ?? "bundle/", document.baseURI)
  .href;
const libraryBakeBaseUrl =
  import.meta.env.VITE_LIBRARY_BAKE_BASE_URL ??
  (import.meta.env.VITE_BUNDLE_BASE_URL === undefined
    ? new URL("library-bake/", document.baseURI).href
    : null);
const startSimWorker = (): Worker =>
  new Worker(new URL("@brr/sim-worker/entry", import.meta.url), { type: "module" });
const createImportWorker = (): Worker =>
  new Worker(new URL("@brr/import-worker/entry", import.meta.url), { type: "module" });
const IMPORT_BAKE_HELPERS_MAX = 3;
const THREADS_KEPT_FOR_EDITOR = 3;
const DEVICE_GIB_PER_BAKE_HELPER = 2;
function deviceMemoryGib(): number {
  const reported: unknown = Reflect.get(navigator, "deviceMemory");
  return typeof reported === "number" ? reported : Number.POSITIVE_INFINITY;
}
const importBakeHelpers = Math.min(
  IMPORT_BAKE_HELPERS_MAX,
  Math.max(0, navigator.hardwareConcurrency - THREADS_KEPT_FOR_EDITOR),
  Math.floor(deviceMemoryGib() / DEVICE_GIB_PER_BAKE_HELPER),
);
container.load(
  ...mainThreadModules({
    bundleBaseUrl,
    startSimWorker,
    createImportWorker,
    importBakeHelpers,
    ...(import.meta.env.VITE_BUNDLE_MANIFEST_FILE === undefined
      ? {}
      : { bundleManifestFile: import.meta.env.VITE_BUNDLE_MANIFEST_FILE }),
    ...(import.meta.env.VITE_LDRAW_LIBRARY_BASE_URL
      ? { ldrawLibraryBaseUrl: import.meta.env.VITE_LDRAW_LIBRARY_BASE_URL }
      : {}),
    ...(libraryBakeBaseUrl === null ? {} : { libraryBakeBaseUrl }),
    ...(import.meta.env.VITE_CATALOG_API_BASE_URL
      ? { catalogApiBaseUrl: import.meta.env.VITE_CATALOG_API_BASE_URL }
      : {}),
    disclaimer: TRADEMARK_DISCLAIMER,
  }),
);
const params = readViewerParams(location.search);

interface ViewerChoice {
  readonly scene: IViewerScene;
  readonly importScene?: IImportScene;
  readonly bomSource?: IBomSource;
}

function viewerScene(viewer: ViewerParams): ViewerChoice {
  switch (viewer.mode) {
    case "model": {
      const modelScene = container.get(MODEL_SCENE);
      modelScene.selectModel(viewer.model ?? "", viewer.modelView);
      modelScene.configureCamera({ distanceLdu: viewer.distanceLdu, zoom: viewer.zoom });
      return { scene: modelScene, bomSource: modelScene };
    }
    case "track": {
      const trackScene = container.get(TRACK_SCENE);
      trackScene.selectPlan(viewer.track ?? "");
      return { scene: trackScene };
    }
    case "import": {
      const importScene = container.get(IMPORT_SCENE);
      return { scene: importScene, importScene, bomSource: importScene };
    }
    case "edit":
      throw new Error("the editor is not a viewer scene");
    default: {
      const unhandled: never = viewer.mode;
      throw new Error(`unhandled ${String(unhandled)}`);
    }
  }
}

function root(): ReactNode {
  const page = readSitePage(location.search);
  switch (page) {
    case "credits":
      return <CreditsPage credits={container.get(CREDITS)} disclaimer={TRADEMARK_DISCLAIMER} />;
    case "about":
      return <AboutPage credits={container.get(CREDITS)} disclaimer={TRADEMARK_DISCLAIMER} />;
    case "app":
      break;
    default: {
      const unhandled: never = page;
      throw new Error(`unhandled page ${String(unhandled)}`);
    }
  }
  if (params.mode === "edit") {
    return (
      <EditorApp
        editor={container.get(EDITOR)}
        camera={container.get(EDITOR_CAMERA)}
        plans={container.get(PLAN_SERVICE)}
        bomService={container.get(BOM_SERVICE)}
        play={container.get(TRAIN_PLAY)}
        paletteSearch={container.get(PALETTE_SEARCH)}
        paletteDrag={container.get(PALETTE_DRAG)}
        palettePrefetch={container.get(PALETTE_PREFETCH)}
        paletteMemory={container.get(PALETTE_MEMORY)}
        paletteThumbnails={container.get(PALETTE_THUMBNAILS)}
        libraryPlacer={container.get(LIBRARY_PART_PLACER)}
        runningGear={container.get(RUNNING_GEAR)}
        options={{
          api: params.api,
          pixelRatio: window.devicePixelRatio,
          look: params.look,
          tier: params.tier,
        }}
        disclaimer={TRADEMARK_DISCLAIMER}
        showState={params.showEditState}
      />
    );
  }
  const { scene, importScene, bomSource } = viewerScene(params);
  const bom = bomSource ? { service: container.get(BOM_SERVICE), source: bomSource } : null;
  return <App scene={scene} params={params} importScene={importScene ?? null} bom={bom} />;
}

createRoot(rootElement).render(<StrictMode>{root()}</StrictMode>);
