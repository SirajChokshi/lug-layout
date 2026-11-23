import type { PartAsset } from "@brr/catalog";
import { VEHICLE_POSE_FLOATS } from "@brr/domain";
import { INSTANCE_MATRIX_FLOATS, type ChunkInstances, type ISceneBackend } from "@brr/render";
import type { PlayModel } from "../play/play-models.ts";
import { withStuds } from "../scene/stud-stream.ts";
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

export interface StandingConsist {
  readonly model: PlayModel;
  readonly vehicles: ReadonlyArray<ConsistVehicle>;
  readonly parts: ReadonlyArray<PartAsset>;
  readonly colors: ColorTable;
}

function rigidBodies(vehicle: ConsistVehicle): ReadonlyArray<RigidBodyInstances | null> {
  return [vehicle.body, vehicle.frontBogie, vehicle.rearBogie];
}

function rigidChunk(rigid: RigidBodyInstances, consist: StandingConsist): ChunkInstances {
  const count = rigid.instances.length;
  const partIndex = new Uint16Array(count);
  const colorIndex = new Uint16Array(count);
  for (let k = 0; k < count; k++) {
    const i = rigid.instances[k] ?? 0;
    partIndex[k] = consist.model.model.partIndex[i] ?? 0;
    colorIndex[k] = consist.model.colorIndex[i] ?? 0;
  }
  return withStuds(
    { originX: 0, originZ: 0, count, partIndex, colorIndex, matrices: rigid.matrices },
    consist.parts,
    consist.colors,
  );
}

function bodyPoseAt(v: number, body: number): number {
  const o = v * VEHICLE_POSE_FLOATS;
  if (body === FRONT_BOGIE) return o + POSE_FRONT_BOGIE;
  if (body === REAR_BOGIE) return o + POSE_REAR_BOGIE;
  return o + POSE_BODY;
}

interface PosedBody {
  readonly rigid: RigidBodyInstances;
  readonly at: number;
  readonly y: number;
}

export function standingGhost(
  consist: StandingConsist,
  poses: Float64Array,
  railTopY: number,
  remainder: StandingRemainder | null,
  groundY: number,
): { readonly instances: ChunkInstances; readonly x: number; readonly z: number } {
  const originX = poses[POSE_BODY] ?? 0;
  const originZ = poses[POSE_BODY + 1] ?? 0;
  const posed: PosedBody[] = [];
  consist.vehicles.forEach((vehicle, v) => {
    const y = railTopY - vehicle.railTopY;
    rigidBodies(vehicle).forEach((rigid, body) => {
      if (rigid) posed.push({ rigid, at: bodyPoseAt(v, body), y });
    });
  });
  if (remainder) {
    posed.push({
      rigid: remainder.body,
      at: bodyPoseAt(remainder.vehicle, BODY),
      y: groundY - remainder.lowestY,
    });
  }
  let count = 0;
  for (const { rigid } of posed) count += rigid.instances.length;
  const partIndex = new Uint16Array(count);
  const colorIndex = new Uint16Array(count);
  const matrices = new Float32Array(count * INSTANCE_MATRIX_FLOATS);
  let slot = 0;
  for (const { rigid, at, y } of posed) {
    const x = (poses[at] ?? 0) - originX;
    const z = (poses[at + 1] ?? 0) - originZ;
    const c = Math.cos(poses[at + 2] ?? 0);
    const s = Math.sin(poses[at + 2] ?? 0);
    for (let k = 0; k < rigid.instances.length; k++) {
      const i = rigid.instances[k] ?? 0;
      const m = k * INSTANCE_MATRIX_FLOATS;
      const o = slot * INSTANCE_MATRIX_FLOATS;
      partIndex[slot] = consist.model.model.partIndex[i] ?? 0;
      colorIndex[slot] = consist.model.colorIndex[i] ?? 0;
      for (let col = 0; col < 4; col++) {
        const lx = rigid.matrices[m + col] ?? 0;
        const ly = rigid.matrices[m + 4 + col] ?? 0;
        const lz = rigid.matrices[m + 8 + col] ?? 0;
        const translation = col === 3 ? 1 : 0;
        matrices[o + col] = c * lx - s * lz + translation * x;
        matrices[o + 4 + col] = ly + translation * y;
        matrices[o + 8 + col] = s * lx + c * lz + translation * z;
      }
      slot++;
    }
  }
  return {
    instances: withStuds(
      { originX: 0, originZ: 0, count, partIndex, colorIndex, matrices },
      consist.parts,
      consist.colors,
    ),
    x: originX,
    z: originZ,
  };
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
    backend.setVehicle(this.id, rigidChunk(remainder.body, consist));
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
        backend.setVehicle(id, rigidChunk(rigid, consist));
        this.ids[v * BODIES_PER_VEHICLE + body] = id;
      });
    });
  }

  railTopY(v: number): number {
    return this.consist.vehicles[v]?.railTopY ?? 0;
  }

  stand(poses: Float64Array, railTopY: number): void {
    for (let v = 0; v < this.consist.vehicles.length; v++) {
      const y = railTopY - this.railTopY(v);
      this.pose(v, poses, v * VEHICLE_POSE_FLOATS, y, y, 0, 0);
    }
  }

  pose(
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
