import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
  type TrackCatalog,
} from "@brr/catalog";
import { TrackGraph } from "@brr/domain";
import { SIM_TICK_HZ, SimSession, simTrackFromGraph, type VehicleSpec } from "@brr/sim";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { beforeAll, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { vehicleFromModel } from "../sim/model-vehicle.ts";
import { routeSegments, simTopology } from "../sim/sim-track-input.ts";
import { buildTrackPlan } from "./track-plan.ts";
import { TRACK_PARTS } from "./track-scene.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);

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
const LOCOMOTIVE_MODEL = "10133-1";
const AUTOPILOT_MINUTES = 20;
const MIN_ARRIVALS_PER_TRAIN = 20;
const OVAL_MINUTES = 2;
const OVAL_SPEED_LDU_PER_S = 150;

let catalog: TrackCatalog;
let locomotive: VehicleSpec;

beforeAll(async () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const loader = container.get(PART_BUNDLE_LOADER);
  catalog = (await loader.load("standard", TRACK_PARTS)).trackCatalog;
  const model = await loader.loadModel("standard", LOCOMOTIVE_MODEL);
  locomotive = vehicleFromModel(model.model, model.bundle.parts).spec;
});

function session(
  plan: string,
  fronts: ReadonlyArray<readonly [number, number]>,
  autopilotSeed: number | null,
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
  return new SimSession({
    track,
    capacity: { trains: fronts.length, vehicles: fronts.length },
    trains: fronts.map(([edge, offsetLdu]) => ({ spec, placement: { edge, offsetLdu } })),
    railway: { topology, autopilotSeed },
  });
}

function run(target: SimSession, minutes: number): void {
  for (let tick = 0; tick < minutes * 60 * SIM_TICK_HZ; tick++) target.simulation.step();
}

it("keeps three or four autopilot trains off each other's track pieces while they all keep arriving", () => {
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
    for (const arrivals of autopilot.simulation.blocks?.arrivals ?? []) {
      expect(arrivals).toBeGreaterThanOrEqual(MIN_ARRIVALS_PER_TRAIN);
    }
  }
});

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
