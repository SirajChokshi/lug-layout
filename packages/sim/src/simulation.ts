import { runningGearSpanProblem } from "@brr/domain";
import { Autopilot } from "./blocks/autopilot.ts";
import { BlockKeeper } from "./blocks/block-keeper.ts";
import { BlockMap, NO_BLOCK, type BlockTopology } from "./blocks/block-map.ts";
import {
  GEOMETRY_FIELDS,
  packGeometry,
  packSpecOnlyGeometry,
  RunningGearPoser,
  type PathSampler,
  type VehicleGeometry,
} from "./running-gear.ts";
import { trackPoint, type SimTrack } from "./sim-track.ts";

export const SIM_TICK_HZ = 60;
export const SIM_TICK_SECONDS = 1 / SIM_TICK_HZ;
export const NO_EDGE = -1;
export const POSE_FLOATS_PER_VEHICLE = 4;
const PATH_CAPACITY = 64;
const PATH_MARGIN_EDGES = 2;

export interface VehicleSpec {
  readonly lengthLdu: number;
  readonly frontBogieLdu: number;
  readonly rearBogieLdu: number;
  readonly geometry?: VehicleGeometry;
}

export interface TrainSpec {
  readonly vehicles: ReadonlyArray<VehicleSpec>;
  readonly maxSpeedLduPerS: number;
  readonly accelerationLduPerS2: number;
  readonly brakingLduPerS2: number;
}

export interface TrainPlacement {
  readonly edge: number;
  readonly offsetLdu: number;
}

export interface SimCapacity {
  readonly trains: number;
  readonly vehicles: number;
}

export interface SimRailway {
  readonly topology: BlockTopology;
  readonly autopilotSeed: number | null;
}

export type OpenEndRule = "brake" | "derail";

export const DIRECTION_FORWARD = 1;
export const DIRECTION_BACKWARD = -1;

const AUTOPILOT_DWELL_SECONDS = 3;
const AUTOPILOT_RETRY_SECONDS = 2;
const NOBODY = -1;
const NOT_SOLVED = -1;

export class Simulation {
  private tickCount = 0;
  private trainCount = 0;
  private vehicleCount = 0;
  readonly switchStates: Uint8Array;
  readonly trainEdge: Int32Array;
  readonly trainOffset: Float64Array;
  readonly trainSpeed: Float64Array;
  readonly trainThrottle: Float64Array;
  private readonly trainSolvedLength: Float64Array;
  private readonly trainSolvedTick: Int32Array;
  private readonly trainMaxSpeed: Float64Array;
  private readonly trainAcceleration: Float64Array;
  private readonly trainBraking: Float64Array;
  private readonly trainReversed: Uint8Array;
  private readonly trainTurnPending: Uint8Array;
  private readonly trainTurnSpeed: Float64Array;
  readonly trainDerailSpeed: Float64Array;
  private readonly trainCoupledLength: Float64Array;
  private readonly trainVehicleStart: Int32Array;
  private readonly trainVehicleCount: Int32Array;
  private readonly vehicleFrontBogie: Float64Array;
  private readonly vehicleRearBogie: Float64Array;
  private readonly vehicleGeometry: Float64Array;
  private readonly vehicleGeometryAt: Int32Array;
  private readonly poser = new RunningGearPoser();
  private samplingTrain = 0;
  private readonly pathSampler: PathSampler = {
    pointBehind: (distance, out, outIndex) =>
      this.pointBehind(this.samplingTrain, distance, out, outIndex),
  };
  private readonly pathEdges: Int32Array;
  private readonly pathTop: Int32Array;
  private readonly pathCount: Int32Array;
  private readonly maxTrainLength: number;
  private readonly hashScratch = new Float64Array(1);
  private readonly hashWords = new Uint32Array(this.hashScratch.buffer);

