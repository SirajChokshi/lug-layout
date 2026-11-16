import {
  PART_BUNDLE_LOADER,
  type BundleLod,
  type IPartBundleLoader,
  type PartBundle,
  type TrackPiece,
} from "@brr/catalog";
import { TrackGraph, type TrackLayout } from "@brr/domain";
import { PLATE_LDU } from "@brr/math";
import { SCENE_BACKEND, type ISceneBackend } from "@brr/render";
import type { SimFrameLayout, SimLoad, SimLoaded, SimPathSegment, TrainSpec } from "@brr/sim";
import { inject, injectable } from "inversify";
import { vehicleFromModel, type ModelVehicle } from "../sim/model-vehicle.ts";
import type { ISimClient, SimTickCost } from "../sim/sim-client.ts";
import { SIM_CLIENT } from "../tokens.ts";
import { plateDepthBelowOrigin } from "./part-footprint.ts";
import { withStuds } from "./stud-stream.ts";
import { buildTrackPlan } from "./track-plan.ts";
import { summarizeTrack, TRACK_PARTS, trackChunks } from "./track-scene.ts";
import { ColorTable, showChunks, type IViewerScene, type SceneSummary } from "./viewer-scene.ts";

export interface TrainRequest {
  readonly edge: number;
  readonly offsetLdu: number;
}

export interface RunRequest {
  readonly plan: string;
  readonly model: string;
  readonly trains: ReadonlyArray<TrainRequest>;
  readonly speedLduPerS: number;
  readonly accelerationLduPerS2: number;
  readonly brakingLduPerS2: number;
}

export interface RunStatus {
  readonly tick: number;
  readonly stateHash: number;
  readonly trains: number;
  readonly trainEdge: ReadonlyArray<number>;
  readonly trainOffsetLdu: ReadonlyArray<number>;
  readonly trainSpeedLduPerS: ReadonlyArray<number>;
  readonly tickCost: SimTickCost;
  readonly vehicle: ModelVehicle["spec"] | null;
  readonly wheelsets: number;
  readonly maxEndResidualLdu: number;
  readonly maxEndHeadingResidualRadians: number;
}

export interface IRunScene extends IViewerScene {
  configure(request: RunRequest): void;
  status(): RunStatus | null;
  readonly sim: ISimClient;
}

const ORBIT_DISTANCE_FACTOR = 0.9;
const ORBIT_ELEVATION_FACTOR = 1.1;
const MIN_ORBIT_RADIUS_LDU = 400;

function mergedBundle(track: PartBundle, model: PartBundle): PartBundle {
  return { ...track, parts: [...track.parts, ...model.parts] };
}

function routeSegments(
  graph: TrackGraph,
  layout: TrackLayout,
  pieces: ReadonlyArray<TrackPiece>,
): SimPathSegment[][] {
  const segments: SimPathSegment[][] = [];
  for (let edge = 0; edge < graph.edgeCount; edge += 2) {
    const placement = graph.edgePlacement[edge] ?? 0;
    const piece = pieces[layout.piece(placement)];
    const route = piece?.routes[graph.edgeRoute[edge] ?? 0];
    if (!route) throw new Error(`edge ${edge} has no catalog route`);
    segments.push([...route.segments]);
  }
  return segments;
}

function railTopY(
  layout: TrackLayout,
  pieces: ReadonlyArray<TrackPiece>,
  bundle: PartBundle,
): number {
  const piece = pieces[layout.piece(0)];
  const asset = bundle.parts.find((part) => part.id === piece?.part);
  if (!asset) throw new Error("the first track placement has no part in the bundle");
  return (layout.yPlates(0) + plateDepthBelowOrigin(asset)) * PLATE_LDU + asset.boundsMax[1];
}

