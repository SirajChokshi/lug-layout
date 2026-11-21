import type { PartAsset, PartModel } from "@brr/catalog";
import type { MergedParts } from "../edit/merged-parts.ts";
import { instanceBoxes, vehicleTop } from "../running-gear/instance-boxes.ts";
import type { GearModelSource } from "../running-gear/running-gear-editor.ts";
import type { ColorTable } from "../scene/viewer-scene.ts";

export type RollingStockModel = Omit<PartModel, "studCover">;

export interface PlayModel {
  readonly name: string;
  readonly label: string;
  readonly model: RollingStockModel;
  readonly colorIndex: Uint16Array;
  readonly gear: GearModelSource;
  readonly vehicleTops: Float64Array;
}

export interface RollingStockIdentity {
  readonly name: string;
  readonly label: string;
  readonly sha256: string;
}

export function playModel(
  identity: RollingStockIdentity,
  model: RollingStockModel,
  modelBundle: { readonly parts: ReadonlyArray<PartAsset> },
  palette: MergedParts,
  colors: ColorTable,
  studBoxes: ReadonlyArray<Float64Array>,
): PlayModel {
  const remapped = palette.remap(model, modelBundle.parts);
  const colorIndex = new Uint16Array(model.instanceCount);
  for (let i = 0; i < model.instanceCount; i++) {
    colorIndex[i] = colors.indexOfCode(model.ldrawColor[i] ?? 0);
  }
  const studded = instanceBoxes(model, modelBundle, studBoxes);
  return {
    name: identity.name,
    label: identity.label,
    model: remapped,
    colorIndex,
    vehicleTops: Float64Array.from(model.vehicles, (vehicle) => vehicleTop(studded, vehicle)),
    gear: {
      name: identity.name,
      sha256: identity.sha256,
      vehicles: model.vehicles,
      instanceBoxes: instanceBoxes(model, modelBundle),
    },
  };
}
