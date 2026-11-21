import { Container } from "inversify";
import { importWorkerModules } from "./import-worker.module.ts";
import { IMPORT_WORKER_HOST } from "./tokens.ts";

const container = new Container();
container.load(...importWorkerModules(self));
container.get(IMPORT_WORKER_HOST).serve();
