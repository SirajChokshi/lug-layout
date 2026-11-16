import { ASSET_FETCHER, PART_BUNDLE_LOADER, type IAssetFetcher } from "@brr/catalog";
import { TrackGraph } from "@brr/domain";
import { SIM_TICK_HZ, SimSession, simTrackFromGraph, type SimPathSegment } from "@brr/sim";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { buildTrackPlan } from "./track-plan.ts";

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
const LOCOMOTIVE = { lengthLdu: 706, frontBogieLdu: 183, rearBogieLdu: 523 };
const SIMULATED_MINUTES = 20;
const MIN_ARRIVALS_PER_TRAIN = 20;

it("keeps three or four autopilot trains off each other's track pieces while they all keep arriving", async () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const bundle = await container.get(PART_BUNDLE_LOADER).load("standard", () => false);
  const { layout, catalogPieces } = buildTrackPlan(TWO_SIDINGS, bundle.trackCatalog);
  const graph = new TrackGraph(layout);
  const segments: SimPathSegment[][] = [];
  for (let edge = 0; edge < graph.edgeCount; edge += 2) {
    const piece = catalogPieces[layout.piece(graph.edgePlacement[edge] ?? 0)];
    segments.push([...(piece?.routes[graph.edgeRoute[edge] ?? 0]?.segments ?? [])]);
  }
  const topology = {
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
    placementCount: graph.placementCount,
    edgePlacement: graph.edgePlacement,
    edgeRoute: graph.edgeRoute,
    endPlacement: graph.endPlacement,
    endPartner: graph.endPartner,
    switchEnd: graph.switchEnd,
  };
  const { track } = simTrackFromGraph(topology, segments);
  const spec = {
    vehicles: [LOCOMOTIVE],
    maxSpeedLduPerS: 400,
    accelerationLduPerS2: 150,
    brakingLduPerS2: 300,
  };
  for (const fronts of [
    [70, 30, 140],
    [70, 30, 98, 140],
  ]) {
    const session = new SimSession({
      track,
      capacity: { trains: fronts.length, vehicles: fronts.length },
      trains: fronts.map((edge) => ({ spec, placement: { edge, offsetLdu: 100 } })),
      railway: { topology, autopilotSeed: 1 },
    });
    const sim = session.simulation;
    for (let tick = 0; tick < SIMULATED_MINUTES * 60 * SIM_TICK_HZ; tick++) sim.step();
    expect(sim.separationCounters[0]).toBe(0);
    for (const arrivals of sim.blocks?.arrivals ?? []) {
      expect(arrivals).toBeGreaterThanOrEqual(MIN_ARRIVALS_PER_TRAIN);
    }
  }
});
