import type { PartAsset, PartModel, PartVehicle } from "@brr/catalog";
import {
  GEOMETRY_FIELDS,
  nearestTrackPoint,
  packGeometry,
  placementsUnder,
  pointEdge,
  pointOffset,
  RunningGearPoser,
  runningGearSpanProblem,
  simTrackFromGraph,
  clearBehind,
  fitTrain,
  trainsOverlap,
  TRACK_POINT_FLOATS,
  TrackGraph,
  TrainPath,
  VEHICLE_POSE_FLOATS,
  type SimTrack,
  type TrackLayout,
} from "@brr/domain";
import { STUD_LDU } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS, type ChunkInstances, type WorldBox } from "@brr/render";
import type { TrackPiece } from "@brr/schema/bundle";
import type { Decoded, Issue } from "@brr/schema/decode";
import type { TrackRecordV1, TrainRecordV1 } from "@brr/schema/world";
import { consistVehicles, type ConsistVehicle, type RigidBodyInstances } from "../sim/consist.ts";
import { routeSegments, simTopology } from "../sim/sim-track-input.ts";
import { withStuds } from "../scene/stud-stream.ts";
import type { ColorTable, ModelCredit } from "../scene/viewer-scene.ts";
import type { Refusal } from "./placement-messages.ts";

export const ROLLING_STOCK_PREFIX = "rolling-stock:";
export const ROLLING_STOCK_PICK_LDU = 3 * STUD_LDU;

export interface RollingStockSource {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly credit: ModelCredit;
  readonly model: PartModel;
  readonly vehicles: ReadonlyArray<PartVehicle>;
}

export interface TrainCar {
  readonly model: string;
  readonly reversed: boolean;
}

export interface TrainAnchor {
  readonly piece: string;
  readonly route: number;
  readonly forward: boolean;
  readonly offsetLdu: number;
}

export interface TrainPlan {
  readonly anchor: TrainAnchor;
  readonly cars: ReadonlyArray<TrainCar>;
}

export interface PlacedTrain extends TrainPlan {
  readonly id: number;
}

export interface TrainEdit {
  readonly id: number;
  readonly before: TrainPlan | null;
  readonly after: TrainPlan | null;
}

export interface RollingStockItem {
  readonly id: string;
  readonly label: string;
  readonly parts: number;
  readonly vehicles: number;
  readonly lengthStuds: number;
  readonly widthStuds: number;
  readonly problem: string | null;
}

