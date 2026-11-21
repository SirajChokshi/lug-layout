import { BUNDLE_BASE_URL, PART_BUNDLE_LOADER, type IPartBundleLoader } from "@brr/catalog";
import type { BundleLod } from "@brr/schema/bundle";
import type {
  ImportInput,
  ImportJob,
  ImportResult,
  PlacementListener,
  RollingDiagnosticsRows,
} from "@brr/import";
import { inject, injectable } from "inversify";
import {
  IMPORT_WORKER_POOL,
  LDRAW_LIBRARY_BASE_URL,
  LIBRARY_BAKE_BASE_URL,
  LIBRARY_CONNECTORS_BASE_URL,
} from "../tokens.ts";
import type { IImportWorkerPool } from "./import-worker-pool.ts";

export interface IModelImporter {
  importText(
    fileName: string,
    text: string,
    lod?: BundleLod,
    onPlaced?: PlacementListener,
  ): Promise<ImportResult>;
  importStudio(
    fileName: string,
    bytes: Uint8Array,
    lod?: BundleLod,
    onPlaced?: PlacementListener,
  ): Promise<ImportResult>;
  rollingDiagnostics(
    partIds: ReadonlyArray<string>,
    lod?: BundleLod,
  ): Promise<RollingDiagnosticsRows>;
}

@injectable()
export class WorkerModelImporter implements IModelImporter {
  constructor(
    @inject(IMPORT_WORKER_POOL) private readonly workers: IImportWorkerPool,
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(BUNDLE_BASE_URL) private readonly bundleBaseUrl: string,
    @inject(LDRAW_LIBRARY_BASE_URL) private readonly ldrawLibraryBaseUrl: string | null,
    @inject(LIBRARY_BAKE_BASE_URL) private readonly libraryBakeBaseUrl: string | null,
    @inject(LIBRARY_CONNECTORS_BASE_URL) private readonly libraryConnectorsBaseUrl: string | null,
  ) {}

  async importText(
    fileName: string,
    text: string,
    lod: BundleLod = "standard",
    onPlaced?: PlacementListener,
  ): Promise<ImportResult> {
    const job = { ...(await this.job(fileName, lod)), text };
    return this.request(lod, { kind: "ldraw", job }, [], onPlaced);
  }

  async importStudio(
    fileName: string,
    bytes: Uint8Array,
    lod: BundleLod = "standard",
    onPlaced?: PlacementListener,
  ): Promise<ImportResult> {
    const [job, bricklinkParts] = await Promise.all([
      this.job(fileName, lod),
      this.loader.loadBricklinkParts(lod),
    ]);
    const input = { kind: "studio", job, bytes, bricklinkParts } as const;
    return this.request(lod, input, [bytes.buffer], onPlaced);
  }

  async rollingDiagnostics(
    partIds: ReadonlyArray<string>,
    lod: BundleLod = "standard",
  ): Promise<RollingDiagnosticsRows> {
    const context = await this.loader.importContext(lod);
    if (this.libraryBakeBaseUrl === null || context.libraryBake === null) return {};
    return this.workers.rollingDiagnostics(
      { url: this.libraryBakeBaseUrl, pin: context.libraryBake },
      partIds,
    );
  }

  private async job(fileName: string, lod: BundleLod): Promise<Omit<ImportJob, "text">> {
    const context = await this.loader.importContext(lod);
    return {
      fileName,
      lod,
      source: context.source,
      studPrimitives: context.studPrimitiveNames,
      unofficialAllowlist: context.unofficialAllowlist,
      primitives: context.primitives,
      sectionVocabulary: context.sectionVocabulary.vocabulary,
      cavityProbe: context.cavityProbe,
      bundlePartIds: context.partIds,
      ldconfigCodes: context.ldconfigCodes,
      translucentColors: context.translucentCodes,
      tableDepthLdu: context.tableDepthLdu,
      vehicles: context.vehicles,
    };
  }

  private async request(
    lod: BundleLod,
    input: ImportInput,
    transfer: Transferable[],
    onPlaced: PlacementListener | undefined,
  ): Promise<ImportResult> {
    const context = await this.loader.importContext(lod);
    const bundleBase = new URL(this.bundleBaseUrl.replace(/\/?$/u, "/"));
    return this.workers.run(
      {
        compilerUrl: new URL(context.compilerPath, bundleBase).href,
        bundleBaseUrl: bundleBase.href,
        connectorIndexes: context.connectorIndexes,
        connectorVocabulary: context.sectionVocabulary.sha256,
        ...(this.ldrawLibraryBaseUrl === null ? {} : { ldrawLibraryUrl: this.ldrawLibraryBaseUrl }),
        ...(this.libraryBakeBaseUrl === null || context.libraryBake === null
          ? {}
          : { libraryBake: { url: this.libraryBakeBaseUrl, pin: context.libraryBake } }),
        ...(this.libraryConnectorsBaseUrl === null || context.libraryConnectors === null
          ? {}
          : {
              libraryConnectors: {
                url: this.libraryConnectorsBaseUrl,
                pin: context.libraryConnectors,
              },
            }),
        input,
      },
      transfer,
      onPlaced,
    );
  }
}
