import { inject, injectable } from "inversify";
import { parseGlb, readInheritColorMesh, readPartMesh } from "./glb.ts";
import {
  parseManifest,
  parseModelFile,
  parsePartExtras,
  type BundleManifest,
  type ManifestPart,
} from "./manifest.ts";
import type {
  BundleLod,
  IAssetFetcher,
  IPartBundleLoader,
  ModelBundle,
  PartAsset,
  PartBundle,
  PartFilter,
  StudPrimitiveAsset,
} from "./part-bundle.ts";
import { ASSET_FETCHER, BUNDLE_BASE_URL } from "./tokens.ts";

const MATRIX_FLOATS = 12;
const MAX_CONCURRENT_FETCHES = 32;

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

  private manifest(lod: BundleLod): Promise<BundleManifest> {
    const cached = this.manifests.get(lod);
    if (cached) return cached;
    const loading = this.fetcher
      .text(`${lod}/manifest.json`)
      .then((text) => parseManifest(JSON.parse(text)));
    this.manifests.set(lod, loading);
    return loading;
  }

  private async bundle(
    lod: BundleLod,
    manifest: BundleManifest,
    parts: ReadonlyArray<ManifestPart>,
  ): Promise<PartBundle> {
    const studPrimitiveNames = manifest.studPrimitives.map((primitive) => primitive.name);
    const studPrimitives = await Promise.all(
      manifest.studPrimitives.map(async (primitive): Promise<StudPrimitiveAsset> => {
        const glb = parseGlb(await this.fetcher.bytes(`${lod}/${primitive.file}`));
        return { mesh: readInheritColorMesh(glb, primitive.name) };
      }),
    );
    const assets = await mapConcurrently(parts, MAX_CONCURRENT_FETCHES, async (part) =>
      toPartAsset(part, await this.fetcher.bytes(`${lod}/${part.file}`), studPrimitiveNames),
    );
    return {
      bundleVersion: manifest.bundleVersion,
      parts: assets,
      studPrimitives,
      colors: manifest.colors,
      credits: manifest.credits,
      models: manifest.models,
    };
  }

  async load(lod: BundleLod, include: PartFilter): Promise<PartBundle> {
    const manifest = await this.manifest(lod);
    return this.bundle(lod, manifest, manifest.parts.filter(include));
  }

  async loadModel(lod: BundleLod, name: string): Promise<ModelBundle> {
    const manifest = await this.manifest(lod);
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
    const [phaseX, phaseZ] = file.lattice.phase;
    return {
      bundle: await this.bundle(lod, manifest, parts),
      entry,
      model: {
        sections: file.sections,
        lattice: {
          phaseX,
          phaseZ,
          aabbMin: file.lattice.aabb.min,
          aabbMax: file.lattice.aabb.max,
        },
        instanceCount: count,
        partIndex: Uint16Array.from(file.instances.part),
        ldrawColor: Uint16Array.from(file.instances.color),
        matrices: Float32Array.from(file.instances.matrix),
      },
    };
  }
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
    role: part.role,
    boundsMin: part.bounds.min,
    producedColor: part.displayColor?.ldraw,
    trackEnds: part.trackEnds,
    boundsMax: part.bounds.max,
    mesh: readPartMesh(glb, part.id),
    studPrimitiveIndex,
    studColors,
    studMatrices,
  };
}