export interface TrainVehicleView {
  readonly model: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

export interface TrainView {
  readonly id: number;
  readonly label: string;
  readonly cars: ReadonlyArray<TrainCar>;
  readonly track: number;
  readonly route: number;
  readonly forward: boolean;
  readonly offsetLdu: number;
  readonly lengthStuds: number;
  readonly vehicles: ReadonlyArray<TrainVehicleView>;
  readonly axleOffCentreLdu: number;
}

export type TrainGhostState = "on-track" | "off-track";

export interface TrainGhostView {
  readonly item: string;
  readonly state: TrainGhostState;
  readonly refusal: Refusal | null;
  readonly couplesTo: number | null;
  readonly track: number | null;
  readonly route: number | null;
  readonly forward: boolean | null;
  readonly offsetLdu: number | null;
}

interface RigidChunks {
  readonly body: ChunkInstances;
  readonly front: ChunkInstances | null;
  readonly rear: ChunkInstances | null;
  readonly box: Float64Array;
}

interface StockVehicle {
  readonly vehicle: ConsistVehicle;
  readonly chunks: RigidChunks;
}

interface RollingStockModel {
  readonly source: string;
  readonly item: RollingStockItem;
  readonly forward: ReadonlyArray<StockVehicle>;
  readonly reversed: ReadonlyArray<StockVehicle>;
}

interface Posed {
  readonly vehicles: ReadonlyArray<StockVehicle>;
  readonly lengthLdu: number;
  readonly edge: number;
  readonly poses: Float64Array;
}

interface DrawnTrain {
  readonly ids: ReadonlyArray<number>;
  readonly posed: Posed;
  readonly box: WorldBox;
}

const NO_ID = -1;
const POSE_BODY_X = 0;
const POSE_BODY_Z = 1;
const POSE_BODY_YAW = 2;
const POSE_FRONT = 3;
const POSE_REAR = 6;

function bodyBox(rigid: RigidBodyInstances, model: PartModel, parts: ReadonlyArray<PartAsset>) {
  const box = Float64Array.of(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  );
  for (let k = 0; k < rigid.instances.length; k++) {
    const part = parts[model.partIndex[rigid.instances[k] ?? 0] ?? 0];
    if (!part) continue;
    const m = rigid.matrices;
    const o = k * INSTANCE_MATRIX_FLOATS;
    for (let axis = 0; axis < 3; axis++) {
      let lo = m[o + axis * 4 + 3] ?? 0;
      let hi = lo;
      for (let j = 0; j < 3; j++) {
        const c = m[o + axis * 4 + j] ?? 0;
        lo += Math.min(c * (part.boundsMin[j] ?? 0), c * (part.boundsMax[j] ?? 0));
        hi += Math.max(c * (part.boundsMin[j] ?? 0), c * (part.boundsMax[j] ?? 0));
      }
      box[axis] = Math.min(box[axis] ?? 0, lo);
      box[axis + 3] = Math.max(box[axis + 3] ?? 0, hi);
    }
  }
  return box;
}

function rigidChunk(
  rigid: RigidBodyInstances,
  model: PartModel,
  parts: ReadonlyArray<PartAsset>,
  colors: ColorTable,
): ChunkInstances {
  const count = rigid.instances.length;
  const partIndex = new Uint16Array(count);
  const colorIndex = new Uint16Array(count);
  for (let k = 0; k < count; k++) {
    const i = rigid.instances[k] ?? 0;
    partIndex[k] = model.partIndex[i] ?? 0;
    colorIndex[k] = colors.indexOfCode(model.ldrawColor[i] ?? 0);
  }
  return withStuds(
    { originX: 0, originZ: 0, count, partIndex, colorIndex, matrices: rigid.matrices },
    parts,
    colors,
    undefined,
  );
}

function stockVehicles(
  source: RollingStockSource,
  reversed: boolean,
  railPart: string,
  parts: ReadonlyArray<PartAsset>,
  colors: ColorTable,
): StockVehicle[] {
  return consistVehicles(source.model, source.name, reversed, railPart, source.vehicles).map(
    (vehicle) => {
      const problem = runningGearSpanProblem(vehicle.spec);
      if (problem) throw new Error(`its running gear can't run: ${problem}`);
      const chunk = (rigid: RigidBodyInstances | null): ChunkInstances | null =>
        rigid ? rigidChunk(rigid, source.model, parts, colors) : null;
      return {
        vehicle,
        chunks: {
          body: rigidChunk(vehicle.body, source.model, parts, colors),
          front: chunk(vehicle.frontBogie),
          rear: chunk(vehicle.rearBogie),
          box: bodyBox(vehicle.body, source.model, parts),
        },
      };
    },
  );
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\.+$/, "");
}

export function rollingStockModel(
  source: RollingStockSource,
  railPart: string,
  parts: ReadonlyArray<PartAsset>,
  colors: ColorTable,
): RollingStockModel {
  const item = (problem: string | null, lengthLdu: number, widthLdu: number): RollingStockItem => ({
    id: `${ROLLING_STOCK_PREFIX}${source.id}`,
    label: source.label,
    parts: source.model.instanceCount,
    vehicles: source.vehicles.length,
    lengthStuds: lengthLdu / STUD_LDU,
    widthStuds: Math.round(widthLdu / STUD_LDU),
    problem,
  });
  try {
    const forward = stockVehicles(source, false, railPart, parts, colors);
    const reversed = stockVehicles(source, true, railPart, parts, colors);
    const lengthLdu = forward.reduce((sum, v) => sum + v.vehicle.spec.lengthLdu, 0);
    const widthLdu = Math.max(
      ...forward.map((v) => (v.chunks.box[5] ?? 0) - (v.chunks.box[2] ?? 0)),
    );
    return { source: source.id, item: item(null, lengthLdu, widthLdu), forward, reversed };
  } catch (error) {
    return { source: source.id, item: item(errorText(error), 0, 0), forward: [], reversed: [] };
  }
}

function pieceKey(layout: TrackLayout, placement: number): string {
  const pose = layout.pose(placement);
  return `${layout.yPlates(placement)}:${pose.heading}:${pose.position.join(",")}`;
}

class Rails {
  readonly graph: TrackGraph;
  readonly track: SimTrack;
  readonly routePlacement: Int32Array;
  private readonly routeStart: Int32Array;
  private readonly keys: string[] = [];
  private readonly byKey = new Map<string, number>();