  readonly track: SimTrack;
  readonly capacity: SimCapacity;
  readonly blockMap: BlockMap | null;
  readonly blocks: BlockKeeper | null;
  private readonly autopilot: Autopilot | null;
  private readonly edgePlacement: Int32Array | null;
  private readonly placementTrain: Int32Array;
  private readonly placementTick: Int32Array;
  private readonly poseScratch: Float64Array;
  readonly separationCounters = Float64Array.of(0, Number.POSITIVE_INFINITY, 0);
  readonly openEnds: OpenEndRule;
  private readonly openEndsDerail: boolean;

  constructor(
    track: SimTrack,
    capacity: SimCapacity,
    railway: SimRailway | null = null,
    openEnds: OpenEndRule = "brake",
  ) {
    this.track = track;
    this.capacity = capacity;
    this.openEnds = openEnds;
    this.openEndsDerail = openEnds === "derail";
    if (railway) {
      const map = new BlockMap(railway.topology, track.edgeLength);
      const keeper = new BlockKeeper(map, capacity.trains);
      this.blockMap = map;
      this.blocks = keeper;
      this.autopilot =
        railway.autopilotSeed === null
          ? null
          : new Autopilot(
              map,
              keeper,
              railway.autopilotSeed,
              capacity.trains,
              AUTOPILOT_DWELL_SECONDS * SIM_TICK_HZ,
              AUTOPILOT_RETRY_SECONDS * SIM_TICK_HZ,
            );
      this.edgePlacement = railway.topology.edgePlacement;
    } else {
      this.blockMap = null;
      this.blocks = null;
      this.autopilot = null;
      this.edgePlacement = null;
    }
    const placements = railway?.topology.placementCount ?? 0;
    this.placementTrain = new Int32Array(placements);
    this.placementTick = new Int32Array(placements).fill(NOBODY);
    this.poseScratch = new Float64Array(capacity.vehicles * POSE_FLOATS_PER_VEHICLE);
    this.switchStates = new Uint8Array(track.switchCount);
    this.trainEdge = new Int32Array(capacity.trains);
    this.trainOffset = new Float64Array(capacity.trains);
    this.trainSpeed = new Float64Array(capacity.trains);
    this.trainThrottle = new Float64Array(capacity.trains);
    this.trainSolvedLength = new Float64Array(capacity.trains);
    this.trainSolvedTick = new Int32Array(capacity.trains).fill(NOT_SOLVED);
    this.trainMaxSpeed = new Float64Array(capacity.trains);
    this.trainAcceleration = new Float64Array(capacity.trains);
    this.trainBraking = new Float64Array(capacity.trains);
    this.trainReversed = new Uint8Array(capacity.trains);
    this.trainTurnPending = new Uint8Array(capacity.trains);
    this.trainTurnSpeed = new Float64Array(capacity.trains);
    this.trainDerailSpeed = new Float64Array(capacity.trains);
    this.trainCoupledLength = new Float64Array(capacity.trains);
    this.trainVehicleStart = new Int32Array(capacity.trains);
    this.trainVehicleCount = new Int32Array(capacity.trains);
    this.vehicleFrontBogie = new Float64Array(capacity.vehicles);
    this.vehicleRearBogie = new Float64Array(capacity.vehicles);
    this.vehicleGeometry = new Float64Array(capacity.vehicles * GEOMETRY_FIELDS);
    this.vehicleGeometryAt = new Int32Array(capacity.vehicles);
    this.pathEdges = new Int32Array(capacity.trains * PATH_CAPACITY);
    this.pathTop = new Int32Array(capacity.trains);
    this.pathCount = new Int32Array(capacity.trains);
    let shortest = Number.POSITIVE_INFINITY;
    for (let e = 0; e < track.edgeCount; e++) {
      shortest = Math.min(shortest, track.edgeLength[e] ?? 0);
    }
    this.maxTrainLength = shortest * (PATH_CAPACITY - PATH_MARGIN_EDGES);
  }

  get tick(): number {
    return this.tickCount;
  }

  get trains(): number {
    return this.trainCount;
  }

