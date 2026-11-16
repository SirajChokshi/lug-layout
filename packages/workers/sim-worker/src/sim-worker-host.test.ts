import { TrackGraph, TrackLayout } from "@brr/domain";
import { HALF_TURN_16, pose16, POSE16_IDENTITY, STUD_LDU, zeta16 } from "@brr/math";
import { RpcEndpoint, SIM_PROTOCOL } from "@brr/rpc";
import type { SimLoad, SimReply, SimRequest } from "@brr/sim";
import { Container } from "inversify";
import { afterEach, expect, it } from "vitest";
import type { ISimClock } from "./sim-worker-host.ts";
import { simWorkerModule } from "./sim-worker.module.ts";
import { SIM_CLOCK, SIM_WORKER_HOST } from "./tokens.ts";

const STRAIGHT_STUDS = 16n;
const PIECES = 6;
const TICK_MS = 1000 / 60;

class ManualClock implements ISimClock {
  ms = 0;
  private callback: (() => void) | undefined;
  now(): number {
    return this.ms;
  }
  repeat(_intervalMs: number, callback: () => void): () => void {
    this.callback = callback;
    return () => {
      this.callback = undefined;
    };
  }
  advance(ms: number): void {
    this.ms += ms;
    this.callback?.();
  }
}

const channels: MessageChannel[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

function straightLine(): SimLoad {
  const exit = pose16(zeta16([STRAIGHT_STUDS, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), 0);
  const entry = pose16(POSE16_IDENTITY.position, HALF_TURN_16);
  const layout = new TrackLayout([{ connectors: [entry, exit], routes: [{ from: 0, to: 1 }] }]);
  let last = layout.place(0, POSE16_IDENTITY, 0);
  for (let i = 1; i < PIECES; i++) last = layout.attach(0, 0, { placement: last, connector: 1 });
  const graph = new TrackGraph(layout);
  const straight = { kind: "straight", lengthLdu: Number(STRAIGHT_STUDS) * STUD_LDU } as const;
  return {
    graph: {
      edgeCount: graph.edgeCount,
      switchCount: graph.switchCount,
      endXLdu: graph.endXLdu,
      endZLdu: graph.endZLdu,
      endHeading: graph.endHeading,
      edgeFromEnd: graph.edgeFromEnd,
      edgeToEnd: graph.edgeToEnd,
      successorStart: graph.successorStart,
      successors: graph.successors,
      edgeSwitch: graph.edgeSwitch,
    },
    routeSegments: Array.from({ length: PIECES }, () => [straight]),
    capacity: { trains: 1, vehicles: 1 },
    trains: [
      {
        spec: {
          vehicles: [{ lengthLdu: 690, frontBogieLdu: 175, rearBogieLdu: 515 }],
          maxSpeedLduPerS: 400,
          accelerationLduPerS2: 200,
          brakingLduPerS2: 300,
        },
        placement: { edge: 8, offsetLdu: 100 },
      },
    ],
  };
}

function connect(): {
  client: RpcEndpoint<SimRequest, SimReply>;
  clock: ManualClock;
  frames: SimReply[];
} {
  const channel = new MessageChannel();
  channels.push(channel);
  channel.port1.start();
  channel.port2.start();
  const clock = new ManualClock();
  const container = new Container();
  container.load(simWorkerModule(channel.port2));
  container.rebind(SIM_CLOCK).toConstantValue(clock);
  container.get(SIM_WORKER_HOST).serve();
  const client = new RpcEndpoint<SimRequest, SimReply>(channel.port1, SIM_PROTOCOL);
  const frames: SimReply[] = [];
  client.listen((reply) => frames.push(reply));
  return { client, clock, frames };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

it("streams fixed ticks over the port and replays its own command log to the live hash", async () => {
  const { client, clock, frames } = connect();
  const loaded = await client.request({ kind: "load", load: straightLine() });
  expect(loaded.kind).toBe("loaded");
  const throttled = await client.request({
    kind: "command",
    command: { kind: "throttle", train: 0, speedLduPerS: 400 },
  });
  expect(throttled).toEqual({ kind: "commanded", accepted: true, tick: 0 });
  client.post({ kind: "run", running: true });
  await settle();
  for (let i = 0; i < 300; i++) clock.advance(TICK_MS / 2);
  await settle();
  const ticks = frames.reduce(
    (sum, reply) => sum + (reply.kind === "frame" ? reply.frame.batchTicks : 0),
    0,
  );
  const last = frames.at(-1);
  expect(last?.kind).toBe("frame");
  if (last?.kind !== "frame") return;
  expect(last.frame.tick).toBe(ticks);
  expect(ticks).toBe(150);
  const bench = await client.request({ kind: "bench", ticks: 600 });
  expect(bench.kind).toBe("bench");
  if (bench.kind !== "bench") return;
  expect(bench.result.replayedToTick).toBe(150);
  expect(bench.result.replayHash).toBe(bench.result.liveHash);
});