  constructor(
    readonly layout: TrackLayout,
    pieces: ReadonlyArray<TrackPiece>,
  ) {
    this.graph = new TrackGraph(layout);
    this.track = simTrackFromGraph(
      simTopology(this.graph),
      routeSegments(this.graph, layout, pieces),
    ).track;
    const routes = this.graph.edgeCount / 2;
    this.routePlacement = new Int32Array(routes);
    for (let route = 0; route < routes; route++) {
      this.routePlacement[route] = this.graph.edgePlacement[route * 2] ?? 0;
    }
    this.routeStart = new Int32Array(layout.count + 1);
    for (let p = 0; p < layout.count; p++) {
      const key = pieceKey(layout, p);
      this.keys.push(key);
      this.byKey.set(key, p);
      this.routeStart[p + 1] =
        (this.routeStart[p] ?? 0) + (layout.pieces[layout.piece(p)]?.routes.length ?? 0);
    }
  }

  placementOf(key: string): number | null {
    return this.byKey.get(key) ?? null;
  }

  routesOf(placement: number): number {
    return (this.routeStart[placement + 1] ?? 0) - (this.routeStart[placement] ?? 0);
  }

  edgeOf(anchor: TrainAnchor): number | null {
    const placement = this.placementOf(anchor.piece);
    if (placement === null || anchor.route >= this.routesOf(placement)) return null;
    const route = (this.routeStart[placement] ?? 0) + anchor.route;
    return route * 2 + (anchor.forward ? 0 : 1);
  }

  anchorOf(edge: number, offsetLdu: number): TrainAnchor {
    const placement = this.graph.edgePlacement[edge] ?? 0;
    return {
      piece: this.keys[placement] ?? "",
      route: this.graph.edgeRoute[edge] ?? 0,
      forward: edge % 2 === 0,
      offsetLdu,
    };
  }
}

function rotatedBox(
  box: Float64Array,
  x: number,
  y: number,
  z: number,
  yaw: number,
  into: [number, number, number, number, number, number],
): void {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  for (const u of [box[0] ?? 0, box[3] ?? 0]) {
    for (const v of [box[2] ?? 0, box[5] ?? 0]) {
      const wx = x + u * cos - v * sin;
      const wz = z + u * sin + v * cos;
      into[0] = Math.min(into[0], wx);
      into[2] = Math.min(into[2], wz);
      into[3] = Math.max(into[3], wx);
      into[5] = Math.max(into[5], wz);
    }
  }
  into[1] = Math.min(into[1], y + (box[1] ?? 0));
  into[4] = Math.max(into[4], y + (box[4] ?? 0));
}

function rayHitsBox(ray: Float64Array, box: WorldBox): number {
  let near = 0;
  let far = Number.POSITIVE_INFINITY;
  const lo = [box.minX, box.minY, box.minZ];
  const hi = [box.maxX, box.maxY, box.maxZ];
  for (let axis = 0; axis < 3; axis++) {
    const origin = ray[axis] ?? 0;
    const direction = ray[axis + 3] ?? 0;
    const min = lo[axis] ?? 0;
    const max = hi[axis] ?? 0;
    if (direction === 0) {
      if (origin < min || origin > max) return Number.POSITIVE_INFINITY;
      continue;
    }
    const a = (min - origin) / direction;
    const b = (max - origin) / direction;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return Number.POSITIVE_INFINITY;
  }
  return near;
}

function writePosed(
  out: Float32Array,
  at: number,
  matrices: Float32Array,
  count: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
): void {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  for (let k = 0; k < count; k++) {
    const i = k * INSTANCE_MATRIX_FLOATS;
    const o = (at + k) * INSTANCE_MATRIX_FLOATS;
    for (let col = 0; col < 4; col++) {
      const u = matrices[i + col] ?? 0;
      const w = matrices[i + 8 + col] ?? 0;
      const shift = col === 3;
      out[o + col] = u * cos - w * sin + (shift ? x : 0);
      out[o + 4 + col] = (matrices[i + 4 + col] ?? 0) + (shift ? y : 0);
      out[o + 8 + col] = u * sin + w * cos + (shift ? z : 0);
    }
  }
}

export class RollingStock {
  private readonly models = new Map<string, RollingStockModel>();
  private rails: Rails | null = null;
  private path: TrainPath | null = null;
  private readonly placed = new Map<number, PlacedTrain>();
  private readonly drawn = new Map<number, DrawnTrain>();
  private readonly poser = new RunningGearPoser();
  private readonly scratch = new Float64Array(2);
  private readonly point = new Float64Array(TRACK_POINT_FLOATS);
  private nextTrain = 1;
  private nextVehicle = 1;