  get vehicles(): number {
    return this.vehicleCount;
  }

  addTrain(spec: TrainSpec, placement: TrainPlacement): number {
    const train = this.trainCount;
    if (train >= this.capacity.trains) throw new Error(`the simulation holds ${train} trains`);
    if (this.vehicleCount + spec.vehicles.length > this.capacity.vehicles) {
      throw new Error(`the simulation holds ${this.capacity.vehicles} vehicles`);
    }
    if (spec.vehicles.length === 0) throw new Error("a train needs at least one vehicle");
    if (
      !(spec.maxSpeedLduPerS > 0) ||
      !(spec.accelerationLduPerS2 > 0) ||
      !(spec.brakingLduPerS2 > 0)
    ) {
      throw new Error("a train needs a positive top speed, acceleration and braking");
    }
    const { edge, offsetLdu } = placement;
    const edgeLength = this.track.edgeLength[edge];
    if (edgeLength === undefined || offsetLdu < 0 || offsetLdu > edgeLength) {
      throw new Error(`train position (${edge}, ${offsetLdu}) is not on the track`);
    }
    let length = 0;
    const firstVehicle = this.vehicleCount;
    for (const vehicle of spec.vehicles) {
      const problem = runningGearSpanProblem(vehicle);
      if (problem) throw new Error(`a vehicle's running gear cannot run: ${problem}`);
      this.vehicleFrontBogie[this.vehicleCount] = length + vehicle.frontBogieLdu;
      this.vehicleRearBogie[this.vehicleCount] = length + vehicle.rearBogieLdu;
      const at = this.vehicleCount * GEOMETRY_FIELDS;
      this.vehicleGeometryAt[this.vehicleCount] = at;
      if (vehicle.geometry) {
        assertGeometryMatchesSpec(vehicle);
        packGeometry(vehicle.geometry, this.vehicleGeometry, at);
      } else {
        packSpecOnlyGeometry(
          vehicle.lengthLdu,
          vehicle.frontBogieLdu,
          vehicle.rearBogieLdu,
          this.vehicleGeometry,
          at,
        );
      }
      this.vehicleCount++;
      length += vehicle.lengthLdu;
    }
    if (length > this.maxTrainLength) {
      throw new Error(`a ${length} LDU train is longer than this track's path buffer allows`);
    }
    this.trainEdge[train] = edge;
    this.trainOffset[train] = offsetLdu;
    this.trainSpeed[train] = 0;
    this.trainThrottle[train] = 0;
    this.trainSolvedTick[train] = NOT_SOLVED;
    this.trainMaxSpeed[train] = spec.maxSpeedLduPerS;
    this.trainAcceleration[train] = spec.accelerationLduPerS2;
    this.trainBraking[train] = spec.brakingLduPerS2;
    this.trainReversed[train] = 0;
    this.trainTurnPending[train] = 0;
    this.trainTurnSpeed[train] = 0;
    this.trainDerailSpeed[train] = 0;
    this.trainCoupledLength[train] = length;
    this.trainVehicleStart[train] = firstVehicle;
    this.trainVehicleCount[train] = spec.vehicles.length;
    if (!this.fillPathBehind(train, edge, offsetLdu, length)) {
      this.vehicleCount = firstVehicle;
      throw new Error(`a ${length} LDU train does not fit behind (${edge}, ${offsetLdu})`);
    }
    this.blocks?.place(train, edge, offsetLdu, this.bodyLengthLdu(train), this.switchStates);
    this.trainCount++;
    return train;
  }

  setThrottle(train: number, speedLduPerS: number): void {
    this.assertTrain(train);
    this.blocks?.drive(train);
    this.trainTurnPending[train] = 0;
    this.applyThrottle(train, speedLduPerS);
  }

