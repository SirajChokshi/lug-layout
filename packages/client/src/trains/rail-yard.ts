import {
  GEOMETRY_FIELDS,
  NO_EDGE,
  RAIL_SPOT_FLOATS,
  RailRun,
  RunningGearPoser,
  SOLID_BOX_FLOATS,
  SOLID_MATRIX_FLOATS,
  SPOT_DISTANCE,
  SPOT_EDGE,
  SPOT_OFFSET,
  VEHICLE_POSE_FLOATS,
  composeAffine,
  packGeometry,
  posedBoxBounds,
  rigidLift,
  rigidPitch,
  runningGearSpanProblem,
  writeRigidFrame,
  type ConsistAnchor,
  type ConsistHandle,
} from "@brr/domain";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import { SCENE_BACKEND, type ChunkInstances, type ISceneBackend, type WorldBox } from "@brr/render";
import { inject, injectable } from "inversify";
import type { IPlaceableCatalog } from "../catalog/placeable-catalog.ts";
import { BOX_FLOATS } from "../edit/local-box.ts";
import type { PlacedModel } from "../edit/placed-chunks.ts";
import type { Placeable } from "../edit/placeable.ts";
import type { PlayTrack } from "../edit/track-drawing.ts";
import type { PlayModel } from "../play/play-models.ts";
import {
  consistVehicles,
  standingRemainder,
  type ConsistVehicle,
  type StandingRemainder,
} from "../sim/consist.ts";
import { PLACEABLE_CATALOG, VEHICLE_IDS } from "../tokens.ts";
import {
  ConsistBodies,
  StandingRemainderBody,
  rigidBodies,
  GhostBuffers,
  standingGhost,
  type StandingConsist,
} from "./consist-bodies.ts";
import {
  CLASH_RANK,
  NO_CLASH_PART,
  NO_SKIP,
  clashOut,
  emptyBounds,
  growBounds,
  type ClashOut,
  type PartClash,
  type PosedParts,
} from "./part-clash.ts";
import { RailTrack, type RailCarrier, type RailHead } from "./rail-track.ts";
import type { IVehicleIds } from "./vehicle-ids.ts";

export interface TrainMember {
  readonly model: PlayModel;
  readonly reversed: boolean;
}

export type CoupledEnd = "front" | "rear";

export interface RailSeat {
  readonly anchor: ConsistAnchor;
  readonly head: RailHead;
  readonly consist: StandingConsist;
  readonly poses: Float64Array;
  readonly pieces: ReadonlySet<number>;
  readonly lengthLdu: number;
  readonly remainders: ReadonlyArray<StandingRemainder>;
  readonly groundY: number;
  readonly boxes: Float64Array;
  readonly tops: Float64Array;
  readonly solids: PosedParts;
}

export type RailAim =
  | { readonly kind: "off" }
  | { readonly kind: "seat"; readonly seat: RailSeat }
  | {
      readonly kind: "couple";
      readonly seat: RailSeat;
      readonly holder: ConsistHandle;
      readonly end: CoupledEnd;
      readonly reversed: boolean;
    }
  | { readonly kind: "refused"; readonly reason: string; readonly seat: RailSeat | null }
  | { readonly kind: "waiting"; readonly reason: string; readonly seat: RailSeat };

export interface RailTrain {
  readonly handle: ConsistHandle;
  readonly members: ReadonlyArray<TrainMember>;
  readonly head: RailHead;
  readonly consist: StandingConsist;
}

export interface VehicleFootprint {
  readonly outline: Float64Array;
  readonly railTopLdu: number;
  readonly topLdu: number;
  readonly label: string;
}

const FOOTPRINT_CORNERS = [0, 1, 3, 2] as const;

class AimScratch {
  poses = new Float64Array(0);
  matrices = new Float64Array(0);
  boxes = new Float64Array(0);
  readonly bounds = new Float64Array(SOLID_BOX_FLOATS);
  private readonly outlines: Float64Array[] = [];

