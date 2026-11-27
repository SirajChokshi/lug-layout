import type { PartAsset } from "@brr/catalog";
import {
  SOLID_MATRIX_FLOATS,
  VEHICLE_POSE_FLOATS,
  composeAffine,
  rigidLift,
  rigidPitch,
  writeRigidFrame,
} from "@brr/domain";
import { INSTANCE_MATRIX_FLOATS, type ChunkInstances, type ISceneBackend } from "@brr/render";
import type { PlayModel } from "../play/play-models.ts";
import { studTotal, withStuds, writeStuds } from "../scene/stud-stream.ts";
import type { ColorTable } from "../scene/viewer-scene.ts";
import type { ConsistVehicle, RigidBodyInstances, StandingRemainder } from "../sim/consist.ts";
import type { IVehicleIds } from "./vehicle-ids.ts";

const NO_BODY = -1;
const BODIES_PER_VEHICLE = 3;
const BODY = 0;
const FRONT_BOGIE = 1;
const REAR_BOGIE = 2;
const POSE_BODY = 0;
const POSE_FRONT_BOGIE = 3;
const POSE_REAR_BOGIE = 6;
const RIGID_POSE_FLOATS = 3;

export interface StandingConsist {
  readonly vehicles: ReadonlyArray<ConsistVehicle>;
  readonly vehicleModels: ReadonlyArray<PlayModel>;
  readonly parts: ReadonlyArray<PartAsset>;
  readonly colors: ColorTable;
}

export function rigidBodies(vehicle: ConsistVehicle): ReadonlyArray<RigidBodyInstances | null> {
  return [vehicle.body, vehicle.frontBogie, vehicle.rearBogie];
}

function vehicleModel(consist: StandingConsist, v: number): PlayModel {
  const model = consist.vehicleModels[v];
  if (!model) throw new Error(`a standing consist has no model for vehicle ${v}`);
  return model;
}

function rigidChunk(
  rigid: RigidBodyInstances,
  consist: StandingConsist,
  model: PlayModel,
): ChunkInstances {
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
    consist.parts,
    consist.colors,
  );
}

export function bodyPoseAt(v: number, body: number): number {
  const o = v * VEHICLE_POSE_FLOATS;
  if (body === FRONT_BOGIE) return o + POSE_FRONT_BOGIE;
  if (body === REAR_BOGIE) return o + POSE_REAR_BOGIE;
  return o + POSE_BODY;
}

interface PosedBody {
  readonly rigid: RigidBodyInstances;
  readonly model: PlayModel;
  readonly at: number;
  readonly y: number;
  readonly onRails: { readonly vehicleAt: number; readonly body: number } | null;
}

function writeFlatFrame(poses: Float64Array, at: number, y: number, out: Float64Array): void {
  const c = Math.cos(poses[at + 2] ?? 0);
  const s = Math.sin(poses[at + 2] ?? 0);
  out.set([c, 0, -s, poses[at] ?? 0, 0, 1, 0, y, s, 0, c, poses[at + 1] ?? 0]);
}

export class GhostBuffers {
  partIndex = new Uint16Array(0);
  colorIndex = new Uint16Array(0);
  matrices = new Float32Array(0);
  studPrimitives = new Uint8Array(0);
  studColors = new Uint16Array(0);
  studMatrices = new Float32Array(0);
  readonly frame = new Float64Array(SOLID_MATRIX_FLOATS);
  readonly lifts = new Float64Array(1);
  readonly posedPart = new Float64Array(SOLID_MATRIX_FLOATS);

  fit(count: number): void {
    if (this.partIndex.length === count) return;
    this.partIndex = new Uint16Array(count);
    this.colorIndex = new Uint16Array(count);
    this.matrices = new Float32Array(count * INSTANCE_MATRIX_FLOATS);
  }

  fitStuds(count: number): void {
    if (this.studPrimitives.length === count) return;
    this.studPrimitives = new Uint8Array(count);
    this.studColors = new Uint16Array(count);
    this.studMatrices = new Float32Array(count * INSTANCE_MATRIX_FLOATS);
  }
}

export function standingGhost(
  consist: StandingConsist,
  poses: Float64Array,
  railTopY: number,
  remainders: ReadonlyArray<StandingRemainder>,
  groundY: number,
  buffers: GhostBuffers,
): { readonly instances: ChunkInstances; readonly x: number; readonly z: number } {
  const originX = poses[POSE_BODY] ?? 0;
  const originZ = poses[POSE_BODY + 1] ?? 0;
  const posed: PosedBody[] = [];
  consist.vehicles.forEach((vehicle, v) => {
    const y = railTopY - vehicle.railTopY;
    const model = vehicleModel(consist, v);
    rigidBodies(vehicle).forEach((rigid, body) => {
      if (!rigid) return;
      const onRails = { vehicleAt: v * VEHICLE_POSE_FLOATS, body };
      posed.push({ rigid, model, at: bodyPoseAt(v, body), y, onRails });
    });
  });
  for (const remainder of remainders) {
    posed.push({
      rigid: remainder.body,
      model: vehicleModel(consist, remainder.vehicle),
      at: bodyPoseAt(remainder.vehicle, BODY),
      y: groundY - remainder.lowestY,
      onRails: null,
    });
  }
  let count = 0;
  for (const { rigid } of posed) count += rigid.instances.length;
  buffers.fit(count);
  const { partIndex, colorIndex, matrices, frame, lifts, posedPart } = buffers;
  let slot = 0;
  for (const { rigid, model, at, y, onRails } of posed) {
    lifts[0] = y;
    if (onRails) writeRigidFrame(poses, onRails.vehicleAt, onRails.body, lifts, 0, frame, 0);
    else writeFlatFrame(poses, at, y, frame);
    frame[3] = (frame[3] ?? 0) - originX;
    frame[11] = (frame[11] ?? 0) - originZ;
    for (let k = 0; k < rigid.instances.length; k++) {
      const i = rigid.instances[k] ?? 0;
      partIndex[slot] = model.model.partIndex[i] ?? 0;
      colorIndex[slot] = model.colorIndex[i] ?? 0;
      composeAffine(frame, 0, rigid.matrices, k * INSTANCE_MATRIX_FLOATS, posedPart, 0);
      matrices.set(posedPart, slot * INSTANCE_MATRIX_FLOATS);
      slot++;
    }
  }
  const base = { originX: 0, originZ: 0, count, partIndex, colorIndex, matrices };
  buffers.fitStuds(studTotal(consist.parts, base));
  const studs = {
    primitiveIndex: buffers.studPrimitives,
    colorIndex: buffers.studColors,
    matrices: buffers.studMatrices,
  };
  const studCount = writeStuds(consist.parts, consist.colors, base, undefined, studs);
  return { instances: { ...base, studs: { count: studCount, ...studs } }, x: originX, z: originZ };
}

