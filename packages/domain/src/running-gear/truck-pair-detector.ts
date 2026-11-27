import {
  addExactRational,
  compareExactRational,
  exactRational,
  exactRationalEquals,
  multiplyExactRational,
  type ExactRational,
} from "@brr/math";
import {
  AXIS_FREE,
  axisDimension,
  axisSign,
  GENDER_MALE,
  type ConnectorTable,
} from "../connect/connector-table.ts";
import type { MatePairs } from "../connect/mate-pairs.ts";
import { SECTION_ROUND, type SnapShapes } from "../connect/snap-shapes.ts";
import {
  IdentifiedPoint,
  identifyDirection,
  identifyPoint,
  NO_FRAME,
  TRANSFORM_FLOATS,
  type PartInstances,
  type SubmodelFrames,
} from "../connect/submodel-frames.ts";
import type { AuthoredBoxes } from "./authored-boxes.ts";
import { authoredPlane, type ClearanceWheelset } from "./clearance.ts";
import { BOX_AXES, BOX_FLOATS, CANDIDATE_REACH_LDU, MODEL_UP } from "./exact-boxes.ts";
import { modelAxisIn } from "./placed-instance.ts";
import { NO_VEHICLE, type MergeablePairs, type PivotPair } from "./tied-groups.ts";

const ROW = 4;
const TRANSLATION = 3;
const COORDINATES = 3;
const SIXTEENTHS = 16;
const ALL_COORDINATES = 0b111;
const NO_PIVOT = -1;
const ZERO = exactRational(0n, 1n);

export interface TruckInput {
  readonly seated: ReadonlyArray<ClearanceWheelset>;
  readonly hasBogies: boolean;
}

export interface TruckPairInput {
  readonly frames: SubmodelFrames;
  readonly instances: PartInstances;
  readonly connectors: ReadonlyArray<ConnectorTable | null>;
  readonly mates: MatePairs;
  readonly authored: AuthoredBoxes;
  readonly boxes: Float64Array;
  readonly trucks: ReadonlyArray<TruckInput>;
}

interface TruckFrame {
  readonly frame: number;
  readonly lateral: number;
  readonly track: number;
  readonly up: number;
  readonly trackCentre: number;
  readonly low: number;
  readonly high: number;
}

interface PivotTable {
  readonly instance: Int32Array;
  readonly along: Int32Array;
  readonly male: Uint8Array;
  readonly vertical: Uint8Array;
  readonly floatOrigin: Float64Array;
  readonly origin: ReadonlyArray<ExactRational>;
}

interface Truck {
  readonly frame: TruckFrame;
  readonly axle: number;
  readonly up: number;
  readonly upSign: number;
  readonly railTops: ReadonlyArray<ExactRational>;
}

function holds(frames: SubmodelFrames, frame: number, instance: number): boolean {
  for (let f = frames.frameOf(instance); f !== NO_FRAME; f = frames.parentFrame(f)) {
    if (f === frame) return true;
  }
  return false;
}

function matedConnectors(mates: MatePairs): Set<string> {
  const mated = new Set<string>();
  for (let m = 0; m < mates.count; m++) {
    mated.add(`${mates.maleInstance[m]}:${mates.maleConnector[m]}`);
    mated.add(`${mates.femaleInstance[m]}:${mates.femaleConnector[m]}`);
  }
  return mated;
}

export class TruckPairDetector {
  constructor(private readonly shapes: SnapShapes) {}

  pairs(input: TruckPairInput): TruckPairs {
    return new TruckPairs(this.shapes, input);
  }
}

export class TruckPairs implements MergeablePairs {
  private readonly trucks: Array<Truck | null | undefined>;
  private readonly tables: Array<PivotTable | undefined>;
  private readonly relate = new Float64Array(TRANSFORM_FLOATS);
  private readonly point = new IdentifiedPoint();
  private readonly ridingMark: Uint8Array;
  private readonly riding: Int32Array;
  private mated: Set<string> | null = null;

  constructor(
    private readonly shapes: SnapShapes,
    private readonly input: TruckPairInput,
  ) {
    this.trucks = Array.from({ length: input.trucks.length });
    this.tables = Array.from({ length: input.trucks.length });
    this.ridingMark = new Uint8Array(input.instances.count);
    this.riding = new Int32Array(input.instances.count);
  }

  mergeable(
    members: ReadonlyArray<number>,
    [a, b]: readonly [number, number],
    vehicleOf: Int32Array,
  ): PivotPair | null {
    const truckA = this.truck(a);
    const truckB = this.truck(b);
    if (!truckA || !truckB) return null;
    const pivotA = this.pivotPoint(a, members, vehicleOf);
    if (pivotA === NO_PIVOT) return null;
    const pivotB = this.pivotPoint(b, members, vehicleOf);
    if (pivotB === NO_PIVOT) return null;
    const originA = this.originOf(a, pivotA);
    const originB = this.originOf(b, pivotB);
    return this.inLine(truckA, truckB, originA, originB) ? [originA, originB] : null;
  }

