import { BUNDLE_BASE_URL, catalogModule } from "@brr/catalog";
import { renderModule } from "@brr/render";
import { ContainerModule } from "inversify";
import { CitySceneService } from "./scene/city-scene-service.ts";
import { CITY_SCENE } from "./tokens.ts";

export const clientModule = new ContainerModule(({ bind }) => {
  bind(CITY_SCENE).to(CitySceneService).inSingletonScope();
});

export interface MainThreadConfig {
  readonly bundleBaseUrl: string;
}

export function mainThreadModules(config: MainThreadConfig): ContainerModule[] {
  const configModule = new ContainerModule(({ bind }) => {
    bind(BUNDLE_BASE_URL).toConstantValue(config.bundleBaseUrl);
  });
  return [configModule, catalogModule, renderModule, clientModule];
}
