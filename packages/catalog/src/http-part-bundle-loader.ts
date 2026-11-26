import { AssetResponseError } from "./asset-response-error.ts";
import { AssetStalledError } from "./asset-stalled-error.ts";
import {
  ConnectorRecords,
  type ConnectorIndexPaths,
  type ConnectorLoad,
  type PackageAttribution,
  type PartConnectors,
  type ReadJson,
} from "./connector-records.ts";
import {
  ALPHA_OPAQUE,
  BundleIndex,
  ConnectorPackage,
  ConnectorPackFile,
  CreditTableFile,
  CrosswalkFile,
  LibraryPartsFile,
  ModelFile,
  PartShape,
  PartTableFile,
  RollingDiagnosticsFile,
  SectionVocabularyFile,
  type BundleCredit,
  type BundleLod,
  type BundleManifest,
  type CatalogPart,
  type ConnectorPacks,
  type ManifestPart,
  type StudRecord,
} from "@brr/schema/bundle";
import { BUNDLE_POINTER_FILE, BundlePointer } from "@brr/schema/bundle-pointer";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { inject, injectable } from "inversify";
import type * as v from "valibot";
import { crosswalkMaps } from "./crosswalk.ts";
import { modelPartCells } from "./model-part-cells.ts";
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
  FetchPriority,
  IAssetFetcher,
  ImportContext,
  IPartBundleLoader,
  ModelBundle,
  ModelCells,
  PartModel,
  PartModelLattice,
  ModelFarMesh,
  ModelRecord,
  PartAsset,
  PartMesh,
  PartShapeRecord,
  PartBundle,
  PartFilter,
  PinnedSectionVocabulary,
  StudPrimitiveAsset,
} from "./part-bundle.ts";
import { FetchPool, type FetchLane, type FetchPoolPolicy } from "./fetch-pool.ts";
import type { ILinkProgress } from "./link-progress.ts";
import {
  ASSET_FETCHER,
  LINK_SILENCE_LIMIT_MS,
  BUNDLE_BASE_URL,
  BUNDLE_MANIFEST_FILE,
  FETCH_POOL_POLICY,
  LINK_PROGRESS,
} from "./tokens.ts";

const MATRIX_FLOATS = 12;
const COMPILED_PART_ROLE = "model";
const HEX_RADIX = 16;
const BYTE_HEX_DIGITS = 2;

interface PinnedSectionVocabularyFile {
  readonly sha256: string;
  readonly file: SectionVocabularyFile;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest]
    .map((byte) => byte.toString(HEX_RADIX).padStart(BYTE_HEX_DIGITS, "0"))
    .join("");
}
const POINTER_ATTEMPTS = 2;

interface ResolvedManifest {
  readonly file: string;
  readonly fromPointer: boolean;
}
const FAR_LOD: BundleLod = "far";

function modelLattice(lattice: ModelFile["lattice"]): PartModelLattice | null {
  if (lattice === null) return null;
  const [phaseX, phaseZ] = lattice.phase;
  return { phaseX, phaseZ, aabbMin: lattice.aabb.min, aabbMax: lattice.aabb.max };
}

function modelCells(cells: ModelFile["cover"]["cells"], label: string): ModelCells | null {
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
    footing: {
      instance: Uint32Array.from(cells.footing.instance),
      cell: Uint32Array.from(cells.footing.cell),
    },
    partCells: cells.partCells
      ? modelPartCells(
          cells.partCells.cell,
          cells.partCells.instance,
          cells.partCells.boxes,
          width * depth,
          label,
        )
      : null,
  };
}

function connectorIndexPaths(
  lod: BundleLod,
  index: Pick<BundleIndex, "connectors" | "connectivity">,
): ConnectorIndexPaths {
  return {
    connectivity: `${lod}/${index.connectivity.file}`,
    connectors: `${lod}/${index.connectors.file}`,
  };
}

export const DEFAULT_LINK_SILENCE_LIMIT_MS = 50_000;

