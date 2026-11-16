import { ContainerModule } from "inversify";
import { ThreeSceneBackend } from "./three/three-scene-backend.ts";
import { SCENE_BACKEND } from "./tokens.ts";

export const renderModule = new ContainerModule(({ bind }) => {
  bind(SCENE_BACKEND).to(ThreeSceneBackend).inSingletonScope();
});
