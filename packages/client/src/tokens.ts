import type { ServiceIdentifier } from "inversify";
import type { IModelScene } from "./scene/model-scene.ts";
import type { IViewerScene } from "./scene/viewer-scene.ts";

export const PART_DISPLAY_SCENE: ServiceIdentifier<IViewerScene> = Symbol.for(
  "brr.client.PartDisplayScene",
);
export const MODEL_SCENE: ServiceIdentifier<IModelScene> = Symbol.for("brr.client.ModelScene");