export class StandingRemainderBody {
  private id = NO_BODY;

  constructor(
    private readonly backend: ISceneBackend,
    private readonly vehicleIds: IVehicleIds,
    consist: StandingConsist,
    remainder: StandingRemainder,
    poses: Float64Array,
    groundY: number,
  ) {
    this.id = vehicleIds.take();
    backend.setVehicle(
      this.id,
      rigidChunk(remainder.body, consist, vehicleModel(consist, remainder.vehicle)),
    );
    const at = bodyPoseAt(remainder.vehicle, BODY);
    backend.setVehiclePose(
      this.id,
      poses[at] ?? 0,
      groundY - remainder.lowestY,
      poses[at + 1] ?? 0,
      poses[at + 2] ?? 0,
    );
  }

  dispose(): void {
    if (this.id === NO_BODY) return;
    this.backend.deleteVehicle(this.id);
    this.vehicleIds.release(this.id);
    this.id = NO_BODY;
  }
}

export class ConsistBodies {
  private readonly ids: Int32Array;

  constructor(
    private readonly backend: ISceneBackend,
    private readonly vehicleIds: IVehicleIds,
    readonly consist: StandingConsist,
  ) {
    this.ids = new Int32Array(consist.vehicles.length * BODIES_PER_VEHICLE).fill(NO_BODY);
    consist.vehicles.forEach((vehicle, v) => {
      rigidBodies(vehicle).forEach((rigid, body) => {
        if (!rigid) return;
        const id = vehicleIds.take();
        backend.setVehicle(id, rigidChunk(rigid, consist, vehicleModel(consist, v)));
        this.ids[v * BODIES_PER_VEHICLE + body] = id;
      });
    });
  }

  railTopY(v: number): number {
    return this.consist.vehicles[v]?.railTopY ?? 0;
  }

  stand(poses: Float64Array, railTopY: number): void {
    for (let v = 0; v < this.consist.vehicles.length; v++) {
      this.onRails(v, poses, v * VEHICLE_POSE_FLOATS, railTopY - this.railTopY(v));
    }
  }

  onRails(v: number, data: Float64Array, at: number, y: number): void {
    const base = v * BODIES_PER_VEHICLE;
    for (let body = BODY; body <= REAR_BOGIE; body++) {
      this.place(
        this.ids[base + body] ?? NO_BODY,
        data,
        at + body * RIGID_POSE_FLOATS,
        y + rigidLift(data, at, body),
        0,
        rigidPitch(data, at, body),
        0,
      );
    }
  }

  offRails(
    v: number,
    data: Float64Array,
    at: number,
    frontY: number,
    rearY: number,
    kink: number,
    roll: number,
  ): void {
    const base = v * BODIES_PER_VEHICLE;
    const spacing = Math.hypot(
      (data[at + POSE_FRONT_BOGIE] ?? 0) - (data[at + POSE_REAR_BOGIE] ?? 0),
      (data[at + POSE_FRONT_BOGIE + 1] ?? 0) - (data[at + POSE_REAR_BOGIE + 1] ?? 0),
    );
    this.place(
      this.ids[base + BODY] ?? NO_BODY,
      data,
      at + POSE_BODY,
      (frontY + rearY) / 2,
      kink,
      spacing === 0 ? 0 : Math.atan2(frontY - rearY, spacing),
      roll,
    );
    this.place(
      this.ids[base + FRONT_BOGIE] ?? NO_BODY,
      data,
      at + POSE_FRONT_BOGIE,
      frontY,
      kink,
      0,
      roll,
    );
    this.place(
      this.ids[base + REAR_BOGIE] ?? NO_BODY,
      data,
      at + POSE_REAR_BOGIE,
      rearY,
      kink,
      0,
      roll,
    );
  }

  private place(
    id: number,
    data: Float64Array,
    at: number,
    y: number,
    kink: number,
    pitch: number,
    roll: number,
  ): void {
    if (id === NO_BODY) return;
    this.backend.setVehiclePose(
      id,
      data[at] ?? 0,
      y,
      data[at + 1] ?? 0,
      (data[at + 2] ?? 0) + kink,
      pitch,
      roll,
    );
  }

  dispose(): void {
    for (let k = 0; k < this.ids.length; k++) {
      const id = this.ids[k] ?? NO_BODY;
      if (id === NO_BODY) continue;
      this.backend.deleteVehicle(id);
      this.vehicleIds.release(id);
      this.ids[k] = NO_BODY;
    }
  }
}
