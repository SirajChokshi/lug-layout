import type { ServiceIdentifier } from "inversify";
import type { ISceneBackend, IThumbnailRenderer } from "./scene-backend.ts";
import type { ThreeSceneBackend } from "./three/three-scene-backend.ts";

export const SCENE_BACKEND: ServiceIdentifier<ISceneBackend> =
  Symbol.for("brr.render.SceneBackend");
export const THUMBNAIL_RENDERER: ServiceIdentifier<IThumbnailRenderer> = Symbol.for(
  "brr.render.ThumbnailRenderer",
);
export const THREE_SCENE_BACKEND: ServiceIdentifier<ThreeSceneBackend> = Symbol.for(
  "brr.render.ThreeSceneBackend",
);
