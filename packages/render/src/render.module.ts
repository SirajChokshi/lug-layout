import { ContainerModule } from "inversify";
import { ThreeSceneBackend } from "./three/three-scene-backend.ts";
import {
  PLAN_SCENE_BACKEND,
  SCENE_BACKEND,
  THREE_SCENE_BACKEND,
  THUMBNAIL_RENDERER,
} from "./tokens.ts";

export const renderModule = new ContainerModule(({ bind }) => {
  bind(THREE_SCENE_BACKEND).to(ThreeSceneBackend).inSingletonScope();
  bind(SCENE_BACKEND).toService(THREE_SCENE_BACKEND);
  bind(THUMBNAIL_RENDERER).toService(THREE_SCENE_BACKEND);
  bind(PLAN_SCENE_BACKEND)
    .toDynamicValue((context) => context.get(THREE_SCENE_BACKEND).plan)
    .inSingletonScope();
});
