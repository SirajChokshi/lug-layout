import { ASSET_FETCHER, PART_BUNDLE_LOADER, type IAssetFetcher } from "@brr/catalog";
import type { TrackCatalog } from "@brr/schema/bundle";
import { TrackGraph } from "@brr/domain";
import {
  SIM_TICK_HZ,
  POSE_FLOATS_PER_VEHICLE,
  createSimSession,
  simTrackFromGraph,
  type SimSession,
  type OpenEndRule,
  type VehicleSpec,
} from "@brr/sim";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { beforeAll, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { instanceBoxes } from "../running-gear/instance-boxes.ts";
import { plannedConsists } from "../sim/consist.ts";
import { routeSegments, simTopology } from "../sim/sim-track-input.ts";
import { buildTrackPlan } from "./track-plan.ts";
import { TRACK_PARTS } from "./track-scene.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const AUTOPILOT_TIMEOUT_MS = 60_000;

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

const BALLOON =
  "ldraw:74746, ldraw:74747.1*3, ldraw:74747*7, ldraw:74746, ldraw:74747*5, ldraw:74746*5";
const PASSING = "ldraw:74746*2, ldraw:75541-f1, ldraw:74746*8, ldraw:75542-f1.1";
const SIDING = "ldraw:74747, ldraw:74746*6, ldraw:74747";
const TWO_SIDINGS = [
  "ldraw:75541-f1",
  BALLOON,
  "/",
  PASSING,
  PASSING,
  "ldraw:74746*2, ldraw:75541-f1",
  BALLOON,
  "/",
  SIDING,
  "/",
  SIDING,
].join(", ");
const SWITCHLESS_OVAL = "ldraw:74746*4, ldraw:74747*8, ldraw:74746*4, ldraw:74747*8";
const OPEN_LINE = "ldraw:74746*6, ldraw:74747*4";
const OPEN_LINE_SPEED_LDU_PER_S = 400;
const LOCOMOTIVE_MODEL = "10133-1";
const AUTOPILOT_MINUTES = 20;
const MIN_ARRIVALS_PER_TRAIN = 20;
const OVAL_MINUTES = 2;
const OVAL_SPEED_LDU_PER_S = 150;

let catalog: TrackCatalog;
let locomotive: VehicleSpec;

beforeAll(async () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const loader = container.get(PART_BUNDLE_LOADER);
  catalog = (await loader.load("standard", TRACK_PARTS)).trackCatalog;
  const model = await loader.loadModel("standard", LOCOMOTIVE_MODEL);
  const planned = plannedConsists(model.model, instanceBoxes(model.model, model.bundle))[0]?.[0];
  if (!planned) throw new Error(`${LOCOMOTIVE_MODEL} has no vehicle`);
  locomotive = planned.spec;
});

function session(
  plan: string,
  fronts: ReadonlyArray<readonly [number, number]>,
  autopilotSeed: number | null,
  openEnds: OpenEndRule = "brake",
): SimSession {
  const { layout, catalogPieces } = buildTrackPlan(plan, catalog);
  const graph = new TrackGraph(layout);
  const topology = simTopology(graph);
  const { track } = simTrackFromGraph(topology, routeSegments(graph, layout, catalogPieces));
  const spec = {
    vehicles: [locomotive],
    maxSpeedLduPerS: 400,
    accelerationLduPerS2: 150,
    brakingLduPerS2: 300,
  };
  return createSimSession({
    track,
    capacity: { trains: fronts.length, vehicles: fronts.length },
    trains: fronts.map(([edge, offsetLdu]) => ({ spec, placement: { edge, offsetLdu } })),
    railway: { topology, autopilotSeed },
    openEnds,
  });
}

function run(target: SimSession, minutes: number): void {
  for (let tick = 0; tick < minutes * 60 * SIM_TICK_HZ; tick++) target.simulation.step();
}

it(
  "keeps three or four autopilot trains off each other's track pieces while they all keep arriving",
  () => {
    for (const fronts of [
      [70, 30, 140],
      [70, 30, 98, 140],
    ]) {
      const autopilot = session(
        TWO_SIDINGS,
        fronts.map((edge) => [edge, 100] as const),
        1,
      );
      run(autopilot, AUTOPILOT_MINUTES);
      expect(autopilot.simulation.separationCounters[0]).toBe(0);
      for (const arrivals of autopilot.simulation.keeper?.arrivals ?? []) {
        expect(arrivals).toBeGreaterThanOrEqual(MIN_ARRIVALS_PER_TRAIN);
      }
    }
  },
  AUTOPILOT_TIMEOUT_MS,
);

