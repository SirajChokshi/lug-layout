import type { PartAsset, PartBundle, PartModel } from "@brr/catalog";
import type { BundleModelEntry } from "@brr/schema/bundle";
import type { MergedParts } from "../edit/merged-parts.ts";
import type { PlayTrack } from "../edit/track-drawing.ts";
import { instanceBoxes } from "../running-gear/instance-boxes.ts";
import type { GearModelSource } from "../running-gear/running-gear-editor.ts";
import type { ColorTable } from "../scene/viewer-scene.ts";

export interface PlayModel {
  readonly name: string;
  readonly setName: string | null;
  readonly model: PartModel;
  readonly colorIndex: Uint16Array;
  readonly gear: GearModelSource;
}

export function playModel(
  entry: BundleModelEntry,
  model: PartModel,
  modelBundle: PartBundle,
  palette: MergedParts,
  colors: ColorTable,
): PlayModel {
  const remapped = palette.remap(model, modelBundle.parts);
  const colorIndex = new Uint16Array(model.instanceCount);
  for (let i = 0; i < model.instanceCount; i++) {
    colorIndex[i] = colors.indexOfCode(model.ldrawColor[i] ?? 0);
  }
  return {
    name: entry.name,
    setName: entry.set?.name ?? null,
    model: remapped,
    colorIndex,
    gear: {
      name: entry.name,
      sha256: entry.sha256,
      vehicles: model.vehicles,
      instanceBoxes: instanceBoxes(model, modelBundle),
    },
  };
}

export interface PlaySetup {
  readonly track: PlayTrack;
  readonly models: ReadonlyArray<PlayModel>;
  readonly parts: ReadonlyArray<PartAsset>;
  readonly colors: ColorTable;
}
