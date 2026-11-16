import {
  PART_BUNDLE_LOADER,
  type BundleLod,
  type IPartBundleLoader,
  type PartBundle,
  type PartModel,
  type TrackPiece,
} from "@brr/catalog";
import { TrackGraph, type TrackLayout } from "@brr/domain";
import { PLATE_LDU } from "@brr/math";
import {
  INSTANCE_MATRIX_FLOATS,
  SCENE_BACKEND,
  type ChunkInstances,
  type ISceneBackend,
} from "@brr/render";
import type { SimFrameLayout, SimLoad, SimLoaded, TrainSpec, VehicleSpec } from "@brr/sim";
import { inject, injectable } from "inversify";
import {
  consistVehicles,
  type ConsistEntry,
  type ConsistVehicle,
  type RigidBodyInstances,
} from "../sim/consist.ts";
import type { ISimClient, SimTickCost } from "../sim/sim-client.ts";
import { BOX_FLOATS, type IRunningGear } from "../running-gear/running-gear-editor.ts";
import { routeSegments, simTopology } from "../sim/sim-track-input.ts";
import { RUNNING_GEAR, SIM_CLIENT } from "../tokens.ts";
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
  readonly consist: ReadonlyArray<ConsistEntry>;
  readonly trains: ReadonlyArray<TrainRequest>;
  readonly speedLduPerS: number;
  readonly accelerationLduPerS2: number;
  readonly brakingLduPerS2: number;
  readonly follow: boolean;
  readonly start: boolean;
  readonly autopilotSeed: number | null;
  readonly followDistanceLdu: number;
}

export type TrainRouteStatus = "manual" | "waiting" | "routed" | "arrived" | "reversing";

const ROUTE_STATUSES: ReadonlyArray<TrainRouteStatus> = [
  "manual",
  "waiting",
  "routed",
  "arrived",
  "reversing",
];

export interface RunStatus {
  readonly tick: number;
  readonly stateHash: number;
  readonly trains: number;
  readonly switches: number;
  readonly trainEdge: ReadonlyArray<number>;
  readonly trainOffsetLdu: ReadonlyArray<number>;
  readonly trainSpeedLduPerS: ReadonlyArray<number>;
  readonly bogiePointsLdu: ReadonlyArray<number>;
  readonly arrivals: ReadonlyArray<number>;
  readonly routeStates: ReadonlyArray<TrainRouteStatus>;
  readonly sharedPieceTicks: number;
  readonly minBogieSeparationLdu: number;
  readonly checkedTicks: number;
  readonly tickCost: SimTickCost;
  readonly vehicles: ReadonlyArray<RunVehicleStatus>;
  readonly maxEndResidualLdu: number;
  readonly maxEndHeadingResidualRadians: number;
}

export interface RunVehicleStatus {
  readonly model: string;
  readonly reversed: boolean;
  readonly spec: VehicleSpec;
  readonly wheelsets: number;
  readonly bogieBodies: number;
}

export interface IRunScene extends IViewerScene {
  configure(request: RunRequest): void;
  status(): RunStatus | null;
  readonly sim: ISimClient;
}

const ORBIT_DISTANCE_FACTOR = 0.9;
const ORBIT_ELEVATION_FACTOR = 1.1;
const MIN_ORBIT_RADIUS_LDU = 400;
const FOLLOW_HEIGHT_PER_DISTANCE = 650 / 1400;
const FOLLOW_SWING_RADIANS = 0.9;

function mergedBundle(track: PartBundle, models: ReadonlyArray<PartBundle>): PartBundle {
  const parts = [...track.parts];
  const known = new Set(parts.map((part) => part.id));
  for (const model of models) {
    for (const part of model.parts) {
      if (known.has(part.id)) continue;
      known.add(part.id);
      parts.push(part);
    }
  }
  return { ...track, parts };
}

