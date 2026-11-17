import {
  BundleIndex,
  CreditTableFile,
  CrosswalkFile,
  ModelFile,
  PartTableFile,
  type BundleCredit,
  type BundleLod,
  type BundleManifest,
  type ManifestPart,
} from "@brr/schema/bundle";
import { BUNDLE_POINTER_FILE, BundlePointer } from "@brr/schema/bundle-pointer";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { inject, injectable } from "inversify";
import type * as v from "valibot";
import { crosswalkMaps } from "./crosswalk.ts";
import {
  parseFarMeshGlb,
  parseGlb,
  readInheritColorMesh,
  readPartMesh,
  readUint32Array,
} from "./glb.ts";
import type {
  BricklinkPartCandidates,
  CompiledPartGlb,
  CatalogCrosswalk,
  IAssetFetcher,
  ImportContext,
  IPartBundleLoader,
  ModelBundle,
  ModelCells,
  PartModelLattice,
  ModelFarMesh,
  PartAsset,
  PartBundle,
  PartFilter,
  StudPrimitiveAsset,
} from "./part-bundle.ts";
import { FetchPool } from "./fetch-pool.ts";
import { ASSET_FETCHER, BUNDLE_BASE_URL, BUNDLE_MANIFEST_FILE } from "./tokens.ts";

const MATRIX_FLOATS = 12;
const COMPILED_PART_ROLE = "model";
const MAX_CONCURRENT_FETCHES = 16;
const POINTER_ATTEMPTS = 2;