  private originOf(truck: number, pivot: number): ExactRational[] {
    const table = this.tables[truck];
    return [0, 1, 2].map((d) => table?.origin[pivot * COORDINATES + d] ?? ZERO);
  }

  private inLine(
    a: Truck,
    b: Truck,
    originA: ReadonlyArray<ExactRational>,
    originB: ReadonlyArray<ExactRational>,
  ): boolean {
    const [top] = a.railTops;
    return (
      top !== undefined &&
      a.axle === b.axle &&
      a.up === b.up &&
      a.upSign === b.upSign &&
      exactRationalEquals(originA[a.axle] ?? ZERO, originB[a.axle] ?? ZERO) &&
      [...a.railTops, ...b.railTops].every((rail) => exactRationalEquals(rail, top))
    );
  }

  private pivotPoint(t: number, members: ReadonlyArray<number>, vehicleOf: Int32Array): number {
    const table = this.table(t, vehicleOf);
    if (!table) return NO_PIVOT;
    let ridingCount = 0;
    vehicleOf.forEach((vehicle, instance) => {
      if (vehicle !== t) return;
      this.riding[ridingCount++] = instance;
      this.ridingMark[instance] = 1;
    });
    let best = NO_PIVOT;
    let line = 0;
    let onOneLine = true;
    for (let k = 0; k < table.instance.length && onOneLine; k++) {
      const own = table.instance[k] ?? 0;
      if (this.ridingMark[own] !== 1 || !this.reaches(table, k, members, ridingCount)) continue;
      const along = table.along[k] ?? 0;
      if (best === NO_PIVOT) line = along;
      onOneLine = along === line;
      if (best === NO_PIVOT || this.higher(table, k, best)) best = k;
    }
    for (let r = 0; r < ridingCount; r++) this.ridingMark[this.riding[r] ?? 0] = 0;
    return onOneLine && best !== NO_PIVOT && table.vertical[best] === 1 ? best : NO_PIVOT;
  }

  private higher(table: PivotTable, k: number, best: number): boolean {
    const order = compareExactRational(
      table.origin[k * COORDINATES + MODEL_UP] ?? ZERO,
      table.origin[best * COORDINATES + MODEL_UP] ?? ZERO,
    );
    return order > 0 || (order === 0 && table.male[k] === 1 && table.male[best] !== 1);
  }

  private reaches(
    table: PivotTable,
    k: number,
    members: ReadonlyArray<number>,
    ridingCount: number,
  ): boolean {
    if (!members.some((member) => this.contains(table, k, member, false))) return false;
    const own = table.instance[k];
    for (let r = 0; r < ridingCount; r++) {
      const instance = this.riding[r] ?? 0;
      if (instance !== own && this.contains(table, k, instance, true)) return false;
    }
    return true;
  }

  private contains(table: PivotTable, k: number, instance: number, strict: boolean): boolean {
    const { boxes, authored } = this.input;
    const at = instance * BOX_FLOATS;
    for (let d = 0; d < COORDINATES; d++) {
      const value = table.floatOrigin[k * COORDINATES + d] ?? 0;
      const low = (boxes[at + d] ?? Number.NaN) - CANDIDATE_REACH_LDU;
      const high = (boxes[at + BOX_AXES + d] ?? Number.NaN) + CANDIDATE_REACH_LDU;
      if (!(value >= low && value <= high)) return false;
    }
    const box = authored.box(instance);
    if (!box) return false;
    for (let d = 0; d < COORDINATES; d++) {
      const interval = box[d];
      const value = table.origin[k * COORDINATES + d];
      if (!interval || !value) return false;
      const low = compareExactRational(value, interval.low);
      const high = compareExactRational(value, interval.high);
      if (strict ? low <= 0 || high >= 0 : low < 0 || high > 0) return false;
    }
    return true;
  }

  private truck(t: number): Truck | null {
    const known = this.trucks[t];
    if (known !== undefined) return known;
    const truck = this.measureTruck(t);
    this.trucks[t] = truck;
    return truck;
  }

  private measureTruck(t: number): Truck | null {
    const { frames, instances, authored } = this.input;
    const truck = this.input.trucks[t];
    const first = truck?.seated[0]?.wheelset;
    if (!truck || truck.hasBogies || !first || truck.seated.length < 2) return null;
    const { frame, dimension, trackCentre } = first;
    if (
      truck.seated.some(
        ({ wheelset }) =>
          wheelset.frame !== frame ||
          wheelset.dimension !== dimension ||
          wheelset.trackCentre !== trackCentre,
      )
    ) {
      return null;
    }
    const up = modelAxisIn(frames, first.axleInstance, frame, MODEL_UP);
    if (up === AXIS_FREE) return null;
    const track = [0, 1, 2].find((d) => d !== dimension && d !== axisDimension(up)) ?? 0;
    const lines: number[] = [];
    for (const { wheelset } of truck.seated) {
      if (!frames.relate(wheelset.axleInstance, frame, this.relate)) return null;
      const [x = 0, y = 0, z = 0] = wheelset.axlePoint;
      if (!identifyPoint(this.relate, x, y, z, ALL_COORDINATES, this.point)) return null;
      lines.push(this.point.sixteenths[track] ?? 0);
    }
    if (new Set(lines).size < 2) return null;
    const planes = truck.seated.map((w) => authoredPlane(frames, instances, authored, w));
    const [plane] = planes;
    if (!plane || planes.some((p) => !p || p.lateral !== plane.lateral || p.up !== plane.up)) {
      return null;
    }
    return {
      frame: {
        frame,
        lateral: dimension,
        track,
        up,
        trackCentre,
        low: Math.min(...lines),
        high: Math.max(...lines),
      },
      axle: plane.lateral,
      up: plane.up,
      upSign: plane.upSign,
      railTops: planes.flatMap((p) => (p ? [p.railTopHeight] : [])),
    };
  }

