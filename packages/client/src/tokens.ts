import type { ServiceIdentifier } from "inversify";
import type { ICitySceneService } from "./scene/city-scene-service.ts";

export const CITY_SCENE: ServiceIdentifier<ICitySceneService> = Symbol.for("brr.client.CityScene");
