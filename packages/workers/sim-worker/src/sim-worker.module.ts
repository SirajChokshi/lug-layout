import type { RpcPort } from "@brr/rpc";
import { ContainerModule } from "inversify";
import { SimWorkerHost, type ISimClock } from "./sim-worker-host.ts";
import { SIM_CLOCK, SIM_PORT, SIM_WORKER_HOST } from "./tokens.ts";

const performanceClock: ISimClock = {
  now: () => performance.now(),
  repeat: (intervalMs, callback) => {
    const handle = setInterval(callback, intervalMs);
    return () => clearInterval(handle);
  },
};

export function simWorkerModule(port: RpcPort): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(SIM_PORT).toConstantValue(port);
    bind(SIM_CLOCK).toConstantValue(performanceClock);
    bind(SIM_WORKER_HOST).to(SimWorkerHost).inSingletonScope();
  });
}