  posesFor(vehicles: number): Float64Array {
    const length = vehicles * VEHICLE_POSE_FLOATS;
    if (this.poses.length !== length) this.poses = new Float64Array(length);
    return this.poses;
  }

  solidsFor(parts: number): void {
    if (this.matrices.length === parts * SOLID_MATRIX_FLOATS) return;
    this.matrices = new Float64Array(parts * SOLID_MATRIX_FLOATS);
    this.boxes = new Float64Array(parts * SOLID_BOX_FLOATS);
  }

  outline(vehicle: number): Float64Array {
    const kept = this.outlines[vehicle];
    if (kept) return kept;
    const made = new Float64Array(FOOTPRINT_CORNERS.length * 2);
    this.outlines[vehicle] = made;
    return made;
  }
}
const BODY = 0;
const FRONT_BOGIE = 1;
const REAR_BOGIE = 2;

export interface RailPick {
  readonly handle: ConsistHandle;
  readonly t: number;
}

export interface RailGhost {
  readonly instances: ChunkInstances;
  readonly x: number;
  readonly z: number;
}

export interface ObstacleModels {
  models(): ReadonlyArray<PlacedModel>;
  carriedParts(placeable: Placeable): ReadonlySet<number>;
}

export interface IRailYard {
  setTrack(track: PlayTrack | null, carriers: ReadonlyArray<RailCarrier>): void;
  watchModels(models: ObstacleModels): void;
  obstacleModels(): ObstacleModels | null;
  rails(): RailTrack | null;
  aim(model: PlayModel, ray: Float64Array, reversed: boolean): RailAim;
  ghost(seat: RailSeat): RailGhost;
  add(handle: ConsistHandle, members: ReadonlyArray<TrainMember>): void;
  remove(handle: ConsistHandle): void;
  clear(): void;
  pick(ray: Float64Array): RailPick | null;
  box(handle: ConsistHandle): WorldBox | null;
  standingFootprints(): ReadonlyArray<VehicleFootprint>;
  seatFootprints(seat: RailSeat, label: string): ReadonlyArray<VehicleFootprint>;
  standingClash(
    parts: PosedParts,
    skip: ReadonlySet<number>,
    clash: PartClash,
    out: ClashOut,
  ): string | null;
  standingOn(placement: number): ConsistHandle | null;
  trains(): ReadonlyArray<RailTrain>;
  park(hidden: boolean): void;
}

interface Prepared {
  readonly vehicles: ReadonlyArray<ConsistVehicle>;
  readonly vehicleModels: ReadonlyArray<PlayModel>;
  readonly geometry: Float64Array;
  readonly geometryAt: Int32Array;
  readonly straightLdu: number;
  readonly boxes: Float64Array;
  readonly tops: Float64Array;
  readonly solids: VehicleSolids;
  readonly remainders: ReadonlyArray<StandingRemainder>;
}

interface VehicleSolids {
  readonly local: Float64Array;
  readonly parts: Uint16Array;
  readonly vehicleAt: Int32Array;
  readonly rigid: Uint8Array;
  readonly lift: Float64Array;
}

interface Parked {
  readonly handle: ConsistHandle;
  readonly members: ReadonlyArray<TrainMember>;
  seat: RailSeat | null;
  bodies: ConsistBodies | null;
  remainders: ReadonlyArray<StandingRemainderBody>;
}

const RAY_ORIGIN = 0;
const RAY_DIRECTION = 3;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function studs(ldu: number): number {
  return Math.round(ldu / STUD_LDU);
}

export function trainLabel(members: ReadonlyArray<TrainMember>): string {
  return members.map((member) => member.model.label).join(" + ");
}