  drive(train: number, signedSpeedLduPerS: number): void {
    this.assertTrain(train);
    this.blocks?.drive(train);
    const wanted = signedSpeedLduPerS < 0 ? DIRECTION_BACKWARD : DIRECTION_FORWARD;
    const facing = this.trainReversed[train] === 1 ? DIRECTION_BACKWARD : DIRECTION_FORWARD;
    const speed = Math.abs(signedSpeedLduPerS);
    if (wanted === facing || speed === 0) {
      this.trainTurnPending[train] = 0;
      this.applyThrottle(train, speed);
      return;
    }
    this.trainTurnPending[train] = 1;
    this.trainTurnSpeed[train] = speed;
    this.trainThrottle[train] = 0;
  }

  direction(train: number): number {
    const facingBackward = this.trainReversed[train] === 1;
    const turning = this.trainTurnPending[train] === 1;
    return facingBackward !== turning ? DIRECTION_BACKWARD : DIRECTION_FORWARD;
  }

  derailed(train: number): boolean {
    return (this.trainDerailSpeed[train] ?? 0) > 0;
  }

  overrunLdu(train: number): number {
    const edge = this.trainEdge[train] ?? 0;
    return Math.max((this.trainOffset[train] ?? 0) - (this.track.edgeLength[edge] ?? 0), 0);
  }

  private leadingBogieLdu(train: number): number {
    const first = this.trainVehicleStart[train] ?? 0;
    if (this.trainReversed[train] !== 1) return this.vehicleFrontBogie[first] ?? 0;
    const last = first + (this.trainVehicleCount[train] ?? 1) - 1;
    return (this.trainCoupledLength[train] ?? 0) - (this.vehicleRearBogie[last] ?? 0);
  }

  private bogiesOffTrack(vehicle: number, train: number): number {
    const overrun = this.overrunLdu(train);
    if (overrun === 0) return 0;
    const reversed = this.trainReversed[train] === 1;
    const length = this.trainCoupledLength[train] ?? 0;
    const front = this.vehicleFrontBogie[vehicle] ?? 0;
    const rear = this.vehicleRearBogie[vehicle] ?? 0;
    const leading = reversed ? length - rear : front;
    const trailing = reversed ? length - front : rear;
    return (leading < overrun ? 1 : 0) + (trailing < overrun ? 1 : 0);
  }

  writeBogiesOffTrack(out: Float64Array, start: number): void {
    for (let t = 0; t < this.trainCount; t++) {
      const first = this.trainVehicleStart[t] ?? 0;
      const end = first + (this.trainVehicleCount[t] ?? 0);
      for (let v = first; v < end; v++) out[start + v] = this.bogiesOffTrack(v, t);
    }
  }

  rerail(train: number): boolean {
    this.assertTrain(train);
    if (!this.derailed(train)) return false;
    const edge = this.trainEdge[train] ?? 0;
    this.trainOffset[train] = Math.min(
      this.trainOffset[train] ?? 0,
      this.track.edgeLength[edge] ?? 0,
    );
    this.trainSpeed[train] = 0;
    this.trainThrottle[train] = 0;
    this.trainTurnPending[train] = 0;
    this.trainDerailSpeed[train] = 0;
    this.trainSolvedTick[train] = NOT_SOLVED;
    return true;
  }

  goTo(train: number, placement: number): boolean {
    this.assertTrain(train);
    const map = this.blockMap;
    const keeper = this.blocks;
    if (!map || !keeper) return false;
    const block = map.placementBlock[placement] ?? NO_BLOCK;
    if (block === NO_BLOCK || map.blockIsJunction[block] === 1) return false;
    keeper.goTo(train, block);
    this.trainTurnPending[train] = 0;
    this.driveAtTopSpeed(train);
    return true;
  }

  driveAtTopSpeed(train: number): void {
    this.applyThrottle(train, this.trainMaxSpeed[train] ?? 0);
  }

  bodyLengthLdu(train: number): number {
    if (this.trainSolvedTick[train] !== this.tickCount) this.poseTrain(train, null, 0, null, 0);
    return this.trainSolvedLength[train] ?? 0;
  }

