import { RpcEndpoint, SIM_PROTOCOL, type RpcPort } from "@brr/rpc";
import type {
  SimBenchResult,
  SimCommand,
  SimFrameMessage,
  SimLoad,
  SimLoaded,
  SimLogEntry,
  SimReply,
  SimRequest,
} from "@brr/sim";
import { inject, injectable } from "inversify";
import { SIM_WORKER_PORT } from "../tokens.ts";

export interface SimLogSnapshot {
  readonly tick: number;
  readonly stateHash: number;
  readonly entries: ReadonlyArray<SimLogEntry>;
}

export interface SimTickCost {
  readonly ticks: number;
  readonly stepMs: number;
  readonly frames: number;
}

export interface ISimClient {
  load(load: SimLoad): Promise<SimLoaded>;
  run(running: boolean): void;
  command(command: SimCommand): Promise<boolean>;
  latestFrame(): SimFrameMessage | null;
  tickCost(): SimTickCost;
  log(): Promise<SimLogSnapshot>;
  bench(ticks: number): Promise<SimBenchResult>;
}

function unexpected(reply: SimReply, wanted: SimReply["kind"]): Error {
  if (reply.kind === "failed") return new Error(`sim worker: ${reply.message}`);
  return new Error(`sim worker answered ${reply.kind}, expected ${wanted}`);
}

@injectable()
export class SimWorkerProxy implements ISimClient {
  private readonly endpoint: RpcEndpoint<SimRequest, SimReply>;
  private latest: SimFrameMessage | null = null;
  private ticks = 0;
  private stepMs = 0;
  private frames = 0;

  constructor(@inject(SIM_WORKER_PORT) port: RpcPort) {
    this.endpoint = new RpcEndpoint(port, SIM_PROTOCOL);
    this.endpoint.listen((reply) => {
      if (reply.kind !== "frame") return;
      const previous = this.latest;
      this.latest = reply.frame;
      this.ticks += reply.frame.batchTicks;
      this.stepMs += reply.frame.batchStepMs;
      this.frames++;
      if (previous) {
        this.endpoint.post({ kind: "recycle", buffer: previous.data }, [previous.data.buffer]);
      }
    });
  }

  async load(load: SimLoad): Promise<SimLoaded> {
    this.latest = null;
    this.ticks = 0;
    this.stepMs = 0;
    this.frames = 0;
    const reply = await this.endpoint.request({ kind: "load", load });
    if (reply.kind !== "loaded") throw unexpected(reply, "loaded");
    return reply.loaded;
  }

  run(running: boolean): void {
    this.endpoint.post({ kind: "run", running });
  }

  async command(command: SimCommand): Promise<boolean> {
    const reply = await this.endpoint.request({ kind: "command", command });
    if (reply.kind !== "commanded") throw unexpected(reply, "commanded");
    return reply.accepted;
  }

  latestFrame(): SimFrameMessage | null {
    return this.latest;
  }

  tickCost(): SimTickCost {
    return { ticks: this.ticks, stepMs: this.stepMs, frames: this.frames };
  }

  async log(): Promise<SimLogSnapshot> {
    const reply = await this.endpoint.request({ kind: "log" });
    if (reply.kind !== "log") throw unexpected(reply, "log");
    return { tick: reply.tick, stateHash: reply.stateHash, entries: reply.entries };
  }

  async bench(ticks: number): Promise<SimBenchResult> {
    const reply = await this.endpoint.request({ kind: "bench", ticks });
    if (reply.kind !== "bench") throw unexpected(reply, "bench");
    return reply.result;
  }
}
