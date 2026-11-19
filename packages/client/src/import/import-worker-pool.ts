import type {
  ImportResult,
  ImportWorkerRequest,
  ImportWorkerResponse,
  LibraryBakeSource,
  RollingDiagnosticsRequest,
  RollingDiagnosticsRows,
} from "@brr/import";
import { IMPORT_PROTOCOL, RpcEndpoint, type BakeHelperHandoff } from "@brr/rpc";
import { inject, injectable } from "inversify";
import { IMPORT_BAKE_HELPERS, IMPORT_WORKER_FACTORY } from "../tokens.ts";

export type ImportWorkerFactory = () => Worker;

export type ImportRun = Omit<ImportWorkerRequest, "kind">;

export interface IImportWorkerPool {
  run(request: ImportRun, transfer: Transferable[]): Promise<ImportResult>;
  rollingDiagnostics(
    libraryBake: LibraryBakeSource,
    partIds: ReadonlyArray<string>,
  ): Promise<RollingDiagnosticsRows>;
}

interface Primary {
  readonly worker: Worker;
  readonly endpoint: RpcEndpoint<
    ImportWorkerRequest | RollingDiagnosticsRequest | BakeHelperHandoff,
    ImportWorkerResponse
  >;
  readonly crashed: Promise<never>;
}

const IDLE_HELPERS_RELEASED_AFTER_MS = 60_000;

@injectable()
export class ImportWorkerPool implements IImportWorkerPool {
  private primary: Primary | null = null;
  private helpers: ReadonlyArray<Worker> = [];
  private helperFailed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private idleRelease: ReturnType<typeof setTimeout> | null = null;

  constructor(
    @inject(IMPORT_WORKER_FACTORY) private readonly createWorker: ImportWorkerFactory,
    @inject(IMPORT_BAKE_HELPERS) private readonly helperCount: number,
  ) {}

  run(request: ImportRun, transfer: Transferable[]): Promise<ImportResult> {
    const result = this.queue.then(() => this.runAlone(request, transfer));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async runAlone(request: ImportRun, transfer: Transferable[]): Promise<ImportResult> {
    this.cancelIdleRelease();
    const primary = this.primary ?? this.startPrimary();
    if (this.helperFailed) this.releaseHelpers();
    if (this.helpers.length < this.helperCount) this.startHelpers(primary);
    try {
      const response = await Promise.race([
        primary.endpoint.request({ ...request, kind: "import" }, transfer),
        primary.crashed,
      ]);
      switch (response.kind) {
        case "imported":
          if (response.model.report.bakeHelpersFailed > 0) this.releaseHelpers();
          return response.model;
        case "failed":
          throw new Error(response.message);
        case "rollingDiagnostics":
          throw new Error("the import worker answered an import with rolling diagnostics");
        default: {
          const unhandled: never = response;
          throw new Error(`unhandled import worker response ${String(unhandled)}`);
        }
      }
    } finally {
      this.scheduleIdleRelease();
    }
  }

  async rollingDiagnostics(
    libraryBake: LibraryBakeSource,
    partIds: ReadonlyArray<string>,
  ): Promise<RollingDiagnosticsRows> {
    const primary = this.primary ?? this.startPrimary();
    const response = await Promise.race([
      primary.endpoint.request({ kind: "rollingDiagnostics", libraryBake, partIds }, []),
      primary.crashed,
    ]);
    switch (response.kind) {
      case "rollingDiagnostics":
        return response.rows;
      case "failed":
        throw new Error(response.message);
      case "imported":
        throw new Error("the import worker answered a rolling diagnostics request with a model");
      default: {
        const unhandled: never = response;
        throw new Error(`unhandled import worker response ${String(unhandled)}`);
      }
    }
  }

  private startPrimary(): Primary {
    const worker = this.createWorker();
    const crashed = new Promise<never>((_, reject) =>
      worker.addEventListener("error", (event) => {
        if (this.primary?.worker !== worker) return;
        worker.terminate();
        this.primary = null;
        this.releaseHelpers();
        reject(new Error(event.message));
      }),
    );
    crashed.catch(() => undefined);
    const primary: Primary = {
      worker,
      endpoint: new RpcEndpoint(worker, IMPORT_PROTOCOL),
      crashed,
    };
    this.primary = primary;
    return primary;
  }

  private startHelpers(primary: Primary): void {
    this.releaseHelpers();
    const helpers = Array.from({ length: this.helperCount }, () => this.createWorker());
    const ports = helpers.map((helper) => {
      const channel = new MessageChannel();
      const handoff = new RpcEndpoint<BakeHelperHandoff, never>(helper, IMPORT_PROTOCOL);
      handoff.post({ kind: "serveBakes", port: channel.port2 }, [channel.port2]);
      helper.addEventListener("error", () => {
        if (this.helpers === helpers) this.helperFailed = true;
      });
      return channel.port1;
    });
    primary.endpoint.post({ kind: "useBakeHelpers", ports }, ports);
    this.helpers = helpers;
  }

  private releaseHelpers(): void {
    for (const helper of this.helpers) helper.terminate();
    this.helpers = [];
    this.helperFailed = false;
  }

  private cancelIdleRelease(): void {
    if (this.idleRelease !== null) clearTimeout(this.idleRelease);
    this.idleRelease = null;
  }

  private scheduleIdleRelease(): void {
    if (this.helpers.length === 0) return;
    this.idleRelease = setTimeout(() => {
      this.idleRelease = null;
      this.releaseHelpers();
    }, IDLE_HELPERS_RELEASED_AFTER_MS);
  }
}
