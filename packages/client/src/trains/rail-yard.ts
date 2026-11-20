import {
  GEOMETRY_FIELDS,
  NO_EDGE,
  RAIL_SPOT_FLOATS,
  RailRun,
  RunningGearPoser,
  SPOT_DISTANCE,
  SPOT_EDGE,
  SPOT_OFFSET,
  VEHICLE_POSE_FLOATS,
  packGeometry,
  runningGearSpanProblem,
  type ConsistAnchor,
  type ConsistHandle,
} from "@brr/domain";
import { STUD_LDU } from "@brr/math";
import { SCENE_BACKEND, type ChunkInstances, type ISceneBackend, type WorldBox } from "@brr/render";
import { inject, injectable } from "inversify";
import type { IPlaceableCatalog } from "../catalog/placeable-catalog.ts";
import { BOX_FLOATS } from "../edit/local-box.ts";
import type { PlayTrack } from "../edit/track-drawing.ts";
import type { PlayModel } from "../play/play-models.ts";
import { consistVehicles, type ConsistVehicle } from "../sim/consist.ts";
import { PLACEABLE_CATALOG, VEHICLE_IDS } from "../tokens.ts";
import { ConsistBodies, standingGhost, type StandingConsist } from "./consist-bodies.ts";
import { RailTrack, type RailHead } from "./rail-track.ts";
import type { IVehicleIds } from "./vehicle-ids.ts";

export interface RailSeat {
  readonly anchor: ConsistAnchor;
  readonly head: RailHead;
  readonly consist: StandingConsist;
  readonly poses: Float64Array;
  readonly pieces: ReadonlySet<number>;
  readonly lengthLdu: number;
}

export type RailAim =
  | { readonly kind: "off" }
  | { readonly kind: "seat"; readonly seat: RailSeat }
  | { readonly kind: "refused"; readonly reason: string; readonly seat: RailSeat | null };

export interface RailTrain {
  readonly handle: ConsistHandle;
  readonly model: PlayModel;
  readonly head: RailHead;
  readonly consist: StandingConsist;
}

export interface RailPick {
  readonly handle: ConsistHandle;
  readonly t: number;
}

export interface RailGhost {
  readonly instances: ChunkInstances;
  readonly x: number;
  readonly z: number;
}

export interface IRailYard {
  setTrack(track: PlayTrack | null): void;
  rails(): RailTrack | null;
  aim(model: PlayModel, ray: Float64Array, reversed: boolean): RailAim;
  ghost(seat: RailSeat): RailGhost;
  add(handle: ConsistHandle, model: PlayModel): string | null;
  remove(handle: ConsistHandle): void;
  clear(): void;
  pick(ray: Float64Array): RailPick | null;
  box(handle: ConsistHandle): WorldBox | null;
  standingOn(placement: number): ConsistHandle | null;
  trains(): ReadonlyArray<RailTrain>;
  unseated(): ReadonlyArray<ConsistHandle>;
  park(hidden: boolean): void;
}

interface Prepared {
  readonly vehicles: ReadonlyArray<ConsistVehicle>;
  readonly geometry: Float64Array;
  readonly geometryAt: Int32Array;
  readonly straightLdu: number;
  readonly boxes: Float64Array;
}

interface Parked {
  readonly handle: ConsistHandle;
  readonly model: PlayModel;
  seat: RailSeat | null;
  bodies: ConsistBodies | null;
}

const RAY_ORIGIN = 0;
const RAY_DIRECTION = 3;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function studs(ldu: number): number {
  return Math.round(ldu / STUD_LDU);
}

function vehicleBoxes(model: PlayModel, vehicles: ReadonlyArray<ConsistVehicle>): Float64Array {
  const boxes = new Float64Array(vehicles.length * BOX_FLOATS);
  const source = model.gear.instanceBoxes;
  vehicles.forEach((consistVehicle, v) => {
    const vehicle = model.model.vehicles[consistVehicle.vehicle];
    const o = v * BOX_FLOATS;
    boxes.fill(Number.POSITIVE_INFINITY, o, o + 3);
    boxes.fill(Number.NEGATIVE_INFINITY, o + 3, o + BOX_FLOATS);
    if (!vehicle) return;
    const cos = Math.cos(vehicle.yaw);
    const sin = Math.sin(vehicle.yaw);
    for (const instance of vehicle.body) {
      const b = instance * BOX_FLOATS;
      for (let corner = 0; corner < 4; corner++) {
        const dx = (source[b + (corner & 1 ? 3 : 0)] ?? 0) - vehicle.origin[0];
        const dz = (source[b + (corner & 2 ? 5 : 2)] ?? 0) - vehicle.origin[1];
        const u = dx * cos + dz * sin;
        const w = -dx * sin + dz * cos;
        boxes[o] = Math.min(boxes[o] ?? 0, u);
        boxes[o + 2] = Math.min(boxes[o + 2] ?? 0, w);
        boxes[o + 3] = Math.max(boxes[o + 3] ?? 0, u);
        boxes[o + 5] = Math.max(boxes[o + 5] ?? 0, w);
      }
      boxes[o + 1] = Math.min(boxes[o + 1] ?? 0, source[b + 1] ?? 0);
      boxes[o + 4] = Math.max(boxes[o + 4] ?? 0, source[b + 4] ?? 0);
    }
  });
  return boxes;
}

