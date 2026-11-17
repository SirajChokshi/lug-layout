import {
  EMPTY_COLUMN,
  type ModelCells,
  type PartAsset,
  type PartModel,
  type PartModelLattice,
} from "@brr/catalog";
import type { RoadSurface } from "@brr/domain";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import type { ModelRole, Vec3 } from "@brr/schema/bundle";
import { INSTANCE_MATRIX_FLOATS, type StudInstances } from "@brr/render";
import type { ChunkPartInstances } from "../scene/placements.ts";
import { withStuds } from "../scene/stud-stream.ts";
import type { ColorTable, ModelCredit } from "../scene/viewer-scene.ts";
import { BOX_FLOATS, type LocalBox } from "./local-box.ts";
import { roadSurface } from "./road-surface.ts";

export type PlaceableKind = "baseplate" | "road-plate" | "mils-module" | "model";
export type PlaceableLayer = "first" | "upper";

export interface PlaceableCells {
  readonly cellX0: number;
  readonly cellZ0: number;
  readonly width: number;
  readonly depth: number;
  readonly footprint: Uint8Array;
  readonly baseplate: Uint8Array;
  readonly columnBottom: Int16Array;
  readonly columnTop: Int16Array;
  readonly bottomLdu: Int32Array;
  readonly topLdu: Int32Array;
  readonly footprintCells: number;
  readonly flatCells: number;
  readonly heightPlates: number;
  readonly offLatticeTop: boolean;
}

export interface StudLattice {
  readonly onLattice: Uint8Array;
  readonly cellX: Int32Array;
  readonly cellZ: Int32Array;
  readonly baseLdu: Int32Array;
}

export interface Placeable {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly groupLabel: string;
  readonly kind: PlaceableKind;
  readonly layer: PlaceableLayer;
  readonly worldColor: number;
  readonly parts: ChunkPartInstances;
  readonly studs: StudInstances;
  readonly studLattice: StudLattice;
  readonly bakedCoveredStuds: number;
  readonly cells: PlaceableCells;
  readonly box: LocalBox;
  readonly partBoxes: Float32Array;
  readonly frameShift: Vec3;
  readonly credit: ModelCredit | null;
  readonly road: RoadSurface | null;
}

const HALF_STUD_LDU = STUD_LDU / 2;
export const FOOTPRINT_NONE = 0;
export const FOOTPRINT_ANTI_STUD = 1;
export const FOOTPRINT_FLAT = 2;

function instanceBoxes(
  instances: ChunkPartInstances,
  parts: ReadonlyArray<PartAsset>,
): Float32Array {
  const boxes = new Float32Array(instances.count * BOX_FLOATS);
  for (let i = 0; i < instances.count; i++) {
    const part = parts[instances.partIndex[i] ?? 0];
    if (!part) continue;
    const m = instances.matrices;
    const o = i * INSTANCE_MATRIX_FLOATS;
    const b = i * BOX_FLOATS;
    for (let axis = 0; axis < 3; axis++) {
      let lo = m[o + axis * 4 + 3] ?? 0;
      let hi = lo;
      for (let k = 0; k < 3; k++) {
        const coefficient = m[o + axis * 4 + k] ?? 0;
        const a = coefficient * (part.boundsMin[k] ?? 0);
        const c = coefficient * (part.boundsMax[k] ?? 0);
        lo += Math.min(a, c);
        hi += Math.max(a, c);
      }
      boxes[b + axis] = lo;
      boxes[b + 3 + axis] = hi;
    }
  }
  return boxes;
}

function latticeCell(centre: number): number | null {
  const cell = (centre - HALF_STUD_LDU) / STUD_LDU;
  return Number.isInteger(cell) ? cell : null;
}