  constructor(
    models: ReadonlyArray<RollingStockModel>,
    private readonly railTopLdu: number,
    private readonly parts: ReadonlyArray<PartAsset>,
    private readonly colors: ColorTable,
    private readonly draw: {
      readonly setVehicle: (id: number, chunk: ChunkInstances) => void;
      readonly setVehiclePose: (id: number, x: number, y: number, z: number, yaw: number) => void;
      readonly deleteVehicle: (id: number) => void;
    },
  ) {
    for (const model of models) this.models.set(model.source, model);
  }

  items(): ReadonlyArray<RollingStockItem> {
    return [...this.models.values()].map((model) => model.item);
  }

  item(id: string): RollingStockItem | null {
    if (!id.startsWith(ROLLING_STOCK_PREFIX)) return null;
    return this.models.get(id.slice(ROLLING_STOCK_PREFIX.length))?.item ?? null;
  }

  get count(): number {
    return this.placed.size;
  }

  trains(): ReadonlyArray<PlacedTrain> {
    return [...this.placed.values()];
  }

  setTrack(layout: TrackLayout, pieces: ReadonlyArray<TrackPiece>): void {
    this.rails = new Rails(layout, pieces);
    this.path = new TrainPath(this.rails.track);
    for (const train of this.placed.values()) this.redraw(train);
  }

  clear(): void {
    for (const id of this.placed.keys()) this.undraw(id);
    this.placed.clear();
    this.nextTrain = 1;
  }

  private vehiclesOf(cars: ReadonlyArray<TrainCar>): StockVehicle[] | null {
    const vehicles: StockVehicle[] = [];
    for (const car of cars) {
      const model = this.models.get(car.model);
      if (!model || model.item.problem !== null) return null;
      vehicles.push(...(car.reversed ? model.reversed : model.forward));
    }
    return vehicles;
  }

  private label(cars: ReadonlyArray<TrainCar>): string {
    return cars.map((car) => this.models.get(car.model)?.item.label ?? car.model).join(" + ");
  }

  private stand(plan: TrainPlan, path: TrainPath): Posed | Refusal {
    const rails = this.rails;
    const vehicles = this.vehiclesOf(plan.cars);
    const label = this.label(plan.cars);
    if (!vehicles) return { rule: "rolling-stock", message: `${label} is not in the catalog.` };
    const edge = rails?.edgeOf(plan.anchor) ?? null;
    if (!rails || edge === null) {
      return {
        rule: "rolling-stock",
        message: `${label} stands on a track piece that is no longer laid.`,
      };
    }
    const lengthLdu = vehicles.reduce((sum, v) => sum + v.vehicle.spec.lengthLdu, 0);
    if (!path.stand(edge, plan.anchor.offsetLdu, lengthLdu)) {
      return {
        rule: "rolling-stock",
        message: `${label} doesn't fit on the track behind its head: it needs ${studs(lengthLdu)} of track in one line, without an open end or a switch to choose at.`,
      };
    }
    const count = vehicles.length;
    const geometry = new Float64Array(count * GEOMETRY_FIELDS);
    const geometryAt = new Int32Array(count);
    vehicles.forEach((v, k) => {
      const spec = v.vehicle.spec;
      if (!spec.geometry) throw new Error(`${label} has a vehicle without measured geometry`);
      geometryAt[k] = k * GEOMETRY_FIELDS;
      packGeometry(spec.geometry, geometry, k * GEOMETRY_FIELDS);
    });
    const poses = new Float64Array(count * VEHICLE_POSE_FLOATS);
    this.poser.writeTrain(path, geometry, geometryAt, 0, count, false, null, 0, poses, 0);
    return { vehicles, lengthLdu, edge, poses };
  }

  private clashes(plan: Posed, path: TrainPath, ignore: number | null): PlacedTrain | null {
    const rails = this.rails;
    if (!rails) return null;
    const other = new TrainPath(rails.track);
    for (const train of this.placed.values()) {
      if (train.id === ignore) continue;
      const drawn = this.drawn.get(train.id);
      const edge = rails.edgeOf(train.anchor);
      if (!drawn || edge === null) continue;
      if (!other.stand(edge, train.anchor.offsetLdu, drawn.posed.lengthLdu)) continue;
      if (trainsOverlap(path, plan.lengthLdu, other, drawn.posed.lengthLdu, rails.routePlacement)) {
        return train;
      }
    }
    return null;
  }

