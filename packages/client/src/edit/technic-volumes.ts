import type { PartAsset } from "@brr/catalog";
import {
  EMPTY_TECHNIC,
  NO_ITEM,
  SignedPermutation,
  TECHNIC_HOLE,
  TECHNIC_SHAFT,
  TechnicSetBuilder,
  type TechnicFeature,
  type TechnicSet,
} from "@brr/domain";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import type { ChunkPartInstances } from "../scene/placements.ts";
import { BOX_FLOATS } from "./local-box.ts";

export interface CellRecords {
  readonly start: Int32Array;
  readonly bottomLdu: Int32Array;
  readonly topLdu: Int32Array;
  readonly item: Int32Array;
}

export interface VolumeCells {
  readonly cellX0: number;
  readonly cellZ0: number;
  readonly width: number;
  readonly depth: number;
  readonly bottomLdu: Int32Array;
  readonly topLdu: Int32Array;
}

export interface PlaceableVolumes {
  readonly technic: TechnicSet;
  readonly records: CellRecords;
}

const BAKE_WELD_LDU = 0.05;
const IDENTIFY_LDU = 0.0005;
const LINEAR_FLOATS = 9;
const AXES = 3;

function identified(value: number): number | null {
  const whole = Math.round(value);
  return Math.abs(value - whole) <= IDENTIFY_LDU ? whole : null;
}

function instanceTransform(matrices: Float32Array, instance: number): SignedPermutation | null {
  const o = instance * INSTANCE_MATRIX_FLOATS;
  const linear = new Int8Array(LINEAR_FLOATS);
  const offset = new Int32Array(AXES);
  for (let row = 0; row < AXES; row++) {
    for (let col = 0; col < AXES; col++) {
      const v = identified(matrices[o + row * 4 + col] ?? 0);
      if (v === null) return null;
      linear[row * AXES + col] = v;
    }
    const t = identified(matrices[o + row * 4 + 3] ?? 0);
    if (t === null) return null;
    offset[row] = t;
  }
  return SignedPermutation.of(linear, offset);
}

function partTechnic(part: PartAsset): TechnicSet | null {
  const { technic } = part;
  if (!technic) return null;
  const box = [...part.boundsMin, ...part.boundsMax];
  const builder = new TechnicSetBuilder();
  if (technic.holes.length > 0) {
    const holes: TechnicFeature[] = technic.holes.map((hole) => ({
      axis: hole.axis,
      at: hole.at,
      from: hole.from,
      radii: hole.radii,
      pin: null,
    }));
    builder.addItem(TECHNIC_HOLE, box, holes);
  } else if (technic.shaft) {
    const { shaft } = technic;
    const components: TechnicFeature[] = shaft.components.map((component) => ({
      axis: shaft.axis,
      at: shaft.at,
      from: component.from,
      radii: component.radii,
      pin: component.pin,
    }));
    builder.addItem(TECHNIC_SHAFT, box, components);
  }
  return builder.count > 0 ? builder.build() : null;
}

function cellRange(lo: number, hi: number, edge: number, count: number): readonly [number, number] {
  const first = Math.max(0, Math.floor((lo + BAKE_WELD_LDU - edge) / STUD_LDU));
  const end = Math.min(count, Math.max(0, Math.ceil((hi - BAKE_WELD_LDU - edge) / STUD_LDU)));
  return [Math.min(first, end), end];
}

function bakeBottom(minY: number): number {
  return Math.floor(minY + BAKE_WELD_LDU);
}

function bakeTop(maxY: number): number {
  return Math.ceil(maxY / PLATE_LDU - BAKE_WELD_LDU / PLATE_LDU) * PLATE_LDU;
}

type Spans = number[];

function union(spans: Spans): Spans {
  const pairs: Array<readonly [number, number]> = [];
  for (let i = 0; i < spans.length; i += 2) pairs.push([spans[i] ?? 0, spans[i + 1] ?? 0]);
  pairs.sort((a, b) => a[0] - b[0]);
  const out: Spans = [];
  for (const [lo, hi] of pairs) {
    if (hi <= lo) continue;
    const last = out.length - 1;
    if (last > 0 && lo <= (out[last] ?? 0)) out[last] = Math.max(out[last] ?? 0, hi);
    else out.push(lo, hi);
  }
  return out;
}

function subtract(from: Spans, minus: Spans): Spans {
  let rest = from;
  for (let m = 0; m < minus.length; m += 2) {
    const lo = minus[m] ?? 0;
    const hi = minus[m + 1] ?? 0;
    const next: Spans = [];
    for (let i = 0; i < rest.length; i += 2) {
      const a = rest[i] ?? 0;
      const b = rest[i + 1] ?? 0;
      if (Math.min(lo, b) > a) next.push(a, Math.min(lo, b));
      if (Math.max(hi, a) < b) next.push(Math.max(hi, a), b);
    }
    rest = next;
  }
  return rest;
}

interface ItemRecord {
  readonly item: number;
  readonly bottomLdu: number;
  readonly topLdu: number;
}

