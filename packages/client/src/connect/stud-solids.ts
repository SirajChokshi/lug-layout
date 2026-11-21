import type { PartShapeAsset } from "@brr/catalog";
import {
  ALL_COORDINATES,
  AXIS_FREE,
  AXIS_POS_Y,
  GENDER_MALE,
  IdentifiedPoint,
  TRANSFORM_FLOATS,
  axisDimension,
  identifyDirection,
  identifyPoint,
  type CellVolumes,
  type ConnectorTable,
  type LatticePose,
  type ModelConnectors,
  type PartInstances,
} from "@brr/domain";
import { IDENTIFICATION_ACCEPTED_DEVIATION_LDU, SIXTEENTHS_PER_LDU, STUD_LDU } from "@brr/math";
import { ConnectorLines, acrossU, acrossV } from "./connector-lines.ts";
import { posedBox } from "./part-boxes.ts";

export const SOLID_FLOATS = 6;
export const NO_REACH_ENTRY = -1;
const COORDINATES = 3;
const MAX = 3;
const X = 0;
const Y = 1;
const Z = 2;
const ROW = 4;
const TRANSLATION = 3;
const CORNERS = 8;
const NO_CONNECTOR = -1;
const STUD_SIXTEENTHS = STUD_LDU * SIXTEENTHS_PER_LDU;
const STUD_CENTRE_SIXTEENTHS = STUD_SIXTEENTHS / 2;

export type StuddedPart = Pick<PartShapeAsset, "studPrimitiveIndex" | "studMatrices">;

export interface StudSources {
  readonly instances: PartInstances;
  readonly parts: ReadonlyArray<StuddedPart | undefined>;
  readonly tables: ReadonlyArray<ConnectorTable | null>;
  readonly primitiveBoxes: ReadonlyArray<Float64Array>;
  readonly model: ModelConnectors;
}

class PartStuds {
  constructor(
    readonly male: Int32Array,
    readonly lineStart: Int32Array,
    readonly lineConnector: Int32Array,
  ) {}
}

class ReachCells implements CellVolumes {
  constructor(
    readonly count: number,
    readonly cellX: Int32Array,
    readonly cellZ: Int32Array,
    readonly bottomLdu: Int32Array,
    readonly topLdu: Int32Array,
  ) {}
}

function outwardOf(box: Float64Array): number {
  return (box[Y] ?? 0) + (box[MAX + Y] ?? 0) < 0 ? -1 : 1;
}

function baseOf(box: Float64Array): number {
  return outwardOf(box) > 0 ? (box[Y] ?? 0) : (box[MAX + Y] ?? 0);
}

function identified(ldu: number): number {
  const sixteenths = Math.round(ldu * SIXTEENTHS_PER_LDU);
  const residual = Math.abs(ldu * SIXTEENTHS_PER_LDU - sixteenths) / SIXTEENTHS_PER_LDU;
  return residual <= IDENTIFICATION_ACCEPTED_DEVIATION_LDU ? sixteenths / SIXTEENTHS_PER_LDU : ldu;
}

function studTransform(matrices: Float32Array, stud: number, out: Float64Array): Float64Array {
  for (let k = 0; k < TRANSFORM_FLOATS; k++) out[k] = matrices[stud * TRANSFORM_FLOATS + k] ?? 0;
  return out;
}

function compose(outer: Float64Array, o: number, inner: Float64Array, out: Float64Array): void {
  for (let row = 0; row < COORDINATES; row++) {
    const a0 = outer[o + row * ROW] ?? 0;
    const a1 = outer[o + row * ROW + 1] ?? 0;
    const a2 = outer[o + row * ROW + 2] ?? 0;
    for (let col = 0; col < ROW; col++) {
      out[row * ROW + col] =
        a0 * (inner[col] ?? 0) +
        a1 * (inner[ROW + col] ?? 0) +
        a2 * (inner[2 * ROW + col] ?? 0) +
        (col === TRANSLATION ? (outer[o + row * ROW + TRANSLATION] ?? 0) : 0);
    }
  }
}

