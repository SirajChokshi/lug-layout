import {
  createSimSession,
  loadSession,
  type LoadedSession,
  type SimCommand,
  type SimFrameLayout,
  type SimFrameMessage,
  type SimLoad,
  type SimLoaded,
} from "@brr/sim";
import type { ISimClient } from "./sim-client.ts";

export class InThreadSim implements ISimClient {
  private current: LoadedSession | null = null;
  private frame: SimFrameMessage | null = null;

  async load(load: SimLoad): Promise<SimLoaded> {
    this.current = loadSession(createSimSession, load);
    this.publish();
    return this.current.loaded;
  }

  run(): void {}

  async command(command: SimCommand): Promise<boolean> {
    const accepted = this.session().apply(command);
    this.publish();
    return accepted;
  }

  latestFrame(): SimFrameMessage | null {
    return this.frame;
  }

  frameLayout(): SimFrameLayout {
    return this.session().layout;
  }

  async nextFrame(): Promise<SimFrameMessage> {
    const frame = this.frame;
    if (!frame) throw new Error("no scenario is loaded");
    return frame;
  }

  advance(ticks: number): void {
    const simulation = this.session().simulation;
    for (let tick = 0; tick < ticks; tick++) simulation.step();
    this.publish();
  }

  private session(): LoadedSession["session"] {
    if (!this.current) throw new Error("no scenario is loaded");
    return this.current.session;
  }

  private publish(): void {
    const session = this.session();
    const data = new Float64Array(session.layout.floats);
    session.writeFrame(data);
    this.frame = { tick: session.simulation.tick, stateHash: session.simulation.stateHash(), data };
  }
}
