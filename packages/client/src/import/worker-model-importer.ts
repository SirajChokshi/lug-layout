import { PART_BUNDLE_LOADER, type BundleLod, type IPartBundleLoader } from "@brr/catalog";
import type { ImportResult, ImportWorkerRequest, ImportWorkerResponse } from "@brr/import";
import { inject, injectable } from "inversify";
import { IMPORT_WORKER_FACTORY } from "../tokens.ts";

export interface IModelImporter {
  importText(fileName: string, text: string, lod?: BundleLod): Promise<ImportResult>;
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
    const context = await this.loader.importContext(lod);
    const request: ImportWorkerRequest = {
      id: this.nextId++,
      compilerUrl: context.compilerUrl,
      input: {
        kind: "ldraw",
        job: {
          fileName,
          text,
          lod,
          source: context.source,
          studPrimitives: context.studPrimitiveNames,
          unofficialAllowlist: context.unofficialAllowlist,
          bundlePartIds: context.partIds,
          ldconfigCodes: context.ldconfigCodes,
        },
      },
    };
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      this.connection().postMessage(request, { transfer: [] });
    });
  }
}
