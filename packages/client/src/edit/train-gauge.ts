import type { PartShapeAsset, PartVehicle, StudPrimitiveAsset } from "@brr/catalog";
import { PLATE_LDU, mmFromLdu } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";

const TENTHS = 10;
const BOX_FLOATS = 6;
const POSITION_FLOATS = 3;
const CORNERS = 8;
const ROW_FLOATS = 4;
const IDENTITY_ROWS = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);

export interface TrainGauge {
  readonly heightLdu: number;
  readonly model: string;
}

export interface RollingStock {
  readonly name: string;
  readonly partIndex: Uint16Array;
  readonly matrices: Float32Array;
  readonly vehicles: ReadonlyArray<PartVehicle>;
}

function tenths(value: number): string {
  const rounded = Math.round(value * TENTHS) / TENTHS;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function heightText(ldu: number): string {
  const plates = tenths(ldu / PLATE_LDU);
  return `${plates} ${plates === "1" ? "plate" : "plates"} (${tenths(mmFromLdu(ldu))} mm)`;
}

function emptyBox(): Float64Array {
  return Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
}

function grow(out: Float64Array, x: number, y: number, z: number): void {
  out[0] = Math.min(out[0] ?? 0, x);
  out[1] = Math.min(out[1] ?? 0, y);
  out[2] = Math.min(out[2] ?? 0, z);
  out[3] = Math.max(out[3] ?? 0, x);
  out[4] = Math.max(out[4] ?? 0, y);
  out[5] = Math.max(out[5] ?? 0, z);
}

function growByCorners(
  out: Float64Array,
  local: Float64Array,
  m: ArrayLike<number>,
  o: number,
): void {
  for (let corner = 0; corner < CORNERS; corner++) {
    const x = corner & 1 ? (local[3] ?? 0) : (local[0] ?? 0);
    const y = corner & 2 ? (local[4] ?? 0) : (local[1] ?? 0);
    const z = corner & 4 ? (local[5] ?? 0) : (local[2] ?? 0);
    const at = (row: number): number =>
      (m[o + row * ROW_FLOATS] ?? 0) * x +
      (m[o + row * ROW_FLOATS + 1] ?? 0) * y +
      (m[o + row * ROW_FLOATS + 2] ?? 0) * z +
      (m[o + row * ROW_FLOATS + 3] ?? 0);
    grow(out, at(0), at(1), at(2));
  }
}

function meshBox(positions: Float32Array): Float64Array {
  const box = emptyBox();
  for (let i = 0; i < positions.length; i += POSITION_FLOATS) {
    grow(box, positions[i] ?? 0, positions[i + 1] ?? 0, positions[i + 2] ?? 0);
  }
  return box;
}

class PartBoxes {
  private readonly studBoxes: ReadonlyArray<Float64Array>;
  private readonly boxes = new Map<number, Float64Array>();

  constructor(
    private readonly parts: ReadonlyArray<PartShapeAsset>,
    studPrimitives: ReadonlyArray<StudPrimitiveAsset>,
  ) {
    this.studBoxes = studPrimitives.map((primitive) => meshBox(primitive.mesh.positions));
  }

  of(partIndex: number): Float64Array {
    const known = this.boxes.get(partIndex);
    if (known) return known;
    const part = this.parts[partIndex];
    if (!part) throw new RangeError(`part index ${partIndex} is not in the palette`);
    const box = emptyBox();
    const body = Float64Array.of(...part.boundsMin, ...part.boundsMax);
    growByCorners(box, body, IDENTITY_ROWS, 0);
    for (let stud = 0; stud < part.studPrimitiveIndex.length; stud++) {
      const primitive = this.studBoxes[part.studPrimitiveIndex[stud] ?? 0];
      if (primitive)
        growByCorners(box, primitive, part.studMatrices, stud * INSTANCE_MATRIX_FLOATS);
    }
    this.boxes.set(partIndex, box);
    return box;
  }
}

function vehicleTop(stock: RollingStock, vehicle: PartVehicle, boxes: PartBoxes): number {
  const box = emptyBox();
  const grown = new Float64Array(BOX_FLOATS);
  const add = (instance: number): void => {
    grown.set(emptyBox());
    const local = boxes.of(stock.partIndex[instance] ?? 0);
    growByCorners(grown, local, stock.matrices, instance * INSTANCE_MATRIX_FLOATS);
    grow(box, grown[0] ?? 0, grown[1] ?? 0, grown[2] ?? 0);
    grow(box, grown[3] ?? 0, grown[4] ?? 0, grown[5] ?? 0);
  };
  vehicle.body.forEach(add);
  for (const bogie of vehicle.bogies) bogie.instances.forEach(add);
  return box[4] ?? -Infinity;
}

export function trainGauge(
  stock: ReadonlyArray<RollingStock>,
  parts: ReadonlyArray<PartShapeAsset>,
  studPrimitives: ReadonlyArray<StudPrimitiveAsset>,
  railPart: string,
): TrainGauge | null {
  const boxes = new PartBoxes(parts, studPrimitives);
  let tallest: TrainGauge | null = null;
  for (const train of stock) {
    for (const vehicle of train.vehicles) {
      const contact = vehicle.railContacts.find((c) => c.railPart === railPart);
      if (!contact) continue;
      const top = vehicleTop(train, vehicle, boxes);
      if (!Number.isFinite(top)) continue;
      const heightLdu = top - contact.railTopY;
      if (!tallest || heightLdu > tallest.heightLdu) tallest = { heightLdu, model: train.name };
    }
  }
  return tallest;
}
