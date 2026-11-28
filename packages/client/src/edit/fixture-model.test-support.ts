import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type BricklinkPartCandidates,
  type CatalogCrosswalk,
  type CompiledPartGlb,
  type ConnectorLoad,
  type FetchPriority,
  type IAssetFetcher,
  type ImportContext,
  type IPartBundleLoader,
  type ModelBundle,
  type ModelRecord,
  type PackageAttribution,
  type PartBundle,
  type PartConnectors,
  type PartFilter,
  type PartMesh,
  type PartModel,
  type PartShapeRecord,
  type StudPrimitiveAsset,
} from "@brr/catalog";
import type {
  BundleIndex,
  BundleLod,
  BundleManifest,
  CatalogPart,
  LibraryPartsFile,
  OmrSetsFile,
  RollingDiagnosticsFile,
} from "@brr/schema/bundle";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { mainThreadModules } from "../client.module.ts";
import { ColorTable } from "../scene/viewer-scene.ts";
import { modelPlaceable, type Placeable } from "./placeable.ts";

const fixtureBundleRoot = new URL(
  "../../../../tools/asset-pipeline/fixture-bundle/",
  import.meta.url,
);
const builtBundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);

function directoryFetcher(root: URL): IAssetFetcher {
  return {
    async bytes(path) {
      const buffer = await readFile(new URL(path, root));
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
    text: (path) => readFile(new URL(path, root), "utf8"),
  };
}

export function fixtureBundleFetcher(): IAssetFetcher {
  return directoryFetcher(fixtureBundleRoot);
}

export function builtBundleFetcher(): IAssetFetcher {
  return directoryFetcher(builtBundleRoot);
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

export class WithFixtureModels implements IPartBundleLoader {
  constructor(
    private readonly shipped: IPartBundleLoader,
    private readonly names: ReadonlyArray<string>,
    private readonly fixtures: IPartBundleLoader = fixtureBundleLoader(),
  ) {}

  loadManifestFile(): Promise<string> {
    return this.shipped.loadManifestFile();
  }

  async loadIndex(lod: BundleLod): Promise<BundleIndex> {
    const [index, fixtures] = await Promise.all([
      this.shipped.loadIndex(lod),
      this.fixtures.loadIndex(lod),
    ]);
    const added = fixtures.models.filter((entry) => this.names.includes(entry.name));
    return { ...index, models: [...index.models, ...added] };
  }

  loadStudPrimitives(lod: BundleLod): Promise<ReadonlyArray<StudPrimitiveAsset>> {
    return this.shipped.loadStudPrimitives(lod);
  }

  loadPartShape(lod: BundleLod, part: CatalogPart): Promise<PartShapeRecord> {
    return this.shipped.loadPartShape(lod, part);
  }

  loadModelRecord(lod: BundleLod, name: string): Promise<ModelRecord> {
    return this.from(name).loadModelRecord(lod, name);
  }

  loadPartMesh(lod: BundleLod, file: string, priority: FetchPriority): Promise<PartMesh> {
    return this.shipped.loadPartMesh(lod, file, priority);
  }

  setPartMeshPriority(lod: BundleLod, file: string, priority: FetchPriority): void {
    this.shipped.setPartMeshPriority(lod, file, priority);
  }

  loadFarModelMesh(name: string, priority: FetchPriority): Promise<PartMesh | null> {
    return this.from(name).loadFarModelMesh(name, priority);
  }

  loadPartFiles(lod: BundleLod): Promise<ReadonlyMap<string, string>> {
    return this.shipped.loadPartFiles(lod);
  }

  loadManifest(lod: BundleLod): Promise<BundleManifest> {
    return this.shipped.loadManifest(lod);
  }

  load(lod: BundleLod, include: PartFilter): Promise<PartBundle> {
    return this.shipped.load(lod, include);
  }

  loadModel(lod: BundleLod, name: string): Promise<ModelBundle> {
    return this.from(name).loadModel(lod, name);
  }

  loadPartConnectors(lod: BundleLod, partId: string): Promise<PartConnectors | null> {
    return this.shipped.loadPartConnectors(lod, partId);
  }

  readPartConnectors(lod: BundleLod, partId: string): Promise<ConnectorLoad> {
    return this.shipped.readPartConnectors(lod, partId);
  }

  prefetchPartConnectors(lod: BundleLod): Promise<void> {
    return this.shipped.prefetchPartConnectors(lod);
  }

  loadConnectivityAttribution(lod: BundleLod): Promise<PackageAttribution> {
    return this.shipped.loadConnectivityAttribution(lod);
  }

  loadSectionVocabularyAttribution(lod: BundleLod): Promise<PackageAttribution | null> {
    return this.shipped.loadSectionVocabularyAttribution(lod);
  }

  importContext(lod: BundleLod): Promise<ImportContext> {
    return this.shipped.importContext(lod);
  }

  loadPartSet(
    lod: BundleLod,
    partIds: ReadonlyArray<string>,
    compiled: ReadonlyArray<CompiledPartGlb>,
  ): Promise<PartBundle> {
    return this.shipped.loadPartSet(lod, partIds, compiled);
  }

  loadCrosswalk(lod: BundleLod): Promise<CatalogCrosswalk> {
    return this.shipped.loadCrosswalk(lod);
  }

  loadBricklinkParts(lod: BundleLod): Promise<BricklinkPartCandidates> {
    return this.shipped.loadBricklinkParts(lod);
  }

  loadRollingDiagnostics(lod: BundleLod): Promise<RollingDiagnosticsFile | null> {
    return this.shipped.loadRollingDiagnostics(lod);
  }

  loadLibraryParts(lod: BundleLod): Promise<LibraryPartsFile | null> {
    return this.shipped.loadLibraryParts(lod);
  }

  loadOmrSets(lod: BundleLod): Promise<OmrSetsFile | null> {
    return this.shipped.loadOmrSets(lod);
  }

  private from(name: string): IPartBundleLoader {
    return this.names.includes(name) ? this.fixtures : this.shipped;
  }
}
