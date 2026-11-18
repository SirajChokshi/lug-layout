import { Container } from "inversify";
import { importWorkerModule } from "./import-worker.module.ts";
import { IMPORT_WORKER_HOST } from "./tokens.ts";

const container = new Container();
container.load(importWorkerModule(self));
container.get(IMPORT_WORKER_HOST).serve();