  private table(t: number, vehicleOf: Int32Array): PivotTable | null {
    const known = this.tables[t];
    if (known) return known;
    const truck = this.truck(t);
    if (!truck) return null;
    const table = this.buildTable(t, truck.frame, vehicleOf);
    this.tables[t] = table;
    return table;
  }

  private buildTable(t: number, truck: TruckFrame, vehicleOf: Int32Array): PivotTable {
    const { frames, instances, connectors, authored, mates } = this.input;
    this.mated ??= matedConnectors(mates);
    const found: number[] = [];
    const origin: ExactRational[] = [];
    const floatOrigin: number[] = [];
    vehicleOf.forEach((vehicle, instance) => {
      if (vehicle !== t && vehicle !== NO_VEHICLE) return;
      const connectorTable = connectors[instances.partIndex[instance] ?? -1];
      const pose = authored.pose(instance);
      if (!connectorTable || !pose || !holds(frames, truck.frame, instance)) return;
      if (!frames.relate(instance, truck.frame, this.relate)) return;
      for (let c = 0; c < connectorTable.count; c++) {
        if (!this.qualifies(connectorTable, instance, c, truck)) continue;
        const local = [0, 1, 2].map((d) => connectorTable.origin[c * COORDINATES + d] ?? 0);
        const at = (row: number): ExactRational =>
          local.reduce(
            (sum, value, d) =>
              addExactRational(
                sum,
                multiplyExactRational(
                  pose[row * ROW + d] ?? ZERO,
                  exactRational(BigInt(value), BigInt(SIXTEENTHS)),
                ),
              ),
            pose[row * ROW + TRANSLATION] ?? ZERO,
          );
        const matrix = instance * TRANSFORM_FLOATS;
        for (let row = 0; row < COORDINATES; row++) {
          origin.push(at(row));
          floatOrigin.push(
            local.reduce(
              (sum, value, d) =>
                sum + (instances.matrices[matrix + row * ROW + d] ?? 0) * (value / SIXTEENTHS),
              instances.matrices[matrix + row * ROW + TRANSLATION] ?? 0,
            ),
          );
        }
        const axis = connectorTable.axis[c] ?? 0;
        const carried = (row: number) => pose[row * ROW + axisDimension(axis)] ?? ZERO;
        found.push(
          instance,
          this.point.sixteenths[truck.track] ?? 0,
          connectorTable.gender[c] === GENDER_MALE ? 1 : 0,
          exactRationalEquals(carried(0), ZERO) &&
            !exactRationalEquals(carried(1), ZERO) &&
            exactRationalEquals(carried(2), ZERO)
            ? 1
            : 0,
        );
      }
    });
    const count = found.length / 4;
    const column = (offset: number) =>
      Array.from({ length: count }, (_, k) => found[k * 4 + offset] ?? 0);
    return {
      instance: Int32Array.from(column(0)),
      along: Int32Array.from(column(1)),
      male: Uint8Array.from(column(2)),
      vertical: Uint8Array.from(column(3)),
      floatOrigin: Float64Array.from(floatOrigin),
      origin,
    };
  }

  private qualifies(
    table: ConnectorTable,
    instance: number,
    c: number,
    truck: TruckFrame,
  ): boolean {
    if (this.mated?.has(`${instance}:${c}`)) return false;
    const male = table.gender[c] === GENDER_MALE;
    const section = this.shapes.firstSection(table.shape[c] ?? 0);
    const code = male ? this.shapes.maleCode(section) : this.shapes.femaleCode(section);
    if (code !== SECTION_ROUND) return false;
    const axis = table.axis[c] ?? 0;
    const unit = [0, 1, 2].map((d) => (d === axisDimension(axis) ? axisSign(axis) : 0));
    if (identifyDirection(this.relate, unit[0] ?? 0, unit[1] ?? 0, unit[2] ?? 0) !== truck.up) {
      return false;
    }
    const [x = 0, y = 0, z = 0] = [0, 1, 2].map(
      (d) => (table.origin[c * COORDINATES + d] ?? 0) / SIXTEENTHS,
    );
    if (!identifyPoint(this.relate, x, y, z, ALL_COORDINATES, this.point)) return false;
    const along = this.point.sixteenths[truck.track] ?? 0;
    return (
      (this.point.sixteenths[truck.lateral] ?? 0) === truck.trackCentre &&
      along >= truck.low &&
      along <= truck.high
    );
  }
}
