import type { ServiceIdentifier } from "inversify";
import type { ISceneBackend } from "./scene-backend.ts";

export const SCENE_BACKEND: ServiceIdentifier<ISceneBackend> =
  Symbol.for("brr.render.SceneBackend");