@injectable()
export class RunScene implements IRunScene {
  private request: RunRequest | undefined;
  private frameLayout: SimFrameLayout | undefined;
  private loaded: SimLoaded | undefined;
  private vehicle: ModelVehicle | undefined;
  private railY = 0;
  private centreX = 0;
  private centreZ = 0;
  private radius = MIN_ORBIT_RADIUS_LDU;

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) readonly backend: ISceneBackend,
    @inject(SIM_CLIENT) readonly sim: ISimClient,
  ) {}

  configure(request: RunRequest): void {
    this.request = request;
  }

  async load(lod: BundleLod): Promise<SceneSummary> {
    const request = this.request;
    if (!request) throw new Error("RunScene.load called before configure");
    const [trackBundle, modelBundle] = await Promise.all([
      this.loader.load(lod, TRACK_PARTS),
      this.loader.loadModel(lod, request.model),
    ]);
    const bundle = mergedBundle(trackBundle, modelBundle.bundle);
    const { layout, catalogPieces } = buildTrackPlan(request.plan, trackBundle.trackCatalog);
    const graph = new TrackGraph(layout);
    this.frame(graph);
    const colors = new ColorTable(bundle);
    const chunks = trackChunks(layout, catalogPieces, bundle, colors);
    const vehicle = vehicleFromModel(modelBundle.model, modelBundle.bundle.parts);
    this.vehicle = vehicle;
    this.railY = railTopY(layout, catalogPieces, bundle);
    const summary = showChunks(this.backend, bundle, undefined, colors, chunks, {
      name: modelBundle.entry.name,
      source: modelBundle.entry.source,
      sections: modelBundle.model.sections,
    });
    const model = modelBundle.model;
    const partOffset = trackBundle.parts.length;
    const partIndex = new Uint16Array(model.instanceCount);
    const colorIndex = new Uint16Array(model.instanceCount);
    for (let i = 0; i < model.instanceCount; i++) {
      partIndex[i] = (model.partIndex[i] ?? 0) + partOffset;
      colorIndex[i] = colors.indexOfCode(model.ldrawColor[i] ?? 0);
    }
    const body = withStuds(
      {
        originX: 0,
        originZ: 0,
        count: model.instanceCount,
        partIndex,
        colorIndex,
        matrices: vehicle.matrices,
      },
      bundle.parts,
      colors,
      undefined,
    );
    for (let t = 0; t < request.trains.length; t++) this.backend.setVehicle(t, body);
    const spec: TrainSpec = {
      vehicles: [vehicle.spec],
      maxSpeedLduPerS: request.speedLduPerS,
      accelerationLduPerS2: request.accelerationLduPerS2,
      brakingLduPerS2: request.brakingLduPerS2,
    };
    const load: SimLoad = {
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
      routeSegments: routeSegments(graph, layout, catalogPieces),
      capacity: { trains: request.trains.length, vehicles: request.trains.length },
      trains: request.trains.map((train) => ({
        spec,
        placement: { edge: train.edge, offsetLdu: train.offsetLdu },
      })),
    };
    this.loaded = await this.sim.load(load);
    this.frameLayout = this.loaded.layout;
    for (let t = 0; t < request.trains.length; t++) {
      await this.sim.command({ kind: "throttle", train: t, speedLduPerS: request.speedLduPerS });
    }
    this.sim.run(true);
    return {
      ...summary,
      parts: summary.parts + model.instanceCount * request.trains.length,
      track: summarizeTrack(request.plan, graph, layout, catalogPieces),
    };
  }

  onFrame(): void {
    const frame = this.sim.latestFrame();
    const layout = this.frameLayout;
    if (!frame || !layout) return;
    const data = frame.data;
    for (let v = 0; v < layout.vehicles; v++) {
      const o = layout.poseStart + v * layout.poseFloatsPerVehicle;
      const fx = data[o] ?? 0;
      const fz = data[o + 1] ?? 0;
      const rx = data[o + 2] ?? 0;
      const rz = data[o + 3] ?? 0;
      this.backend.setVehiclePose(
        v,
        (fx + rx) / 2,
        this.railY,
        (fz + rz) / 2,
        Math.atan2(fz - rz, fx - rx),
      );
    }
  }

  status(): RunStatus | null {
    const frame = this.sim.latestFrame();
    const layout = this.frameLayout;
    const loaded = this.loaded;
    if (!frame || !layout || !loaded) return null;
    const pick = (start: number): number[] =>
      Array.from(frame.data.subarray(start, start + layout.trains));
    return {
      tick: frame.tick,
      stateHash: frame.stateHash,
      trains: layout.trains,
      trainEdge: pick(layout.trainEdgeStart),
      trainOffsetLdu: pick(layout.trainOffsetStart),
      trainSpeedLduPerS: pick(layout.trainSpeedStart),
      tickCost: this.sim.tickCost(),
      vehicle: this.vehicle?.spec ?? null,
      wheelsets: this.vehicle?.wheelsets ?? 0,
      maxEndResidualLdu: loaded.maxEndResidualLdu,
      maxEndHeadingResidualRadians: loaded.maxEndHeadingResidualRadians,
    };
  }

  private frame(graph: TrackGraph): void {
    if (graph.endCount === 0) return;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let end = 0; end < graph.endCount; end++) {
      minX = Math.min(minX, graph.endXLdu[end] ?? 0);
      maxX = Math.max(maxX, graph.endXLdu[end] ?? 0);
      minZ = Math.min(minZ, graph.endZLdu[end] ?? 0);
      maxZ = Math.max(maxZ, graph.endZLdu[end] ?? 0);
    }
    this.centreX = (minX + maxX) / 2;
    this.centreZ = (minZ + maxZ) / 2;
    this.radius = Math.max(Math.hypot(maxX - minX, maxZ - minZ) / 2, MIN_ORBIT_RADIUS_LDU);
  }

  setCamera(t: number): void {
    const angle = t * 2 * Math.PI;
    const distance = this.radius * ORBIT_DISTANCE_FACTOR;
    this.backend.setView(
      this.centreX + distance * Math.cos(angle),
      this.radius * ORBIT_ELEVATION_FACTOR,
      this.centreZ + distance * Math.sin(angle),
      this.centreX,
      0,
      this.centreZ,
    );
  }
}