interface ResolvedManifest {
  readonly file: string;
  readonly fromPointer: boolean;
}

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
    footprint: Uint32Array.from(cells.footprint),
    flat: Uint32Array.from(cells.flat),
    columnBottom: Int16Array.from(cells.columnBottom),
    columnTop: Int16Array.from(cells.columnTop),
  };
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
  private readonly pool = new FetchPool(MAX_CONCURRENT_FETCHES);
  private readonly partAssets = new Map<string, Promise<PartAsset>>();
  private readonly studPrimitiveAssets = new Map<
    BundleLod,
    Promise<ReadonlyArray<StudPrimitiveAsset>>
  >();
  private readonly crosswalks = new Map<BundleLod, Promise<CrosswalkFile>>();
  private resolvedManifest: Promise<ResolvedManifest> | undefined;

  constructor(
    @inject(ASSET_FETCHER) private readonly fetcher: IAssetFetcher,
    @inject(BUNDLE_MANIFEST_FILE) private readonly fallbackManifestFile: string,
  ) {}

  private manifestFile(): Promise<ResolvedManifest> {
    this.resolvedManifest ??= this.resolveManifestFile();
    return this.resolvedManifest;
  }

  private async resolveManifestFile(): Promise<ResolvedManifest> {
    for (let attempt = 0; attempt < POINTER_ATTEMPTS; attempt++) {
      const pointed = await this.pointer();
      if (pointed !== undefined) return { file: pointed, fromPointer: true };
    }
    return { file: this.fallbackManifestFile, fromPointer: false };
  }

  private async manifestIndex(lod: BundleLod): Promise<v.InferOutput<typeof BundleIndex>> {
    const { file, fromPointer } = await this.manifestFile();
    const path = `${lod}/${file}`;
    try {
      return await this.json(BundleIndex, path);
    } catch (error) {
      const source = fromPointer
        ? `the manifest ${BUNDLE_POINTER_FILE} names`
        : `${BUNDLE_POINTER_FILE} could not be read and the fallback manifest`;
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`The part bundle is unreachable: ${source}, ${path}, failed: ${cause}`, {
        cause: error,
      });
    }
  }

  private async pointer(): Promise<string | undefined> {
    let text: string;
    try {
      text = await this.text(BUNDLE_POINTER_FILE);
    } catch {
      return undefined;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return undefined;
    }
    const pointer = decode(BundlePointer, json, BUNDLE_POINTER_FILE);
    return pointer.ok ? pointer.value.manifestFile : undefined;
  }

  private bytes(path: string): Promise<ArrayBuffer> {
    return this.pool.run(() => this.fetcher.bytes(path));
  }

  private text(path: string): Promise<string> {
    return this.pool.run(() => this.fetcher.text(path));
  }

  private async json<const TSchema extends v.GenericSchema>(
    schema: TSchema,
    path: string,
  ): Promise<v.InferOutput<TSchema>> {
    return decodedOrThrow(decode(schema, JSON.parse(await this.text(path))), path);
  }

  private async manifest(lod: BundleLod): Promise<BundleManifest> {
    const index = await this.manifestIndex(lod);
    const [{ parts }, { credits }] = await Promise.all([
      this.json(PartTableFile, `${lod}/${index.partTable.file}`),
      this.json(CreditTableFile, `${lod}/${index.creditTable.file}`),
    ]);
    return { ...index, parts, credits };
  }

  loadManifest(lod: BundleLod): Promise<BundleManifest> {
    const cached = this.manifests.get(lod);
    if (cached) return cached;
    const loading = this.manifest(lod);
    this.manifests.set(lod, loading);
    loading.catch(() => {
      if (this.manifests.get(lod) === loading) this.manifests.delete(lod);
    });
    return loading;
  }

  private studPrimitives(
    lod: BundleLod,
    manifest: BundleManifest,
  ): Promise<ReadonlyArray<StudPrimitiveAsset>> {
    const cached = this.studPrimitiveAssets.get(lod);
    if (cached) return cached;
    const loading = Promise.all(
      manifest.studPrimitives.map(async (primitive): Promise<StudPrimitiveAsset> => {
        const glb = parseGlb(await this.bytes(`${lod}/${primitive.file}`), primitive.file);
        return { mesh: readInheritColorMesh(glb, primitive.name) };
      }),
    );
    this.studPrimitiveAssets.set(lod, loading);
    loading.catch(() => this.studPrimitiveAssets.delete(lod));
    return loading;
  }

  private partAsset(
    lod: BundleLod,
    part: ManifestPart,
    studPrimitiveNames: ReadonlyArray<string>,
  ): Promise<PartAsset> {
    const key = `${lod}/${part.file}`;
    const cached = this.partAssets.get(key);
    if (cached) return cached;
    const loading = this.bytes(key).then((bytes) => toPartAsset(part, bytes, studPrimitiveNames));
    this.partAssets.set(key, loading);
    loading.catch(() => this.partAssets.delete(key));
    return loading;
  }

  private async bundle(
    lod: BundleLod,
    manifest: BundleManifest,
    parts: ReadonlyArray<ManifestPart>,
  ): Promise<PartBundle> {
    const studPrimitiveNames = manifest.studPrimitives.map((primitive) => primitive.name);
    const [studPrimitives, assets] = await Promise.all([
      this.studPrimitives(lod, manifest),
      Promise.all(parts.map((part) => this.partAsset(lod, part, studPrimitiveNames))),
    ]);
    return {
      bundleVersion: manifest.bundleVersion,
      parts: assets,
      studPrimitives,
      colors: manifest.colors,
      credits: manifest.credits,
      models: manifest.models,
      trackCatalog: manifest.trackCatalog,
      trackShapes: manifest.trackShapes,
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
      Promise.all(
        partIds.map(async (id): Promise<PartAsset> => {
          const glb = compiledParts.get(id);
          if (glb) {
            const asset = compiledPartAsset(id, glb, studPrimitiveNames);
            compiledCredits.push(...asset.credits);
            return asset.part;
          }
          const part = manifestParts.get(id);
          if (!part) throw new Error(`part ${id} is neither in the bundle nor compiled`);
          return this.partAsset(lod, part, studPrimitiveNames);
        }),
      ),
    ]);
    return {
      bundleVersion: manifest.bundleVersion,
      parts: assets,
      studPrimitives,
      colors: manifest.colors,
      credits: [...manifest.credits, ...compiledCredits],
      models: manifest.models,
      trackCatalog: manifest.trackCatalog,
      trackShapes: manifest.trackShapes,
      milsEdgeRules: manifest.milsEdgeRules,
    };
  }

  async load(lod: BundleLod, include: PartFilter): Promise<PartBundle> {
    const manifest = await this.loadManifest(lod);
    return this.bundle(lod, manifest, manifest.parts.filter(include));
  }

  private crosswalkFile(lod: BundleLod): Promise<CrosswalkFile> {
    const cached = this.crosswalks.get(lod);
    if (cached) return cached;
    const loading = this.loadManifest(lod).then(async ({ crosswalk }) =>
      decodedOrThrow(
        decode(CrosswalkFile, JSON.parse(await this.text(`${lod}/${crosswalk.file}`))),
        `${lod}/${crosswalk.file}`,
      ),
    );
    this.crosswalks.set(lod, loading);
    loading.catch(() => this.crosswalks.delete(lod));
    return loading;
  }

  async loadCrosswalk(lod: BundleLod): Promise<CatalogCrosswalk> {
    return crosswalkMaps(await this.crosswalkFile(lod));
  }

  async loadBricklinkParts(lod: BundleLod): Promise<BricklinkPartCandidates> {
    return (await this.crosswalkFile(lod)).bricklinkParts;
  }

  async loadModel(lod: BundleLod, name: string): Promise<ModelBundle> {
    const manifest = await this.loadManifest(lod);
    const entry = manifest.models.find((model) => model.name === name);
    if (!entry) {
      const available = manifest.models.map((model) => model.name).join(", ");
      throw new Error(`model "${name}" is not in the bundle (available: ${available})`);
    }
    const file = decodedOrThrow(
      decode(ModelFile, JSON.parse(await this.text(`${lod}/${entry.file}`))),
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
    const [bundle, farMesh] = await Promise.all([
      this.bundle(lod, manifest, parts),
      entry.farMesh ? this.farMesh(`${lod}/${entry.farMesh.file}`) : undefined,
    ]);
    return {
      bundle,
      farMesh,
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

  private async farMesh(path: string): Promise<ModelFarMesh> {
    const glb = parseFarMeshGlb(await this.bytes(path), path);
    const { extras } = glb.document;
    const cellIndex = readUint32Array(glb, extras.arrays.voxelCells);
    const ldrawColor = readUint32Array(glb, extras.arrays.voxelColors);
    if (cellIndex.length !== extras.voxels.count || ldrawColor.length !== extras.voxels.count) {
      throw new Error(`${path}: voxel arrays do not hold ${extras.voxels.count} cells`);
    }
    return {
      mesh: readPartMesh(glb, path),
      voxels: {
        origin: extras.voxels.origin,
        cellLdu: extras.voxels.cellLdu,
        dims: extras.voxels.dims,
        cellIndex,
        ldrawColor,
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
  const part = { id, title: id, role: COMPILED_PART_ROLE, bounds: extras.bounds } as const;
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
    "id" | "title" | "role" | "bounds" | "displayColor" | "producedColors" | "trackEnds"
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
  return {
    id: part.id,
    title: part.title,
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