function boundCorners(transform: Float64Array, box: Float64Array, out: Float64Array): void {
  out.fill(Number.POSITIVE_INFINITY, 0, MAX);
  out.fill(Number.NEGATIVE_INFINITY, MAX, SOLID_FLOATS);
  for (let corner = 0; corner < CORNERS; corner++) {
    const x = corner & 1 ? (box[MAX + X] ?? 0) : (box[X] ?? 0);
    const y = corner & 2 ? (box[MAX + Y] ?? 0) : (box[Y] ?? 0);
    const z = corner & 4 ? (box[MAX + Z] ?? 0) : (box[Z] ?? 0);
    for (let axis = 0; axis < COORDINATES; axis++) {
      const r = axis * ROW;
      const value =
        (transform[r] ?? 0) * x +
        (transform[r + 1] ?? 0) * y +
        (transform[r + 2] ?? 0) * z +
        (transform[r + TRANSLATION] ?? 0);
      out[axis] = Math.min(out[axis] ?? 0, value);
      out[MAX + axis] = Math.max(out[MAX + axis] ?? 0, value);
    }
  }
  for (let k = 0; k < SOLID_FLOATS; k++) out[k] = identified(out[k] ?? 0);
}

function isCellCentre(sixteenths: number): boolean {
  return (sixteenths - STUD_CENTRE_SIXTEENTHS) % STUD_SIXTEENTHS === 0;
}

function standsOnLattice(
  axis: number,
  transform: Float64Array,
  box: Float64Array,
  point: IdentifiedPoint,
): boolean {
  return (
    axis === AXIS_POS_Y &&
    identifyPoint(transform, 0, baseOf(box), 0, ALL_COORDINATES, point) &&
    isCellCentre(point.sixteenths[X] ?? 0) &&
    isCellCentre(point.sixteenths[Z] ?? 0)
  );
}

function partStuds(
  part: StuddedPart,
  table: ConnectorTable | null,
  primitiveBoxes: ReadonlyArray<Float64Array>,
): PartStuds {
  const studs = part.studPrimitiveIndex.length;
  const male = new Int32Array(studs).fill(NO_CONNECTOR);
  const lineStart = new Int32Array(studs + 1);
  const lineConnector: number[] = [];
  const lines = table ? ConnectorLines.of(table) : null;
  const transform = new Float64Array(TRANSFORM_FLOATS);
  const point = new IdentifiedPoint();
  const solid = new Float64Array(SOLID_FLOATS);
  for (let s = 0; s < studs; s++) {
    lineStart[s] = lineConnector.length;
    const box = primitiveBoxes[part.studPrimitiveIndex[s] ?? 0];
    if (!table || !lines || !box) continue;
    studTransform(part.studMatrices, s, transform);
    const axis = identifyDirection(transform, 0, outwardOf(box), 0);
    if (axis === AXIS_FREE) continue;
    if (!identifyPoint(transform, 0, baseOf(box), 0, ALL_COORDINATES, point)) continue;
    boundCorners(transform, box, solid);
    const dimension = axisDimension(axis);
    const base = point.sixteenths[dimension] ?? 0;
    const from = Math.floor((solid[dimension] ?? 0) * SIXTEENTHS_PER_LDU);
    const to = Math.ceil((solid[MAX + dimension] ?? 0) * SIXTEENTHS_PER_LDU);
    const u = point.sixteenths[acrossU(dimension)] ?? 0;
    const v = point.sixteenths[acrossV(dimension)] ?? 0;
    for (let e = lines.first(dimension, u, v); lines.holds(e, dimension, u, v); e++) {
      const c = lines.connector[e] ?? 0;
      const along = lines.along(e);
      if (along < from || along > to) continue;
      lineConnector.push(c);
      if (along === base && table.axis[c] === axis && table.gender[c] === GENDER_MALE) {
        male[s] = c;
      }
    }
  }
  lineStart[studs] = lineConnector.length;
  return new PartStuds(male, lineStart, Int32Array.from(lineConnector));
}

function exposedFrom(model: ModelConnectors, instance: number, connector: number): number {
  let low = 0;
  let high = model.count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const i = model.instance[middle] ?? 0;
    const c = model.connector[middle] ?? 0;
    if (i < instance || (i === instance && c < connector)) low = middle + 1;
    else high = middle;
  }
  return low;
}

