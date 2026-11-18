import { BUNDLE_BASE_URL, PART_BUNDLE_LOADER, type IPartBundleLoader } from "@brr/catalog";
import type { BundleLod } from "@brr/schema/bundle";
import type { ImportInput, ImportJob, ImportResult } from "@brr/import";
import { inject, injectable } from "inversify";
import { IMPORT_WORKER_POOL, LDRAW_LIBRARY_BASE_URL } from "../tokens.ts";
import type { IImportWorkerPool } from "./import-worker-pool.ts";

export interface IModelImporter {
  importText(fileName: string, text: string, lod?: BundleLod): Promise<ImportResult>;
  importStudio(fileName: string, bytes: Uint8Array, lod?: BundleLod): Promise<ImportResult>;
}

@injectable()
export class WorkerModelImporter implements IModelImporter {
  constructor(
    @inject(IMPORT_WORKER_POOL) private readonly workers: IImportWorkerPool,
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(BUNDLE_BASE_URL) private readonly bundleBaseUrl: string,
    @inject(LDRAW_LIBRARY_BASE_URL) private readonly ldrawLibraryBaseUrl: string | null,
  ) {}

  async importText(
    fileName: string,
    text: string,
    lod: BundleLod = "standard",
  ): Promise<ImportResult> {
    return this.request(lod, { kind: "ldraw", job: { ...(await this.job(fileName, lod)), text } });
  }

  async importStudio(
    fileName: string,
    bytes: Uint8Array,
    lod: BundleLod = "standard",
  ): Promise<ImportResult> {
    const [job, bricklinkParts] = await Promise.all([
      this.job(fileName, lod),
      this.loader.loadBricklinkParts(lod),
    ]);
    return this.request(lod, { kind: "studio", job, bytes, bricklinkParts }, [bytes.buffer]);
  }

  private async job(fileName: string, lod: BundleLod): Promise<Omit<ImportJob, "text">> {
    const context = await this.loader.importContext(lod);
    return {
      fileName,
      lod,
      source: context.source,
      studPrimitives: context.studPrimitiveNames,
      unofficialAllowlist: context.unofficialAllowlist,
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
    transfer: Transferable[] = [],
  ): Promise<ImportResult> {
    const context = await this.loader.importContext(lod);
    const compilerUrl = new URL(
      context.compilerPath,
      new URL(this.bundleBaseUrl.replace(/\/?$/u, "/")),
    ).href;
    return this.workers.run(
      {
        compilerUrl,
        ...(this.ldrawLibraryBaseUrl === null ? {} : { ldrawLibraryUrl: this.ldrawLibraryBaseUrl }),
        input,
      },
      transfer,
    );
  }
}
