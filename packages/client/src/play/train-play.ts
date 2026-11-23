import { STUD_LDU } from "@brr/math";
import { RAY_FLOATS, SCENE_BACKEND, type ISceneBackend } from "@brr/render";
import type { SimFrameLayout, SimTrainLoad, TrainSpec } from "@brr/sim";
import { inject, injectable } from "inversify";
import type { IRunningGear } from "../running-gear/running-gear-editor.ts";
import type { PlayModel } from "./play-models.ts";
import { consistVehicles, type ConsistVehicle } from "../sim/consist.ts";
import type { ISimClient } from "../sim/sim-client.ts";
import { routeSegments, simTopology } from "../sim/sim-track-input.ts";
import type { IPlaceableCatalog } from "../catalog/placeable-catalog.ts";
import { PLACEABLE_CATALOG, RAIL_YARD, RUNNING_GEAR, SIM_CLIENT, VEHICLE_IDS } from "../tokens.ts";
import { playObstacles } from "./play-obstacles.ts";
import { ConsistBodies } from "../trains/consist-bodies.ts";
import { trainLabel, type IRailYard } from "../trains/rail-yard.ts";
import type { RailTrack } from "../trains/rail-track.ts";
import type { IVehicleIds } from "../trains/vehicle-ids.ts";

export type PlayStatus = "idle" | "loading" | "running" | "error";
export type FollowCamera = (x: number, z: number) => void;

export interface PlaySwitchView {
  readonly index: number;
  readonly label: string;
  readonly diverging: boolean;
  readonly x: number;
  readonly z: number;
}

export interface PlayTrainView {
  readonly index: number;
  readonly label: string;
  readonly vehicles: number;
  readonly lengthLdu: number;
  readonly speedLduPerS: number;
  readonly direction: number;
  readonly derailSpeedLduPerS: number;
  readonly bogiesOffTrack: number;
  readonly blockedBy: string | null;
  readonly xLdu: number;
  readonly zLdu: number;
}

export interface PlaySnapshot {
  readonly status: PlayStatus;
  readonly error: string | null;
  readonly notice: string | null;
  readonly trains: ReadonlyArray<PlayTrainView>;
  readonly driven: number;
  readonly vehicles: number;
  readonly trainLengthLdu: number;
  readonly maxSpeedLduPerS: number;
  readonly targetLduPerS: number;
  readonly speedLduPerS: number;
  readonly direction: number;
  readonly derailSpeedLduPerS: number;
  readonly bogiesOffTrack: number;
  readonly trainXLdu: number;
  readonly trainZLdu: number;
  readonly switches: ReadonlyArray<PlaySwitchView>;
  readonly following: boolean;
  readonly tick: number;
}

export interface ITrainPlay {
  subscribe(listener: () => void): () => void;
  snapshot(): PlaySnapshot;
  start(): Promise<void>;
  refusal(): string | null;
  stop(): void;
  drive(signedSpeedLduPerS: number): void;
  chooseDriven(train: number): void;
  throwSwitch(index: number): void;
  rerail(): void;
  follow(camera: FollowCamera | null): void;
  click(ndcX: number, ndcY: number): boolean;
}

export const NO_TRACK_LAID = "Lay some track first, then set a train on it.";
export const NO_TRAIN_PLACED =
  "No train stands on the rails. Hold a train over laid track to set it on them.";

export function playRefusal(yard: Pick<IRailYard, "rails" | "trains">): string | null {
  if (!yard.rails()) return NO_TRACK_LAID;
  return yard.trains().length === 0 ? NO_TRAIN_PLACED : null;
}

const MAX_SPEED_LDU_PER_S = 400;
const ACCELERATION_LDU_PER_S2 = 150;
const BRAKING_LDU_PER_S2 = 300;
const SWITCH_PICK_RADIUS_LDU = 4 * STUD_LDU;
const STATUS_INTERVAL_MS = 100;
const DIVERGING = 1;
const NOT_BLOCKED = 0;
const STRAIGHT = 0;
const OFF_TRACK_YAW_RADIANS = 0.12;
const OFF_TRACK_ROLL_RADIANS = 0.22;

interface RunningTrain {
  readonly label: string;
  readonly bodies: ConsistBodies;
  readonly firstVehicle: number;
  readonly lengthLdu: number;
  targetLduPerS: number;
  blockedBy: number;
}

const IDLE: PlaySnapshot = {
  status: "idle",
  error: null,
  notice: null,
  trains: [],
  driven: 0,
  vehicles: 0,
  trainLengthLdu: 0,
  maxSpeedLduPerS: MAX_SPEED_LDU_PER_S,
  targetLduPerS: 0,
  speedLduPerS: 0,
  direction: 1,
  derailSpeedLduPerS: 0,
  bogiesOffTrack: 0,
  trainXLdu: 0,
  trainZLdu: 0,
  switches: [],
  following: false,
  tick: 0,
};