const utf8 = new TextDecoder();

class SilenceWatch {
  readonly signal: AbortSignal;
  readonly stalled: Promise<never>;
  private timer: ReturnType<typeof setTimeout>;

  constructor(url: string, limitMs: number, link: ILinkProgress) {
    const controller = new AbortController();
    const { promise, reject } = Promise.withResolvers<never>();
    this.signal = controller.signal;
    this.stalled = promise;
    const check = (): void => {
      const remainingMs = limitMs - link.silenceMs();
      if (remainingMs > 0) {
        this.timer = setTimeout(check, Math.ceil(remainingMs));
        return;
      }
      reject(new AssetStalledError(url, limitMs));
      controller.abort();
    };
    this.timer = setTimeout(check, limitMs);
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}

function joined(chunks: ReadonlyArray<Uint8Array>, length: number): ArrayBuffer {
  const only = chunks.length === 1 ? chunks[0] : undefined;
  if (
    only?.buffer instanceof ArrayBuffer &&
    only.byteOffset === 0 &&
    only.byteLength === only.buffer.byteLength
  ) {
    return only.buffer;
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

async function download(
  url: string,
  signal: AbortSignal,
  link: ILinkProgress,
): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal });
  link.markProgress();
  if (!response.ok) throw new AssetResponseError(url, response.status);
  if (response.body === null) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    link.markProgress();
    chunks.push(read.value);
    length += read.value.byteLength;
  }
  return joined(chunks, length);
}

@injectable()
export class HttpAssetFetcher implements IAssetFetcher {
  constructor(
    @inject(BUNDLE_BASE_URL) private readonly baseUrl: string,
    @inject(LINK_SILENCE_LIMIT_MS) private readonly linkSilenceLimitMs: number,
    @inject(LINK_PROGRESS) private readonly link: ILinkProgress,
  ) {
    if (!Number.isInteger(linkSilenceLimitMs) || linkSilenceLimitMs <= 0) {
      throw new Error(
        `a link silence limit of ${linkSilenceLimitMs} ms is not a positive whole number of milliseconds`,
      );
    }
  }

  bytes(path: string): Promise<ArrayBuffer> {
    return this.get(path);
  }

  async text(path: string): Promise<string> {
    return utf8.decode(await this.get(path));
  }

  private get(path: string): Promise<ArrayBuffer> {
    const url = `${this.baseUrl.replace(/\/$/u, "")}/${path}`;
    const watch = new SilenceWatch(url, this.linkSilenceLimitMs, this.link);
    return Promise.race([watch.stalled, download(url, watch.signal, this.link)]).finally(() =>
      watch.stop(),
    );
  }
}

@injectable()
export class HttpPartBundleLoader implements IPartBundleLoader {
  private readonly indices = new Map<BundleLod, Promise<BundleIndex>>();
  private readonly manifests = new Map<BundleLod, Promise<BundleManifest>>();
  private readonly meshes = new Map<string, Promise<PartMesh>>();
  private readonly partAssets = new Map<string, Promise<PartAsset>>();
  private readonly studPrimitiveAssets = new Map<
    BundleLod,
    Promise<ReadonlyArray<StudPrimitiveAsset>>
  >();
  private readonly crosswalks = new Map<BundleLod, Promise<CrosswalkFile>>();
  private readonly rollingDiagnosticsFiles = new Map<
    BundleLod,
    Promise<RollingDiagnosticsFile | null>
  >();
  private readonly connectorRecords = new Map<BundleLod, Promise<ConnectorRecords>>();
  private readonly partConnectorReads = new Map<string, Promise<ConnectorLoad>>();
  private readonly connectorPackFiles = new Map<BundleLod, Promise<ReadonlyMap<string, unknown>>>();
  private readonly sectionVocabularies = new Map<
    BundleLod,
    Promise<PinnedSectionVocabularyFile | null>
  >();
  private resolvedManifest: Promise<ResolvedManifest> | undefined;