function exposes(model: ModelConnectors, at: number, instance: number, connector: number): boolean {
  return at < model.count && model.instance[at] === instance && model.connector[at] === connector;
}

function firstCell(lo: number): number {
  return Math.floor(lo / STUD_LDU);
}

function endCell(hi: number): number {
  return Math.ceil(hi / STUD_LDU);
}

class StudList {
  readonly instance: number[] = [];
  readonly solid: number[] = [];
  readonly axis: number[] = [];
  readonly lineStart: number[] = [];
  readonly lineConnector: number[] = [];

  add(instance: number, solid: Float64Array, axis: number): void {
    this.instance.push(instance);
    for (let k = 0; k < SOLID_FLOATS; k++) this.solid.push(solid[k] ?? 0);
    this.axis.push(axis);
    this.lineStart.push(this.lineConnector.length);
  }

  get count(): number {
    return this.instance.length;
  }
}

class ReachIndex {
  readonly cellX: number[] = [];
  readonly cellZ: number[] = [];
  readonly bottom: number[] = [];
  readonly top: number[] = [];
  readonly members: number[][] = [];
  readonly cellX0: number;
  readonly cellZ0: number;
  readonly width: number;
  readonly depth: number;
  readonly entryOfCell: Int32Array;

  constructor(solid: Float64Array, count: number) {
    let x0 = 0;
    let z0 = 0;
    let x1 = 0;
    let z1 = 0;
    for (let s = 0; s < count; s++) {
      const b = s * SOLID_FLOATS;
      x0 = s === 0 ? firstCell(solid[b + X] ?? 0) : Math.min(x0, firstCell(solid[b + X] ?? 0));
      z0 = s === 0 ? firstCell(solid[b + Z] ?? 0) : Math.min(z0, firstCell(solid[b + Z] ?? 0));
      x1 =
        s === 0 ? endCell(solid[b + MAX + X] ?? 0) : Math.max(x1, endCell(solid[b + MAX + X] ?? 0));
      z1 =
        s === 0 ? endCell(solid[b + MAX + Z] ?? 0) : Math.max(z1, endCell(solid[b + MAX + Z] ?? 0));
    }
    this.cellX0 = x0;
    this.cellZ0 = z0;
    this.width = x1 - x0;
    this.depth = z1 - z0;
    this.entryOfCell = new Int32Array(this.width * this.depth).fill(NO_REACH_ENTRY);
    for (let s = 0; s < count; s++) this.cover(solid, s);
  }

  private cover(solid: Float64Array, stud: number): void {
    const b = stud * SOLID_FLOATS;
    const lo = Math.floor(solid[b + Y] ?? 0);
    const hi = Math.ceil(solid[b + MAX + Y] ?? 0);
    const toX = endCell(solid[b + MAX + X] ?? 0);
    const toZ = endCell(solid[b + MAX + Z] ?? 0);
    for (let z = firstCell(solid[b + Z] ?? 0); z < toZ; z++) {
      for (let x = firstCell(solid[b + X] ?? 0); x < toX; x++) {
        const entry = this.entry(x, z, lo, hi);
        this.bottom[entry] = Math.min(this.bottom[entry] ?? lo, lo);
        this.top[entry] = Math.max(this.top[entry] ?? hi, hi);
        this.members[entry]?.push(stud);
      }
    }
  }

  private entry(x: number, z: number, lo: number, hi: number): number {
    const cell = (z - this.cellZ0) * this.width + (x - this.cellX0);
    const known = this.entryOfCell[cell] ?? NO_REACH_ENTRY;
    if (known !== NO_REACH_ENTRY) return known;
    const entry = this.members.length;
    this.entryOfCell[cell] = entry;
    this.cellX.push(x);
    this.cellZ.push(z);
    this.bottom.push(lo);
    this.top.push(hi);
    this.members.push([]);
    return entry;
  }

  cells(): ReachCells {
    return new ReachCells(
      this.members.length,
      Int32Array.from(this.cellX),
      Int32Array.from(this.cellZ),
      Int32Array.from(this.bottom),
      Int32Array.from(this.top),
    );
  }

