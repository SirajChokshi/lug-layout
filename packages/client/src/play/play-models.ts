import type { PartAsset, PartModel } from "@brr/catalog";
import type { MergedParts } from "../edit/merged-parts.ts";
import { instanceBoxes } from "../running-gear/instance-boxes.ts";
import type { GearModelSource } from "../running-gear/running-gear-editor.ts";
import type { ColorTable } from "../scene/viewer-scene.ts";

export interface PlayModel {
  readonly name: string;
  readonly label: string;
  readonly model: PartModel;
  readonly colorIndex: Uint16Array;
  readonly gear: GearModelSource;
}

export interface RollingStockIdentity {
  readonly name: string;
  readonly label: string;
  readonly sha256: string;
}

export function playModel(
  identity: RollingStockIdentity,
  model: PartModel,
  modelBundle: { readonly parts: ReadonlyArray<PartAsset> },
  palette: MergedParts,
  colors: ColorTable,
): PlayModel {
  const remapped = palette.remap(model, modelBundle.parts);
  const colorIndex = new Uint16Array(model.instanceCount);
  for (let i = 0; i < model.instanceCount; i++) {
    colorIndex[i] = colors.indexOfCode(model.ldrawColor[i] ?? 0);
  }
  return {
    name: identity.name,
    label: identity.label,
    model: remapped,
    colorIndex,
    gear: {
      name: identity.name,
      sha256: identity.sha256,
      vehicles: model.vehicles,
      instanceBoxes: instanceBoxes(model, modelBundle),
    },
  };
}