  private readonly pool: FetchPool;

  constructor(
    @inject(ASSET_FETCHER) private readonly fetcher: IAssetFetcher,
    @inject(BUNDLE_MANIFEST_FILE) private readonly fallbackManifestFile: string,
    @inject(FETCH_POOL_POLICY) poolPolicy: FetchPoolPolicy,
  ) {
    this.pool = new FetchPool(poolPolicy);
  }

  async loadManifestFile(): Promise<string> {
    return (await this.manifestFile()).file;
  }

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

  private bytes(path: string, lane: FetchLane): Promise<ArrayBuffer> {
    return this.pool.run(path, () => this.fetcher.bytes(path), lane);
  }

  private text(path: string): Promise<string> {
    return this.pool.run(path, () => this.fetcher.text(path), "structural");
  }

  private async json<const TSchema extends v.GenericSchema>(
    schema: TSchema,
    path: string,
  ): Promise<v.InferOutput<TSchema>> {
    return decodedOrThrow(decode(schema, JSON.parse(await this.text(path))), path);
  }

  private cached<K, T>(cache: Map<K, Promise<T>>, key: K, load: () => Promise<T>): Promise<T> {
    const existing = cache.get(key);
    if (existing) return existing;
    const loading = load();
    cache.set(key, loading);
    loading.catch(() => {
      if (cache.get(key) === loading) cache.delete(key);
    });
    return loading;
  }

  loadIndex(lod: BundleLod): Promise<BundleIndex> {
    return this.cached(this.indices, lod, () => this.manifestIndex(lod));
  }

  async loadStudPrimitives(lod: BundleLod): Promise<ReadonlyArray<StudPrimitiveAsset>> {
    return this.studPrimitives(lod, await this.loadIndex(lod));
  }

  async loadPartShape(lod: BundleLod, part: CatalogPart): Promise<PartShapeRecord> {
    const [index, shape] = await Promise.all([
      this.loadIndex(lod),
      this.json(PartShape, `${lod}/${part.shape.file}`),
    ]);
    return shapeRecord(shape, studPrimitiveNamesOf(index));
  }

  async loadModelRecord(lod: BundleLod, name: string): Promise<ModelRecord> {
    const index = await this.loadIndex(lod);
    const entry = index.models.find((model) => model.name === name);
    if (!entry) throw new Error(`model "${name}" is not in the bundle`);
    const file = await this.json(ModelFile, `${lod}/${entry.file}`);
    const names = studPrimitiveNamesOf(index);
    return {
      entry,
      model: partModel(file),
      parts: file.shapes.map((shape) => shapeRecord(shape, names)),
    };
  }

  loadPartMesh(lod: BundleLod, file: string, priority: FetchPriority): Promise<PartMesh> {
    const path = `${lod}/${file}`;
    return this.cached(this.meshes, path, async () =>
      readPartMesh(parseGlb(await this.bytes(path, priority), file), file),
    );
  }

  setPartMeshPriority(lod: BundleLod, file: string, priority: FetchPriority): void {
    this.pool.setPriority(`${lod}/${file}`, priority);
  }

  async loadFarModelMesh(name: string, priority: FetchPriority): Promise<PartMesh | null> {
    const index = await this.loadIndex(FAR_LOD);
    const farMesh = index.models.find((model) => model.name === name)?.farMesh;
    if (!farMesh) return null;
    return (await this.farMesh(`${FAR_LOD}/${farMesh.file}`, priority)).mesh;
  }

  async loadPartFiles(lod: BundleLod): Promise<ReadonlyMap<string, string>> {
    const index = await this.loadIndex(lod);
    const { parts } = await this.json(PartTableFile, `${lod}/${index.partTable.file}`);
    return new Map(parts.map((part) => [part.id, part.file]));
  }

