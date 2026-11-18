import { RpcEndpoint, SIM_PROTOCOL, type RpcPort } from "@brr/rpc";
import type {
  SimCommand,
  SimFrameMessage,
  SimLoad,
  SimLoaded,
  SimReply,
  SimRequest,
} from "@brr/sim";
import { inject, injectable } from "inversify";
import { SIM_WORKER_PORT } from "../tokens.ts";

export interface ISimClient {
  load(load: SimLoad): Promise<SimLoaded>;
  run(running: boolean): void;
  command(command: SimCommand): Promise<boolean>;
  latestFrame(): SimFrameMessage | null;
  nextFrame(): Promise<SimFrameMessage>;
}

function unexpected(reply: SimReply, wanted: SimReply["kind"]): Error {
  if (reply.kind === "failed") return new Error(`sim worker: ${reply.message}`);
  return new Error(`sim worker answered ${reply.kind}, expected ${wanted}`);
}

@injectable()
export class SimWorkerProxy implements ISimClient {
  private readonly endpoint: RpcEndpoint<SimRequest, SimReply>;
  private latest: SimFrameMessage | null = null;
  private readonly frameWaiters: Array<(frame: SimFrameMessage) => void> = [];

  constructor(@inject(SIM_WORKER_PORT) port: RpcPort) {
    this.endpoint = new RpcEndpoint(port, SIM_PROTOCOL);
    this.endpoint.listen((reply) => {
      if (reply.kind !== "frame") return;
      const previous = this.latest;
      this.latest = reply.frame;
      for (const resolve of this.frameWaiters.splice(0)) resolve(reply.frame);
      if (previous) {
        this.endpoint.post({ kind: "recycle", buffer: previous.data }, [previous.data.buffer]);
      }
    });
  }

  async load(load: SimLoad): Promise<SimLoaded> {
    this.latest = null;
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

  nextFrame(): Promise<SimFrameMessage> {
    return new Promise((resolve) => this.frameWaiters.push(resolve));
  }
}
