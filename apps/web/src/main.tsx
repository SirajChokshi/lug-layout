import {
  BOM_SERVICE,
  CREDITS,
  EDITOR,
  EDITOR_CAMERA,
  HOTBAR,
  IMPORT_SCENE,
  mainThreadModules,
  MODEL_SCENE,
  PALETTE,
  PANEL_LAYOUT,
  RUNNING_GEAR,
  SCALE_BAR,
  STARTER_WORLDS,
  TRACK_SCENE,
  TRAIN_PLAY,
  type IBomSource,
  type IImportScene,
  PLAN_SERVICE,
  PLAN_SHEET_SERVICE,
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
const bundleBucketUrl =
  import.meta.env.VITE_BUNDLE_BASE_URL === undefined
    ? document.baseURI
    : new URL(import.meta.env.VITE_BUNDLE_BASE_URL.replace(/\/?$/u, "/"), document.baseURI).href;
const libraryConnectorsBaseUrl =
  import.meta.env.VITE_LIBRARY_CONNECTORS_BASE_URL ??
  new URL("library-connectors/", bundleBucketUrl).href;
const shadowLibraryBaseUrl =
  import.meta.env.VITE_SHADOW_LIBRARY_BASE_URL ?? new URL("shadow-library/", bundleBucketUrl).href;
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
const STARTERS_DIRECTORY = "../starters/";
const starterFileUrls = new Map(
  Object.entries(
    import.meta.glob<string>("../starters/**/*", { query: "?url", import: "default", eager: true }),
  ).map(([path, url]) => [path.slice(STARTERS_DIRECTORY.length), url]),
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
    libraryConnectorsBaseUrl,
    shadowLibraryBaseUrl,
    ...(import.meta.env.VITE_CATALOG_API_BASE_URL
      ? { catalogApiBaseUrl: import.meta.env.VITE_CATALOG_API_BASE_URL }
      : {}),
    starterFileUrls,
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
        scaleBar={container.get(SCALE_BAR)}
        plans={container.get(PLAN_SERVICE)}
        sheets={container.get(PLAN_SHEET_SERVICE)}
        bomService={container.get(BOM_SERVICE)}
        play={container.get(TRAIN_PLAY)}
        palette={container.get(PALETTE)}
        panels={container.get(PANEL_LAYOUT)}
        hotbar={container.get(HOTBAR)}
        runningGear={container.get(RUNNING_GEAR)}
        starters={container.get(STARTER_WORLDS)}
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
