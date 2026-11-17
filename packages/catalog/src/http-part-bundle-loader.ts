import { inject, injectable } from "inversify";
import { parseGlb, readInheritColorMesh, readPartMesh } from "./glb.ts";
import {
  parseManifest,
  parseModelFile,
  parsePartExtras,
  type BundleManifest,
  type ManifestPart,
  type ModelFileLattice,
} from "./manifest.ts";
import type {
  BundleCredit,
  BundleLod,
  CompiledPartGlb,
  IAssetFetcher,
  ImportContext,
  IPartBundleLoader,
  ModelBundle,
  ModelLattice,
  PartAsset,
  PartBundle,
  PartFilter,
  StudPrimitiveAsset,
} from "./part-bundle.ts";
import { ASSET_FETCHER, BUNDLE_BASE_URL } from "./tokens.ts";

const MATRIX_FLOATS = 12;
const COMPILED_PART_ROLE = "model";
const MAX_CONCURRENT_FETCHES = 32;

function modelLattice(lattice: ModelFileLattice | null): ModelLattice | null {
  if (lattice === null) return null;
  const [phaseX, phaseZ] = lattice.phase;
  return { phaseX, phaseZ, aabbMin: lattice.aabb.min, aabbMax: lattice.aabb.max };
}

async function mapConcurrently<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) {
      const item = items[index];
      if (item !== undefined) results[index] = await map(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

@injectable()
export class HttpAssetFetcher implements IAssetFetcher {
  constructor(@inject(BUNDLE_BASE_URL) private readonly baseUrl: string) {}

  private async get(path: string): Promise<Response> {
    const url = `${this.baseUrl.replace(/\/$/u, "")}/${path}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
    return response;
  }

  async bytes(path: string): Promise<ArrayBuffer> {
    return (await this.get(path)).arrayBuffer();
  }

  async text(path: string): Promise<string> {
    return (await this.get(path)).text();
  }
}

@injectable()
export class HttpPartBundleLoader implements IPartBundleLoader {
  private readonly manifests = new Map<BundleLod, Promise<BundleManifest>>();

  constructor(@inject(ASSET_FETCHER) private readonly fetcher: IAssetFetcher) {}

  loadManifest(lod: BundleLod): Promise<BundleManifest> {
    const cached = this.manifests.get(lod);
    if (cached) return cached;
    const loading = this.fetcher
      .text(`${lod}/manifest.json`)
      .then((text) => parseManifest(JSON.parse(text)));
    this.manifests.set(lod, loading);
    return loading;
  }

  private studPrimitives(
    lod: BundleLod,
    manifest: BundleManifest,
  ): Promise<ReadonlyArray<StudPrimitiveAsset>> {
    return Promise.all(
      manifest.studPrimitives.map(async (primitive): Promise<StudPrimitiveAsset> => {
        const glb = parseGlb(await this.fetcher.bytes(`${lod}/${primitive.file}`));
        return { mesh: readInheritColorMesh(glb, primitive.name) };
      }),
    );
  }

  private async bundle(
    lod: BundleLod,
    manifest: BundleManifest,
    parts: ReadonlyArray<ManifestPart>,
  ): Promise<PartBundle> {
    const studPrimitiveNames = manifest.studPrimitives.map((primitive) => primitive.name);
    const [studPrimitives, assets] = await Promise.all([
      this.studPrimitives(lod, manifest),
      mapConcurrently(parts, MAX_CONCURRENT_FETCHES, async (part) =>
        toPartAsset(part, await this.fetcher.bytes(`${lod}/${part.file}`), studPrimitiveNames),
      ),
    ]);
    return {
      bundleVersion: manifest.bundleVersion,
      parts: assets,
      studPrimitives,
      colors: manifest.colors,
      credits: manifest.credits,
      models: manifest.models,
      trackCatalog: manifest.trackCatalog,
    };
  }

  async importContext(lod: BundleLod): Promise<ImportContext> {
    const manifest = await this.loadManifest(lod);
    if (!manifest.compiler) throw new Error(`bundle ${manifest.bundleVersion} ships no compiler`);
    return {
      bundleVersion: manifest.bundleVersion,
      source: manifest.source,
      compilerPath: `${lod}/${manifest.compiler.file}`,
      unofficialAllowlist: manifest.compiler.unofficialAllowlist,
      studPrimitiveNames: manifest.studPrimitives.map((primitive) => primitive.name),
      partIds: manifest.parts.map((part) => part.id),
      ldconfigCodes: manifest.colors.map((color) => color.code),
    };
  }

  async loadPartSet(
    lod: BundleLod,
    partIds: ReadonlyArray<string>,
    compiled: ReadonlyArray<CompiledPartGlb>,
  ): Promise<PartBundle> {
    const manifest = await this.loadManifest(lod);
    const manifestParts = new Map(manifest.parts.map((part) => [part.id, part]));
    const compiledParts = new Map(compiled.map((part) => [part.partId, part.glb]));
    const studPrimitiveNames = manifest.studPrimitives.map((primitive) => primitive.name);
    const compiledCredits: BundleCredit[] = [];
    const [studPrimitives, assets] = await Promise.all([
      this.studPrimitives(lod, manifest),
      mapConcurrently(partIds, MAX_CONCURRENT_FETCHES, async (id): Promise<PartAsset> => {
        const glb = compiledParts.get(id);
        if (glb) {
          const asset = compiledPartAsset(id, glb, studPrimitiveNames);
          compiledCredits.push(...asset.credits);
          return asset.part;
        }
        const part = manifestParts.get(id);
        if (!part) throw new Error(`part ${id} is neither in the bundle nor compiled`);
        return toPartAsset(
          part,
          await this.fetcher.bytes(`${lod}/${part.file}`),
          studPrimitiveNames,
        );
      }),
    ]);
    return {
      bundleVersion: manifest.bundleVersion,
      parts: assets,
      studPrimitives,
      colors: manifest.colors,
      credits: [...manifest.credits, ...compiledCredits],
      models: manifest.models,
      trackCatalog: manifest.trackCatalog,
    };
  }

  async load(lod: BundleLod, include: PartFilter): Promise<PartBundle> {
    const manifest = await this.loadManifest(lod);
    return this.bundle(lod, manifest, manifest.parts.filter(include));
  }

  async loadModel(lod: BundleLod, name: string): Promise<ModelBundle> {
    const manifest = await this.loadManifest(lod);
    const entry = manifest.models.find((model) => model.name === name);
    if (!entry) {
      const available = manifest.models.map((model) => model.name).join(", ");
      throw new Error(`model "${name}" is not in the bundle (available: ${available})`);
    }
    const file = parseModelFile(
      JSON.parse(await this.fetcher.text(`${lod}/${entry.file}`)),
      entry.file,
    );
    const manifestParts = new Map(manifest.parts.map((part) => [part.id, part]));
    const parts = file.parts.map((id) => {
      const part = manifestParts.get(id);
      if (!part) throw new Error(`${entry.file}: part ${id} is not in the manifest`);
      return part;
    });
    const count = file.instances.part.length;
    return {
      bundle: await this.bundle(lod, manifest, parts),
      entry,
      model: {
        sections: file.sections,
        lattice: modelLattice(file.lattice),
        instanceCount: count,
        partIndex: Uint16Array.from(file.instances.part),
        ldrawColor: Uint16Array.from(file.instances.color),
        matrices: Float32Array.from(file.instances.matrix),
        vehicles: file.vehicles,
      },
    };
  }
}

function compiledPartAsset(
  id: string,
  glb: Uint8Array,
  studPrimitiveNames: ReadonlyArray<string>,
): { part: PartAsset; credits: ReadonlyArray<BundleCredit> } {
  const bytes = glb.slice().buffer;
  const extras = parsePartExtras(parseGlb(bytes).document.extras, id);
  if (!extras.bounds) throw new Error(`${id}: compiled GLB carries no bounds`);
  const sources = extras.sources ?? [];
  const part: ManifestPart = {
    id,
    path: sources[0]?.path ?? id,
    role: COMPILED_PART_ROLE,
    file: "",
    bounds: extras.bounds,
  };
  return {
    part: toPartAsset(part, bytes, studPrimitiveNames),
    credits: sources.map((source) => ({
      path: source.path,
      title: "",
      author: source.author,
      license: source.license,
    })),
  };
}

function toPartAsset(
  part: ManifestPart,
  bytes: ArrayBuffer,
  studPrimitiveNames: ReadonlyArray<string>,
): PartAsset {
  const glb = parseGlb(bytes);
  const extras = parsePartExtras(glb.document.extras, part.id);
  const studCount = extras.studs.length;
  const studPrimitiveIndex = new Uint8Array(studCount);
  const studColors = new Uint16Array(studCount);
  const studMatrices = new Float32Array(studCount * MATRIX_FLOATS);
  for (let i = 0; i < studCount; i++) {
    const stud = extras.studs[i];
    if (!stud) continue;
    const primitive = studPrimitiveNames.indexOf(stud.primitive);
    if (primitive < 0) throw new Error(`${part.id}: unknown stud primitive ${stud.primitive}`);
    studPrimitiveIndex[i] = primitive;
    studColors[i] = stud.color;
    studMatrices.set(stud.matrix, i * MATRIX_FLOATS);
  }
  return {
    id: part.id,
    title: part.title ?? part.id,
    role: part.role,
    boundsMin: part.bounds.min,
    producedColor: part.displayColor?.ldraw,
    producedColors: part.producedColors?.colors.map((color) => color.ldraw) ?? [],
    trackEnds: part.trackEnds,
    boundsMax: part.bounds.max,
    mesh: readPartMesh(glb, part.id),
    studPrimitiveIndex,
    studColors,
    studMatrices,
  };
}