  private async manifest(lod: BundleLod): Promise<BundleManifest> {
    const index = await this.loadIndex(lod);
    const [{ parts }, { credits }] = await Promise.all([
      this.json(PartTableFile, `${lod}/${index.partTable.file}`),
      this.json(CreditTableFile, `${lod}/${index.creditTable.file}`),
    ]);
    return { ...index, parts, credits };
  }

  loadManifest(lod: BundleLod): Promise<BundleManifest> {
    return this.cached(this.manifests, lod, () => this.manifest(lod));
  }

  private studPrimitives(
    lod: BundleLod,
    manifest: Pick<BundleIndex, "studPrimitives">,
  ): Promise<ReadonlyArray<StudPrimitiveAsset>> {
    const cached = this.studPrimitiveAssets.get(lod);
    if (cached) return cached;
    const loading = Promise.all(
      manifest.studPrimitives.map(async (primitive): Promise<StudPrimitiveAsset> => {
        const glb = parseGlb(
          await this.bytes(`${lod}/${primitive.file}`, "structural"),
          primitive.file,
        );
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
    const loading = this.bytes(key, "high").then((bytes) =>
      toPartAsset(part, bytes, studPrimitiveNames),
    );
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
      tablePlane: manifest.tablePlane,
    };
  }

  private sectionVocabularyFile(lod: BundleLod): Promise<PinnedSectionVocabularyFile | null> {
    let pinned = this.sectionVocabularies.get(lod);
    if (pinned === undefined) {
      pinned = this.loadIndex(lod).then(async ({ compiler }) => {
        if (!compiler) return null;
        const { file, sha256 } = compiler.sectionVocabulary;
        const path = `${lod}/${file}`;
        const bytes = await this.bytes(path, "structural");
        const digest = await sha256Hex(bytes);
        if (digest !== sha256) {
          throw new Error(`${path} has SHA-256 ${digest}, but the manifest references ${sha256}`);
        }
        const text = new TextDecoder().decode(bytes);
        return {
          sha256,
          file: decodedOrThrow(decode(SectionVocabularyFile, JSON.parse(text)), path),
        };
      });
      this.sectionVocabularies.set(lod, pinned);
    }
    return pinned;
  }

  async loadSectionVocabularyAttribution(lod: BundleLod): Promise<PackageAttribution | null> {
    const pinned = await this.sectionVocabularyFile(lod);
    return pinned && { licenses: [pinned.file.license], attribution: pinned.file.attribution };
  }

  private async pinnedSectionVocabulary(lod: BundleLod): Promise<PinnedSectionVocabulary> {
    const pinned = await this.sectionVocabularyFile(lod);
    if (!pinned) throw new Error(`the ${lod} bundle ships no compiler, so no section vocabulary`);
    const { sizes, lengths } = pinned.file;
    return { sha256: pinned.sha256, vocabulary: { sizes, lengths } };
  }

  async importContext(lod: BundleLod): Promise<ImportContext> {
    const manifest = await this.loadManifest(lod);
    if (!manifest.compiler) throw new Error(`bundle ${manifest.bundleVersion} ships no compiler`);
    const sectionVocabulary = await this.pinnedSectionVocabulary(lod);
    return {
      bundleVersion: manifest.bundleVersion,
      source: manifest.source,
      compilerPath: `${lod}/${manifest.compiler.file}`,
      connectorIndexes: connectorIndexPaths(lod, manifest),
      unofficialAllowlist: manifest.compiler.unofficialAllowlist,
      studPrimitiveNames: manifest.studPrimitives.map((primitive) => primitive.name),
      primitives: manifest.compiler.primitives ?? null,
      sectionVocabulary,
      cavityProbe: manifest.compiler.cavityProbe,
      partIds: manifest.parts.map((part) => part.id),
      ldconfigCodes: manifest.colors.map((color) => color.code),
      translucentCodes: manifest.colors
        .filter((color) => color.alpha < ALPHA_OPAQUE)
        .map((color) => color.code),
      tableDepthLdu: manifest.tablePlane.depthBelowTopLdu,
      vehicles: manifest.compiler.vehicles ?? null,
      libraryBake: manifest.compiler.libraryBake ?? null,
      libraryConnectors: manifest.compiler.libraryConnectors ?? null,
      shadowLibrary: manifest.compiler.shadowLibrary ?? null,
    };
  }

  private records(lod: BundleLod): Promise<ConnectorRecords> {
    let records = this.connectorRecords.get(lod);
    if (records === undefined) {
      records = this.loadIndex(lod).then(
        (index) =>
          new ConnectorRecords(
            this.connectorJson(lod, index.connectorPacks),
            connectorIndexPaths(lod, index),
            index.compiler?.sectionVocabulary.sha256 ?? null,
          ),
      );
      this.connectorRecords.set(lod, records);
    }
    return records;
  }

  private connectorJson(lod: BundleLod, packs: ConnectorPacks | undefined): ReadJson {
    if (packs === undefined) return async (path) => JSON.parse(await this.text(path));
    return async (path) => {
      const file = (await this.packedConnectorFiles(lod, packs)).get(path);
      if (file === undefined) throw new Error(`neither connector pack holds ${path}`);
      return file;
    };
  }

  private packedConnectorFiles(
    lod: BundleLod,
    packs: ConnectorPacks,
  ): Promise<ReadonlyMap<string, unknown>> {
    return this.cached(this.connectorPackFiles, lod, async () => {
      const loaded = await Promise.all(
        ConnectorPackage.options.map(async (pkg) => {
          const path = `${lod}/${packs[pkg].file}`;
          const pack = await this.json(ConnectorPackFile, path);
          if (pack.package !== pkg) throw new Error(`${path} packs ${pack.package}, not ${pkg}`);
          return Object.entries(pack.files);
        }),
      );
      return new Map(loaded.flat().map(([file, json]) => [`${lod}/${file}`, json]));
    });
  }

  async prefetchPartConnectors(lod: BundleLod): Promise<void> {
    await (await this.records(lod)).prepare();
  }

  async loadPartConnectors(lod: BundleLod, partId: string): Promise<PartConnectors | null> {
    return (await this.records(lod)).load(partId);
  }

  readPartConnectors(lod: BundleLod, partId: string): Promise<ConnectorLoad> {
    return this.cached(this.partConnectorReads, `${lod}/${partId}`, async () =>
      (await this.records(lod)).read(partId),
    );
  }

  async loadConnectivityAttribution(lod: BundleLod): Promise<PackageAttribution> {
    return (await this.records(lod)).connectivityAttribution();
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
      tablePlane: manifest.tablePlane,
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

  async loadLibraryParts(lod: BundleLod): Promise<LibraryPartsFile | null> {
    const { libraryParts } = await this.loadIndex(lod);
    if (libraryParts === undefined) return null;
    return this.json(LibraryPartsFile, `${lod}/${libraryParts.file}`);
  }

  loadRollingDiagnostics(lod: BundleLod): Promise<RollingDiagnosticsFile | null> {
    return this.cached(this.rollingDiagnosticsFiles, lod, async () => {
      const { rollingDiagnostics } = await this.loadIndex(lod);
      if (rollingDiagnostics === undefined) return null;
      const path = `${lod}/${rollingDiagnostics.file}`;
      const bytes = await this.bytes(path, "structural");
      if ((await sha256Hex(bytes)) !== rollingDiagnostics.sha256) {
        throw new Error(`${path} differs from the SHA-256 the manifest names`);
      }
      return decodedOrThrow(
        decode(RollingDiagnosticsFile, JSON.parse(new TextDecoder().decode(bytes))),
        path,
      );
    });
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
    const [bundle, farMesh] = await Promise.all([
      this.bundle(lod, manifest, parts),
      entry.farMesh ? this.farMesh(`${lod}/${entry.farMesh.file}`, "high") : undefined,
    ]);
    return { bundle, farMesh, entry, model: partModel(file) };
  }

  private async farMesh(path: string, priority: FetchPriority): Promise<ModelFarMesh> {
    const glb = parseFarMeshGlb(await this.bytes(path, priority), path);
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

interface StudArrays {
  readonly studPrimitiveIndex: Uint8Array;
  readonly studColors: Uint16Array;
  readonly studMatrices: Float32Array;
}

function studArrays(
  partId: string,
  studs: ReadonlyArray<StudRecord>,
  studPrimitiveNames: ReadonlyArray<string>,
): StudArrays {
  const studCount = studs.length;
  const studPrimitiveIndex = new Uint8Array(studCount);
  const studColors = new Uint16Array(studCount);
  const studMatrices = new Float32Array(studCount * MATRIX_FLOATS);
  for (let i = 0; i < studCount; i++) {
    const stud = studs[i];
    if (!stud) continue;
    const primitive = studPrimitiveNames.indexOf(stud.primitive);
    if (primitive < 0) throw new Error(`${partId}: unknown stud primitive ${stud.primitive}`);
    studPrimitiveIndex[i] = primitive;
    studColors[i] = stud.color;
    studMatrices.set(stud.matrix, i * MATRIX_FLOATS);
  }
  return { studPrimitiveIndex, studColors, studMatrices };
}

function studPrimitiveNamesOf(index: Pick<BundleIndex, "studPrimitives">): ReadonlyArray<string> {
  return index.studPrimitives.map((primitive) => primitive.name);
}

function shapeRecord(shape: PartShape, studPrimitiveNames: ReadonlyArray<string>): PartShapeRecord {
  return {
    id: shape.id,
    title: shape.title,
    role: shape.role,
    boundsMin: shape.bounds.min,
    boundsMax: shape.bounds.max,
    producedColor: shape.displayColor?.ldraw,
    producedColors: shape.producedColors,
    trackEnds: shape.trackEnds,
    meshFile: shape.file,
    ...studArrays(shape.id, shape.studs, studPrimitiveNames),
    technic: shape.technic ?? null,
    rolling: shape.rolling ?? null,
    topSurface: shape.topSurface ?? null,
    outline: shape.outline ?? null,
  };
}

function partModel(file: ModelFile): PartModel {
  const { cover } = file;
  return {
    sections: file.sections,
    lattice: modelLattice(file.lattice),
    studCover: {
      studs: cover.studs,
      covered: cover.coveredStuds,
      visibleBits: Uint32Array.from(cover.visibleBits),
    },
    cells: modelCells(cover.cells, file.name),
    instanceCount: file.instances.part.length,
    partIndex: Uint16Array.from(file.instances.part),
    ldrawColor: Uint32Array.from(file.instances.color),
    matrices: Float32Array.from(file.instances.matrix),
    partTransforms: Float64Array.from(file.partTransforms),
    submodels: {
      count: file.submodels.parent.length,
      parent: Int32Array.from(file.submodels.parent),
      matrices: Float64Array.from(file.submodels.matrices),
      ofPart: Int32Array.from(file.submodels.ofPart),
    },
    vehicles: file.vehicles.map((vehicle) => ({
      ...vehicle,
      body: Uint32Array.from(vehicle.body),
      bogies: vehicle.bogies.map((bogie) => ({
        ...bogie,
        instances: Uint32Array.from(bogie.instances),
      })),
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
  return {
    id: part.id,
    title: part.title,
    role: part.role,
    boundsMin: part.bounds.min,
    producedColor: part.displayColor?.ldraw,
    producedColors: part.producedColors,
    trackEnds: part.trackEnds,
    boundsMax: part.bounds.max,
    mesh: readPartMesh(glb, part.id),
    ...studArrays(part.id, glb.document.extras.studs, studPrimitiveNames),
    technic: glb.document.extras.technic ?? null,
    rolling: glb.document.extras.rolling ?? null,
    topSurface: glb.document.extras.topSurface ?? null,
    outline: null,
  };
}
