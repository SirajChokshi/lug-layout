import { BUNDLE_BASE_URL, PART_BUNDLE_LOADER, type IPartBundleLoader } from "@brr/catalog";
import type { BundleLod } from "@brr/schema/bundle";
import type {
  ImportInput,
  ImportJob,
  ImportResult,
  ImportWorkerRequest,
  ImportWorkerResponse,
} from "@brr/import";
import { inject, injectable } from "inversify";
import { IMPORT_WORKER_FACTORY, LDRAW_LIBRARY_BASE_URL } from "../tokens.ts";

export interface IModelImporter {
  importText(fileName: string, text: string, lod?: BundleLod): Promise<ImportResult>;
  importStudio(fileName: string, bytes: Uint8Array, lod?: BundleLod): Promise<ImportResult>;
}

export type ImportWorkerFactory = () => Worker;

interface Pending {
  readonly resolve: (result: ImportResult) => void;
  readonly reject: (error: Error) => void;
}

@injectable()
export class WorkerModelImporter implements IModelImporter {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    @inject(IMPORT_WORKER_FACTORY) private readonly createWorker: ImportWorkerFactory,
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(BUNDLE_BASE_URL) private readonly bundleBaseUrl: string,
    @inject(LDRAW_LIBRARY_BASE_URL) private readonly ldrawLibraryBaseUrl: string | null,
  ) {}

  private connection(): Worker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.addEventListener("message", (event: MessageEvent<ImportWorkerResponse>) =>
      this.settle(event.data),
    );
    worker.addEventListener("error", (event) => {
      for (const pending of this.pending.values()) pending.reject(new Error(event.message));
      this.pending.clear();
    });
    this.worker = worker;
    return worker;
  }

  private settle(response: ImportWorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    switch (response.kind) {
      case "imported":
        pending.resolve(response.model);
        return;
      case "failed":
        pending.reject(new Error(response.message));
        return;
      default: {
        const unhandled: never = response;
        throw new Error(`unhandled worker response ${String(unhandled)}`);
      }
    }
  }

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
      primitives: context.primitives,
      sectionVocabulary: context.sectionVocabulary.vocabulary,
      cavityProbe: context.cavityProbe,
      bundlePartIds: context.partIds,
      ldconfigCodes: context.ldconfigCodes,
      translucentColors: context.translucentCodes,
      vehicles: context.vehicles,
    };
  }

  private async request(
    lod: BundleLod,
    input: ImportInput,
    transfer: Transferable[] = [],
  ): Promise<ImportResult> {
    const context = await this.loader.importContext(lod);
    const bundleBase = new URL(this.bundleBaseUrl.replace(/\/?$/u, "/"));
    const request: ImportWorkerRequest = {
      id: this.nextId++,
      compilerUrl: new URL(context.compilerPath, bundleBase).href,
      bundleBaseUrl: bundleBase.href,
      connectorIndexes: context.connectorIndexes,
      ...(this.ldrawLibraryBaseUrl === null ? {} : { ldrawLibraryUrl: this.ldrawLibraryBaseUrl }),
      input,
    };
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      this.connection().postMessage(request, { transfer });
    });
  }
}
