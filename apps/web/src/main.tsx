import { mainThreadModules, PART_DISPLAY_SCENE } from "@brr/client";
import { Container } from "inversify";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { readViewerParams } from "./viewer/viewer-params.ts";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element");

const container = new Container();
container.load(...mainThreadModules({ bundleBaseUrl: new URL("bundle/", document.baseURI).href }));
const scene = container.get(PART_DISPLAY_SCENE);
const params = readViewerParams(location.search);

createRoot(rootElement).render(
  <StrictMode>
    <App scene={scene} params={params} />
  </StrictMode>,
);