@injectable()
export class RailYard implements IRailYard {
  private track: RailTrack | null = null;
  private run: RailRun | null = null;
  private readonly poser = new RunningGearPoser();
  private readonly spot = new Float64Array(RAIL_SPOT_FLOATS);
  private readonly lengths = new Float64Array(1);
  private readonly prepared = new Map<PlayModel, Prepared | string>();
  private readonly parked: Parked[] = [];
  private hidden = false;

  constructor(
    @inject(SCENE_BACKEND) private readonly backend: ISceneBackend,
    @inject(VEHICLE_IDS) private readonly vehicleIds: IVehicleIds,
    @inject(PLACEABLE_CATALOG) private readonly catalog: IPlaceableCatalog,
  ) {}

  setTrack(track: PlayTrack | null): void {
    this.track = track && track.layout.count > 0 ? new RailTrack(track) : null;
    this.run = this.track ? new RailRun(this.track.network) : null;
    this.prepared.clear();
    for (const parked of this.parked) this.restand(parked);
  }

  rails(): RailTrack | null {
    return this.track;
  }

  aim(model: PlayModel, ray: Float64Array, reversed: boolean): RailAim {
    const rails = this.track;
    if (!rails) return { kind: "off" };
    const directionY = ray[RAY_DIRECTION + 1] ?? 0;
    if (directionY >= 0) return { kind: "off" };
    const t = (rails.railTopY - (ray[RAY_ORIGIN + 1] ?? 0)) / directionY;
    const x = (ray[RAY_ORIGIN] ?? 0) + (ray[RAY_DIRECTION] ?? 0) * t;
    const z = (ray[RAY_ORIGIN + 2] ?? 0) + (ray[RAY_DIRECTION + 2] ?? 0) * t;
    const network = rails.network;
    if (!network.nearest(x, z, this.spot)) return { kind: "off" };
    if ((this.spot[SPOT_DISTANCE] ?? 0) > rails.play.halfWidthLdu) return { kind: "off" };
    const forward = this.spot[SPOT_EDGE] ?? 0;
    const edge = reversed ? forward ^ 1 : forward;
    const along = this.spot[SPOT_OFFSET] ?? 0;
    const offset = reversed ? network.edgeLength(forward) - along : along;
    const prepared = this.prepare(model, rails);
    if (typeof prepared === "string") return { kind: "refused", reason: prepared, seat: null };
    if (!network.seat(edge, offset, prepared.straightLdu, this.spot)) {
      return { kind: "refused", reason: this.tooLong(model, prepared.straightLdu), seat: null };
    }
    const head = { edge: this.spot[SPOT_EDGE] ?? edge, offsetLdu: this.spot[SPOT_OFFSET] ?? 0 };
    let stood = this.stand(model, prepared, rails, head);
    if (typeof stood === "string") return { kind: "refused", reason: stood, seat: null };
    if (stood.lengthLdu > prepared.straightLdu) {
      if (!network.seat(edge, offset, stood.lengthLdu, this.spot)) {
        return { kind: "refused", reason: this.tooLong(model, stood.lengthLdu), seat: null };
      }
      const reseated = {
        edge: this.spot[SPOT_EDGE] ?? edge,
        offsetLdu: this.spot[SPOT_OFFSET] ?? 0,
      };
      stood = this.stand(model, prepared, rails, reseated);
      if (typeof stood === "string") return { kind: "refused", reason: stood, seat: null };
    }
    const holder = this.holderOf(stood.pieces);
    if (holder) {
      return {
        kind: "refused",
        reason: `${model.label} would stand on track that ${holder.model.label} already stands on. Put it on a free stretch of track.`,
        seat: stood,
      };
    }
    return { kind: "seat", seat: stood };
  }

  ghost(seat: RailSeat): RailGhost {
    return standingGhost(seat.consist, seat.poses, this.track?.railTopY ?? 0);
  }

  add(handle: ConsistHandle, model: PlayModel): string | null {
    const parked: Parked = { handle, model, seat: null, bodies: null };
    this.parked.push(parked);
    return this.restand(parked);
  }

