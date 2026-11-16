import {
  BOM_SERVICE,
  CITY_SCENE,
  IMPORT_SCENE,
  mainThreadModules,
  MODEL_SCENE,
  PART_DISPLAY_SCENE,
  type IImportScene,
  type IBomSource,
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
const bundleBaseUrl = new URL(import.meta.env.VITE_BUNDLE_BASE_URL ?? "bundle/", document.baseURI)
  .href;
const createImportWorker = (): Worker =>
  new Worker(new URL("@brr/import-worker/entry", import.meta.url), { type: "module" });
container.load(...mainThreadModules({ bundleBaseUrl, createImportWorker }));
const params = readViewerParams(location.search);

let placements: (() => PlacementDump) | null = null;
let importScene: IImportScene | null = null;
let bomSource: IBomSource | null = null;

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
    bomSource = city;
    return city;
  }
  if (params.importer) {
    importScene = container.get(IMPORT_SCENE);
    bomSource = importScene;
    return importScene;
  }
  if (params.model !== null) {
    const modelScene = container.get(MODEL_SCENE);
    modelScene.selectModel(params.model);
    bomSource = modelScene;
    return modelScene;
  }
  return container.get(PART_DISPLAY_SCENE);
}

const scene = chooseScene();
const bom = bomSource ? { service: container.get(BOM_SERVICE), source: bomSource } : null;

createRoot(rootElement).render(
  <StrictMode>
    <App
      scene={scene}
      params={params}
      placements={placements}
      importScene={importScene}
      bom={bom}
    />
  </StrictMode>,
);
