import { PLATE_LDU } from "@brr/math";
import {
  BundleManifest,
  ModelFile,
  type BundleCredit,
  type BundleLod,
  type ManifestPart,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { inject, injectable } from "inversify";
import { parseGlb, readInheritColorMesh, readPartMesh } from "./glb.ts";
import type {
  CompiledPartGlb,
  IAssetFetcher,
  ImportContext,
  IPartBundleLoader,
  ModelBundle,
  ModelCells,
  PartModelLattice,
  PartAsset,
  PartBundle,
  PartFilter,
  StudPrimitiveAsset,
} from "./part-bundle.ts";
import { PIN_BOX_FLOATS, PIN_ORIGIN_FLOATS } from "./part-bundle.ts";
import { ASSET_FETCHER, BUNDLE_BASE_URL, BUNDLE_MANIFEST_FILE } from "./tokens.ts";

const MATRIX_FLOATS = 12;
const COMPILED_PART_ROLE = "model";
const MAX_CONCURRENT_FETCHES = 32;

function modelLattice(lattice: ModelFile["lattice"]): PartModelLattice | null {
  if (lattice === null) return null;
  const [phaseX, phaseZ] = lattice.phase;
  return { phaseX, phaseZ, aabbMin: lattice.aabb.min, aabbMax: lattice.aabb.max };
}

function modelCells(cells: ModelFile["cover"]["cells"]): ModelCells | null {
  if (cells === null) return null;
  const [originX, originZ] = cells.origin;
  const [width, depth] = cells.size;
  return {
    originX,
    originZ,
    width,
    depth,
    restY: cells.bottomY,
    groundY: cells.groundY,
    footprint: Uint32Array.from(cells.footprint),
    flat: Uint32Array.from(cells.flat),
    columnBottom: Int16Array.from(cells.columnBottom),
    columnTop: Int16Array.from(cells.columnTop),
  };
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

  constructor(
    @inject(ASSET_FETCHER) private readonly fetcher: IAssetFetcher,
    @inject(BUNDLE_MANIFEST_FILE) private readonly manifestFile: string,
  ) {}

  loadManifest(lod: BundleLod): Promise<BundleManifest> {
    const cached = this.manifests.get(lod);
    if (cached) return cached;
    const loading = this.fetcher
      .text(`${lod}/${this.manifestFile}`)
      .then((text) =>
        decodedOrThrow(decode(BundleManifest, JSON.parse(text)), `${lod}/${this.manifestFile}`),
      );
    this.manifests.set(lod, loading);
    return loading;
  }

  private studPrimitives(
    lod: BundleLod,
    manifest: BundleManifest,
  ): Promise<ReadonlyArray<StudPrimitiveAsset>> {
    return Promise.all(
      manifest.studPrimitives.map(async (primitive): Promise<StudPrimitiveAsset> => {
        const glb = parseGlb(await this.fetcher.bytes(`${lod}/${primitive.file}`), primitive.file);
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
      milsEdgeRules: manifest.milsEdgeRules,
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
      milsEdgeRules: manifest.milsEdgeRules,
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
    const file = decodedOrThrow(
      decode(ModelFile, JSON.parse(await this.fetcher.text(`${lod}/${entry.file}`))),
      entry.file,
    );
    const manifestParts = new Map(manifest.parts.map((part) => [part.id, part]));
    const parts = file.parts.map((id) => {
      const part = manifestParts.get(id);
      if (!part) throw new Error(`${entry.file}: part ${id} is not in the manifest`);
      return part;
    });
    const count = file.instances.part.length;
    const { cover } = file;
    return {
      bundle: await this.bundle(lod, manifest, parts),
      entry,
      model: {
        sections: file.sections,
        lattice: modelLattice(file.lattice),
        studCover: {
          studs: cover.studs,
          covered: cover.coveredStuds,
          visibleBits: Uint32Array.from(cover.visibleBits),
        },
        cells: modelCells(cover.cells),
        instanceCount: count,
        partIndex: Uint16Array.from(file.instances.part),
        ldrawColor: Uint16Array.from(file.instances.color),
        matrices: Float32Array.from(file.instances.matrix),
        vehicles: file.vehicles.map((vehicle) => ({
          ...vehicle,
          body: Uint32Array.from(vehicle.body),
          bogies: vehicle.bogies.map((bogie) => ({
            ...bogie,
            instances: Uint32Array.from(bogie.instances),
          })),
        })),
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
  const { extras } = parseGlb(bytes, id).document;
  const part = {
    id,
    title: id,
    role: COMPILED_PART_ROLE,
    bounds: extras.bounds,
    baseplate: extras.bounds.max[1] - extras.bounds.min[1] < PLATE_LDU && extras.studs.length > 0,
    aliasOf: null,
  } as const;
  return {
    part: toPartAsset(part, bytes, studPrimitiveNames),
    credits: extras.sources.map((source) => ({
      path: source.path,
      title: "",
      author: source.author,
      license: source.license,
    })),
  };
}

function toPartAsset(
  part: Pick<
    ManifestPart,
    | "id"
    | "title"
    | "role"
    | "bounds"
    | "displayColor"
    | "producedColors"
    | "trackEnds"
    | "baseplate"
    | "aliasOf"
  >,
  bytes: ArrayBuffer,
  studPrimitiveNames: ReadonlyArray<string>,
): PartAsset {
  const glb = parseGlb(bytes, part.id);
  const { extras } = glb.document;
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
  const holeMatrices = new Float32Array(extras.technicHoles.length * MATRIX_FLOATS);
  for (let i = 0; i < extras.technicHoles.length; i++) {
    const hole = extras.technicHoles[i];
    if (hole) holeMatrices.set(hole.matrix, i * MATRIX_FLOATS);
  }
  const pinCount = extras.technicPins.length;
  const pinOrigins = new Float32Array(pinCount * PIN_ORIGIN_FLOATS);
  const pinBoxes = new Float32Array(pinCount * PIN_BOX_FLOATS);
  for (let i = 0; i < pinCount; i++) {
    const pin = extras.technicPins[i];
    if (!pin) continue;
    pinOrigins.set(
      [pin.matrix[3] ?? 0, pin.matrix[7] ?? 0, pin.matrix[11] ?? 0],
      i * PIN_ORIGIN_FLOATS,
    );
    pinBoxes.set([...pin.bounds.min, ...pin.bounds.max], i * PIN_BOX_FLOATS);
  }
  return {
    id: part.id,
    title: part.title,
    role: part.role,
    boundsMin: part.bounds.min,
    producedColor: part.displayColor?.ldraw,
    producedColors: part.producedColors?.colors.map((color) => color.ldraw) ?? [],
    baseplate: part.baseplate,
    aliasOf: part.aliasOf,
    trackEnds: part.trackEnds,
    boundsMax: part.bounds.max,
    mesh: readPartMesh(glb, part.id),
    studPrimitiveIndex,
    studColors,
    studMatrices,
    holeMatrices,
    pinOrigins,
    pinBoxes,
  };
}
