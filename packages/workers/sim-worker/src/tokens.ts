import type { RpcPort } from "@brr/rpc";
import type { SimSessionFactory } from "@brr/sim";
import type { ServiceIdentifier } from "inversify";
import type { ISimClock, SimWorkerHost } from "./sim-worker-host.ts";

export const SIM_PORT: ServiceIdentifier<RpcPort> = Symbol.for("brr.simWorker.Port");
export const SIM_CLOCK: ServiceIdentifier<ISimClock> = Symbol.for("brr.simWorker.Clock");
export const SIM_SESSION_FACTORY: ServiceIdentifier<SimSessionFactory> = Symbol.for(
  "brr.simWorker.SessionFactory",
);
export const SIM_WORKER_HOST: ServiceIdentifier<SimWorkerHost> = Symbol.for("brr.simWorker.Host");
