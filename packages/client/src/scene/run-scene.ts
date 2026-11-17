import {
  PART_BUNDLE_LOADER,
  type IPartBundleLoader,
  type PartBundle,
  type PartModel,
} from "@brr/catalog";
import type { BundleLod, TrackCatalog, TrackPiece } from "@brr/schema/bundle";
import { NO_EDGE, TrackGraph, type TrackLayout } from "@brr/domain";
import { SCENE_BACKEND, type ChunkInstances, type ISceneBackend } from "@brr/render";
import type { SimFrameLayout, SimLoad, SimLoaded, TrainSpec, VehicleSpec } from "@brr/sim";
import { worldTrack, worldTrains } from "@brr/schema/world";
import { issueText } from "@brr/schema/decode";
import { WORLD_REPOSITORY, type IWorldRepository } from "@brr/storage";
import { inject, injectable } from "inversify";
import {
  consistVehicles,
  type ConsistEntry,
  type ConsistVehicle,
  type RigidBodyInstances,
} from "../sim/consist.ts";
import type { ISimClient, SimTickCost } from "../sim/sim-client.ts";
import { instanceBoxes } from "../running-gear/instance-boxes.ts";
import type { IRunningGear, RunningGearSource } from "../running-gear/running-gear-editor.ts";
import { routeSegments, simTopology } from "../sim/sim-track-input.ts";
import { RUNNING_GEAR, SIM_CLIENT } from "../tokens.ts";
import { railTopLdu } from "./part-footprint.ts";
import { withStuds } from "./stud-stream.ts";
import { buildTrackPlan, type TrackPlanLayout } from "./track-plan.ts";
import { buildWorldTrack, routeEdge } from "./world-track.ts";
import { summarizeTrack, TRACK_PARTS, trackChunks } from "./track-scene.ts";
import { ColorTable, showChunks, type IViewerScene, type SceneSummary } from "./viewer-scene.ts";

export interface TrainRequest {
  readonly edge: number;
  readonly offsetLdu: number;
}

export interface RunRequest {
  readonly world: string | null;
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
  readonly gear: RunningGearSource;
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
const OMR_PREFIX = /^omr:/u;

interface RunTrain {
  readonly edge: number;
  readonly offsetLdu: number;
  readonly consist: ReadonlyArray<ConsistEntry>;
}

interface RunTrack extends TrackPlanLayout {
  readonly name: string;
  readonly trains: ReadonlyArray<RunTrain>;
  readonly source: "plan" | "world";
}

function railTopY(
  layout: TrackLayout,
  pieces: ReadonlyArray<TrackPiece>,
  bundle: PartBundle,
): number {
  const piece = pieces[layout.piece(0)];
  const asset = bundle.parts.find((part) => part.id === piece?.part);
  if (!asset) throw new Error("the first track placement has no part in the bundle");
  return railTopLdu(asset, layout.yPlates(0));
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
    @inject(WORLD_REPOSITORY) private readonly worlds: IWorldRepository,
  ) {}

  private async runTrack(request: RunRequest, catalog: TrackCatalog): Promise<RunTrack> {
    if (request.world === null) {
      return {
        ...buildTrackPlan(request.plan, catalog),
        name: request.plan,
        trains: request.trains.map((train) => ({ ...train, consist: request.consist })),
        source: "plan",
      };
    }
    const stored = await this.worlds.read(request.world);
    if (!stored.ok) {
      throw new Error(`world ${request.world} can't be read: ${issueText(stored.issues)}`);
    }
    const { shards, manifest } = stored.value;
    const track = buildWorldTrack(worldTrack(shards), catalog);
    const graph = new TrackGraph(track.layout);
    const trains = worldTrains(shards).map((record, index) => {
      const edge = routeEdge(graph, record.track, record.route, record.forward);
      if (edge === NO_EDGE) {
        throw new Error(
          `train ${index + 1} stands on route ${record.route} of track piece ${record.track}, which isn't laid`,
        );
      }
      return {
        edge,
        offsetLdu: record.offsetLdu,
        consist: record.cars.map((car) => ({
          model: car.ref.replace(OMR_PREFIX, ""),
          reversed: car.reversed,
        })),
      };
    });
    if (trains.length === 0) {
      throw new Error(`world "${manifest.name}" has no rolling stock on its track to run`);
    }
    return { ...track, name: manifest.name, trains, source: "world" };
  }

