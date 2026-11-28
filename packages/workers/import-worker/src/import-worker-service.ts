import { ConnectorRecords } from "@brr/catalog/connector-records";
import {
  BundleThenLibraryConnectors,
  IGNORE_PLACEMENT,
  importStudioFile,
  LibraryBakeStore,
  LibraryConnectorStore,
  PlanGlyphCache,
  ShadowMirror,
  type BrickCompiler,
  type FetchFunction,
  type IBakeHelper,
  type ImportResult,
  type PlacementListener,
  type ImportWorkerRequest,
  type IPartRecords,
  type IShadowLibrary,
  type LdrawMirror,
  type LibraryBakeSource,
  type MirrorSource,
  type ModelImportEngine,
  type PartConnectorSource,
  type RollingDiagnosticsRequest,
  type RollingDiagnosticsRows,
  type ShadowLibrarySource,
} from "@brr/import";
import { ASSET_CACHE, type IAssetCache } from "@brr/storage";
import { inject, injectable } from "inversify";
import type { IBakeHelperRegistry } from "./bake-helper-registry.ts";
import type { ICompilerLoader } from "./compiler-loader.ts";
import {
  BAKE_HELPER_REGISTRY,
  COMPILER_LOADER,
  IMPORT_FETCH,
  LDRAW_MIRROR_FACTORY,
  MODEL_IMPORT_ENGINE_FACTORY,
} from "./tokens.ts";

export interface IImportWorkerService {
  run(request: ImportWorkerRequest, onPlaced?: PlacementListener): Promise<ImportResult>;
  rollingDiagnostics(request: RollingDiagnosticsRequest): Promise<RollingDiagnosticsRows>;
}

export type LdrawMirrorFactory = (source: MirrorSource, baseUrl: string | undefined) => LdrawMirror;

export type ModelImportEngineFactory = (
  compiler: BrickCompiler,
  mirror: LdrawMirror,
  connectors: PartConnectorSource,
  records: IPartRecords | null,
  helpers: ReadonlyArray<IBakeHelper>,
  shadowLibrary: IShadowLibrary | null,
  glyphs: PlanGlyphCache,
) => ModelImportEngine;

@injectable()
export class ImportWorkerService implements IImportWorkerService {
  private readonly connectorStores = new Map<string, ConnectorRecords>();
  private readonly libraryConnectorStores = new Map<string, LibraryConnectorStore>();
  private readonly recordStores = new Map<string, IPartRecords>();
  private readonly shadowMirrors = new Map<string, ShadowMirror>();

  constructor(
    @inject(COMPILER_LOADER) private readonly compilers: ICompilerLoader,
    @inject(BAKE_HELPER_REGISTRY) private readonly bakeHelpers: IBakeHelperRegistry,
    @inject(LDRAW_MIRROR_FACTORY) private readonly createMirror: LdrawMirrorFactory,
    @inject(MODEL_IMPORT_ENGINE_FACTORY) private readonly createEngine: ModelImportEngineFactory,
    @inject(IMPORT_FETCH) private readonly fetchUrl: FetchFunction,
    @inject(ASSET_CACHE) private readonly assetCache: IAssetCache,
  ) {}

  private connectorRecords(request: ImportWorkerRequest): ConnectorRecords {
    const base = new URL(request.bundleBaseUrl.replace(/\/?$/u, "/"));
    const key = JSON.stringify([base.href, request.connectorIndexes, request.connectorVocabulary]);
    let records = this.connectorStores.get(key);
    if (records === undefined) {
      records = new ConnectorRecords(
        async (path) => {
          const url = new URL(path, base);
          const response = await this.fetchUrl(url.href);
          if (!response.ok) throw new Error(`GET ${url.href} failed with ${response.status}`);
          return response.json();
        },
        request.connectorIndexes,
        request.connectorVocabulary,
      );
      this.connectorStores.set(key, records);
    }
    return records;
  }

  private partConnectors(request: ImportWorkerRequest): PartConnectorSource {
    const bundle = this.connectorRecords(request);
    const source = request.libraryConnectors;
    if (source === undefined) return bundle;
    const key = `${source.url} ${source.pin.sha256}`;
    let store = this.libraryConnectorStores.get(key);
    if (store === undefined) {
      store = new LibraryConnectorStore(source.url, source.pin, this.fetchUrl, this.assetCache);
      this.libraryConnectorStores.set(key, store);
    }
    const library = store.source({
      source: request.input.job.source,
      sectionVocabulary: request.connectorVocabulary,
    });
    return new BundleThenLibraryConnectors(bundle, library);
  }

  private partRecords(source: LibraryBakeSource | undefined): IPartRecords | null {
    if (source === undefined) return null;
    const key = `${source.url} ${source.pin.sha256}`;
    let store = this.recordStores.get(key);
    if (store === undefined) {
      store = new LibraryBakeStore(source.url, source.pin, this.fetchUrl, this.assetCache);
      this.recordStores.set(key, store);
    }
    return store;
  }

  private shadowLibrary(source: ShadowLibrarySource | undefined): IShadowLibrary | null {
    if (source === undefined) return null;
    const key = `${source.url} ${source.pin.sha256}`;
    let mirror = this.shadowMirrors.get(key);
    if (mirror === undefined) {
      mirror = new ShadowMirror(source.url, source.pin, this.fetchUrl, this.assetCache);
      this.shadowMirrors.set(key, mirror);
    }
    return mirror;
  }

  async rollingDiagnostics(request: RollingDiagnosticsRequest): Promise<RollingDiagnosticsRows> {
    const records = this.partRecords(request.libraryBake);
    if (records === null) return {};
    return Object.fromEntries(await records.rollingDiagnostics(request.partIds));
  }

  async run(
    request: ImportWorkerRequest,
    onPlaced: PlacementListener = IGNORE_PLACEMENT,
  ): Promise<ImportResult> {
    const compiler = await this.compilers.load(request.compilerUrl);
    const helpers = this.bakeHelpers.helpers(request.compilerUrl);
    const connectors = this.partConnectors(request);
    const records = this.partRecords(request.libraryBake);
    const { input } = request;
    const mirror = this.createMirror(input.job.source, request.ldrawLibraryUrl);
    const shadow = this.shadowLibrary(request.shadowLibrary);
    const glyphs = new PlanGlyphCache(request.compilerUrl, this.assetCache);
    const engine = this.createEngine(
      compiler,
      mirror,
      connectors,
      records,
      helpers,
      shadow,
      glyphs,
    );
    switch (input.kind) {
      case "ldraw":
        return engine.importText(input.job, onPlaced);
      case "studio":
        return importStudioFile(engine, compiler, mirror, input, onPlaced);
      default: {
        const unhandled: never = input;
        throw new Error(`unhandled import input ${JSON.stringify(unhandled)}`);
      }
    }
  }
}
