import { simTrackFromGraph } from "@brr/domain";
import type { SimLoad, SimLoaded } from "./protocol.ts";
import type { SimScenario, SimSession, SimSessionFactory } from "./sim-session.ts";
import { SIM_TICK_HZ } from "./simulation.ts";

export interface LoadedSession {
  readonly session: SimSession;
  readonly loaded: SimLoaded;
}

export function loadSession(createSession: SimSessionFactory, load: SimLoad): LoadedSession {
  const built = simTrackFromGraph(load.graph, load.routeSegments);
  const scenario: SimScenario = {
    track: built.track,
    capacity: load.capacity,
    trains: load.trains,
    railway: { topology: load.graph, autopilotSeed: load.autopilotSeed },
    openEnds: load.openEnds,
  };
  const session = createSession(scenario);
  return {
    session,
    loaded: {
      layout: session.layout,
      tickHz: SIM_TICK_HZ,
      maxEndResidualLdu: built.maxEndResidualLdu,
      maxEndHeadingResidualRadians: built.maxEndHeadingResidualRadians,
    },
  };
}
