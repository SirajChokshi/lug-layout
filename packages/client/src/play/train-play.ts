import { TrackGraph } from "@brr/domain";
import { STUD_LDU } from "@brr/math";
import { RAY_FLOATS, SCENE_BACKEND, type ChunkInstances, type ISceneBackend } from "@brr/render";
import type { SimFrameLayout, TrainSpec } from "@brr/sim";
import { inject, injectable } from "inversify";
import type { IRunningGear } from "../running-gear/running-gear-editor.ts";
import { consistVehicles, type ConsistVehicle, type RigidBodyInstances } from "../sim/consist.ts";
import type { ISimClient } from "../sim/sim-client.ts";
import { routeSegments, simTopology } from "../sim/sim-track-input.ts";
import { withStuds } from "../scene/stud-stream.ts";
import { RUNNING_GEAR, SIM_CLIENT } from "../tokens.ts";
import { NO_TRACK_LAID, NO_TRAIN_PLACED, type PlayModel, type PlaySetup } from "./play-models.ts";
import { edgeLengths, trainStart } from "./train-start.ts";

export type PlayStatus = "idle" | "loading" | "running" | "error";
export type FollowCamera = (x: number, z: number) => void;

export interface PlaySwitchView {
  readonly index: number;
  readonly label: string;
  readonly diverging: boolean;
  readonly x: number;
  readonly z: number;
}

export interface PlaySnapshot {
  readonly status: PlayStatus;
  readonly error: string | null;
  readonly notice: string | null;
  readonly trainModel: string | null;
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
  chooseTrain(model: string): void;
  start(setup: PlaySetup): Promise<void>;
  stop(): void;
  drive(signedSpeedLduPerS: number): void;
  throwSwitch(index: number): void;
  rerail(): void;
  follow(camera: FollowCamera | null): void;
  click(ndcX: number, ndcY: number): boolean;
}

const MAX_SPEED_LDU_PER_S = 400;
const ACCELERATION_LDU_PER_S2 = 150;
const BRAKING_LDU_PER_S2 = 300;
const SWITCH_PICK_RADIUS_LDU = 4 * STUD_LDU;
const STATUS_INTERVAL_MS = 100;
const DIVERGING = 1;
const STRAIGHT = 0;
const OFF_TRACK_YAW_RADIANS = 0.12;
const OFF_TRACK_ROLL_RADIANS = 0.22;
const NO_BODY = -1;
const DIVERGING_PIECE = /-f2$/u;

interface PlacedVehicle {
  readonly vehicle: ConsistVehicle;
  readonly body: number;
  readonly frontBogie: number;
  readonly rearBogie: number;
}

interface SwitchSite {
  readonly label: string;
  readonly x: number;
  readonly z: number;
  readonly startsDiverging: boolean;
}