  remove(handle: ConsistHandle): void {
    const index = this.parked.findIndex((parked) => parked.handle === handle);
    const parked = this.parked[index];
    if (!parked) return;
    parked.bodies?.dispose();
    this.parked.splice(index, 1);
  }

  clear(): void {
    for (const parked of this.parked) parked.bodies?.dispose();
    this.parked.length = 0;
  }

  pick(ray: Float64Array): RailPick | null {
    let best: RailPick | null = null;
    for (const parked of this.parked) {
      const seat = parked.seat;
      if (!seat) continue;
      const boxes = this.preparedBoxes(parked.model);
      for (let v = 0; v < seat.consist.vehicles.length; v++) {
        const t = this.vehicleHit(seat, boxes, v, ray);
        if (t < (best?.t ?? Number.POSITIVE_INFINITY)) best = { handle: parked.handle, t };
      }
    }
    return best;
  }

  box(handle: ConsistHandle): WorldBox | null {
    const parked = this.parked.find((candidate) => candidate.handle === handle);
    const seat = parked?.seat;
    if (!parked || !seat) return null;
    const boxes = this.preparedBoxes(parked.model);
    const out = {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY,
    };
    for (let v = 0; v < seat.consist.vehicles.length; v++) {
      const o = v * BOX_FLOATS;
      const at = v * VEHICLE_POSE_FLOATS;
      const x = seat.poses[at] ?? 0;
      const z = seat.poses[at + 1] ?? 0;
      const c = Math.cos(seat.poses[at + 2] ?? 0);
      const s = Math.sin(seat.poses[at + 2] ?? 0);
      const y = this.vehicleY(seat, v);
      for (let corner = 0; corner < 4; corner++) {
        const u = boxes[o + (corner & 1 ? 3 : 0)] ?? 0;
        const w = boxes[o + (corner & 2 ? 5 : 2)] ?? 0;
        out.minX = Math.min(out.minX, x + c * u - s * w);
        out.maxX = Math.max(out.maxX, x + c * u - s * w);
        out.minZ = Math.min(out.minZ, z + s * u + c * w);
        out.maxZ = Math.max(out.maxZ, z + s * u + c * w);
      }
      out.minY = Math.min(out.minY, y + (boxes[o + 1] ?? 0));
      out.maxY = Math.max(out.maxY, y + (boxes[o + 4] ?? 0));
    }
    return out;
  }

  standingOn(placement: number): ConsistHandle | null {
    return this.parked.find((parked) => parked.seat?.pieces.has(placement))?.handle ?? null;
  }

  trains(): ReadonlyArray<RailTrain> {
    return this.parked.flatMap(({ handle, model, seat }) =>
      seat ? [{ handle, model, head: seat.head, consist: seat.consist }] : [],
    );
  }

  unseated(): ReadonlyArray<ConsistHandle> {
    return this.parked.flatMap((parked) => (parked.seat ? [] : [parked.handle]));
  }

  park(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    for (const parked of this.parked) this.show(parked);
  }

  private restand(parked: Parked): string | null {
    parked.bodies?.dispose();
    parked.bodies = null;
    parked.seat = null;
    const rails = this.track;
    if (!rails) return `${parked.model.label} has no track to stand on.`;
    const head = rails.headOf(parked.handle.pose.anchor);
    if (!head) return `the track ${parked.model.label} stood on is gone.`;
    const prepared = this.prepare(parked.model, rails);
    if (typeof prepared === "string") return prepared;
    const stood = this.stand(parked.model, prepared, rails, head);
    if (typeof stood === "string") return stood;
    parked.seat = stood;
    this.show(parked);
    return null;
  }

  private show(parked: Parked): void {
    parked.bodies?.dispose();
    parked.bodies = null;
    const seat = parked.seat;
    if (this.hidden || !seat) return;
    parked.bodies = new ConsistBodies(this.backend, this.vehicleIds, seat.consist);
    parked.bodies.stand(seat.poses, this.track?.railTopY ?? 0);
  }

  private prepare(model: PlayModel, rails: RailTrack): Prepared | string {
    const known = this.prepared.get(model);
    if (known !== undefined) return known;
    let prepared: Prepared | string;
    try {
      const vehicles = consistVehicles(model.model, model.name, false, rails.railPart);
      const geometry = new Float64Array(vehicles.length * GEOMETRY_FIELDS);
      const geometryAt = new Int32Array(vehicles.length);
      let straightLdu = 0;
      const problems: string[] = [];
      vehicles.forEach((vehicle, v) => {
        const problem = runningGearSpanProblem(vehicle.spec);
        if (problem) problems.push(problem);
        const { geometry: shape } = vehicle.spec;
        if (!shape) throw new Error(`vehicle ${v} has no running gear geometry`);
        geometryAt[v] = v * GEOMETRY_FIELDS;
        packGeometry(shape, geometry, v * GEOMETRY_FIELDS);
        straightLdu += vehicle.spec.lengthLdu;
      });
      prepared =
        problems.length > 0
          ? `${model.label} can't run: ${problems.join("; ")}`
          : { vehicles, geometry, geometryAt, straightLdu, boxes: vehicleBoxes(model, vehicles) };
    } catch (error) {
      prepared = `${model.label} can't go on the rails: ${errorText(error)}`;
    }
    this.prepared.set(model, prepared);
    return prepared;
  }

