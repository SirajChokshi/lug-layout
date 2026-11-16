import {
  BOM_SERVICE,
  BUILDABLE_SERVICE,
  CITY_SCENE,
  CREDITS,
  EDITOR,
  IMPORT_SCENE,
  mainThreadModules,
  MODEL_SCENE,
  PART_DISPLAY_SCENE,
  PLAN_SERVICE,
  type IBomSource,
  type IImportScene,
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
const createImportWorker = (): Worker =>
  new Worker(new URL("@brr/import-worker/entry", import.meta.url), { type: "module" });
container.load(...mainThreadModules({ bundleBaseUrl, createImportWorker }));
const params = readViewerParams(location.search);

interface ViewerChoice {
  readonly scene: IViewerScene;
  readonly placements: (() => PlacementDump) | null;
  readonly importScene: IImportScene | null;
  readonly bomSource: IBomSource | null;
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
        importScene: null,
        bomSource: city,
      };
    }
    case "import": {
      const importScene = container.get(IMPORT_SCENE);
      return { scene: importScene, placements: null, importScene, bomSource: importScene };
    }
    case "model": {
      const modelScene = container.get(MODEL_SCENE);
      modelScene.selectModel(viewer.model ?? "");
      return { scene: modelScene, placements: null, importScene: null, bomSource: modelScene };
    }
    case "parts":
      return {
        scene: container.get(PART_DISPLAY_SCENE),
        placements: null,
        importScene: null,
        bomSource: null,
      };
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
        plans={container.get(PLAN_SERVICE)}
        buildable={container.get(BUILDABLE_SERVICE)}
        options={{ api: params.api, pixelRatio: window.devicePixelRatio }}
        disclaimer={TRADEMARK_DISCLAIMER}
        showState={params.showEditState}
      />
    );
  }
  const { scene, placements, importScene, bomSource } = viewerScene(params);
  const bom = bomSource ? { service: container.get(BOM_SERVICE), source: bomSource } : null;
  return (
    <App
      scene={scene}
      params={params}
      placements={placements}
      importScene={importScene}
      bom={bom}
    />
  );
}

createRoot(rootElement).render(<StrictMode>{root()}</StrictMode>);