  configure(request: RunRequest): void {
    this.request = request;
  }

  async load(lod: BundleLod): Promise<SceneSummary> {
    const request = this.request;
    if (!request) throw new Error("RunScene.load called before configure");
    const trackBundle = await this.loader.load(lod, TRACK_PARTS);
    const run = await this.runTrack(request, trackBundle.trackCatalog);
    const models = [
      ...new Set(run.trains.flatMap((train) => train.consist.map((entry) => entry.model))),
    ];
    const modelBundles = await Promise.all(
      models.map((model) => this.loader.loadModel(lod, model)),
    );
    const modelByName = new Map(models.map((name, i) => [name, modelBundles[i]]));
    const bundle = mergedBundle(
      trackBundle,
      modelBundles.map((model) => model.bundle),
    );
    const { layout, catalogPieces } = run;
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
    const consists = run.trains.map((train) =>
      train.consist.flatMap((entry) => {
        const loaded = modelByName.get(entry.model);
        if (!loaded) throw new Error(`model ${entry.model} did not load`);
        return consistVehicles(
          loaded.model,
          entry.model,
          entry.reversed,
          railPart,
          run.source === "plan"
            ? this.runningGear.effectiveVehicles(entry.model)
            : loaded.model.vehicles,
        ).map((vehicle) => ({ vehicle, loaded }));
      }),
    );
    const consist = run.source === "plan" ? (consists[0] ?? []) : consists.flat();
    this.consist = consist.map(({ vehicle }) => vehicle);
    const rigidChunks = consists.flat().map(({ vehicle, loaded }) => {
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
      name: models.join(" + "),
      source: first?.entry.source ?? "",
      sections: modelBundles.flatMap((model) => model.model.sections),
    });
    let nextBody = 0;
    let drawnParts = 0;
    this.placed = [];
    let firstOfTrain = 0;
    for (const trainVehicles of consists) {
      trainVehicles.forEach(({ vehicle }, v) => {
        const prepared = rigidChunks[firstOfTrain + v];
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
      firstOfTrain += trainVehicles.length;
    }
    const specs: TrainSpec[] = consists.map((trainVehicles) => ({
      vehicles: trainVehicles.map(({ vehicle }) => vehicle.spec),
      maxSpeedLduPerS: request.speedLduPerS,
      accelerationLduPerS2: request.accelerationLduPerS2,
      brakingLduPerS2: request.brakingLduPerS2,
    }));
    const load: SimLoad = {
      graph: simTopology(graph),
      routeSegments: routeSegments(graph, layout, catalogPieces),
      capacity: {
        trains: run.trains.length,
        vehicles: specs.reduce((sum, spec) => sum + spec.vehicles.length, 0),
      },
      trains: run.trains.map((train, t) => {
        const spec = specs[t];
        if (!spec) throw new Error(`train ${t + 1} has no consist`);
        return { spec, placement: { edge: train.edge, offsetLdu: train.offsetLdu } };
      }),
      autopilotSeed: request.autopilotSeed,
      openEnds: "brake",
    };
    this.loaded = await this.sim.load(load);
    this.frameLayout = this.loaded.layout;
    if (request.autopilotSeed === null) {
      for (let t = 0; t < run.trains.length; t++) {
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
      track: summarizeTrack(run.name, graph, layout, catalogPieces),
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
        gear: this.runningGear.gearSource(vehicle.model, vehicle.vehicle),
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