function studLattice(studs: StudInstances): StudLattice {
  const onLattice = new Uint8Array(studs.count);
  const cellX = new Int32Array(studs.count);
  const cellZ = new Int32Array(studs.count);
  const baseLdu = new Int32Array(studs.count);
  const m = studs.matrices;
  for (let i = 0; i < studs.count; i++) {
    const o = i * INSTANCE_MATRIX_FLOATS;
    const upright = m[o + 1] === 0 && m[o + 9] === 0 && (m[o + 5] ?? 0) > 0;
    const x = latticeCell(m[o + 3] ?? 0);
    const z = latticeCell(m[o + 11] ?? 0);
    const base = m[o + 7] ?? 0;
    if (!upright || x === null || z === null || !Number.isInteger(base)) continue;
    onLattice[i] = 1;
    cellX[i] = x;
    cellZ[i] = z;
    baseLdu[i] = base;
  }
  return { onLattice, cellX, cellZ, baseLdu };
}

function wholeCells(ldu: number, what: string): number {
  const cells = ldu / STUD_LDU;
  if (!Number.isInteger(cells)) {
    throw new Error(`${what} ${ldu} LDU is not on the 20 LDU cell grid after the lattice shift`);
  }
  return cells;
}

function modelCells(
  cells: ModelCells,
  shift: Vec3,
  label: string,
  restPlatesInFrame: number,
  withFootprint: boolean,
  tableY: number,
): PlaceableCells {
  const footprint = new Uint8Array(cells.width * cells.depth);
  if (withFootprint) {
    for (const cell of cells.footprint) footprint[cell] = FOOTPRINT_ANTI_STUD;
    for (const cell of cells.flat) footprint[cell] = FOOTPRINT_FLAT;
  }
  const baseplate = new Uint8Array(cells.width * cells.depth);
  if (cells.groundY !== null) for (const cell of cells.flat) baseplate[cell] = 1;
  const columnBottom = new Int16Array(cells.columnBottom.length);
  const columnTop = new Int16Array(cells.columnTop.length);
  let heightPlates = 0;
  for (let i = 0; i < columnTop.length; i++) {
    const top = cells.columnTop[i] ?? EMPTY_COLUMN;
    if (top === EMPTY_COLUMN) {
      columnBottom[i] = EMPTY_COLUMN;
      columnTop[i] = EMPTY_COLUMN;
      continue;
    }
    columnBottom[i] = Math.max(0, Math.floor((cells.columnBottom[i] ?? 0) + restPlatesInFrame));
    columnTop[i] = Math.max(0, Math.ceil(top + restPlatesInFrame));
    heightPlates = Math.max(heightPlates, columnTop[i] ?? 0);
  }
  const bottomLdu = new Int32Array(columnTop.length);
  const topLdu = new Int32Array(columnTop.length);
  for (let i = 0; i < columnTop.length; i++) {
    const top = columnTop[i] ?? EMPTY_COLUMN;
    if (top === EMPTY_COLUMN) continue;
    const bottom = columnBottom[i] ?? 0;
    bottomLdu[i] = baseplate[i] === 1 && bottom === 0 ? tableY : bottom * PLATE_LDU;
    topLdu[i] = top * PLATE_LDU;
  }
  return {
    cellX0: wholeCells(cells.originX + shift[0], `${label} cell origin x`),
    cellZ0: wholeCells(cells.originZ + shift[2], `${label} cell origin z`),
    width: cells.width,
    depth: cells.depth,
    footprint,
    baseplate,
    columnBottom,
    columnTop,
    bottomLdu,
    topLdu,
    footprintCells: withFootprint ? cells.footprint.length : 0,
    flatCells: withFootprint ? cells.flat.length : 0,
    heightPlates,
    offLatticeTop: false,
  };
}

function partCells(part: PartAsset, shift: Vec3, tableY: number): PlaceableCells {
  const cellX0 = wholeCells(part.boundsMin[0], `${part.id} min x`);
  const cellZ0 = wholeCells(part.boundsMin[2], `${part.id} min z`);
  const width = wholeCells(part.boundsMax[0], `${part.id} max x`) - cellX0;
  const depth = wholeCells(part.boundsMax[2], `${part.id} max z`) - cellZ0;
  const topY = part.boundsMax[1] + shift[1];
  const heightPlates = Math.max(0, Math.ceil(topY / PLATE_LDU));
  return {
    cellX0,
    cellZ0,
    width,
    depth,
    footprint: new Uint8Array(width * depth),
    baseplate: new Uint8Array(width * depth).fill(isBaseplatePart(part) ? 1 : 0),
    columnBottom: new Int16Array(width * depth),
    columnTop: new Int16Array(width * depth).fill(heightPlates),
    bottomLdu: new Int32Array(width * depth).fill(tableY),
    topLdu: new Int32Array(width * depth).fill(Math.ceil(topY)),
    footprintCells: 0,
    flatCells: 0,
    heightPlates,
    offLatticeTop: topY % PLATE_LDU !== 0,
  };
}