@injectable()
export class TrainPlay implements ITrainPlay {
  private readonly listeners = new Set<() => void>();
  private state: PlaySnapshot = IDLE;
  private running: RunningTrain[] = [];
  private layout: SimFrameLayout | null = null;
  private rails: RailTrack | null = null;
  private looping = false;
  private lastStatusMs = 0;
  private camera: FollowCamera | null = null;
  private readonly ray = new Float64Array(RAY_FLOATS);
  private obstacleLabels: ReadonlyArray<string> = [];

  constructor(
    @inject(SCENE_BACKEND) private readonly backend: ISceneBackend,
    @inject(SIM_CLIENT) private readonly sim: ISimClient,
    @inject(RUNNING_GEAR) private readonly runningGear: IRunningGear,
    @inject(RAIL_YARD) private readonly yard: IRailYard,
    @inject(VEHICLE_IDS) private readonly vehicleIds: IVehicleIds,
    @inject(PLACEABLE_CATALOG) private readonly catalog: IPlaceableCatalog,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): PlaySnapshot {
    return this.state;
  }

  private update(patch: Partial<PlaySnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  async start(): Promise<void> {
    if (this.state.status === "loading" || this.state.status === "running") return;
    this.update({ status: "loading", error: null, notice: null });
    try {
      await this.load();
      this.looping = true;
      this.sim.run(true);
      this.update({ status: "running", targetLduPerS: 0 });
      this.followTrain();
      requestAnimationFrame(this.step);
    } catch (error) {
      this.clearTrains();
      this.update({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  refusal(): string | null {
    return playRefusal(this.yard);
  }

  private async load(): Promise<void> {
    const rails = this.yard.rails();
    const placed = this.yard.trains();
    if (!rails) throw new Error(NO_TRACK_LAID);
    if (placed.length === 0) throw new Error(NO_TRAIN_PLACED);
    const models = new Set(placed.flatMap((train) => train.members.map(({ model }) => model)));
    await this.runningGear.setModels([...models].map((model) => model.gear));
    const consists = placed.map((train) => {
      const vehicles: ConsistVehicle[] = [];
      const vehicleModels: PlayModel[] = [];
      for (const { model, reversed } of train.members) {
        const gear = this.runningGear.effectiveVehicles(model.name);
        for (const vehicle of consistVehicles(
          model.model,
          model.name,
          reversed,
          rails.railPart,
          gear,
        )) {
          vehicles.push(vehicle);
          vehicleModels.push(model);
        }
      }
      return { train, vehicles, vehicleModels };
    });
    const loads: SimTrainLoad[] = consists.map(({ train, vehicles }) => ({
      spec: {
        vehicles: vehicles.map((vehicle) => vehicle.spec),
        maxSpeedLduPerS: MAX_SPEED_LDU_PER_S,
        accelerationLduPerS2: ACCELERATION_LDU_PER_S2,
        brakingLduPerS2: BRAKING_LDU_PER_S2,
      } satisfies TrainSpec,
      placement: { edge: train.head.edge, offsetLdu: train.head.offsetLdu },
    }));
    const vehicleCount = consists.reduce((sum, { vehicles }) => sum + vehicles.length, 0);
    const obstacleModels = this.yard.obstacleModels();
    const obstacles = obstacleModels
      ? await playObstacles({
          consists,
          rails,
          models: obstacleModels,
          solids: this.catalog.partSolids(),
          loadSolids: (parts) => this.catalog.loadPartSolids(parts),
          partTitle: (part) => this.catalog.parts()[part]?.title ?? `palette part ${part}`,
        })
      : null;
    const loaded = await this.sim.load({
      graph: simTopology(rails.graph),
      routeSegments: routeSegments(rails.graph, rails.play.layout, rails.play.pieces),
      capacity: { trains: loads.length, vehicles: vehicleCount },
      trains: loads,
      autopilotSeed: null,
      openEnds: "derail",
      ...(obstacles ? { obstacles: obstacles.obstacles } : {}),
    });
    this.obstacleLabels = obstacles?.labels ?? [];
    for (let s = 0; s < rails.switchStates.length; s++) {
      if (rails.switchStates[s] === DIVERGING) {
        await this.sim.command({ kind: "switch", switchIndex: s, state: DIVERGING });
      }
    }
    this.layout = loaded.layout;
    this.rails = rails;
    this.clearTrains();
    this.yard.park(true);
    let firstVehicle = 0;
    this.running = consists.map(({ train, vehicles, vehicleModels }) => {
      const first = firstVehicle;
      firstVehicle += vehicles.length;
      return {
        label: trainLabel(train.members),
        bodies: new ConsistBodies(this.backend, this.vehicleIds, {
          vehicles,
          vehicleModels,
          parts: train.consist.parts,
          colors: train.consist.colors,
        }),
        firstVehicle: first,
        lengthLdu: vehicles.reduce((sum, vehicle) => sum + vehicle.spec.lengthLdu, 0),
        targetLduPerS: 0,
        blockedBy: NOT_BLOCKED,
      };
    });
    this.update({ driven: 0, switches: this.switchViews(rails.switchStates) });
    this.poseVehicles();
    this.publishStatus();
  }

  stop(): void {
    this.looping = false;
    this.sim.run(false);
    this.clearTrains();
    this.layout = null;
    this.rails = null;
    this.update({ ...IDLE, following: this.state.following });
  }

  private clearTrains(): void {
    for (const train of this.running) train.bodies.dispose();
    this.running = [];
    this.yard.park(false);
  }

  chooseDriven(train: number): void {
    const chosen = this.running[train];
    if (this.state.status !== "running" || !chosen) return;
    this.update({ driven: train, targetLduPerS: chosen.targetLduPerS, notice: null });
    this.publishStatus();
    this.followTrain();
  }

  drive(signedSpeedLduPerS: number): void {
    const train = this.running[this.state.driven];
    if (this.state.status !== "running" || !train || this.state.derailSpeedLduPerS > 0) return;
    const max = this.state.maxSpeedLduPerS;
    const target = Math.min(Math.max(signedSpeedLduPerS, -max), max);
    train.targetLduPerS = target;
    this.update({ targetLduPerS: target, notice: null });
    void this.sim.command({ kind: "drive", train: this.state.driven, signedSpeedLduPerS: target });
  }

  throwSwitch(index: number): void {
    if (this.state.status !== "running") return;
    const current = this.state.switches[index];
    if (!current) return;
    const state = current.diverging ? STRAIGHT : DIVERGING;
    void this.sim.command({ kind: "switch", switchIndex: index, state }).then((accepted) => {
      this.update({
        notice: accepted
          ? null
          : `${current.label} is locked: a train is on it or has it reserved ahead.`,
      });
    });
  }

  rerail(): void {
    const train = this.running[this.state.driven];
    if (this.state.status !== "running" || !train) return;
    train.targetLduPerS = 0;
    this.update({ targetLduPerS: 0, notice: null });
    void this.sim.command({ kind: "rerail", train: this.state.driven });
  }

  follow(camera: FollowCamera | null): void {
    this.camera = camera;
    this.update({ following: camera !== null });
    this.followTrain();
  }

  private followTrain(): void {
    const camera = this.camera;
    const train = this.running[this.state.driven];
    if (!camera || !train) return;
    const frame = this.sim.latestFrame();
    const layout = this.layout;
    if (!frame || !layout) return;
    camera(this.trainX(frame.data, layout, train), this.trainZ(frame.data, layout, train));
  }

  private trainX(data: Float64Array, layout: SimFrameLayout, train: RunningTrain): number {
    return this.trainCentre(data, layout, train, 0);
  }

  private trainZ(data: Float64Array, layout: SimFrameLayout, train: RunningTrain): number {
    return this.trainCentre(data, layout, train, 1);
  }

  private trainCentre(
    data: Float64Array,
    layout: SimFrameLayout,
    train: RunningTrain,
    axis: number,
  ): number {
    const vehicles = train.bodies.consist.vehicles.length;
    const first = layout.vehiclePoseStart + train.firstVehicle * layout.vehiclePoseFloats;
    const last = first + (vehicles - 1) * layout.vehiclePoseFloats;
    return ((data[first + axis] ?? 0) + (data[last + axis] ?? 0)) / 2;
  }

  click(ndcX: number, ndcY: number): boolean {
    const rails = this.rails;
    if (this.state.status !== "running" || !rails) return false;
    this.backend.rayThrough(ndcX, ndcY, this.ray);
    const directionY = this.ray[4] ?? 0;
    if (directionY >= 0) return false;
    const t = (rails.railTopY - (this.ray[1] ?? 0)) / directionY;
    const x = (this.ray[0] ?? 0) + (this.ray[3] ?? 0) * t;
    const z = (this.ray[2] ?? 0) + (this.ray[5] ?? 0) * t;
    let best = -1;
    let bestDistance = SWITCH_PICK_RADIUS_LDU;
    for (let s = 0; s < rails.sites.length; s++) {
      const site = rails.sites[s];
      if (!site) continue;
      const distance = Math.hypot(site.x - x, site.z - z);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = s;
      }
    }
    if (best < 0) return false;
    this.throwSwitch(best);
    return true;
  }

  private readonly step = (): void => {
    if (!this.looping) return;
    this.poseVehicles();
    this.followTrain();
    const now = performance.now();
    if (now - this.lastStatusMs >= STATUS_INTERVAL_MS) {
      this.lastStatusMs = now;
      this.publishStatus();
    }
    requestAnimationFrame(this.step);
  };

  private publishStatus(): void {
    const frame = this.sim.latestFrame();
    const layout = this.layout;
    if (!frame || !layout) return;
    const data = frame.data;
    const notice = this.newlyBlocked(data, layout);
    const trains = this.running.map((train, t) => {
      let off = 0;
      const end = train.firstVehicle + train.bodies.consist.vehicles.length;
      for (let v = train.firstVehicle; v < end; v++) {
        off += data[layout.bogiesOffTrackStart + v] ?? 0;
      }
      return {
        index: t,
        label: train.label,
        vehicles: train.bodies.consist.vehicles.length,
        lengthLdu: train.lengthLdu,
        speedLduPerS: data[layout.trainSpeedStart + t] ?? 0,
        direction: data[layout.trainDirectionStart + t] ?? 1,
        derailSpeedLduPerS: data[layout.trainDerailSpeedStart + t] ?? 0,
        bogiesOffTrack: off,
        blockedBy: this.obstacleLabels[train.blockedBy - 1] ?? null,
        xLdu: this.trainX(data, layout, train),
        zLdu: this.trainZ(data, layout, train),
      };
    });
    const states = data.subarray(layout.switchStart, layout.switchStart + layout.switches);
    const switches = this.state.switches.some(
      (view, s) => view.diverging !== ((states[s] ?? 0) === DIVERGING),
    )
      ? this.switchViews(states)
      : this.state.switches;
    const driven = trains[this.state.driven];
    this.update({
      ...(notice === null ? {} : { notice, targetLduPerS: 0 }),
      trains,
      vehicles: driven?.vehicles ?? 0,
      trainLengthLdu: driven?.lengthLdu ?? 0,
      trainXLdu: driven?.xLdu ?? 0,
      trainZLdu: driven?.zLdu ?? 0,
      speedLduPerS: driven?.speedLduPerS ?? 0,
      direction: driven?.direction ?? 1,
      derailSpeedLduPerS: driven?.derailSpeedLduPerS ?? 0,
      bogiesOffTrack: driven?.bogiesOffTrack ?? 0,
      switches,
      tick: frame.tick,
    });
  }

  private newlyBlocked(data: Float64Array, layout: SimFrameLayout): string | null {
    let notice: string | null = null;
    for (let t = 0; t < this.running.length; t++) {
      const train = this.running[t];
      if (!train) continue;
      const blockedBy = data[layout.trainBlockedStart + t] ?? NOT_BLOCKED;
      if (blockedBy === train.blockedBy) continue;
      train.blockedBy = blockedBy;
      if (blockedBy === NOT_BLOCKED) continue;
      train.targetLduPerS = 0;
      if (t !== this.state.driven) continue;
      const model = this.obstacleLabels[blockedBy - 1] ?? "a model";
      notice = `${train.label} stopped: it would run into ${model}.`;
    }
    return notice;
  }

  private switchViews(states: ArrayLike<number>): PlaySwitchView[] {
    return (this.rails?.sites ?? []).map((site, index) => ({
      index,
      label: site.label,
      diverging: (states[index] ?? 0) === DIVERGING,
      x: site.x,
      z: site.z,
    }));
  }

  private poseVehicles(): void {
    const frame = this.sim.latestFrame();
    const layout = this.layout;
    const rails = this.rails;
    if (!frame || !layout || !rails) return;
    const data = frame.data;
    for (let t = 0; t < this.running.length; t++) {
      const train = this.running[t];
      if (!train) continue;
      const leadingIsFront = (data[layout.trainFacingStart + t] ?? 1) > 0;
      const count = train.bodies.consist.vehicles.length;
      for (let k = 0; k < count; k++) {
        const v = train.firstVehicle + k;
        const off = data[layout.bogiesOffTrackStart + v] ?? 0;
        const onRails = rails.railTopY - train.bodies.railTopY(k);
        const onGround = -train.bodies.railTopY(k);
        const leadingY = off >= 1 ? onGround : onRails;
        const trailingY = off >= 2 ? onGround : onRails;
        const side = v % 2 === 0 ? 1 : -1;
        const kink = off === 0 ? 0 : OFF_TRACK_YAW_RADIANS * side;
        const roll = off === 0 ? 0 : OFF_TRACK_ROLL_RADIANS * side;
        train.bodies.pose(
          k,
          data,
          layout.vehiclePoseStart + v * layout.vehiclePoseFloats,
          leadingIsFront ? leadingY : trailingY,
          leadingIsFront ? trailingY : leadingY,
          kink,
          roll,
        );
      }
    }
  }
}
