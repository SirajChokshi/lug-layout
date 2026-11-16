import { inject, injectable } from "inversify";
import { parseGlb, readInheritColorMesh, readPartMesh } from "./glb.ts";
import { parseManifest, parseModelFile, parsePartExtras, type ManifestPart } from "./manifest.ts";
import type {
  BundleLod,
  BundleModelEntry,
  IAssetFetcher,
  IPartBundleLoader,
  PartAsset,
  PartBundle,
  PartModel,
  StudPrimitiveAsset,
} from "./part-bundle.ts";
import { ASSET_FETCHER, BUNDLE_BASE_URL } from "./tokens.ts";

const MATRIX_FLOATS = 12;

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
  constructor(@inject(ASSET_FETCHER) private readonly fetcher: IAssetFetcher) {}

  async load(lod: BundleLod): Promise<PartBundle> {
    const manifest = parseManifest(JSON.parse(await this.fetcher.text(`${lod}/manifest.json`)));
    const studPrimitiveNames = manifest.studPrimitives.map((primitive) => primitive.name);
    const studPrimitives = await Promise.all(
      manifest.studPrimitives.map(async (primitive): Promise<StudPrimitiveAsset> => {
        const glb = parseGlb(await this.fetcher.bytes(`${lod}/${primitive.file}`));
        return { mesh: readInheritColorMesh(glb, primitive.name) };
      }),
    );
    const parts = await Promise.all(
      manifest.parts.map(async (part) =>
        toPartAsset(part, await this.fetcher.bytes(`${lod}/${part.file}`), studPrimitiveNames),
      ),
    );
    return {
      parts,
      studPrimitives,
      colors: manifest.colors,
      credits: manifest.credits,
      models: manifest.models,
    };
  }

  async loadModel(lod: BundleLod, entry: BundleModelEntry): Promise<PartModel> {
    const model = parseModelFile(
      JSON.parse(await this.fetcher.text(`${lod}/${entry.file}`)),
      entry.file,
    );
    const count = model.instances.part.length;
    return {
      sections: model.sections,
      instanceCount: count,
      partIndex: Uint16Array.from(model.instances.part),
      ldrawColor: Uint16Array.from(model.instances.color),
      matrices: Float32Array.from(model.instances.matrix),
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