interface PlanBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

function footprintBounds(cells: ModelCells): PlanBounds | null {
  if (cells.footprint.length === 0) return null;
  let minI = Number.POSITIVE_INFINITY;
  let maxI = Number.NEGATIVE_INFINITY;
  let minJ = Number.POSITIVE_INFINITY;
  let maxJ = Number.NEGATIVE_INFINITY;
  for (const cell of cells.footprint) {
    const i = cell % cells.width;
    const j = Math.floor(cell / cells.width);
    minI = Math.min(minI, i);
    maxI = Math.max(maxI, i);
    minJ = Math.min(minJ, j);
    maxJ = Math.max(maxJ, j);
  }
  return {
    minX: cells.originX + minI * STUD_LDU,
    maxX: cells.originX + (maxI + 1) * STUD_LDU,
    minZ: cells.originZ + minJ * STUD_LDU,
    maxZ: cells.originZ + (maxJ + 1) * STUD_LDU,
  };
}

export function phaseShift(phase: number): number {
  return HALF_STUD_LDU - phase;
}

export function pivotOnStudCorner(centre: number): number {
  return Math.round(centre / STUD_LDU) * STUD_LDU;
}

export function modelFrameShift(
  lattice: PartModelLattice,
  cells: ModelCells,
  restingOn: number,
): Vec3 {
  const shiftX = phaseShift(lattice.phaseX);
  const shiftZ = phaseShift(lattice.phaseZ);
  const plan = footprintBounds(cells) ?? {
    minX: lattice.aabbMin[0],
    maxX: lattice.aabbMax[0],
    minZ: lattice.aabbMin[2],
    maxZ: lattice.aabbMax[2],
  };
  const centreX = (plan.minX + plan.maxX) / 2 + shiftX;
  const centreZ = (plan.minZ + plan.maxZ) / 2 + shiftZ;
  return [shiftX - pivotOnStudCorner(centreX), -restingOn, shiftZ - pivotOnStudCorner(centreZ)];
}

function shifted(matrices: Float32Array, count: number, shift: Vec3): Float32Array {
  const out = Float32Array.from(matrices);
  for (let i = 0; i < count; i++) {
    const o = i * INSTANCE_MATRIX_FLOATS;
    out[o + 3] = (out[o + 3] ?? 0) + shift[0];
    out[o + 7] = (out[o + 7] ?? 0) + shift[1];
    out[o + 11] = (out[o + 11] ?? 0) + shift[2];
  }
  return out;
}

function shiftedBox(min: Vec3, max: Vec3, shift: Vec3): LocalBox {
  return {
    min: [min[0] + shift[0], min[1] + shift[1], min[2] + shift[2]],
    max: [max[0] + shift[0], max[1] + shift[1], max[2] + shift[2]],
  };
}

function restingY(cells: ModelCells, name: string, role: ModelRole | undefined): number {
  if (role === "mils-module" && cells.groundY === null) {
    throw new Error(`MILS module ${name} does not stand on its own baseplate`);
  }
  return cells.groundY ?? cells.restY;
}

function hasRoadPart(instances: ChunkPartInstances, parts: ReadonlyArray<PartAsset>): boolean {
  for (let i = 0; i < instances.count; i++) {
    const index = instances.partIndex[i];
    const part = index === undefined ? undefined : parts[index];
    if (!part)
      throw new Error(`instance ${i} names part ${String(index)}, which the palette lacks`);
    if (part.role === "road") return true;
  }
  return false;
}

