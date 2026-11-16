import { RpcEndpoint, SIM_PROTOCOL, type RpcPort } from "@brr/rpc";
import {
  loadSession,
  replay,
  SIM_TICK_SECONDS,
  type LoadedSession,
  type SimReply,
  type SimRequest,
} from "@brr/sim";
import { inject, injectable } from "inversify";
import { SIM_CLOCK, SIM_PORT } from "./tokens.ts";

export interface ISimClock {
  now(): number;
  repeat(intervalMs: number, callback: () => void): () => void;
}

const TICK_MS = SIM_TICK_SECONDS * 1000;
const PUMP_INTERVAL_MS = 4;
const MAX_TICKS_PER_PUMP = 8;

@injectable()
export class SimWorkerHost {
  private readonly endpoint: RpcEndpoint<SimReply, SimRequest>;
  private current: LoadedSession | undefined;
  private readonly spareFrames: Float64Array[] = [];
  private stopPump: (() => void) | undefined;
  private runStartMs = 0;
  private runStartTick = 0;

  constructor(
    @inject(SIM_PORT) port: RpcPort,
    @inject(SIM_CLOCK) private readonly clock: ISimClock,
  ) {
    this.endpoint = new RpcEndpoint(port, SIM_PROTOCOL);
  }

  serve(): void {
    this.endpoint.listen((request, id) => {
      try {
        this.handle(request, id);
      } catch (error) {
        this.endpoint.reply(id, { kind: "failed", message: String(error) });
      }
    });
  }

  private handle(request: SimRequest, id: number): void {
    switch (request.kind) {
      case "load": {
        this.setRunning(false);
        this.spareFrames.length = 0;
        this.current = loadSession(request.load);
        this.endpoint.reply(id, { kind: "loaded", loaded: this.current.loaded });
        this.postFrame(0, 0);
        return;
      }
      case "run":
        this.setRunning(request.running);
        return;
      case "command": {
        const session = this.loaded().session;
        const accepted = session.apply(request.command);
        this.endpoint.reply(id, { kind: "commanded", accepted, tick: session.simulation.tick });
        if (!this.stopPump) this.postFrame(0, 0);
        return;
      }
      case "recycle":
        this.spareFrames.push(request.buffer);
        return;
      case "bench": {
        const { scenario, session } = this.loaded();
        const live = session.simulation;
        const copy = replay(scenario, session.log, live.tick);
        const replayHash = copy.stateHash();
        const start = this.clock.now();
        for (let i = 0; i < request.ticks; i++) copy.step();
        const elapsedMs = this.clock.now() - start;
        this.endpoint.reply(id, {
          kind: "bench",
          result: {
            replayedToTick: live.tick,
            replayHash,
            liveHash: live.stateHash(),
            ticks: request.ticks,
            elapsedMs,
          },
        });
        return;
      }
      default: {
        const unhandled: never = request;
        throw new Error(`unhandled sim request ${String(unhandled)}`);
      }
    }
  }

  private loaded(): LoadedSession {
    if (!this.current) throw new Error("the sim worker has no scenario loaded");
    return this.current;
  }

  private setRunning(running: boolean): void {
    if (!running) {
      this.stopPump?.();
      this.stopPump = undefined;
      return;
    }
    if (this.stopPump) return;
    const sim = this.loaded().session.simulation;
    this.runStartMs = this.clock.now();
    this.runStartTick = sim.tick;
    this.stopPump = this.clock.repeat(PUMP_INTERVAL_MS, () => this.pump());
  }

  private pump(): void {
    const { session } = this.loaded();
    const sim = session.simulation;
    const now = this.clock.now();
    let due = this.runStartTick + Math.floor((now - this.runStartMs) / TICK_MS) - sim.tick;
    if (due > MAX_TICKS_PER_PUMP) {
      this.runStartMs += (due - MAX_TICKS_PER_PUMP) * TICK_MS;
      due = MAX_TICKS_PER_PUMP;
    }
    if (due <= 0) return;
    const start = this.clock.now();
    for (let i = 0; i < due; i++) sim.step();
    this.postFrame(due, this.clock.now() - start);
  }

  private postFrame(batchTicks: number, batchStepMs: number): void {
    const { session } = this.loaded();
    const sim = session.simulation;
    const data = this.spareFrames.pop() ?? new Float64Array(session.layout.floats);
    session.writeFrame(data);
    this.endpoint.post(
      {
        kind: "frame",
        frame: { tick: sim.tick, stateHash: sim.stateHash(), batchTicks, batchStepMs, data },
      },
      [data.buffer],
    );
  }
}