function joinedBoxes(parts: ReadonlyArray<Float64Array>): Float64Array {
  const out = new Float64Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function vehicleBoxes(model: PlayModel, vehicles: ReadonlyArray<ConsistVehicle>): Float64Array {
  const boxes = new Float64Array(vehicles.length * BOX_FLOATS);
  const source = model.instanceBoxes;
  vehicles.forEach((consistVehicle, v) => {
    const vehicle = model.model.runningGear.vehicles[consistVehicle.vehicle];
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

function vehicleSolids(
  vehicles: ReadonlyArray<ConsistVehicle>,
  models: ReadonlyArray<PlayModel>,
  railTopY: number,
): VehicleSolids {
  let count = 0;
  for (const vehicle of vehicles) {
    for (const rigid of rigidBodies(vehicle)) count += rigid?.instances.length ?? 0;
  }
  const solids: VehicleSolids = {
    local: new Float64Array(count * SOLID_MATRIX_FLOATS),
    parts: new Uint16Array(count),
    vehicleAt: new Int32Array(count),
    rigid: new Uint8Array(count),
    lift: new Float64Array(count),
  };
  let e = 0;
  vehicles.forEach((vehicle, v) => {
    const partIndex = models[v]?.model.partIndex;
    rigidBodies(vehicle).forEach((rigid, body) => {
      if (!rigid) return;
      for (let k = 0; k < rigid.instances.length; k++, e++) {
        solids.local.set(
          rigid.transforms.subarray(k * SOLID_MATRIX_FLOATS, (k + 1) * SOLID_MATRIX_FLOATS),
          e * SOLID_MATRIX_FLOATS,
        );
        solids.parts[e] = partIndex?.[rigid.instances[k] ?? 0] ?? 0;
        solids.vehicleAt[e] = v * VEHICLE_POSE_FLOATS;
        solids.rigid[e] = body;
        solids.lift[e] = railTopY - vehicle.railTopY;
      }
    });
  });
  return solids;
}

@injectable()
export class RailYard implements IRailYard {
  private track: RailTrack | null = null;
  private run: RailRun | null = null;
  private otherRun: RailRun | null = null;
  private readonly poser = new RunningGearPoser();
  private readonly spot = new Float64Array(RAIL_SPOT_FLOATS);
  private readonly lengths = new Float64Array(1);
  private readonly vehicleFrame = new Float64Array(SOLID_MATRIX_FLOATS);
  private readonly vehicleBase = new Float64Array(1);
  private readonly trainClash = clashOut();
  private readonly endPoints = new Float64Array(6);
  private readonly prepared = new Map<string, Prepared | string>();
  private readonly modelKeys = new WeakMap<PlayModel, number>();
  private nextModelKey = 0;
  private readonly parked: Parked[] = [];
  private readonly ghostBuffers = new GhostBuffers();
  private readonly aimScratch = new AimScratch();
  private hidden = false;
  private watched: ObstacleModels | null = null;

  constructor(
    @inject(SCENE_BACKEND) private readonly backend: ISceneBackend,
    @inject(VEHICLE_IDS) private readonly vehicleIds: IVehicleIds,
    @inject(PLACEABLE_CATALOG) private readonly catalog: IPlaceableCatalog,
  ) {}

  private restandAll(): void {
    this.prepared.clear();
    for (const parked of this.parked) this.restand(parked);
  }

  setTrack(track: PlayTrack | null, carriers: ReadonlyArray<RailCarrier>): void {
    this.track = track && track.layout.count > 0 ? new RailTrack(track, carriers) : null;
    this.run = this.track ? new RailRun(this.track.network) : null;
    this.otherRun = this.track ? new RailRun(this.track.network) : null;
    this.restandAll();
  }

  rails(): RailTrack | null {
    return this.track;
  }

  watchModels(models: ObstacleModels): void {
    this.watched = models;
  }

  obstacleModels(): ObstacleModels | null {
    return this.watched;
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
    const members = [{ model, reversed: false }];
    const prepared = this.prepare(members, rails);
    if (typeof prepared === "string") return { kind: "refused", reason: prepared, seat: null };
    if (!network.seat(edge, offset, prepared.straightLdu, this.spot)) {
      return {
        kind: "refused",
        reason: this.tooLong(model.label, prepared.straightLdu),
        seat: null,
      };
    }
    const head = { edge: this.spot[SPOT_EDGE] ?? edge, offsetLdu: this.spot[SPOT_OFFSET] ?? 0 };
    let stood = this.stand(model.label, prepared, rails, head, this.aimScratch);
    if (typeof stood === "string") return { kind: "refused", reason: stood, seat: null };
    if (stood.lengthLdu > prepared.straightLdu) {
      if (!network.seat(edge, offset, stood.lengthLdu, this.spot)) {
        return { kind: "refused", reason: this.tooLong(model.label, stood.lengthLdu), seat: null };
      }
      const reseated = {
        edge: this.spot[SPOT_EDGE] ?? edge,
        offsetLdu: this.spot[SPOT_OFFSET] ?? 0,
      };
      stood = this.stand(model.label, prepared, rails, reseated, this.aimScratch);
      if (typeof stood === "string") return { kind: "refused", reason: stood, seat: null };
    }
    const holder = this.holderOf(stood.pieces, null);
    return holder ? this.couple(model, stood, holder, rails) : { kind: "seat", seat: stood };
  }

  private couple(model: PlayModel, stood: RailSeat, holder: Parked, rails: RailTrack): RailAim {
    const standing = holder.seat;
    const label = trainLabel(holder.members);
    const blocked = `${model.label} would stand on track that ${label} already stands on. Put it on a free stretch of track, or right behind or in front of it on the same line to couple it.`;
    if (!standing) return { kind: "refused", reason: blocked, seat: stood };
    const sameWay = this.runsSameWay(stood, standing);
    if (sameWay === null) return { kind: "refused", reason: blocked, seat: stood };
    const end = this.nearerEnd(stood, standing);
    const reversed = !sameWay;
    if (end === "front" && reversed) {
      const reason = `${model.label} faces the other way: turn it round (R) to couple it to the front of ${label}.`;
      return { kind: "refused", reason, seat: stood };
    }
    const held = { model, reversed };
    const members = end === "rear" ? [...holder.members, held] : [held, ...holder.members];
    const head = end === "rear" ? standing.head : this.headAhead(standing.head, stood.lengthLdu);
    const coupledLabel = trainLabel(members);
    if (head === null) {
      const reason = `${model.label} doesn't fit in front of ${label}: the track ends there.`;
      return { kind: "refused", reason, seat: stood };
    }
    const prepared = this.prepare(members, rails);
    if (typeof prepared === "string") return { kind: "refused", reason: prepared, seat: stood };
    const coupled = this.stand(coupledLabel, prepared, rails, head);
    if (typeof coupled === "string") return { kind: "refused", reason: coupled, seat: stood };
    const other = this.holderOf(coupled.pieces, holder);
    if (other) {
      const reason = `${coupledLabel} would reach track that ${trainLabel(other.members)} already stands on.`;
      return { kind: "refused", reason, seat: coupled };
    }
    return { kind: "couple", seat: coupled, holder: holder.handle, end, reversed };
  }

  private runsSameWay(held: RailSeat, standing: RailSeat): boolean | null {
    const run = this.run;
    const other = this.otherRun;
    if (!run || !other) return null;
    if (!run.standAt(standing.head.edge, standing.head.offsetLdu, standing.lengthLdu)) return null;
    if (!other.standAt(held.head.edge, held.head.offsetLdu, held.lengthLdu)) return null;
    for (let i = 0; i < other.edgeCount; i++) {
      const edge = other.edge(i);
      for (let j = 0; j < run.edgeCount; j++) {
        const along = run.edge(j);
        if (along === edge) return true;
        if (along === (edge ^ 1)) return false;
      }
    }
    return null;
  }

  private nearerEnd(held: RailSeat, standing: RailSeat): CoupledEnd {
    const run = this.run;
    const ends = this.endPoints;
    if (!run) return "rear";
    run.standAt(held.head.edge, held.head.offsetLdu, held.lengthLdu);
    ends[0] = held.lengthLdu / 2;
    run.pointBehind(ends, 0);
    run.standAt(standing.head.edge, standing.head.offsetLdu, standing.lengthLdu);
    ends[2] = 0;
    run.pointBehind(ends, 2);
    ends[4] = standing.lengthLdu;
    run.pointBehind(ends, 4);
    const x = ends[0] ?? 0;
    const z = ends[1] ?? 0;
    const toFront = ((ends[2] ?? 0) - x) ** 2 + ((ends[3] ?? 0) - z) ** 2;
    const toRear = ((ends[4] ?? 0) - x) ** 2 + ((ends[5] ?? 0) - z) ** 2;
    return toFront < toRear ? "front" : "rear";
  }

  private headAhead(head: RailHead, distanceLdu: number): RailHead | null {
    const network = this.track?.network;
    if (!network) return null;
    if (network.advance(head.edge, head.offsetLdu, distanceLdu, this.spot) < distanceLdu) {
      return null;
    }
    return {
      edge: this.spot[SPOT_EDGE] ?? head.edge,
      offsetLdu: Math.floor(this.spot[SPOT_OFFSET] ?? 0),
    };
  }

  ghost(seat: RailSeat): RailGhost {
    return standingGhost(
      seat.consist,
      seat.poses,
      this.track?.railTopY ?? 0,
      seat.remainders,
      seat.groundY,
      this.ghostBuffers,
    );
  }

  add(handle: ConsistHandle, members: ReadonlyArray<TrainMember>): void {
    const parked: Parked = { handle, members, seat: null, bodies: null, remainders: [] };
    this.parked.push(parked);
    this.restand(parked);
  }

  remove(handle: ConsistHandle): void {
    const index = this.parked.findIndex((parked) => parked.handle === handle);
    const parked = this.parked[index];
    if (!parked) return;
    parked.bodies?.dispose();
    for (const remainder of parked.remainders) remainder.dispose();
    this.parked.splice(index, 1);
  }

  clear(): void {
    for (const parked of this.parked) {
      parked.bodies?.dispose();
      for (const remainder of parked.remainders) remainder.dispose();
    }
    this.parked.length = 0;
  }

  pick(ray: Float64Array): RailPick | null {
    let best: RailPick | null = null;
    for (const parked of this.parked) {
      const seat = parked.seat;
      if (!seat) continue;
      for (let v = 0; v < seat.consist.vehicles.length; v++) {
        const t = this.vehicleHit(seat, seat.boxes, v, ray);
        if (t < (best?.t ?? Number.POSITIVE_INFINITY)) best = { handle: parked.handle, t };
      }
    }
    return best;
  }

  box(handle: ConsistHandle): WorldBox | null {
    const parked = this.parked.find((candidate) => candidate.handle === handle);
    const seat = parked?.seat;
    if (!parked || !seat) return null;
    const { boxes } = seat;
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

  standingFootprints(): ReadonlyArray<VehicleFootprint> {
    return this.parked.flatMap(({ members, seat }) =>
      seat ? this.seatFootprints(seat, trainLabel(members)) : [],
    );
  }

  seatFootprints(seat: RailSeat, label: string): ReadonlyArray<VehicleFootprint> {
    const { boxes, tops } = seat;
    const railTopY = this.track?.railTopY ?? 0;
    return seat.consist.vehicles.map((_, v) => {
      const o = v * BOX_FLOATS;
      const at = v * VEHICLE_POSE_FLOATS;
      const x = seat.poses[at] ?? 0;
      const z = seat.poses[at + 1] ?? 0;
      const c = Math.cos(seat.poses[at + 2] ?? 0);
      const s = Math.sin(seat.poses[at + 2] ?? 0);
      const pitch = rigidPitch(seat.poses, at, BODY);
      const cosPitch = Math.cos(pitch);
      const sinPitch = Math.sin(pitch);
      const y = this.vehicleY(seat, v) + rigidLift(seat.poses, at, BODY);
      const top = tops[v] ?? Number.NEGATIVE_INFINITY;
      let rear = Number.POSITIVE_INFINITY;
      let front = Number.NEGATIVE_INFINITY;
      let highest = Number.NEGATIVE_INFINITY;
      for (const along of [boxes[o] ?? 0, boxes[o + 3] ?? 0]) {
        for (const up of [boxes[o + 1] ?? 0, boxes[o + 4] ?? 0]) {
          const ahead = along * cosPitch - up * sinPitch;
          rear = Math.min(rear, ahead);
          front = Math.max(front, ahead);
        }
        highest = Math.max(highest, along * sinPitch + top * cosPitch);
      }
      const outline = this.aimScratch.outline(v);
      FOOTPRINT_CORNERS.forEach((corner, k) => {
        const u = corner & 1 ? front : rear;
        const w = boxes[o + (corner & 2 ? 5 : 2)] ?? 0;
        outline[2 * k] = x + c * u - s * w;
        outline[2 * k + 1] = z + s * u + c * w;
      });
      const underFront = rigidLift(seat.poses, at, FRONT_BOGIE);
      const underRear = rigidLift(seat.poses, at, REAR_BOGIE);
      return {
        outline,
        railTopLdu: railTopY + Math.min(underFront, underRear),
        topLdu: y + highest,
        label,
      };
    });
  }

  standingClash(
    parts: PosedParts,
    skip: ReadonlySet<number>,
    clash: PartClash,
    out: ClashOut,
  ): string | null {
    out.kind = "clear";
    out.part = NO_CLASH_PART;
    let label: string | null = null;
    for (let p = 0; p < this.parked.length; p++) {
      const parked = this.parked[p];
      const seat = parked?.seat;
      if (!parked || !seat) continue;
      clash.first(seat.solids, NO_SKIP, parts, skip, this.trainClash);
      const { kind } = this.trainClash;
      if (CLASH_RANK[kind] <= CLASH_RANK[out.kind]) continue;
      out.kind = kind;
      out.part = this.trainClash.part;
      label = trainLabel(parked.members);
      if (kind === "clash") return label;
    }
    return label;
  }

  standingOn(placement: number): ConsistHandle | null {
    return this.parked.find((parked) => parked.seat?.pieces.has(placement))?.handle ?? null;
  }

  trains(): ReadonlyArray<RailTrain> {
    return this.parked.flatMap(({ handle, members, seat }) =>
      seat ? [{ handle, members, head: seat.head, consist: seat.consist }] : [],
    );
  }

  park(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    for (const parked of this.parked) this.show(parked);
  }

  private restand(parked: Parked): void {
    parked.bodies?.dispose();
    parked.bodies = null;
    for (const remainder of parked.remainders) remainder.dispose();
    parked.remainders = [];
    parked.seat = null;
    const rails = this.track;
    const head = rails?.headOf(parked.handle.pose.anchor) ?? null;
    if (!rails || !head) return;
    const prepared = this.prepare(parked.members, rails);
    const label = trainLabel(parked.members);
    const stood =
      typeof prepared === "string" ? prepared : this.stand(label, prepared, rails, head);
    if (typeof stood === "string") return;
    parked.seat = stood;
    this.show(parked);
    parked.remainders = stood.remainders.map(
      (remainder) =>
        new StandingRemainderBody(
          this.backend,
          this.vehicleIds,
          stood.consist,
          remainder,
          stood.poses,
          stood.groundY,
        ),
    );
  }

  private show(parked: Parked): void {
    parked.bodies?.dispose();
    parked.bodies = null;
    const seat = parked.seat;
    if (this.hidden || !seat) return;
    parked.bodies = new ConsistBodies(this.backend, this.vehicleIds, seat.consist);
    parked.bodies.stand(seat.poses, this.track?.railTopY ?? 0);
  }

  private membersKey(members: ReadonlyArray<TrainMember>): string {
    return members
      .map(({ model, reversed }) => {
        let key = this.modelKeys.get(model);
        if (key === undefined) {
          key = this.nextModelKey++;
          this.modelKeys.set(model, key);
        }
        return reversed ? `${key}r` : `${key}`;
      })
      .join(",");
  }

  private prepare(members: ReadonlyArray<TrainMember>, rails: RailTrack): Prepared | string {
    const key = this.membersKey(members);
    const known = this.prepared.get(key);
    if (known !== undefined) return known;
    let prepared: Prepared | string;
    const label = trainLabel(members);
    try {
      const vehicles: ConsistVehicle[] = [];
      const vehicleModels: PlayModel[] = [];
      const boxes: Float64Array[] = [];
      const tops: number[] = [];
      const remainders: StandingRemainder[] = [];
      for (const { model, reversed } of members) {
        const own = consistVehicles(
          model.model,
          model.name,
          reversed,
          rails.rail,
          model.instanceBoxes,
        );
        const first = vehicles.length;
        for (const vehicle of own) {
          vehicles.push(vehicle);
          vehicleModels.push(model);
          tops.push(model.vehicleTops[vehicle.vehicle] ?? Number.NEGATIVE_INFINITY);
        }
        boxes.push(vehicleBoxes(model, own));
        const remainder = standingRemainder(model.model, own, model.instanceBoxes);
        if (remainder) remainders.push({ ...remainder, vehicle: first + remainder.vehicle });
      }
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
          ? `${label} can't run: ${problems.join("; ")}`
          : {
              vehicles,
              vehicleModels,
              geometry,
              geometryAt,
              straightLdu,
              boxes: joinedBoxes(boxes),
              tops: Float64Array.from(tops),
              solids: vehicleSolids(vehicles, vehicleModels, rails.railTopY),
              remainders,
            };
    } catch (error) {
      prepared = `${label} can't go on the rails: ${errorText(error)}`;
    }
    this.prepared.set(key, prepared);
    return prepared;
  }

  private stand(
    label: string,
    prepared: Prepared,
    rails: RailTrack,
    head: RailHead,
    scratch: AimScratch | null = null,
  ): RailSeat | string {
    const run = this.run;
    if (!run) return `${label} has no track to stand on.`;
    const network = rails.network;
    if (!run.standAt(head.edge, head.offsetLdu, prepared.straightLdu)) {
      return `${label} is longer than this loop of track.`;
    }
    const count = prepared.vehicles.length;
    const poses = scratch ? scratch.posesFor(count) : new Float64Array(count * VEHICLE_POSE_FLOATS);
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
      return this.tooLong(label, lengthLdu);
    }
    if (!run.standAt(head.edge, head.offsetLdu, lengthLdu)) {
      return `${label} is longer than this loop of track.`;
    }
    const pieces = new Set<number>();
    for (let i = 0; i < run.edgeCount; i++) {
      const edge = run.edge(i);
      if (edge !== NO_EDGE) pieces.add(rails.placementOf(edge));
    }
    const anchor = rails.anchorOf(head);
    if (!anchor) return `${label} can't stand on this track: no laid piece or model holds it.`;
    const consist: StandingConsist = {
      vehicles: prepared.vehicles,
      vehicleModels: prepared.vehicleModels,
      parts: this.catalog.parts(),
      colors: this.catalog.colors(),
    };
    const { remainders, boxes, tops } = prepared;
    const groundY = this.laidAt(pieces, rails);
    const solids = this.seatSolids(prepared.solids, poses, scratch);
    return {
      anchor,
      head,
      consist,
      poses,
      pieces,
      lengthLdu,
      remainders,
      groundY,
      boxes,
      tops,
      solids,
    };
  }

  private seatSolids(
    vehicle: VehicleSolids,
    poses: Float64Array,
    scratch: AimScratch | null,
  ): PosedParts {
    const count = vehicle.parts.length;
    scratch?.solidsFor(count);
    const matrices = scratch ? scratch.matrices : new Float64Array(count * SOLID_MATRIX_FLOATS);
    const boxes = scratch ? scratch.boxes : new Float64Array(count * SOLID_BOX_FLOATS);
    const bounds = scratch ? scratch.bounds : new Float64Array(SOLID_BOX_FLOATS);
    emptyBounds(bounds);
    const solids = this.catalog.partSolids();
    const frame = this.vehicleFrame;
    for (let e = 0; e < count; e++) {
      writeRigidFrame(
        poses,
        vehicle.vehicleAt[e] ?? 0,
        vehicle.rigid[e] ?? 0,
        vehicle.lift,
        e,
        frame,
        0,
      );
      const m = e * SOLID_MATRIX_FLOATS;
      const b = e * SOLID_BOX_FLOATS;
      composeAffine(frame, 0, vehicle.local, m, matrices, m);
      posedBoxBounds(matrices, m, solids.box(vehicle.parts[e] ?? 0), 0, boxes, b);
      growBounds(bounds, boxes, b);
    }
    return { count, partIndex: vehicle.parts, matrices, boxes, bounds };
  }

  private laidAt(pieces: ReadonlySet<number>, rails: RailTrack): number {
    let plates = Number.POSITIVE_INFINITY;
    for (const piece of pieces) plates = Math.min(plates, rails.play.layout.yPlates(piece));
    if (plates === Number.POSITIVE_INFINITY) throw new Error("a standing train covers no track");
    return plates * PLATE_LDU;
  }

  private tooLong(label: string, lengthLdu: number): string {
    return `${label} is ${studs(lengthLdu)} studs long and doesn't fit on this run of track.`;
  }

  private holderOf(pieces: ReadonlySet<number>, except: Parked | null): Parked | null {
    for (const parked of this.parked) {
      if (!parked.seat || parked === except) continue;
      for (const piece of pieces) if (parked.seat.pieces.has(piece)) return parked;
    }
    return null;
  }

  private vehicleY(seat: RailSeat, v: number): number {
    return (this.track?.railTopY ?? 0) - (seat.consist.vehicles[v]?.railTopY ?? 0);
  }

  private vehicleHit(seat: RailSeat, boxes: Float64Array, v: number, ray: Float64Array): number {
    const o = v * BOX_FLOATS;
    const frame = this.vehicleFrame;
    this.vehicleBase[0] = this.vehicleY(seat, v);
    writeRigidFrame(seat.poses, v * VEHICLE_POSE_FLOATS, BODY, this.vehicleBase, 0, frame, 0);
    const px = (ray[RAY_ORIGIN] ?? 0) - (frame[3] ?? 0);
    const py = (ray[RAY_ORIGIN + 1] ?? 0) - (frame[7] ?? 0);
    const pz = (ray[RAY_ORIGIN + 2] ?? 0) - (frame[11] ?? 0);
    const dx = ray[RAY_DIRECTION] ?? 0;
    const dy = ray[RAY_DIRECTION + 1] ?? 0;
    const dz = ray[RAY_DIRECTION + 2] ?? 0;
    const local = (axis: number, x: number, y: number, z: number): number =>
      (frame[axis] ?? 0) * x + (frame[4 + axis] ?? 0) * y + (frame[8 + axis] ?? 0) * z;
    const origin = [local(0, px, py, pz), local(1, px, py, pz), local(2, px, py, pz)];
    const direction = [local(0, dx, dy, dz), local(1, dx, dy, dz), local(2, dx, dy, dz)];
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
