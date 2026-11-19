import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
  type IPartBundleLoader,
  type PartModel,
} from "@brr/catalog";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { mainThreadModules } from "../client.module.ts";
import { ColorTable } from "../scene/viewer-scene.ts";
import { modelPlaceable, type Placeable } from "./placeable.ts";

const fixtureBundleRoot = new URL(
  "../../../../tools/asset-pipeline/fixture-bundle/",
  import.meta.url,
);

function fixtureBundleFetcher(): IAssetFetcher {
  return {
    async bytes(path) {
      const buffer = await readFile(new URL(path, fixtureBundleRoot));
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
    text: (path) => readFile(new URL(path, fixtureBundleRoot), "utf8"),
  };
}

export function fixtureBundleLoader(): IPartBundleLoader {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(fixtureBundleFetcher());
  return container.get(PART_BUNDLE_LOADER);
}

export interface CheckedModel {
  readonly pending: Placeable;
  readonly checked: Placeable;
}

export async function fixtureModelChecks(name: string): Promise<CheckedModel> {
  const { bundle, model, entry } = await fixtureBundleLoader().loadModel("standard", name);
  const placeable = (studCover: PartModel["studCover"] | null): Placeable =>
    modelPlaceable(
      `${entry.origin}:${name}`,
      name,
      name,
      { ...model, studCover },
      { name, source: entry.source, sections: model.sections },
      bundle.parts,
      new ColorTable(bundle),
      null,
    );
  return { pending: placeable(null), checked: placeable(model.studCover) };
}

export async function fixtureModel(name: string): Promise<Placeable> {
  const { bundle, model, entry } = await fixtureBundleLoader().loadModel("standard", name);
  return modelPlaceable(
    `${entry.origin}:${name}`,
    name,
    name,
    model,
    { name, source: entry.source, sections: model.sections },
    bundle.parts,
    new ColorTable(bundle),
    null,
  );
}