  check(plan: TrainPlan, ignore: number | null): Refusal | null {
    const rails = this.rails;
    if (!rails) return offTrack(this.label(plan.cars));
    const path = new TrainPath(rails.track);
    const posed = this.stand(plan, path);
    if (!("poses" in posed)) return posed;
    const clash = this.clashes(posed, path, ignore);
    return clash ? clashRefusal(this.label(plan.cars), this.label(clash.cars)) : null;
  }

  ghost(
    modelId: string,
    facingBackward: boolean,
    x: number,
    z: number,
  ): {
    readonly view: TrainGhostView;
    readonly plan: TrainPlan | null;
    readonly edit: TrainEdit | null;
  } {
    const model = this.models.get(modelId);
    const rails = this.rails;
    const path = this.path;
    const label = model?.item.label ?? modelId;
    const offTrackView = (refusal: Refusal): TrainGhostView => ({
      item: `${ROLLING_STOCK_PREFIX}${modelId}`,
      state: "off-track",
      refusal,
      couplesTo: null,
      track: null,
      route: null,
      forward: null,
      offsetLdu: null,
    });
    if (!model) return { view: offTrackView(offTrack(label)), plan: null, edit: null };
    if (model.item.problem !== null) {
      return {
        view: offTrackView({
          rule: "rolling-stock",
          message: `${label} can't be placed: ${model.item.problem}.`,
        }),
        plan: null,
        edit: null,
      };
    }
    if (
      !rails ||
      !path ||
      !nearestTrackPoint(rails.track, x, z, ROLLING_STOCK_PICK_LDU, this.scratch, this.point)
    ) {
      return { view: offTrackView(offTrack(label)), plan: null, edit: null };
    }
    const route = pointEdge(this.point) >> 1;
    const along = pointOffset(this.point);
    const coupling = this.couplingAt(model, route, along, facingBackward);
    const car: TrainCar = { model: modelId, reversed: coupling?.reversed ?? false };
    let plan: TrainPlan;
    let edit: TrainEdit;
    if (coupling) {
      plan = { anchor: coupling.train.anchor, cars: [...coupling.train.cars, car] };
      edit = { id: coupling.train.id, before: coupling.train, after: plan };
    } else {
      const edge = route * 2 + (facingBackward ? 1 : 0);
      const length = rails.track.edgeLength[edge] ?? 0;
      const offset = facingBackward ? length - along : along;
      const fit = fitTrain(rails.track, path, edge, offset, model.item.lengthStuds * STUD_LDU);
      if (fit.kind === "short") {
        const refusal: Refusal = {
          rule: "rolling-stock",
          message: `${label} needs ${studs(model.item.lengthStuds * STUD_LDU)} of track in one line, without an open end or a switch to choose at; the track here gives ${studs(fit.clearLdu)}.`,
        };
        return { view: { ...offTrackView(refusal), state: "on-track" }, plan: null, edit: null };
      }
      plan = { anchor: rails.anchorOf(fit.edge, fit.offsetLdu), cars: [car] };
      edit = { id: this.nextTrain, before: null, after: plan };
    }
    const refusal = this.check(plan, coupling?.train.id ?? null);
    const placement = rails.placementOf(plan.anchor.piece);
    return {
      view: {
        item: `${ROLLING_STOCK_PREFIX}${modelId}`,
        state: "on-track",
        refusal,
        couplesTo: coupling?.train.id ?? null,
        track: placement,
        route: plan.anchor.route,
        forward: plan.anchor.forward,
        offsetLdu: plan.anchor.offsetLdu,
      },
      plan,
      edit: refusal ? null : edit,
    };
  }

  private couplingAt(
    model: RollingStockModel,
    route: number,
    along: number,
    facingBackward: boolean,
  ): { readonly train: PlacedTrain; readonly reversed: boolean } | null {
    const rails = this.rails;
    if (!rails) return null;
    const path = new TrainPath(rails.track);
    const carLength = model.item.lengthStuds * STUD_LDU;
    for (const train of this.placed.values()) {
      const drawn = this.drawn.get(train.id);
      const edge = rails.edgeOf(train.anchor);
      if (!drawn || edge === null) continue;
      const reach = drawn.posed.lengthLdu + carLength + ROLLING_STOCK_PICK_LDU;
      const clear = clearBehind(rails.track, edge, train.anchor.offsetLdu, reach);
      if (!path.stand(edge, train.anchor.offsetLdu, Math.min(reach, clear))) continue;
      const behind = path.distanceBehind(route, along);
      if (behind <= drawn.posed.lengthLdu || behind > reach) continue;
      let trainForward = true;
      for (let k = 0; k < path.edgeCount; k++) {
        if (path.edge(k) >> 1 === route) trainForward = path.edge(k) % 2 === 0;
      }
      return { train, reversed: trainForward === facingBackward };
    }
    return null;
  }

