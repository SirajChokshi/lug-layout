import {
  CITY_SCENE,
  mainThreadModules,
  MODEL_SCENE,
  PART_DISPLAY_SCENE,
  type IViewerScene,
  type PlacementDump,
} from "@brr/client";
import { Container } from "inversify";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { readViewerParams } from "./viewer/viewer-params.ts";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element");

const container = new Container();
container.load(...mainThreadModules({ bundleBaseUrl: new URL("bundle/", document.baseURI).href }));
const params = readViewerParams(location.search);

let placements: (() => PlacementDump) | null = null;

function chooseScene(): IViewerScene {
  if (params.city) {
    const city = container.get(CITY_SCENE);
    city.configure({
      targetParts: params.parts,
      seed: params.seed,
      camera: params.camera,
      originChunkX: params.originChunkX,
      originChunkZ: params.originChunkZ,
    });
    if (params.dumpWorld) placements = () => city.placementDump();
    return city;
  }
  if (params.model !== null) {
    const modelScene = container.get(MODEL_SCENE);
    modelScene.selectModel(params.model);
    return modelScene;
  }
  return container.get(PART_DISPLAY_SCENE);
}

const scene = chooseScene();

createRoot(rootElement).render(
  <StrictMode>
    <App scene={scene} params={params} placements={placements} />
  </StrictMode>,
);
