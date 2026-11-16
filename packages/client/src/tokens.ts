import type { ServiceIdentifier } from "inversify";
import type { IViewerScene } from "./scene/viewer-scene.ts";

export const PART_DISPLAY_SCENE: ServiceIdentifier<IViewerScene> = Symbol.for(
  "brr.client.PartDisplayScene",
);