  ghostChunk(
    plan: TrainPlan,
    fromCar: number,
  ): { chunk: ChunkInstances; x: number; z: number } | null {
    const rails = this.rails;
    if (!rails) return null;
    const path = new TrainPath(rails.track);
    const posed = this.stand(plan, path);
    if (!("poses" in posed)) return null;
    let first = 0;
    for (let c = 0; c < fromCar; c++) {
      const model = this.models.get(plan.cars[c]?.model ?? "");
      first += model ? model.forward.length : 0;
    }
    return this.bake(posed, first);
  }

  freeChunk(modelId: string, facingBackward: boolean, x: number, z: number) {
    const model = this.models.get(modelId);
    if (!model || model.item.problem !== null) return null;
    const vehicles = facingBackward ? model.reversed : model.forward;
    const poses = new Float64Array(vehicles.length * VEHICLE_POSE_FLOATS);
    let ahead = 0;
    vehicles.forEach((v, k) => {
      const geometry = v.vehicle.spec.geometry;
      const o = k * VEHICLE_POSE_FLOATS;
      poses[o + POSE_BODY_X] = x - ahead - (geometry?.frontCoupler.xLdu ?? 0);
      poses[o + POSE_BODY_Z] = z;
      for (const at of [POSE_FRONT, POSE_REAR]) {
        const pivot = at === POSE_FRONT ? geometry?.front : geometry?.rear;
        poses[o + at] = (poses[o + POSE_BODY_X] ?? 0) + (pivot?.pivotXLdu ?? 0);
        poses[o + at + 1] = z + (pivot?.pivotZLdu ?? 0);
      }
      ahead += v.vehicle.spec.lengthLdu;
    });
    return this.bake({ vehicles, lengthLdu: ahead, edge: NO_ID, poses }, 0);
  }

  private bake(posed: Posed, first: number): { chunk: ChunkInstances; x: number; z: number } {
    const o0 = first * VEHICLE_POSE_FLOATS;
    const originX = posed.poses[o0 + POSE_BODY_X] ?? 0;
    const originZ = posed.poses[o0 + POSE_BODY_Z] ?? 0;
    let count = 0;
    for (let k = first; k < posed.vehicles.length; k++) {
      const c = posed.vehicles[k]?.chunks;
      count += (c?.body.count ?? 0) + (c?.front?.count ?? 0) + (c?.rear?.count ?? 0);
    }
    const partIndex = new Uint16Array(count);
    const colorIndex = new Uint16Array(count);
    const matrices = new Float32Array(count * INSTANCE_MATRIX_FLOATS);
    let at = 0;
    for (let k = first; k < posed.vehicles.length; k++) {
      const v = posed.vehicles[k];
      if (!v) continue;
      const o = k * VEHICLE_POSE_FLOATS;
      const y = this.railTopLdu - v.vehicle.railTopY;
      const bodies: Array<readonly [ChunkInstances | null, number]> = [
        [v.chunks.body, o + POSE_BODY_X],
        [v.chunks.front, o + POSE_FRONT],
        [v.chunks.rear, o + POSE_REAR],
      ];
      for (const [chunk, p] of bodies) {
        if (!chunk) continue;
        partIndex.set(chunk.partIndex, at);
        colorIndex.set(chunk.colorIndex, at);
        writePosed(
          matrices,
          at,
          chunk.matrices,
          chunk.count,
          (posed.poses[p] ?? 0) - originX,
          y,
          (posed.poses[p + 1] ?? 0) - originZ,
          posed.poses[p + 2] ?? 0,
        );
        at += chunk.count;
      }
    }
    return {
      chunk: withStuds(
        { originX: 0, originZ: 0, count, partIndex, colorIndex, matrices },
        this.parts,
        this.colors,
        undefined,
      ),
      x: originX,
      z: originZ,
    };
  }

  apply(edit: TrainEdit, backwards: boolean): void {
    const to = backwards ? edit.before : edit.after;
    this.undraw(edit.id);
    this.placed.delete(edit.id);
    if (to) {
      const train: PlacedTrain = { id: edit.id, anchor: to.anchor, cars: to.cars };
      this.placed.set(edit.id, train);
      this.redraw(train);
    }
    this.nextTrain = Math.max(this.nextTrain, edit.id + 1);
  }