const IDLE: PlaySnapshot = {
  status: "idle",
  error: null,
  notice: null,
  trainModel: null,
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
  private placed: PlacedVehicle[] = [];
  private layout: SimFrameLayout | null = null;
  private sites: SwitchSite[] = [];
  private railTopY = 0;
  private running = false;
  private lastStatusMs = 0;
  private camera: FollowCamera | null = null;
  private readonly ray = new Float64Array(RAY_FLOATS);

  constructor(
    @inject(SCENE_BACKEND) private readonly backend: ISceneBackend,
    @inject(SIM_CLIENT) private readonly sim: ISimClient,
    @inject(RUNNING_GEAR) private readonly runningGear: IRunningGear,
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

  chooseTrain(model: string): void {
    if (this.state.status === "running" || this.state.status === "loading") return;
    this.update({ trainModel: model });
  }

  async start(setup: PlaySetup): Promise<void> {
    if (this.state.status === "loading" || this.state.status === "running") return;
    this.update({ status: "loading", error: null, notice: null });
    try {
      await this.load(setup);
      this.running = true;
      this.sim.run(true);
      this.update({ status: "running", targetLduPerS: 0 });
      this.followTrain();
      requestAnimationFrame(this.step);
    } catch (error) {
      this.clearVehicles();
      this.update({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async load(setup: PlaySetup): Promise<void> {
    const model =
      setup.models.find((candidate) => candidate.name === this.state.trainModel) ?? setup.models[0];
    if (!model) throw new Error(NO_TRAIN_PLACED);
    const { layout, pieces } = setup.track;
    if (layout.count === 0) throw new Error(NO_TRACK_LAID);
    const graph = new TrackGraph(layout);
    await this.runningGear.setModels([model.gear]);
    const consist = consistVehicles(
      model.model,
      model.name,
      false,
      setup.track.railPart,
      this.runningGear.effectiveVehicles(model.name),
    );
    const spec: TrainSpec = {
      vehicles: consist.map((vehicle) => vehicle.spec),
      maxSpeedLduPerS: MAX_SPEED_LDU_PER_S,
      accelerationLduPerS2: ACCELERATION_LDU_PER_S2,
      brakingLduPerS2: BRAKING_LDU_PER_S2,
    };
    const trainLengthLdu = spec.vehicles.reduce((sum, vehicle) => sum + vehicle.lengthLdu, 0);
    this.sites = switchSites(graph, setup);
    const initialStates = Uint8Array.from(this.sites, (site) =>
      site.startsDiverging ? DIVERGING : STRAIGHT,
    );
    const lengths = edgeLengths(graph, layout, pieces);
    const start = trainStart(graph, lengths, initialStates, trainLengthLdu);
    if (!start) {
      throw new Error(
        `The ${Math.round(trainLengthLdu / STUD_LDU)}-stud train does not fit on any run of this track. Lay a longer run or pick a shorter train.`,
      );
    }
    const loaded = await this.sim.load({
      graph: simTopology(graph),
      routeSegments: routeSegments(graph, layout, pieces),
      capacity: { trains: 1, vehicles: consist.length },
      trains: [{ spec, placement: { edge: start.edge, offsetLdu: start.offsetLdu } }],
      autopilotSeed: null,
      openEnds: "derail",
    });
    for (let s = 0; s < initialStates.length; s++) {
      if (initialStates[s] === DIVERGING) {
        await this.sim.command({ kind: "switch", switchIndex: s, state: DIVERGING });
      }
    }
    this.layout = loaded.layout;
    this.railTopY = setup.track.railTopY;
    this.clearVehicles();
    let nextBody = 0;
    const show = (rigid: RigidBodyInstances | null): number => {
      if (!rigid) return NO_BODY;
      const id = nextBody++;
      this.backend.setVehicle(id, rigidChunk(rigid, model, setup));
      return id;
    };
    this.placed = consist.map((vehicle) => ({
      vehicle,
      body: show(vehicle.body),
      frontBogie: show(vehicle.frontBogie),
      rearBogie: show(vehicle.rearBogie),
    }));
    this.update({
      vehicles: consist.length,
      trainLengthLdu,
      switches: this.switchViews(initialStates),
    });
    this.poseVehicles();
  }

  stop(): void {
    this.running = false;
    this.sim.run(false);
    this.clearVehicles();
    this.layout = null;
    this.sites = [];
    this.update({
      ...IDLE,
      trainModel: this.state.trainModel,
      following: this.state.following,
    });
  }

  private clearVehicles(): void {
    for (const placed of this.placed) {
      for (const body of [placed.body, placed.frontBogie, placed.rearBogie]) {
        if (body !== NO_BODY) this.backend.deleteVehicle(body);
      }
    }
    this.placed = [];
  }

  drive(signedSpeedLduPerS: number): void {
    if (this.state.status !== "running" || this.state.derailSpeedLduPerS > 0) return;
    const max = this.state.maxSpeedLduPerS;
    const target = Math.min(Math.max(signedSpeedLduPerS, -max), max);
    this.update({ targetLduPerS: target, notice: null });
    void this.sim.command({ kind: "drive", train: 0, signedSpeedLduPerS: target });
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
          : `${current.label} is locked: the train is on it or has it reserved ahead.`,
      });
    });
  }

  rerail(): void {
    if (this.state.status !== "running") return;
    this.update({ targetLduPerS: 0, notice: null });
    void this.sim.command({ kind: "rerail", train: 0 });
  }

  follow(camera: FollowCamera | null): void {
    this.camera = camera;
    this.update({ following: camera !== null });
    this.followTrain();
  }

  private followTrain(): void {
    const camera = this.camera;
    const centre = this.trainCentre();
    if (camera && centre) camera(centre.x, centre.z);
  }

  private trainCentre(): { readonly x: number; readonly z: number } | null {
    const frame = this.sim.latestFrame();
    const layout = this.layout;
    if (!frame || !layout || layout.vehicles === 0) return null;
    const first = layout.vehiclePoseStart;
    const last = first + (layout.vehicles - 1) * layout.vehiclePoseFloats;
    const data = frame.data;
    return {
      x: ((data[first] ?? 0) + (data[last] ?? 0)) / 2,
      z: ((data[first + 1] ?? 0) + (data[last + 1] ?? 0)) / 2,
    };
  }

  click(ndcX: number, ndcY: number): boolean {
    if (this.state.status !== "running") return false;
    this.backend.rayThrough(ndcX, ndcY, this.ray);
    const directionY = this.ray[4] ?? 0;
    if (directionY >= 0) return false;
    const t = (this.railTopY - (this.ray[1] ?? 0)) / directionY;
    const x = (this.ray[0] ?? 0) + (this.ray[3] ?? 0) * t;
    const z = (this.ray[2] ?? 0) + (this.ray[5] ?? 0) * t;
    let best = -1;
    let bestDistance = SWITCH_PICK_RADIUS_LDU;
    for (let s = 0; s < this.sites.length; s++) {
      const site = this.sites[s];
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
    if (!this.running) return;
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
    let off = 0;
    for (let v = 0; v < layout.vehicles; v++) off += data[layout.bogiesOffTrackStart + v] ?? 0;
    const states = data.subarray(layout.switchStart, layout.switchStart + layout.switches);
    const switches = this.state.switches.some(
      (view, s) => view.diverging !== ((states[s] ?? 0) === DIVERGING),
    )
      ? this.switchViews(states)
      : this.state.switches;
    const centre = this.trainCentre();
    this.update({
      trainXLdu: centre?.x ?? 0,
      trainZLdu: centre?.z ?? 0,
      speedLduPerS: data[layout.trainSpeedStart] ?? 0,
      direction: data[layout.trainDirectionStart] ?? 1,
      derailSpeedLduPerS: data[layout.trainDerailSpeedStart] ?? 0,
      bogiesOffTrack: off,
      switches,
      tick: frame.tick,
    });
  }

  private switchViews(states: ArrayLike<number>): PlaySwitchView[] {
    return this.sites.map((site, index) => ({
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
    if (!frame || !layout) return;
    const data = frame.data;
    for (let v = 0; v < this.placed.length; v++) {
      const placed = this.placed[v];
      if (!placed) continue;
      const o = layout.vehiclePoseStart + v * layout.vehiclePoseFloats;
      const off = data[layout.bogiesOffTrackStart + v] ?? 0;
      const onRails = this.railTopY - placed.vehicle.railTopY;
      const onGround = -placed.vehicle.railTopY;
      const leadingY = off >= 1 ? onGround : onRails;
      const trailingY = off >= 2 ? onGround : onRails;
      const side = v % 2 === 0 ? 1 : -1;
      const kink = off === 0 ? 0 : OFF_TRACK_YAW_RADIANS * side;
      const roll = off === 0 ? 0 : OFF_TRACK_ROLL_RADIANS * side;
      const leadingIsFront = (data[layout.trainFacingStart] ?? 1) > 0;
      const frontY = leadingIsFront ? leadingY : trailingY;
      const rearY = leadingIsFront ? trailingY : leadingY;
      const spacing = Math.hypot(
        (data[o + 3] ?? 0) - (data[o + 6] ?? 0),
        (data[o + 4] ?? 0) - (data[o + 7] ?? 0),
      );
      this.backend.setVehiclePose(
        placed.body,
        data[o] ?? 0,
        (frontY + rearY) / 2,
        data[o + 1] ?? 0,
        (data[o + 2] ?? 0) + kink,
        spacing === 0 ? 0 : Math.atan2(frontY - rearY, spacing),
        roll,
      );
      this.poseBogie(placed.frontBogie, data, o + 3, frontY, kink, roll);
      this.poseBogie(placed.rearBogie, data, o + 6, rearY, kink, roll);
    }
  }

  private poseBogie(
    body: number,
    data: Float64Array,
    o: number,
    y: number,
    kink: number,
    roll: number,
  ): void {
    if (body === NO_BODY) return;
    this.backend.setVehiclePose(
      body,
      data[o] ?? 0,
      y,
      data[o + 1] ?? 0,
      (data[o + 2] ?? 0) + kink,
      0,
      roll,
    );
  }
}

function switchSites(graph: TrackGraph, setup: PlaySetup): SwitchSite[] {
  const { layout, pieces } = setup.track;
  const sites: SwitchSite[] = [];
  for (let s = 0; s < graph.switchCount; s++) {
    const placement = graph.endPlacement[graph.switchEnd[s] ?? 0] ?? 0;
    const piece = pieces[layout.piece(placement)];
    let x = 0;
    let z = 0;
    let ends = 0;
    for (let end = 0; end < graph.endCount; end++) {
      if (graph.endPlacement[end] !== placement) continue;
      x += graph.endXLdu[end] ?? 0;
      z += graph.endZLdu[end] ?? 0;
      ends++;
    }
    sites.push({
      label: `Switch ${s + 1} (${piece?.title ?? "switch"})`,
      x: ends === 0 ? 0 : x / ends,
      z: ends === 0 ? 0 : z / ends,
      startsDiverging: DIVERGING_PIECE.test(piece?.id ?? ""),
    });
  }
  return sites;
}

function rigidChunk(rigid: RigidBodyInstances, model: PlayModel, setup: PlaySetup): ChunkInstances {
  const count = rigid.instances.length;
  const partIndex = new Uint16Array(count);
  const colorIndex = new Uint16Array(count);
  for (let k = 0; k < count; k++) {
    const i = rigid.instances[k] ?? 0;
    partIndex[k] = model.model.partIndex[i] ?? 0;
    colorIndex[k] = model.colorIndex[i] ?? 0;
  }
  return withStuds(
    { originX: 0, originZ: 0, count, partIndex, colorIndex, matrices: rigid.matrices },
    setup.parts,
    setup.colors,
  );
}
