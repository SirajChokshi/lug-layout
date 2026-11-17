import {
  BOM_SERVICE,
  CITY_SCENE,
  CREDITS,
  EDITOR,
  EDITOR_CAMERA,
  IMPORT_SCENE,
  LAYOUT_SCENE,
  mainThreadModules,
  MODEL_SCENE,
  PALETTE_MEMORY,
  PALETTE_THUMBNAILS,
  PART_DISPLAY_SCENE,
  RUN_SCENE,
  RUNNING_GEAR,
  TRACK_SCENE,
  type IBomSource,
  type IImportScene,
  type IRunScene,
  PLAN_SERVICE,
  type IViewerScene,
  type PlacementDump,
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
const startSimWorker = (): Worker =>
  new Worker(new URL("@brr/sim-worker/entry", import.meta.url), { type: "module" });
const createImportWorker = (): Worker =>
  new Worker(new URL("@brr/import-worker/entry", import.meta.url), { type: "module" });
container.load(
  ...mainThreadModules({
    bundleBaseUrl,
    startSimWorker,
    createImportWorker,
    ...(import.meta.env.VITE_BUNDLE_MANIFEST_FILE === undefined
      ? {}
      : { bundleManifestFile: import.meta.env.VITE_BUNDLE_MANIFEST_FILE }),
    ...(import.meta.env.VITE_CATALOG_API_BASE_URL
      ? { catalogApiBaseUrl: import.meta.env.VITE_CATALOG_API_BASE_URL }
      : {}),
    disclaimer: TRADEMARK_DISCLAIMER,
  }),
);
const params = readViewerParams(location.search);

interface ViewerChoice {
  readonly scene: IViewerScene;
  readonly placements: (() => PlacementDump) | null;
  readonly run: IRunScene | null;
  readonly importScene?: IImportScene;
  readonly bomSource?: IBomSource;
}

function viewerScene(viewer: ViewerParams): ViewerChoice {
  switch (viewer.mode) {
    case "city": {
      const city = container.get(CITY_SCENE);
      city.configure({
        targetParts: viewer.parts,
        seed: viewer.seed,
        camera: viewer.camera,
        originChunkX: viewer.originChunkX,
        originChunkZ: viewer.originChunkZ,
      });
      return {
        scene: city,
        placements: viewer.dumpWorld ? () => city.placementDump() : null,
        run: null,
        bomSource: city,
      };
    }
    case "layout": {
      const layout = container.get(LAYOUT_SCENE);
      layout.configure({ camera: viewer.camera, tiles: viewer.tiles });
      return { scene: layout, placements: null, run: null };
    }
    case "model": {
      const modelScene = container.get(MODEL_SCENE);
      modelScene.selectModel(viewer.model ?? "", viewer.modelView);
      modelScene.configureCamera({ distanceLdu: viewer.distanceLdu, zoom: viewer.zoom });
      return { scene: modelScene, placements: null, run: null, bomSource: modelScene };
    }
    case "track": {
      const trackScene = container.get(TRACK_SCENE);
      trackScene.selectPlan(viewer.track ?? "");
      return { scene: trackScene, placements: null, run: null };
    }
    case "run": {
      const runScene = container.get(RUN_SCENE);
      runScene.configure({
        plan: viewer.track ?? "",
        consist: viewer.consist,
        trains: viewer.trains,
        speedLduPerS: viewer.speedLduPerS,
        accelerationLduPerS2: viewer.accelerationLduPerS2,
        brakingLduPerS2: viewer.brakingLduPerS2,
        follow: viewer.follow,
        start: viewer.start,
        autopilotSeed: viewer.autopilotSeed,
        followDistanceLdu: viewer.followDistanceLdu,
      });
      return { scene: runScene, placements: null, run: runScene };
    }
    case "parts":
      return { scene: container.get(PART_DISPLAY_SCENE), placements: null, run: null };
    case "import": {
      const importScene = container.get(IMPORT_SCENE);
      return {
        scene: importScene,
        placements: null,
        run: null,
        importScene,
        bomSource: importScene,
      };
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
        palette={container.get(PALETTE_MEMORY)}
        thumbnails={container.get(PALETTE_THUMBNAILS)}
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
  const { scene, placements, run, importScene, bomSource } = viewerScene(params);
  const bom = bomSource ? { service: container.get(BOM_SERVICE), source: bomSource } : null;
  return (
    <App
      scene={scene}
      params={params}
      placements={placements}
      run={run}
      runningGear={run ? container.get(RUNNING_GEAR) : null}
      importScene={importScene ?? null}
      bom={bom}
    />
  );
}

createRoot(rootElement).render(<StrictMode>{root()}</StrictMode>);
