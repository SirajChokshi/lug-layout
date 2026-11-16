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

export class Simulation {
  private tickCount = 0;
  private trainCount = 0;
  private vehicleCount = 0;
  readonly switchStates: Uint8Array;
  readonly trainEdge: Int32Array;
  readonly trainOffset: Float64Array;
  readonly trainSpeed: Float64Array;
  readonly trainThrottle: Float64Array;
  private readonly trainLength: Float64Array;
  private readonly trainMaxSpeed: Float64Array;
  private readonly trainAcceleration: Float64Array;
  private readonly trainBraking: Float64Array;
  private readonly trainReversed: Uint8Array;
  private readonly trainVehicleStart: Int32Array;
  private readonly trainVehicleCount: Int32Array;
  private readonly vehicleFrontBogie: Float64Array;
  private readonly vehicleRearBogie: Float64Array;
  private readonly pathEdges: Int32Array;
  private readonly pathTop: Int32Array;
  private readonly pathCount: Int32Array;
  private readonly maxTrainLength: number;
  private readonly hashScratch = new Float64Array(1);
  private readonly hashWords = new Uint32Array(this.hashScratch.buffer);

  readonly track: SimTrack;
  readonly capacity: SimCapacity;

  constructor(track: SimTrack, capacity: SimCapacity) {
    this.track = track;
    this.capacity = capacity;
    this.switchStates = new Uint8Array(track.switchCount);
    this.trainEdge = new Int32Array(capacity.trains);
    this.trainOffset = new Float64Array(capacity.trains);
    this.trainSpeed = new Float64Array(capacity.trains);
    this.trainThrottle = new Float64Array(capacity.trains);
    this.trainLength = new Float64Array(capacity.trains);
    this.trainMaxSpeed = new Float64Array(capacity.trains);
    this.trainAcceleration = new Float64Array(capacity.trains);
    this.trainBraking = new Float64Array(capacity.trains);
    this.trainReversed = new Uint8Array(capacity.trains);
    this.trainVehicleStart = new Int32Array(capacity.trains);
    this.trainVehicleCount = new Int32Array(capacity.trains);
    this.vehicleFrontBogie = new Float64Array(capacity.vehicles);
    this.vehicleRearBogie = new Float64Array(capacity.vehicles);
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
      if (
        !(vehicle.lengthLdu > 0) ||
        vehicle.frontBogieLdu < 0 ||
        vehicle.rearBogieLdu > vehicle.lengthLdu ||
        vehicle.frontBogieLdu > vehicle.rearBogieLdu
      ) {
        throw new Error("a vehicle's bogies must lie front to rear within its length");
      }
      this.vehicleFrontBogie[this.vehicleCount] = length + vehicle.frontBogieLdu;
      this.vehicleRearBogie[this.vehicleCount] = length + vehicle.rearBogieLdu;
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
    this.trainLength[train] = length;
    this.trainMaxSpeed[train] = spec.maxSpeedLduPerS;
    this.trainAcceleration[train] = spec.accelerationLduPerS2;
    this.trainBraking[train] = spec.brakingLduPerS2;
    this.trainReversed[train] = 0;
    this.trainVehicleStart[train] = firstVehicle;
    this.trainVehicleCount[train] = spec.vehicles.length;
    if (!this.fillPathBehind(train, edge, offsetLdu, length)) {
      this.vehicleCount = firstVehicle;
      throw new Error(`a ${length} LDU train does not fit behind (${edge}, ${offsetLdu})`);
    }
    this.trainCount++;
    return train;
  }

  setThrottle(train: number, speedLduPerS: number): void {
    this.assertTrain(train);
    const max = this.trainMaxSpeed[train] ?? 0;
    this.trainThrottle[train] = Math.min(Math.max(speedLduPerS, 0), max);
  }

  setSwitch(switchIndex: number, state: number): void {
    if (switchIndex < 0 || switchIndex >= this.switchStates.length) {
      throw new Error(`switch ${switchIndex} is not on this track`);
    }
    this.switchStates[switchIndex] = state;
  }

  reverse(train: number): boolean {
    this.assertTrain(train);
    if ((this.trainSpeed[train] ?? 0) !== 0) return false;
    const length = this.trainLength[train] ?? 0;
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
    return true;
  }

  step(): void {
    for (let t = 0; t < this.trainCount; t++) this.advanceTrain(t);
    this.tickCount++;
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
    for (let t = 0; t < this.trainCount; t++) {
      const first = this.trainVehicleStart[t] ?? 0;
      const count = this.trainVehicleCount[t] ?? 0;
      const reversed = this.trainReversed[t] === 1;
      const length = this.trainLength[t] ?? 0;
      for (let v = first; v < first + count; v++) {
        const front = this.vehicleFrontBogie[v] ?? 0;
        const rear = this.vehicleRearBogie[v] ?? 0;
        const o = v * POSE_FLOATS_PER_VEHICLE;
        this.pointBehind(t, reversed ? length - front : front, out, o);
        this.pointBehind(t, reversed ? length - rear : rear, out, o + 2);
      }
    }
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

  private advanceTrain(train: number): void {
    const braking = this.trainBraking[train] ?? 0;
    const acceleration = this.trainAcceleration[train] ?? 0;
    let speed = this.trainSpeed[train] ?? 0;
    const stoppingDistance = (speed * speed) / (2 * braking) + speed * SIM_TICK_SECONDS;
    const clear = this.clearDistanceAhead(train, stoppingDistance);
    const stopCap = Math.sqrt(2 * braking * clear);
    const target = Math.min(this.trainThrottle[train] ?? 0, stopCap);
    if (speed < target) speed = Math.min(target, speed + acceleration * SIM_TICK_SECONDS);
    else speed = Math.max(target, speed - braking * SIM_TICK_SECONDS);
    let edge = this.trainEdge[train] ?? 0;
    let offset = (this.trainOffset[train] ?? 0) + speed * SIM_TICK_SECONDS;
    let length = this.track.edgeLength[edge] ?? 0;
    while (offset > length) {
      const next = this.successor(edge);
      if (next === NO_EDGE) {
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
}
