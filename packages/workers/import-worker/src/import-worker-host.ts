import {
  layoutParts,
  transferablesOf,
  type BlueBrickBudgetRequest,
  type ImportWorkerPlaced,
  type ImportWorkerRequest,
  type ImportWorkerResponse,
  type LayoutPartsRequest,
  type RollingDiagnosticsRequest,
} from "@brr/import";
import { IMPORT_PROTOCOL, RpcEndpoint, type BakeHelperHandoff, type RpcPort } from "@brr/rpc";
import { inject, injectable } from "inversify";
import { serveBakes } from "./bake-helper-host.ts";
import type { IBakeHelperRegistry } from "./bake-helper-registry.ts";
import type { ICompilerLoader } from "./compiler-loader.ts";
import type { IImportWorkerService } from "./import-worker-service.ts";
import {
  BAKE_HELPER_REGISTRY,
  COMPILER_LOADER,
  IMPORT_PORT,
  IMPORT_WORKER_SERVICE,
} from "./tokens.ts";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@injectable()
export class ImportWorkerHost {
  private readonly endpoint: RpcEndpoint<
    ImportWorkerResponse | ImportWorkerPlaced,
    | ImportWorkerRequest
    | RollingDiagnosticsRequest
    | LayoutPartsRequest
    | BlueBrickBudgetRequest
    | BakeHelperHandoff
  >;

  constructor(
    @inject(IMPORT_PORT) port: RpcPort,
    @inject(IMPORT_WORKER_SERVICE) private readonly service: IImportWorkerService,
    @inject(BAKE_HELPER_REGISTRY) private readonly bakeHelpers: IBakeHelperRegistry,
    @inject(COMPILER_LOADER) private readonly compilers: ICompilerLoader,
  ) {
    this.endpoint = new RpcEndpoint(port, IMPORT_PROTOCOL);
  }

  serve(): void {
    this.endpoint.listen((message, id) => {
      switch (message.kind) {
        case "import":
          this.service
            .run(message, (placed) =>
              this.endpoint.post({ kind: "placed", ticket: message.ticket, placed }),
            )
            .then(
              (model) =>
                this.endpoint.reply(id, { kind: "imported", model }, transferablesOf(model)),
              (error: unknown) =>
                this.endpoint.reply(id, { kind: "failed", message: messageOf(error) }),
            );
          return;
        case "rollingDiagnostics":
          this.service.rollingDiagnostics(message).then(
            (rows) => this.endpoint.reply(id, { kind: "rollingDiagnostics", rows }),
            (error: unknown) =>
              this.endpoint.reply(id, { kind: "failed", message: messageOf(error) }),
          );
          return;
        case "layoutParts":
          this.compilers
            .load(message.compilerUrl)
            .then((compiler) => layoutParts(compiler, message.fileName, message.text))
            .then(
              (parts) => this.endpoint.reply(id, { kind: "layoutParts", parts }),
              (error: unknown) =>
                this.endpoint.reply(id, { kind: "failed", message: messageOf(error) }),
            );
          return;
        case "blueBrickBudget":
          this.service.blueBrickBudget(message).then(
            (budget) => this.endpoint.reply(id, { kind: "blueBrickBudget", budget }),
            (error: unknown) =>
              this.endpoint.reply(id, { kind: "failed", message: messageOf(error) }),
          );
          return;
        case "useBakeHelpers":
          this.bakeHelpers.use(message.ports);
          return;
        case "serveBakes":
          serveBakes(message.port, (url) => this.compilers.load(url));
          return;
        default: {
          const unhandled: never = message;
          throw new Error(`unhandled import worker message ${String(unhandled)}`);
        }
      }
    });
  }
}