  private applyThrottle(train: number, speedLduPerS: number): void {
    const max = this.trainMaxSpeed[train] ?? 0;
    this.trainThrottle[train] = Math.min(Math.max(speedLduPerS, 0), max);
  }

  setSwitch(switchIndex: number, state: number): boolean {
    if (switchIndex < 0 || switchIndex >= this.switchStates.length) {
      throw new Error(`switch ${switchIndex} is not on this track`);
    }
    if (this.blocks && !this.blocks.canThrow(switchIndex)) return false;
    this.switchStates[switchIndex] = state;
    return true;
  }

  reverse(train: number): boolean {
    this.assertTrain(train);
    if ((this.trainSpeed[train] ?? 0) !== 0 || this.derailed(train)) return false;
    const length = this.poseTrain(train, null, 0, null, 0);
    const base = train * PATH_CAPACITY;
    const count = this.pathCount[train] ?? 0;
    let slot = this.pathTop[train] ?? 0;
    let remaining = length - (this.trainOffset[train] ?? 0);
    let used = 1;
    while (remaining > 0 && used < count) {
      slot = (slot + PATH_CAPACITY - 1) % PATH_CAPACITY;
      remaining -= this.track.edgeLength[this.pathEdges[base + slot] ?? 0] ?? 0;
      used++;
    }
    if (remaining > 0) throw new Error(`train ${train} path buffer does not cover its length`);
    const tailEdge = this.pathEdges[base + slot] ?? 0;
    const tailOffset = -remaining;
    const reversedPath = new Int32Array(used);
    let read = this.pathTop[train] ?? 0;
    for (let i = 0; i < used; i++) {
      reversedPath[i] = this.track.reverseEdge[this.pathEdges[base + read] ?? 0] ?? 0;
      read = (read + PATH_CAPACITY - 1) % PATH_CAPACITY;
    }
    this.pathEdges.set(reversedPath, base);
    this.pathTop[train] = used - 1;
    this.pathCount[train] = used;
    this.trainEdge[train] = this.track.reverseEdge[tailEdge] ?? 0;
    this.trainOffset[train] = (this.track.edgeLength[tailEdge] ?? 0) - tailOffset;
    this.trainReversed[train] = this.trainReversed[train] === 1 ? 0 : 1;
    this.trainSolvedTick[train] = NOT_SOLVED;
    this.blocks?.reseat(
      train,
      this.trainEdge[train] ?? 0,
      this.trainOffset[train] ?? 0,
      this.bodyLengthLdu(train),
      this.switchStates,
    );
    return true;
  }

  step(): void {
    this.autopilot?.update(this);
    const blocks = this.blocks;
    if (blocks) {
      for (let t = 0; t < this.trainCount; t++) {
        if (blocks.routeState(t) === "reversing" && this.trainSpeed[t] === 0) this.reverse(t);
      }
    }
    for (let t = 0; t < this.trainCount; t++) {
      if (this.trainTurnPending[t] === 1) this.completeTurn(t);
      this.advanceTrain(t);
    }
    this.tickCount++;
    if (this.edgePlacement) this.measureSeparation(this.edgePlacement);
  }

  successor(edge: number): number {
    const start = this.track.successorStart[edge] ?? 0;
    const count = (this.track.successorStart[edge + 1] ?? start) - start;
    if (count === 0) return NO_EDGE;
    if (count === 1) return this.track.successors[start] ?? NO_EDGE;
    const switchIndex = this.track.switchOfEdge[edge] ?? 0;
    const choice = Math.min(this.switchStates[switchIndex] ?? 0, count - 1);
    return this.track.successors[start + choice] ?? NO_EDGE;
  }

  writeVehiclePoses(out: Float64Array): void {
    this.writePoses(out, 0, null, 0);
  }

  writeCoupledVehiclePoses(out: Float64Array, start: number): void {
    this.writePoses(null, 0, out, start);
  }