  private preparedBoxes(model: PlayModel): Float64Array {
    const prepared = this.prepared.get(model);
    return typeof prepared === "object" ? prepared.boxes : new Float64Array(0);
  }

  private stand(
    model: PlayModel,
    prepared: Prepared,
    rails: RailTrack,
    head: RailHead,
  ): RailSeat | string {
    const run = this.run;
    if (!run) return `${model.label} has no track to stand on.`;
    const network = rails.network;
    if (!run.standAt(head.edge, head.offsetLdu, prepared.straightLdu)) {
      return `${model.label} is longer than this loop of track.`;
    }
    const count = prepared.vehicles.length;
    const poses = new Float64Array(count * VEHICLE_POSE_FLOATS);
    this.poser.writeTrain(
      run,
      prepared.geometry,
      prepared.geometryAt,
      0,
      count,
      false,
      null,
      0,
      poses,
      0,
      this.lengths,
      0,
    );
    const lengthLdu = this.lengths[0] ?? prepared.straightLdu;
    if (network.reachBehind(head.edge, head.offsetLdu, lengthLdu) < lengthLdu) {
      return this.tooLong(model, lengthLdu);
    }
    if (!run.standAt(head.edge, head.offsetLdu, lengthLdu)) {
      return `${model.label} is longer than this loop of track.`;
    }
    const pieces = new Set<number>();
    for (let i = 0; i < run.edgeCount; i++) {
      const edge = run.edge(i);
      if (edge !== NO_EDGE) pieces.add(rails.placementOf(edge));
    }
    const anchor = rails.anchorOf(head);
    if (!anchor) {
      return `${model.label} can't stand on this track: it lies off the stud grid inside its model, so the train has nothing exact to stand on.`;
    }
    const consist: StandingConsist = {
      model,
      vehicles: prepared.vehicles,
      parts: this.catalog.parts(),
      colors: this.catalog.colors(),
    };
    return { anchor, head, consist, poses, pieces, lengthLdu };
  }

  private tooLong(model: PlayModel, lengthLdu: number): string {
    return `${model.label} is ${studs(lengthLdu)} studs long and doesn't fit on this run of track.`;
  }

  private holderOf(pieces: ReadonlySet<number>): Parked | null {
    for (const parked of this.parked) {
      if (!parked.seat) continue;
      for (const piece of pieces) if (parked.seat.pieces.has(piece)) return parked;
    }
    return null;
  }

  private vehicleY(seat: RailSeat, v: number): number {
    return (this.track?.railTopY ?? 0) - (seat.consist.vehicles[v]?.railTopY ?? 0);
  }

  private vehicleHit(seat: RailSeat, boxes: Float64Array, v: number, ray: Float64Array): number {
    const at = v * VEHICLE_POSE_FLOATS;
    const o = v * BOX_FLOATS;
    const c = Math.cos(seat.poses[at + 2] ?? 0);
    const s = Math.sin(seat.poses[at + 2] ?? 0);
    const px = (ray[RAY_ORIGIN] ?? 0) - (seat.poses[at] ?? 0);
    const py = (ray[RAY_ORIGIN + 1] ?? 0) - this.vehicleY(seat, v);
    const pz = (ray[RAY_ORIGIN + 2] ?? 0) - (seat.poses[at + 1] ?? 0);
    const dx = ray[RAY_DIRECTION] ?? 0;
    const dy = ray[RAY_DIRECTION + 1] ?? 0;
    const dz = ray[RAY_DIRECTION + 2] ?? 0;
    const origin = [c * px + s * pz, py, -s * px + c * pz];
    const direction = [c * dx + s * dz, dy, -s * dx + c * dz];
    let near = 0;
    let far = Number.POSITIVE_INFINITY;
    for (let axis = 0; axis < 3; axis++) {
      const p = origin[axis] ?? 0;
      const d = direction[axis] ?? 0;
      const lo = boxes[o + axis] ?? 0;
      const hi = boxes[o + 3 + axis] ?? 0;
      if (d === 0) {
        if (p < lo || p > hi) return Number.POSITIVE_INFINITY;
        continue;
      }
      const a = (lo - p) / d;
      const b = (hi - p) / d;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
    return near <= far ? near : Number.POSITIVE_INFINITY;
  }
}