function railPartFor(layout: TrackLayout, pieces: ReadonlyArray<TrackPiece>): string {
  const system = pieces[layout.piece(0)]?.system;
  const straight = pieces.find((piece) => piece.system === system && piece.kind === "straight");
  if (!straight)
    throw new Error(`track system ${String(system)} has no straight to measure rails on`);
  return straight.part;
}

interface PlacedVehicle {
  readonly vehicle: ConsistVehicle;
  readonly body: number;
  readonly frontBogie: number;
  readonly rearBogie: number;
}

const NO_BODY = -1;

function instanceBoxes(model: PartModel, bundle: PartBundle): Float32Array {
  const out = new Float32Array(model.instanceCount * BOX_FLOATS);
  const m = model.matrices;
  for (let i = 0; i < model.instanceCount; i++) {
    const part = bundle.parts[model.partIndex[i] ?? 0];
    const o = i * INSTANCE_MATRIX_FLOATS;
    const b = i * BOX_FLOATS;
    for (let axis = 0; axis < 3; axis++) {
      out[b + axis] = Number.POSITIVE_INFINITY;
      out[b + 3 + axis] = Number.NEGATIVE_INFINITY;
    }
    if (!part) continue;
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? part.boundsMax[0] : part.boundsMin[0];
      const y = corner & 2 ? part.boundsMax[1] : part.boundsMin[1];
      const z = corner & 4 ? part.boundsMax[2] : part.boundsMin[2];
      for (let axis = 0; axis < 3; axis++) {
        const r = o + axis * 4;
        const value = (m[r] ?? 0) * x + (m[r + 1] ?? 0) * y + (m[r + 2] ?? 0) * z + (m[r + 3] ?? 0);
        out[b + axis] = Math.min(out[b + axis] ?? 0, value);
        out[b + 3 + axis] = Math.max(out[b + 3 + axis] ?? 0, value);
      }
    }
  }
  return out;
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
  private consist: ReadonlyArray<ConsistVehicle> = [];
  private placed: PlacedVehicle[] = [];
  private railY = 0;
  private centreX = 0;
  private centreZ = 0;
  private radius = MIN_ORBIT_RADIUS_LDU;

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) readonly backend: ISceneBackend,
    @inject(SIM_CLIENT) readonly sim: ISimClient,
    @inject(RUNNING_GEAR) private readonly runningGear: IRunningGear,
  ) {}

  configure(request: RunRequest): void {
    this.request = request;
  }

  async load(lod: BundleLod): Promise<SceneSummary> {
    const request = this.request;
    if (!request) throw new Error("RunScene.load called before configure");
    const models = [...new Set(request.consist.map((entry) => entry.model))];
    const [trackBundle, ...modelBundles] = await Promise.all([
      this.loader.load(lod, TRACK_PARTS),
      ...models.map((model) => this.loader.loadModel(lod, model)),
    ]);
    const modelByName = new Map(models.map((name, i) => [name, modelBundles[i]]));
    const bundle = mergedBundle(
      trackBundle,
      modelBundles.map((model) => model.bundle),
    );
    const { layout, catalogPieces } = buildTrackPlan(request.plan, trackBundle.trackCatalog);
    const graph = new TrackGraph(layout);
    this.frame(graph);
    const colors = new ColorTable(bundle);
    const chunks = trackChunks(layout, catalogPieces, bundle, colors);
    const railPart = railPartFor(layout, catalogPieces);
    this.railY = railTopY(layout, catalogPieces, bundle);
    const first = modelBundles[0];
    await this.runningGear.setModels(
      models.map((name, i) => {
        const loaded = modelBundles[i];
        if (!loaded) throw new Error(`model ${name} did not load`);
        return {
          name,
          sha256: loaded.entry.sha256,
          vehicles: loaded.model.vehicles,
          instanceBoxes: instanceBoxes(loaded.model, loaded.bundle),
        };
      }),
    );
    const consist = request.consist.flatMap((entry) => {
      const loaded = modelByName.get(entry.model);
      if (!loaded) throw new Error(`model ${entry.model} did not load`);
      return consistVehicles(
        loaded.model,
        entry.model,
        entry.reversed,
        railPart,
        this.runningGear.effectiveVehicles(entry.model),
      ).map((vehicle) => ({ vehicle, loaded }));
    });
    this.consist = consist.map(({ vehicle }) => vehicle);
    const rigidChunks = consist.map(({ vehicle, loaded }) => {
      const chunk = (rigid: RigidBodyInstances | null): ChunkInstances | null =>
        rigid ? this.rigidChunk(rigid, loaded.model, loaded.bundle, bundle, colors) : null;
      return {
        body: chunk(vehicle.body),
        frontBogie: chunk(vehicle.frontBogie),
        rearBogie: chunk(vehicle.rearBogie),
        parts:
          vehicle.body.instances.length +
          (vehicle.frontBogie?.instances.length ?? 0) +
          (vehicle.rearBogie?.instances.length ?? 0),
      };
    });
    const summary = showChunks(this.backend, bundle, undefined, colors, chunks, {
      name: request.consist.map((entry) => entry.model).join(" + "),
      source: first?.entry.source ?? "",
      sections: modelBundles.flatMap((model) => model.model.sections),
    });
    let nextBody = 0;
    let drawnParts = 0;
    this.placed = [];
    for (let t = 0; t < request.trains.length; t++) {
      consist.forEach(({ vehicle }, v) => {
        const prepared = rigidChunks[v];
        if (!prepared) return;
        const show = (chunk: ChunkInstances | null): number => {
          if (!chunk) return NO_BODY;
          const id = nextBody++;
          this.backend.setVehicle(id, chunk);
          return id;
        };
        drawnParts += prepared.parts;
        this.placed.push({
          vehicle,
          body: show(prepared.body),
          frontBogie: show(prepared.frontBogie),
          rearBogie: show(prepared.rearBogie),
        });
      });
    }
    const spec: TrainSpec = {
      vehicles: consist.map(({ vehicle }) => vehicle.spec),
      maxSpeedLduPerS: request.speedLduPerS,
      accelerationLduPerS2: request.accelerationLduPerS2,
      brakingLduPerS2: request.brakingLduPerS2,
    };
    const load: SimLoad = {
      graph: simTopology(graph),
      routeSegments: routeSegments(graph, layout, catalogPieces),
      capacity: {
        trains: request.trains.length,
        vehicles: request.trains.length * consist.length,
      },
      trains: request.trains.map((train) => ({
        spec,
        placement: { edge: train.edge, offsetLdu: train.offsetLdu },
      })),
      autopilotSeed: request.autopilotSeed,
    };
    this.loaded = await this.sim.load(load);
    this.frameLayout = this.loaded.layout;
    if (request.autopilotSeed === null) {
      for (let t = 0; t < request.trains.length; t++) {
        await this.sim.command({ kind: "throttle", train: t, speedLduPerS: request.speedLduPerS });
      }
    }
    if (request.start) {
      const firstFrame = this.sim.nextFrame();
      this.sim.run(true);
      await firstFrame;
    }
    return {
      ...summary,
      parts: summary.parts + drawnParts,
      track: summarizeTrack(request.plan, graph, layout, catalogPieces),
    };
  }

  onFrame(): void {
    const frame = this.sim.latestFrame();
    const layout = this.frameLayout;
    if (!frame || !layout) return;
    const data = frame.data;
    for (let v = 0; v < layout.vehicles; v++) {
      const placed = this.placed[v];
      if (!placed) continue;
      const o = layout.vehiclePoseStart + v * layout.vehiclePoseFloats;
      const y = this.railY - placed.vehicle.railTopY;
      this.backend.setVehiclePose(placed.body, data[o] ?? 0, y, data[o + 1] ?? 0, data[o + 2] ?? 0);
      if (placed.frontBogie !== NO_BODY) {
        this.backend.setVehiclePose(
          placed.frontBogie,
          data[o + 3] ?? 0,
          y,
          data[o + 4] ?? 0,
          data[o + 5] ?? 0,
        );
      }
      if (placed.rearBogie !== NO_BODY) {
        this.backend.setVehiclePose(
          placed.rearBogie,
          data[o + 6] ?? 0,
          y,
          data[o + 7] ?? 0,
          data[o + 8] ?? 0,
        );
      }
    }
  }

  private rigidChunk(
    rigid: RigidBodyInstances,
    model: PartModel,
    modelBundle: PartBundle,
    bundle: PartBundle,
    colors: ColorTable,
  ): ChunkInstances {
    const count = rigid.instances.length;
    const partIndex = new Uint16Array(count);
    const colorIndex = new Uint16Array(count);
    for (let k = 0; k < count; k++) {
      const i = rigid.instances[k] ?? 0;
      const id = modelBundle.parts[model.partIndex[i] ?? 0]?.id;
      const merged = bundle.parts.findIndex((part) => part.id === id);
      if (merged < 0) throw new Error(`part ${String(id)} is missing from the run bundle`);
      partIndex[k] = merged;
      colorIndex[k] = colors.indexOfCode(model.ldrawColor[i] ?? 0);
    }
    return withStuds(
      { originX: 0, originZ: 0, count, partIndex, colorIndex, matrices: rigid.matrices },
      bundle.parts,
      colors,
      undefined,
    );
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
      switches: layout.switches,
      trainEdge: pick(layout.trainEdgeStart),
      trainOffsetLdu: pick(layout.trainOffsetStart),
      trainSpeedLduPerS: pick(layout.trainSpeedStart),
      bogiePointsLdu: Array.from({ length: layout.vehicles * 4 }, (_, k) => {
        const o = layout.vehiclePoseStart + Math.floor(k / 4) * layout.vehiclePoseFloats;
        const offsets = [3, 4, 6, 7];
        return frame.data[o + (offsets[k % 4] ?? 0)] ?? 0;
      }),
      arrivals: pick(layout.arrivalsStart),
      routeStates: pick(layout.routeStateStart).map((code) => ROUTE_STATUSES[code] ?? "manual"),
      sharedPieceTicks: frame.data[layout.sharedPieceTicksIndex] ?? 0,
      minBogieSeparationLdu: frame.data[layout.minBogieSeparationIndex] ?? 0,
      checkedTicks: frame.data[layout.checkedTicksIndex] ?? 0,
      tickCost: this.sim.tickCost(),
      vehicles: this.consist.map((vehicle) => ({
        model: vehicle.model,
        reversed: vehicle.reversed,
        spec: vehicle.spec,
        wheelsets: vehicle.wheelsets,
        bogieBodies: (vehicle.frontBogie ? 1 : 0) + (vehicle.rearBogie ? 1 : 0),
      })),
      maxEndResidualLdu: loaded.maxEndResidualLdu,
      maxEndHeadingResidualRadians: loaded.maxEndHeadingResidualRadians,
    };
  }

  private followTrain(t: number): boolean {
    const frame = this.sim.latestFrame();
    const layout = this.frameLayout;
    if (!frame || !layout || layout.vehicles === 0) return false;
    const o = layout.vehiclePoseStart;
    const data = frame.data;
    const x = data[o] ?? 0;
    const z = data[o + 1] ?? 0;
    const outward = Math.atan2(z - this.centreZ, x - this.centreX);
    const angle = outward + FOLLOW_SWING_RADIANS * Math.sin(t * 2 * Math.PI);
    const distance = this.request?.followDistanceLdu ?? 0;
    this.backend.setView(
      x + distance * Math.cos(angle),
      this.railY + distance * FOLLOW_HEIGHT_PER_DISTANCE,
      z + distance * Math.sin(angle),
      x,
      this.railY,
      z,
    );
    return true;
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
    if (this.request?.follow && this.followTrain(t)) return;
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