  writePoses(
    pivots: Float64Array | null,
    pivotStart: number,
    poses: Float64Array | null,
    poseStart: number,
  ): void {
    for (let t = 0; t < this.trainCount; t++) {
      this.poseTrain(t, pivots, pivotStart, poses, poseStart);
    }
  }

  private poseTrain(
    train: number,
    pivots: Float64Array | null,
    pivotStart: number,
    poses: Float64Array | null,
    poseStart: number,
  ): number {
    this.samplingTrain = train;
    const length = this.poser.writeTrain(
      this.pathSampler,
      this.vehicleGeometry,
      this.vehicleGeometryAt,
      this.trainVehicleStart[train] ?? 0,
      this.trainVehicleCount[train] ?? 0,
      this.trainReversed[train] === 1,
      pivots,
      pivotStart,
      poses,
      poseStart,
    );
    this.trainSolvedLength[train] = length;
    this.trainSolvedTick[train] = this.tickCount;
    return length;
  }

  stateHash(): number {
    let hash = 0x811c9dc5;
    hash = this.mixWord(hash, this.tickCount);
    for (let t = 0; t < this.trainCount; t++) {
      hash = this.mixWord(hash, this.trainEdge[t] ?? 0);
      hash = this.mixFloat(hash, this.trainOffset[t] ?? 0);
      hash = this.mixFloat(hash, this.trainSpeed[t] ?? 0);
      hash = this.mixFloat(hash, this.trainThrottle[t] ?? 0);
      hash = this.mixWord(hash, this.trainReversed[t] ?? 0);
      hash = this.mixWord(hash, this.trainTurnPending[t] ?? 0);
      hash = this.mixFloat(hash, this.trainTurnSpeed[t] ?? 0);
      hash = this.mixFloat(hash, this.trainDerailSpeed[t] ?? 0);
      const count = this.pathCount[t] ?? 0;
      let slot = this.pathTop[t] ?? 0;
      hash = this.mixWord(hash, count);
      for (let i = 0; i < count; i++) {
        hash = this.mixWord(hash, this.pathEdges[t * PATH_CAPACITY + slot] ?? 0);
        slot = (slot + PATH_CAPACITY - 1) % PATH_CAPACITY;
      }
    }
    for (let s = 0; s < this.switchStates.length; s++) {
      hash = this.mixWord(hash, this.switchStates[s] ?? 0);
    }
    return hash >>> 0;
  }

  private mixWord(hash: number, word: number): number {
    return Math.imul(hash ^ (word >>> 0), 0x01000193) >>> 0;
  }

  private mixFloat(hash: number, value: number): number {
    this.hashScratch[0] = value;
    return this.mixWord(this.mixWord(hash, this.hashWords[0] ?? 0), this.hashWords[1] ?? 0);
  }

  private assertTrain(train: number): void {
    if (!Number.isInteger(train) || train < 0 || train >= this.trainCount) {
      throw new Error(`train ${train} is not in the simulation`);
    }
  }

  private fillPathBehind(train: number, edge: number, offset: number, length: number): boolean {
    const behind = new Int32Array(PATH_CAPACITY);
    let used = 0;
    let current = this.track.reverseEdge[edge] ?? 0;
    let remaining = length - offset;
    behind[used++] = current;
    while (remaining > 0) {
      const next = this.successor(current);
      if (next === NO_EDGE || used >= PATH_CAPACITY) return false;
      current = next;
      behind[used++] = current;
      remaining -= this.track.edgeLength[current] ?? 0;
    }
    const base = train * PATH_CAPACITY;
    for (let i = 0; i < used; i++) {
      this.pathEdges[base + i] = this.track.reverseEdge[behind[used - 1 - i] ?? 0] ?? 0;
    }
    this.pathTop[train] = used - 1;
    this.pathCount[train] = used;
    return true;
  }

