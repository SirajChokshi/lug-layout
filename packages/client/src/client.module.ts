import { BUNDLE_BASE_URL, catalogModule } from "@brr/catalog";
import { renderModule } from "@brr/render";
import { ContainerModule } from "inversify";
import { PartDisplayScene } from "./scene/part-display-scene.ts";
import { PART_DISPLAY_SCENE } from "./tokens.ts";

const clientModule = new ContainerModule(({ bind }) => {
  bind(PART_DISPLAY_SCENE).to(PartDisplayScene).inSingletonScope();
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