  entryStart(): Int32Array {
    const start = new Int32Array(this.members.length + 1);
    for (let e = 0; e < this.members.length; e++) {
      start[e + 1] = (start[e] ?? 0) + (this.members[e]?.length ?? 0);
    }
    return start;
  }
}

export class StudSolids {
  private connectorLines: ConnectorLines | null = null;

  private constructor(
    readonly model: ModelConnectors,
    readonly count: number,
    readonly instance: Int32Array,
    readonly solid: Float64Array,
    readonly axis: Int8Array,
    readonly lineStart: Int32Array,
    readonly lineConnector: Int32Array,
    readonly reach: CellVolumes,
    readonly entryStart: Int32Array,
    readonly entryStud: Int32Array,
    readonly cellX0: number,
    readonly cellZ0: number,
    readonly width: number,
    readonly depth: number,
    private readonly entryOfCell: Int32Array,
  ) {}

  get lines(): ConnectorLines {
    this.connectorLines ??= ConnectorLines.of(this.model);
    return this.connectorLines;
  }

  writePosed(pose: LatticePose, out: Float64Array): number {
    for (let s = 0; s < this.count; s++) posedBox(this.solid, s, pose, out, s * SOLID_FLOATS);
    return this.count * SOLID_FLOATS;
  }

  entryAt(cellX: number, cellZ: number): number {
    const i = cellX - this.cellX0;
    const j = cellZ - this.cellZ0;
    if (i < 0 || j < 0 || i >= this.width || j >= this.depth) return NO_REACH_ENTRY;
    return this.entryOfCell[j * this.width + i] ?? NO_REACH_ENTRY;
  }

  static of(sources: StudSources): StudSolids {
    const { instances, parts, tables, primitiveBoxes, model } = sources;
    const byPart = new Map<number, PartStuds>();
    const list = new StudList();
    const transform = new Float64Array(TRANSFORM_FLOATS);
    const local = new Float64Array(TRANSFORM_FLOATS);
    const solid = new Float64Array(SOLID_FLOATS);
    const base = new IdentifiedPoint();
    for (let i = 0; i < instances.count; i++) {
      const partIndex = instances.partIndex[i] ?? -1;
      const part = parts[partIndex];
      if (!part) continue;
      for (let s = 0; s < part.studPrimitiveIndex.length; s++) {
        const box = primitiveBoxes[part.studPrimitiveIndex[s] ?? 0];
        if (!box) continue;
        studTransform(part.studMatrices, s, local);
        compose(instances.matrices, i * TRANSFORM_FLOATS, local, transform);
        const axis = identifyDirection(transform, 0, outwardOf(box), 0);
        if (standsOnLattice(axis, transform, box, base)) continue;
        let studs = byPart.get(partIndex);
        if (!studs) {
          studs = partStuds(part, tables[partIndex] ?? null, primitiveBoxes);
          byPart.set(partIndex, studs);
        }
        const male = studs.male[s] ?? NO_CONNECTOR;
        const mates = axis !== AXIS_FREE && male !== NO_CONNECTOR;
        if (mates && !exposes(model, exposedFrom(model, i, male), i, male)) continue;
        boundCorners(transform, box, solid);
        list.add(i, solid, axis);
        if (!mates) continue;
        for (let l = studs.lineStart[s] ?? 0; l < (studs.lineStart[s + 1] ?? 0); l++) {
          const c = studs.lineConnector[l] ?? 0;
          for (let e = exposedFrom(model, i, c); exposes(model, e, i, c); e++) {
            list.lineConnector.push(e);
          }
        }
      }
    }
    list.lineStart.push(list.lineConnector.length);
    return StudSolids.indexed(model, list);
  }

  private static indexed(model: ModelConnectors, list: StudList): StudSolids {
    const solid = Float64Array.from(list.solid);
    const reach = new ReachIndex(solid, list.count);
    return new StudSolids(
      model,
      list.count,
      Int32Array.from(list.instance),
      solid,
      Int8Array.from(list.axis),
      Int32Array.from(list.lineStart),
      Int32Array.from(list.lineConnector),
      reach.cells(),
      reach.entryStart(),
      Int32Array.from(reach.members.flat()),
      reach.cellX0,
      reach.cellZ0,
      reach.width,
      reach.depth,
      reach.entryOfCell,
    );
  }
}