  private pushPath(train: number, edge: number): void {
    const top = ((this.pathTop[train] ?? 0) + 1) % PATH_CAPACITY;
    this.pathEdges[train * PATH_CAPACITY + top] = edge;
    this.pathTop[train] = top;
    this.pathCount[train] = Math.min((this.pathCount[train] ?? 0) + 1, PATH_CAPACITY);
  }

  private clearDistanceAhead(train: number, limit: number): number {
    let edge = this.trainEdge[train] ?? 0;
    let clear = (this.track.edgeLength[edge] ?? 0) - (this.trainOffset[train] ?? 0);
    while (clear < limit) {
      const next = this.successor(edge);
      if (next === NO_EDGE) return clear;
      edge = next;
      clear += this.track.edgeLength[edge] ?? 0;
    }
    return clear;
  }

  private completeTurn(train: number): void {
    if ((this.trainSpeed[train] ?? 0) !== 0) return;
    if (!this.reverse(train)) return;
    this.trainTurnPending[train] = 0;
    this.applyThrottle(train, this.trainTurnSpeed[train] ?? 0);
  }

  private skid(train: number): void {
    const speed = Math.max(
      (this.trainSpeed[train] ?? 0) - (this.trainBraking[train] ?? 0) * SIM_TICK_SECONDS,
      0,
    );
    this.trainSpeed[train] = speed;
    this.trainOffset[train] = (this.trainOffset[train] ?? 0) + speed * SIM_TICK_SECONDS;
  }

  private clearAhead(train: number, speed: number, braking: number): number {
    const derails = this.openEndsDerail;
    const blocks = this.blocks;
    if (!blocks) {
      if (derails) return Number.POSITIVE_INFINITY;
      return this.clearDistanceAhead(
        train,
        (speed * speed) / (2 * braking) + speed * SIM_TICK_SECONDS,
      );
    }
    const held = blocks.clearDistanceAhead(
      train,
      this.trainEdge[train] ?? 0,
      this.trainOffset[train] ?? 0,
      speed,
      braking,
      this.bodyLengthLdu(train),
      this.switchStates,
    );
    if (derails && blocks.heldEndIsOpen(train, this.switchStates)) {
      return Number.POSITIVE_INFINITY;
    }
    return held;
  }

  private advanceTrain(train: number): void {
    if ((this.trainDerailSpeed[train] ?? 0) > 0) {
      this.skid(train);
      return;
    }
    const braking = this.trainBraking[train] ?? 0;
    const acceleration = this.trainAcceleration[train] ?? 0;
    let speed = this.trainSpeed[train] ?? 0;
    const clear = this.clearAhead(train, speed, braking);
    const stopCap = Math.sqrt(2 * braking * clear);
    const target = Math.min(this.trainThrottle[train] ?? 0, stopCap);
    if (speed < target) speed = Math.min(target, speed + acceleration * SIM_TICK_SECONDS);
    else speed = Math.max(target, speed - braking * SIM_TICK_SECONDS);
    let edge = this.trainEdge[train] ?? 0;
    const travel = speed * SIM_TICK_SECONDS;
    let offset = (this.trainOffset[train] ?? 0) + (this.blocks && travel > clear ? clear : travel);
    let length = this.track.edgeLength[edge] ?? 0;
    while (offset > length) {
      const next = this.blocks
        ? this.blocks.heldSuccessor(train, edge, this.switchStates)
        : this.successor(edge);
      if (next === NO_EDGE) {
        if (this.openEndsDerail && this.successor(edge) === NO_EDGE) {
          if (offset - length >= this.leadingBogieLdu(train)) {
            this.trainDerailSpeed[train] = speed;
            this.trainThrottle[train] = 0;
            this.trainTurnPending[train] = 0;
          }
          break;
        }
        offset = length;
        speed = 0;
        break;
      }
      offset -= length;
      edge = next;
      length = this.track.edgeLength[edge] ?? 0;
      this.pushPath(train, edge);
    }
    this.trainEdge[train] = edge;
    this.trainOffset[train] = offset;
    this.trainSpeed[train] = speed;
  }

