import { transferablesOf, type ImportWorkerRequest, type ImportWorkerResponse } from "@brr/import";
import { Container } from "inversify";
import { importWorkerModule } from "./import-worker.module.ts";
import { IMPORT_WORKER_SERVICE } from "./tokens.ts";

const container = new Container();
container.load(importWorkerModule);
const service = container.get(IMPORT_WORKER_SERVICE);

function reply(response: ImportWorkerResponse, transfer: Transferable[]): void {
  self.postMessage(response, { transfer });
}

self.addEventListener("message", (event: MessageEvent<ImportWorkerRequest>) => {
  const request = event.data;
  service.run(request).then(
    (model) => reply({ id: request.id, kind: "imported", model }, transferablesOf(model)),
    (error: unknown) => reply({ id: request.id, kind: "failed", message: String(error) }, []),
  );
});
