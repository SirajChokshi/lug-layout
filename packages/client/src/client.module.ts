import { BUNDLE_BASE_URL, catalogModule } from "@brr/catalog";
import { renderModule } from "@brr/render";
import { ContainerModule } from "inversify";
import { CreditsService } from "./credits/credits-service.ts";
import { Editor } from "./edit/editor.ts";
import { CityScene } from "./scene/city-scene.ts";
import { ModelScene } from "./scene/model-scene.ts";
import { PartDisplayScene } from "./scene/part-display-scene.ts";
import { TrackScene } from "./scene/track-scene.ts";
import {
  CITY_SCENE,
  CREDITS,
  EDITOR,
  MODEL_SCENE,
  PART_DISPLAY_SCENE,
  TRACK_SCENE,
} from "./tokens.ts";

const clientModule = new ContainerModule(({ bind }) => {
  bind(PART_DISPLAY_SCENE).to(PartDisplayScene).inSingletonScope();
  bind(MODEL_SCENE).to(ModelScene).inSingletonScope();
  bind(CITY_SCENE).to(CityScene).inSingletonScope();
  bind(EDITOR).to(Editor).inSingletonScope();
  bind(CREDITS).to(CreditsService).inSingletonScope();
  bind(TRACK_SCENE).to(TrackScene).inSingletonScope();
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
