import type { PartAsset, PartModel, StudPrimitiveAsset } from "@brr/catalog";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";

export interface GaugeModel {
  readonly name: string;
  readonly model: PartModel;
  readonly parts: ReadonlyArray<PartAsset>;
  readonly studPrimitives: ReadonlyArray<StudPrimitiveAsset>;
}

export interface Gauge {
  readonly heightLdu: number;
  readonly model: string;
}

export interface ClearanceGauges {
  readonly train: Gauge | null;
  readonly minifig: Gauge | null;
}

interface Box {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

const HEAD_TITLE = /^~?Minifig Head\b/u;
const LEGS_TITLE = /^~?Minifig (?:Legs?|Hips and Legs)\b/u;
const SAME_FIGURE_LDU = 30;

function emptyBox(): Box {
  return {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
}

function meshBox(positions: Float32Array): Box {
  const box = emptyBox();
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] ?? 0;
    const y = positions[i + 1] ?? 0;
    const z = positions[i + 2] ?? 0;
    box.minX = Math.min(box.minX, x);
    box.minY = Math.min(box.minY, y);
    box.minZ = Math.min(box.minZ, z);
    box.maxX = Math.max(box.maxX, x);
    box.maxY = Math.max(box.maxY, y);
    box.maxZ = Math.max(box.maxZ, z);
  }
  return box;
}

function growByCorners(out: Box, local: Box, m: ArrayLike<number>, o: number): void {
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? local.maxX : local.minX;
    const y = corner & 2 ? local.maxY : local.minY;
    const z = corner & 4 ? local.maxZ : local.minZ;
    const wx = (m[o] ?? 0) * x + (m[o + 1] ?? 0) * y + (m[o + 2] ?? 0) * z + (m[o + 3] ?? 0);
    const wy = (m[o + 4] ?? 0) * x + (m[o + 5] ?? 0) * y + (m[o + 6] ?? 0) * z + (m[o + 7] ?? 0);
    const wz = (m[o + 8] ?? 0) * x + (m[o + 9] ?? 0) * y + (m[o + 10] ?? 0) * z + (m[o + 11] ?? 0);
    out.minX = Math.min(out.minX, wx);
    out.minY = Math.min(out.minY, wy);
    out.minZ = Math.min(out.minZ, wz);
    out.maxX = Math.max(out.maxX, wx);
    out.maxY = Math.max(out.maxY, wy);
    out.maxZ = Math.max(out.maxZ, wz);
  }
}

const IDENTITY_ROWS = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function partBox(part: PartAsset, studBoxes: ReadonlyArray<Box>): Box {
  const box = emptyBox();
  const body: Box = {
    minX: part.boundsMin[0],
    minY: part.boundsMin[1],
    minZ: part.boundsMin[2],
    maxX: part.boundsMax[0],
    maxY: part.boundsMax[1],
    maxZ: part.boundsMax[2],
  };
  growByCorners(box, body, IDENTITY_ROWS, 0);
  for (let stud = 0; stud < part.studPrimitiveIndex.length; stud++) {
    const primitive = studBoxes[part.studPrimitiveIndex[stud] ?? 0];
    if (primitive) growByCorners(box, primitive, part.studMatrices, stud * INSTANCE_MATRIX_FLOATS);
  }
  return box;
}

class InstanceBoxes {
  private readonly studBoxes: ReadonlyArray<Box>;
  private readonly partBoxes = new Map<number, Box>();

  constructor(private readonly source: GaugeModel) {
    this.studBoxes = source.studPrimitives.map((primitive) => meshBox(primitive.mesh.positions));
  }

  of(instance: number): Box {
    const { model, parts } = this.source;
    const index = model.partIndex[instance] ?? 0;
    let local = this.partBoxes.get(index);
    if (!local) {
      const part = parts[index];
      if (!part) throw new Error(`instance ${instance} has no part`);
      local = partBox(part, this.studBoxes);
      this.partBoxes.set(index, local);
    }
    const box = emptyBox();
    growByCorners(box, local, model.matrices, instance * INSTANCE_MATRIX_FLOATS);
    return box;
  }
}

function taller(best: Gauge | null, heightLdu: number, model: string): Gauge | null {
  return best && best.heightLdu >= heightLdu ? best : { heightLdu, model };
}

export function trainGauge(models: ReadonlyArray<GaugeModel>, railPart: string): Gauge | null {
  let best: Gauge | null = null;
  for (const source of models) {
    const boxes = new InstanceBoxes(source);
    for (const vehicle of source.model.vehicles) {
      const contact = vehicle.railContacts.find((c) => c.railPart === railPart);
      if (!contact) continue;
      let top = -Infinity;
      const rigid = [vehicle.body, ...vehicle.bogies.map((bogie) => bogie.instances)];
      for (const instances of rigid) {
        for (const instance of instances) {
          top = Math.max(top, boxes.of(instance).maxY);
        }
      }
      if (Number.isFinite(top)) best = taller(best, top - contact.railTopY, source.name);
    }
  }
  return best;
}

function centre(box: Box): readonly [number, number] {
  return [(box.minX + box.maxX) / 2, (box.minZ + box.maxZ) / 2];
}

export function minifigGauge(models: ReadonlyArray<GaugeModel>): Gauge | null {
  let best: Gauge | null = null;
  for (const source of models) {
    const { name, model, parts } = source;
    const boxes = new InstanceBoxes(source);
    const heads: Box[] = [];
    const legs: Box[] = [];
    for (let i = 0; i < model.instanceCount; i++) {
      const title = parts[model.partIndex[i] ?? 0]?.title ?? "";
      if (HEAD_TITLE.test(title)) heads.push(boxes.of(i));
      else if (LEGS_TITLE.test(title)) legs.push(boxes.of(i));
    }
    for (const head of heads) {
      const [hx, hz] = centre(head);
      let feet = Infinity;
      for (const leg of legs) {
        const [lx, lz] = centre(leg);
        const sameFigure =
          Math.abs(lx - hx) <= SAME_FIGURE_LDU &&
          Math.abs(lz - hz) <= SAME_FIGURE_LDU &&
          leg.maxY <= head.maxY;
        if (sameFigure) feet = Math.min(feet, leg.minY);
      }
      if (Number.isFinite(feet)) best = taller(best, head.maxY - feet, name);
    }
  }
  return best;
}
