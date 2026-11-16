import {
  CITY_SCENE,
  CREDITS,
  EDITOR,
  mainThreadModules,
  MODEL_SCENE,
  PART_DISPLAY_SCENE,
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
container.load(...mainThreadModules({ bundleBaseUrl }));
const params = readViewerParams(location.search);

function viewerScene(viewer: ViewerParams): {
  readonly scene: IViewerScene;
  readonly placements: (() => PlacementDump) | null;
} {
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
      return { scene: city, placements: viewer.dumpWorld ? () => city.placementDump() : null };
    }
    case "model": {
      const modelScene = container.get(MODEL_SCENE);
      modelScene.selectModel(viewer.model ?? "");
      return { scene: modelScene, placements: null };
    }
    case "parts":
      return { scene: container.get(PART_DISPLAY_SCENE), placements: null };
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
        options={{ api: params.api, pixelRatio: window.devicePixelRatio }}
        disclaimer={TRADEMARK_DISCLAIMER}
        showState={params.showEditState}
      />
    );
  }
  const { scene, placements } = viewerScene(params);
  return <App scene={scene} params={params} placements={placements} />;
}

createRoot(rootElement).render(<StrictMode>{root()}</StrictMode>);