  replayRefusal(edit: TrainEdit, backwards: boolean): Refusal | null {
    const to = backwards ? edit.before : edit.after;
    return to ? this.check(to, edit.id) : null;
  }

  removal(id: number): TrainEdit | null {
    const train = this.placed.get(id);
    return train ? { id, before: train, after: null } : null;
  }

  private undraw(id: number): void {
    const drawn = this.drawn.get(id);
    if (!drawn) return;
    for (const vehicle of drawn.ids) this.draw.deleteVehicle(vehicle);
    this.drawn.delete(id);
  }

  private redraw(train: PlacedTrain): void {
    this.undraw(train.id);
    const rails = this.rails;
    if (!rails) return;
    const path = new TrainPath(rails.track);
    const posed = this.stand(train, path);
    if (!("poses" in posed)) return;
    const ids: number[] = [];
    const box: [number, number, number, number, number, number] = [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    posed.vehicles.forEach((v, k) => {
      const o = k * VEHICLE_POSE_FLOATS;
      const y = this.railTopLdu - v.vehicle.railTopY;
      const show = (chunk: ChunkInstances | null, p: number): void => {
        if (!chunk) return;
        const id = this.nextVehicle++;
        this.draw.setVehicle(id, chunk);
        this.draw.setVehiclePose(
          id,
          posed.poses[p] ?? 0,
          y,
          posed.poses[p + 1] ?? 0,
          posed.poses[p + 2] ?? 0,
        );
        ids.push(id);
      };
      show(v.chunks.body, o + POSE_BODY_X);
      show(v.chunks.front, o + POSE_FRONT);
      show(v.chunks.rear, o + POSE_REAR);
      rotatedBox(
        v.chunks.box,
        posed.poses[o + POSE_BODY_X] ?? 0,
        y,
        posed.poses[o + POSE_BODY_Z] ?? 0,
        posed.poses[o + POSE_BODY_YAW] ?? 0,
        box,
      );
    });
    this.drawn.set(train.id, {
      ids,
      posed,
      box: { minX: box[0], minY: box[1], minZ: box[2], maxX: box[3], maxY: box[4], maxZ: box[5] },
    });
  }

  trainAt(ray: Float64Array): { readonly id: number; readonly t: number } | null {
    let best: { id: number; t: number } | null = null;
    for (const [id, drawn] of this.drawn) {
      const t = rayHitsBox(ray, drawn.box);
      if (t < (best?.t ?? Number.POSITIVE_INFINITY)) best = { id, t };
    }
    return best;
  }

  box(id: number): WorldBox | null {
    return this.drawn.get(id)?.box ?? null;
  }

  trainLabel(id: number): string {
    const train = this.placed.get(id);
    return train ? this.label(train.cars) : "";
  }

  trainsOn(placement: number): ReadonlyArray<string> {
    const rails = this.rails;
    if (!rails) return [];
    const path = new TrainPath(rails.track);
    const labels: string[] = [];
    for (const train of this.placed.values()) {
      const drawn = this.drawn.get(train.id);
      const edge = rails.edgeOf(train.anchor);
      if (!drawn || edge === null) continue;
      if (!path.stand(edge, train.anchor.offsetLdu, drawn.posed.lengthLdu)) continue;
      if (placementsUnder(path, drawn.posed.lengthLdu, rails.routePlacement).has(placement)) {
        labels.push(this.label(train.cars));
      }
    }
    return labels;
  }

  anchorPiece(plan: TrainPlan): number | null {
    return this.rails?.placementOf(plan.anchor.piece) ?? null;
  }

  views(): ReadonlyArray<TrainView> {
    const rails = this.rails;
    if (!rails) return [];
    return [...this.placed.values()].flatMap((train) => {
      const drawn = this.drawn.get(train.id);
      const track = rails.placementOf(train.anchor.piece);
      if (!drawn || track === null) return [];
      const { posed } = drawn;
      return [
        {
          id: train.id,
          label: this.label(train.cars),
          cars: train.cars,
          track,
          route: train.anchor.route,
          forward: train.anchor.forward,
          offsetLdu: train.anchor.offsetLdu,
          lengthStuds: posed.lengthLdu / STUD_LDU,
          vehicles: posed.vehicles.map((v, k) => {
            const o = k * VEHICLE_POSE_FLOATS;
            return {
              model: v.vehicle.model,
              x: posed.poses[o + POSE_BODY_X] ?? 0,
              y: this.railTopLdu - v.vehicle.railTopY,
              z: posed.poses[o + POSE_BODY_Z] ?? 0,
              yaw: posed.poses[o + POSE_BODY_YAW] ?? 0,
            };
          }),
          axleOffCentreLdu: this.axleOffCentre(posed, rails.track),
        },
      ];
    });
  }

  private axleOffCentre(posed: Posed, track: SimTrack): number {
    let worst = 0;
    const point = new Float64Array(TRACK_POINT_FLOATS);
    const scratch = new Float64Array(2);
    posed.vehicles.forEach((v, k) => {
      const geometry = v.vehicle.spec.geometry;
      if (!geometry) return;
      const o = k * VEHICLE_POSE_FLOATS;
      for (const [guide, at] of [
        [geometry.front, POSE_FRONT],
        [geometry.rear, POSE_REAR],
      ] as const) {
        const px = posed.poses[o + at] ?? 0;
        const pz = posed.poses[o + at + 1] ?? 0;
        const yaw = posed.poses[o + at + 2] ?? 0;
        const axles = guide.pivots ? [guide.leadAxleXLdu, guide.trailAxleXLdu] : [guide.pivotXLdu];
        for (const axleX of axles) {
          const u = axleX - guide.pivotXLdu;
          const w = guide.pivots ? guide.axleZLdu - guide.pivotZLdu : 0;
          const ax = px + u * Math.cos(yaw) - w * Math.sin(yaw);
          const az = pz + u * Math.sin(yaw) + w * Math.cos(yaw);
          nearestTrackPoint(track, ax, az, Number.POSITIVE_INFINITY, scratch, point);
          worst = Math.max(worst, point[2] ?? 0);
        }
      }
    });
    return worst;
  }

  records(track: ReadonlyArray<TrackRecordV1>): TrainRecordV1[] {
    const rails = this.rails;
    if (!rails) return [];
    return [...this.placed.values()].flatMap((train) => {
      const placement = rails.placementOf(train.anchor.piece);
      const record = placement === null ? undefined : track[placement];
      if (!record) return [];
      return [
        {
          track: record.index,
          route: train.anchor.route,
          forward: train.anchor.forward,
          offsetLdu: train.anchor.offsetLdu,
          cars: train.cars.map((car) => ({
            ref: car.model,
            reversed: car.reversed,
          })),
        },
      ];
    });
  }

  restore(records: ReadonlyArray<TrainRecordV1>): Decoded<number> {
    const rails = this.rails;
    const issues: Issue[] = [];
    const plans: TrainPlan[] = [];
    records.forEach((record, index) => {
      const path = `train ${index + 1}`;
      if (!rails || record.track >= rails.layout.count) {
        issues.push({ path, message: `stands on track piece ${record.track}, which isn't laid` });
        return;
      }
      const unknown = record.cars.find((car) => !this.models.has(car.ref));
      if (unknown) {
        issues.push({
          path,
          message: `"${unknown.ref}" isn't rolling stock in this app's catalog`,
        });
        return;
      }
      plans.push({
        anchor: {
          piece: pieceKey(rails.layout, record.track),
          route: record.route,
          forward: record.forward,
          offsetLdu: record.offsetLdu,
        },
        cars: record.cars.map((car) => ({ model: car.ref, reversed: car.reversed })),
      });
    });
    if (issues.length > 0) return { ok: false, issues };
    for (const plan of plans) {
      const refusal = this.check(plan, null);
      if (refusal) {
        issues.push({ path: `train ${this.placed.size + 1}`, message: refusal.message });
        continue;
      }
      this.apply({ id: this.nextTrain, before: null, after: plan }, false);
    }
    if (issues.length > 0) {
      this.clear();
      return { ok: false, issues };
    }
    return { ok: true, value: this.placed.size };
  }
}

function studs(ldu: number): string {
  return `${Number((ldu / STUD_LDU).toFixed(1))} studs`;
}

function offTrack(label: string): Refusal {
  return {
    rule: "rolling-stock",
    message: `${label} rests only on track: there's no laid track under the cursor. Rolling stock can't stand on studs, baseplates or the table.`,
  };
}

function clashRefusal(label: string, other: string): Refusal {
  return {
    rule: "rolling-stock",
    message: `${label} would stand on track that ${other} already occupies. Move the cursor clear of it, or just behind its last car to couple on.`,
  };
}
