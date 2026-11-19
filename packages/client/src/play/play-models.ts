import type { PartAsset, PartModel } from "@brr/catalog";
import type { MergedParts } from "../edit/merged-parts.ts";
import type { PlayTrack } from "../edit/track-drawing.ts";
import type { ColorTable } from "../scene/viewer-scene.ts";

export interface PlayModel {
  readonly name: string;
  readonly label: string;
  readonly model: PartModel;
  readonly colorIndex: Uint16Array;
}

export interface PlayModelName {
  readonly name: string;
  readonly label: string;
}

export function playModel(
  { name, label }: PlayModelName,
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
    name,
    label,
    model: remapped,
    colorIndex,
  };
}

export interface PlayRefusal {
  readonly label: string;
  readonly reason: string;
}

export interface PlaySetup {
  readonly track: PlayTrack;
  readonly models: ReadonlyArray<PlayModel>;
  readonly refused: ReadonlyArray<PlayRefusal>;
  readonly railFitNotChecked: ReadonlyArray<string>;
  readonly parts: ReadonlyArray<PartAsset>;
  readonly colors: ColorTable;
}