function plainRecords(cells: VolumeCells): CellRecords {
  const count = cells.width * cells.depth;
  const start = new Int32Array(count + 1);
  let n = 0;
  for (let cell = 0; cell < count; cell++) {
    start[cell] = n;
    if ((cells.topLdu[cell] ?? 0) > (cells.bottomLdu[cell] ?? 0)) n++;
  }
  start[count] = n;
  const out = {
    start,
    bottomLdu: new Int32Array(n),
    topLdu: new Int32Array(n),
    item: new Int32Array(n).fill(NO_ITEM),
  };
  for (let cell = 0; cell < count; cell++) {
    const r = start[cell] ?? 0;
    if (r === (start[cell + 1] ?? 0)) continue;
    out.bottomLdu[r] = cells.bottomLdu[cell] ?? 0;
    out.topLdu[r] = cells.topLdu[cell] ?? 0;
  }
  return out;
}

export function plainVolumes(cells: VolumeCells): PlaceableVolumes {
  return { technic: EMPTY_TECHNIC, records: plainRecords(cells) };
}

export function technicVolumes(
  instances: ChunkPartInstances,
  parts: ReadonlyArray<PartAsset>,
  partBoxes: Float32Array,
  cells: VolumeCells,
): PlaceableVolumes {
  const local = new Map<number, TechnicSet | null>();
  const builder = new TechnicSetBuilder();
  const itemOf = new Int32Array(instances.count).fill(NO_ITEM);
  for (let i = 0; i < instances.count; i++) {
    const partIndex = instances.partIndex[i] ?? 0;
    let set = local.get(partIndex);
    if (set === undefined) {
      const part = parts[partIndex];
      set = part ? partTechnic(part) : null;
      local.set(partIndex, set);
    }
    if (!set) continue;
    const transform = instanceTransform(instances.matrices, i);
    if (!transform) continue;
    itemOf[i] = builder.count;
    builder.addPlaced(set, 0, transform, partBoxes.subarray(i * BOX_FLOATS, (i + 1) * BOX_FLOATS));
  }
  if (builder.count === 0) return plainVolumes(cells);

  const count = cells.width * cells.depth;
  const edgeX = cells.cellX0 * STUD_LDU;
  const edgeZ = cells.cellZ0 * STUD_LDU;
  const itemRecords = new Map<number, ItemRecord[]>();
  const technicBands = new Map<number, Spans>();
  const plainBands = new Map<number, Spans>();
  const cellsOf = (i: number): readonly [number, number, number, number] => {
    const b = i * BOX_FLOATS;
    const [x0, x1] = cellRange(partBoxes[b] ?? 0, partBoxes[b + 3] ?? 0, edgeX, cells.width);
    const [z0, z1] = cellRange(partBoxes[b + 2] ?? 0, partBoxes[b + 5] ?? 0, edgeZ, cells.depth);
    return [x0, x1, z0, z1];
  };
  for (let i = 0; i < instances.count; i++) {
    const item = itemOf[i] ?? NO_ITEM;
    if (item === NO_ITEM) continue;
    const minY = partBoxes[i * BOX_FLOATS + 1] ?? 0;
    const maxY = partBoxes[i * BOX_FLOATS + 4] ?? 0;
    const bottomLdu = Math.floor(minY + IDENTIFY_LDU);
    const topLdu = Math.ceil(maxY - IDENTIFY_LDU);
    const [x0, x1, z0, z1] = cellsOf(i);
    for (let j = z0; j < z1; j++) {
      for (let k = x0; k < x1; k++) {
        const cell = j * cells.width + k;
        const records = itemRecords.get(cell) ?? [];
        records.push({ item, bottomLdu, topLdu });
        itemRecords.set(cell, records);
        const bands = technicBands.get(cell) ?? [];
        bands.push(bakeBottom(minY), bakeTop(maxY));
        technicBands.set(cell, bands);
      }
    }
  }
  for (let i = 0; i < instances.count; i++) {
    if ((itemOf[i] ?? NO_ITEM) !== NO_ITEM) continue;
    const [x0, x1, z0, z1] = cellsOf(i);
    const minY = partBoxes[i * BOX_FLOATS + 1] ?? 0;
    const maxY = partBoxes[i * BOX_FLOATS + 4] ?? 0;
    for (let j = z0; j < z1; j++) {
      for (let k = x0; k < x1; k++) {
        const cell = j * cells.width + k;
        if (!technicBands.has(cell)) continue;
        const bands = plainBands.get(cell) ?? [];
        bands.push(bakeBottom(minY), bakeTop(maxY));
        plainBands.set(cell, bands);
      }
    }
  }

  const start = new Int32Array(count + 1);
  const bottoms: number[] = [];
  const tops: number[] = [];
  const items: number[] = [];
  for (let cell = 0; cell < count; cell++) {
    start[cell] = items.length;
    const bottom = cells.bottomLdu[cell] ?? 0;
    const top = cells.topLdu[cell] ?? 0;
    const records = itemRecords.get(cell);
    const column: Spans = top > bottom ? [bottom, top] : [];
    const solid = records
      ? subtract(
          column,
          subtract(union(technicBands.get(cell) ?? []), union(plainBands.get(cell) ?? [])),
        )
      : column;
    for (let s = 0; s < solid.length; s += 2) {
      bottoms.push(solid[s] ?? 0);
      tops.push(solid[s + 1] ?? 0);
      items.push(NO_ITEM);
    }
    for (const record of records ?? []) {
      bottoms.push(record.bottomLdu);
      tops.push(record.topLdu);
      items.push(record.item);
    }
  }
  start[count] = items.length;
  return {
    technic: builder.build(),
    records: {
      start,
      bottomLdu: Int32Array.from(bottoms),
      topLdu: Int32Array.from(tops),
      item: Int32Array.from(items),
    },
  };
}