  private pointBehind(train: number, distance: number, out: Float64Array, outIndex: number): void {
    const base = train * PATH_CAPACITY;
    const count = this.pathCount[train] ?? 0;
    let slot = this.pathTop[train] ?? 0;
    let edge = this.pathEdges[base + slot] ?? 0;
    let offset = (this.trainOffset[train] ?? 0) - distance;
    let used = 1;
    while (offset < 0 && used < count) {
      slot = (slot + PATH_CAPACITY - 1) % PATH_CAPACITY;
      edge = this.pathEdges[base + slot] ?? 0;
      offset += this.track.edgeLength[edge] ?? 0;
      used++;
    }
    trackPoint(this.track, edge, Math.max(offset, 0), out, outIndex);
  }

  private measureSeparation(edgePlacement: Int32Array): void {
    const tick = this.tickCount;
    this.writeVehiclePoses(this.poseScratch);
    let shared = false;
    for (let t = 0; t < this.trainCount; t++) {
      const base = t * PATH_CAPACITY;
      const count = this.pathCount[t] ?? 0;
      const length = this.bodyLengthLdu(t);
      let slot = this.pathTop[t] ?? 0;
      let covered = this.trainOffset[t] ?? 0;
      let used = 1;
      shared =
        this.markPiece(edgePlacement[this.pathEdges[base + slot] ?? 0] ?? 0, t, tick) || shared;
      while (covered < length && used < count) {
        slot = (slot + PATH_CAPACITY - 1) % PATH_CAPACITY;
        const edge = this.pathEdges[base + slot] ?? 0;
        shared = this.markPiece(edgePlacement[edge] ?? 0, t, tick) || shared;
        covered += this.track.edgeLength[edge] ?? 0;
        used++;
      }
    }
    const counters = this.separationCounters;
    if (shared) counters[0] = (counters[0] ?? 0) + 1;
    let nearest = counters[1] ?? Number.POSITIVE_INFINITY;
    const poses = this.poseScratch;
    for (let t = 0; t < this.trainCount; t++) {
      const firstA = this.trainVehicleStart[t] ?? 0;
      const endA = firstA + (this.trainVehicleCount[t] ?? 0);
      for (let u = t + 1; u < this.trainCount; u++) {
        const firstB = this.trainVehicleStart[u] ?? 0;
        const endB = firstB + (this.trainVehicleCount[u] ?? 0);
        for (let a = firstA * 2; a < endA * 2; a++) {
          const ax = poses[a * 2] ?? 0;
          const az = poses[a * 2 + 1] ?? 0;
          for (let b = firstB * 2; b < endB * 2; b++) {
            const d = Math.hypot((poses[b * 2] ?? 0) - ax, (poses[b * 2 + 1] ?? 0) - az);
            if (d < nearest) nearest = d;
          }
        }
      }
    }
    counters[1] = nearest;
    counters[2] = (counters[2] ?? 0) + 1;
  }

  private markPiece(placement: number, train: number, tick: number): boolean {
    if (this.placementTick[placement] === tick && this.placementTrain[placement] !== train) {
      return true;
    }
    this.placementTick[placement] = tick;
    this.placementTrain[placement] = train;
    return false;
  }
}

const GEOMETRY_TOLERANCE_LDU = 1e-6;

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= GEOMETRY_TOLERANCE_LDU;
}

function assertGeometryMatchesSpec(vehicle: VehicleSpec): void {
  const geometry = vehicle.geometry;
  if (!geometry) return;
  const front = geometry.frontCoupler.xLdu;
  if (
    !close(front - geometry.rearCoupler.xLdu, vehicle.lengthLdu) ||
    !close(front - geometry.front.pivotXLdu, vehicle.frontBogieLdu) ||
    !close(front - geometry.rear.pivotXLdu, vehicle.rearBogieLdu)
  ) {
    throw new Error("a vehicle's geometry disagrees with its length and bogie distances");
  }
}
