import { simTrackFromGraph } from "./graph-track.ts";
import type { SimLoad, SimLoaded } from "./protocol.ts";
import { SimSession, type SimScenario } from "./sim-session.ts";
import { SIM_TICK_HZ } from "./simulation.ts";

export interface LoadedSession {
  readonly scenario: SimScenario;
  readonly session: SimSession;
  readonly loaded: SimLoaded;
}

export function loadSession(load: SimLoad): LoadedSession {
  const built = simTrackFromGraph(load.graph, load.routeSegments);
  const scenario: SimScenario = {
    track: built.track,
    capacity: load.capacity,
    trains: load.trains,
    railway: { topology: load.graph, autopilotSeed: load.autopilotSeed },
  };
  const session = new SimSession(scenario);
  return {
    scenario,
    session,
    loaded: {
      layout: session.layout,
      tickHz: SIM_TICK_HZ,
      maxEndResidualLdu: built.maxEndResidualLdu,
      maxEndHeadingResidualRadians: built.maxEndHeadingResidualRadians,
    },
  };
}