export function modelPlaceable(
  name: string,
  label: string,
  role: ModelRole | undefined,
  model: PartModel,
  credit: ModelCredit,
  parts: ReadonlyArray<PartAsset>,
  colors: ColorTable,
  tableY: number,
): Placeable {
  const { lattice, cells } = model;
  if (lattice === null || cells === null) {
    throw new Error(`model ${name} has no stud lattice from the bake, so it cannot be placed`);
  }
  const restingOn = restingY(cells, name, role);
  const shift = modelFrameShift(lattice, cells, restingOn);
  const colorIndex = new Uint16Array(model.instanceCount);
  for (let i = 0; i < model.instanceCount; i++) {
    colorIndex[i] = colors.indexOfCode(model.ldrawColor[i] ?? 0);
  }
  const local: ChunkPartInstances = {
    originX: 0,
    originZ: 0,
    count: model.instanceCount,
    partIndex: model.partIndex,
    colorIndex,
    matrices: shifted(model.matrices, model.instanceCount, shift),
  };
  const box = shiftedBox(lattice.aabbMin, lattice.aabbMax, shift);
  const partBoxes = instanceBoxes(local, parts);
  const isModule = role === "mils-module";
  const id = isModule ? `generated:${name}` : `omr:${name}`;
  const studs = withStuds(local, parts, colors, undefined, model.studCover).studs;
  return {
    id,
    label,
    group: id,
    groupLabel: label,
    kind: isModule ? "mils-module" : "model",
    layer: cells.groundY === null ? "upper" : "first",
    worldColor: 0,
    parts: local,
    studs,
    studLattice: studLattice(studs),
    bakedCoveredStuds: model.studCover.covered,
    cells: modelCells(
      cells,
      shift,
      name,
      ((cells.groundY ?? cells.restY) - restingOn) / PLATE_LDU,
      !isModule,
      tableY,
    ),
    box,
    partBoxes,
    frameShift: shift,
    credit: isModule ? null : credit,
    road: isModule && hasRoadPart(local, parts) ? roadSurface(local, partBoxes, box, parts) : null,
  };
}

const IDENTITY_MATRIX = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);

export function isBaseplatePart(part: PartAsset): boolean {
  return part.baseplate;
}

function restingOnTable(part: PartAsset, tableY: number): number {
  if (!isBaseplatePart(part)) return tableY - part.boundsMin[1];
  if (part.boundsMax[1] !== 0) {
    throw new Error(
      `${part.id} is a baseplate whose top face is at y = ${part.boundsMax[1]}, not 0`,
    );
  }
  return 0;
}

export function partPlaceable(
  part: PartAsset,
  partIndex: number,
  ldrawColor: number,
  colorName: string,
  parts: ReadonlyArray<PartAsset>,
  colors: ColorTable,
  tableY: number,
): Placeable {
  const shift: Vec3 = [0, restingOnTable(part, tableY), 0];
  const local: ChunkPartInstances = {
    originX: 0,
    originZ: 0,
    count: 1,
    partIndex: Uint16Array.of(partIndex),
    colorIndex: Uint16Array.of(colors.indexOfCode(ldrawColor)),
    matrices: shifted(IDENTITY_MATRIX, 1, shift),
  };
  const box = shiftedBox(part.boundsMin, part.boundsMax, shift);
  const partBoxes = instanceBoxes(local, parts);
  const isRoad = part.role === "road";
  const studs = withStuds(local, parts, colors, undefined).studs;
  return {
    id: `${part.id}@${ldrawColor}`,
    label: `${part.id.replace("ldraw:", "")} ${part.title}, ${colorName}`,
    group: part.id,
    groupLabel: `${part.id.replace("ldraw:", "")} ${part.title}`,
    kind: isRoad ? "road-plate" : "baseplate",
    layer: "first",
    worldColor: ldrawColor,
    parts: local,
    studs,
    studLattice: studLattice(studs),
    bakedCoveredStuds: 0,
    cells: partCells(part, shift, tableY),
    box,
    partBoxes,
    frameShift: shift,
    credit: null,
    road: isRoad ? roadSurface(local, partBoxes, box, parts) : null,
  };
}
