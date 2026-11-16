import { Container } from "inversify";
import { simWorkerModule } from "./sim-worker.module.ts";
import { SIM_WORKER_HOST } from "./tokens.ts";

const container = new Container();
container.load(simWorkerModule(self));
container.get(SIM_WORKER_HOST).serve();