it("runs two manual trains on a switchless oval and stops the follower behind a stopped leader", () => {
  const fronts = [
    [0, 300],
    [12, 300],
  ] as const;
  const both = session(SWITCHLESS_OVAL, fronts, null);
  both.apply({ kind: "throttle", train: 0, speedLduPerS: OVAL_SPEED_LDU_PER_S });
  both.apply({ kind: "throttle", train: 1, speedLduPerS: OVAL_SPEED_LDU_PER_S });
  run(both, OVAL_MINUTES);
  expect(both.simulation.separationCounters[0]).toBe(0);
  expect(Array.from(both.simulation.trainSpeed)).toEqual([
    OVAL_SPEED_LDU_PER_S,
    OVAL_SPEED_LDU_PER_S,
  ]);

  const following = session(SWITCHLESS_OVAL, fronts, null);
  following.apply({ kind: "throttle", train: 0, speedLduPerS: OVAL_SPEED_LDU_PER_S });
  run(following, OVAL_MINUTES);
  const sim = following.simulation;
  expect(sim.separationCounters[0]).toBe(0);
  expect(sim.trainSpeed[0]).toBe(0);
  expect(sim.trainEdge[0]).not.toBe(fronts[0][0]);
  const couplersTouchingBogieDistance =
    locomotive.frontBogieLdu + locomotive.lengthLdu - locomotive.rearBogieLdu;
  expect(sim.separationCounters[1]).toBeGreaterThan(couplersTouchingBogieDistance);
});

function leadBogieXZ(target: SimSession): readonly [number, number] {
  const poses = new Float64Array(target.simulation.vehicles * POSE_FLOATS_PER_VEHICLE);
  target.simulation.writeVehiclePoses(poses);
  return [poses[0] ?? 0, poses[1] ?? 0];
}

it("stops a reserved train short of an open end under the brake rule and runs it off under the derail rule once its leading axle leaves the rail", () => {
  const stopped = session(OPEN_LINE, [[4, 100]], null, "brake");
  stopped.apply({ kind: "drive", train: 0, signedSpeedLduPerS: OPEN_LINE_SPEED_LDU_PER_S });
  run(stopped, 1);
  const stoppedSim = stopped.simulation;
  const stoppedEdge = stoppedSim.trainEdge[0] ?? 0;
  expect(stoppedSim.derailed(0)).toBe(false);
  expect(stoppedSim.trainSpeed[0]).toBe(0);
  expect(stoppedSim.successor(stoppedEdge)).toBe(-1);
  expect(stoppedSim.trainOffset[0] ?? 0).toBeLessThan(
    stoppedSim.track.edgeLength[stoppedEdge] ?? 0,
  );

  const derailing = session(OPEN_LINE, [[4, 100]], null, "derail");
  const sim = derailing.simulation;
  derailing.apply({ kind: "drive", train: 0, signedSpeedLduPerS: OPEN_LINE_SPEED_LDU_PER_S });
  for (let tick = 0; tick < 60 * SIM_TICK_HZ && !sim.derailed(0); tick++) sim.step();
  expect(sim.derailed(0)).toBe(true);
  expect(sim.trainDerailSpeed[0]).toBe(OPEN_LINE_SPEED_LDU_PER_S);
  expect(sim.trainEdge[0]).toBe(stoppedEdge);
  const geometry = locomotive.geometry;
  if (!geometry) throw new Error(`${LOCOMOTIVE_MODEL} has no imported running gear geometry`);
  const leadAxle = geometry.frontCoupler.xLdu - geometry.front.leadAxleXLdu;
  expect(leadAxle).toBeLessThan(locomotive.frontBogieLdu);
  expect(sim.overrunLdu(0)).toBeGreaterThanOrEqual(leadAxle);
  expect(sim.overrunLdu(0)).toBeLessThan(leadAxle + OPEN_LINE_SPEED_LDU_PER_S / SIM_TICK_HZ);
  run(derailing, 1);
  expect(sim.trainSpeed[0]).toBe(0);
  expect(derailing.apply({ kind: "rerail", train: 0 })).toBe(true);
  const [restX, restZ] = leadBogieXZ(derailing);
  derailing.apply({ kind: "drive", train: 0, signedSpeedLduPerS: -OPEN_LINE_SPEED_LDU_PER_S });
  run(derailing, 0.1);
  expect(sim.derailed(0)).toBe(false);
  expect(sim.trainSpeed[0]).toBeGreaterThan(0);
  const [x, z] = leadBogieXZ(derailing);
  expect(Math.hypot(x - restX, z - restZ)).toBeGreaterThan(OPEN_LINE_SPEED_LDU_PER_S);
});

it("keeps routed trains to their stops under the derail rule: one arrives at a stub end, one parked near it reverses to a stop behind", () => {
  const lastPlacement = buildTrackPlan(OPEN_LINE, catalog).layout.count - 1;
  for (const openEnds of ["brake", "derail"] as const) {
    const toStub = session(OPEN_LINE, [[4, 100]], null, openEnds);
    expect(toStub.apply({ kind: "goTo", train: 0, placement: lastPlacement })).toBe(true);
    run(toStub, 1);
    const ahead = toStub.simulation;
    expect(ahead.derailed(0)).toBe(false);
    expect(ahead.keeper?.routeState(0)).toBe("arrived");
    expect(ahead.keeper?.arrivals[0]).toBe(1);
    expect(ahead.overrunLdu(0)).toBe(0);

    const behind = session(OPEN_LINE, [[2 * lastPlacement, 300]], null, openEnds);
    expect(behind.apply({ kind: "goTo", train: 0, placement: 0 })).toBe(true);
    run(behind, 1);
    const reversed = behind.simulation;
    expect(reversed.derailed(0)).toBe(false);
    expect(reversed.keeper?.routeState(0)).toBe("arrived");
    expect(reversed.keeper?.arrivals[0]).toBe(1);
  }
});
