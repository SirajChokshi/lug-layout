import {
  EMPTY_COLUMN,
  type ModelCells,
  type ModelStudCover,
  type PartShapeAsset,
  type PartModel,
  type PartModelLattice,
} from "@brr/catalog";
import type { PartInstances, RoadSurface, SubmodelInstances } from "@brr/domain";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import type { ModelRole, Vec3 } from "@brr/schema/bundle";
import { INSTANCE_MATRIX_FLOATS, type StudInstances } from "@brr/render";
import type { ChunkPartInstances } from "../scene/placements.ts";
import { bakedVisible, withStuds } from "../scene/stud-stream.ts";
import type { ColorTable, ModelCredit } from "../scene/viewer-scene.ts";
import { BOX_FLOATS, type LocalBox } from "./local-box.ts";
import { roadSurface } from "./road-surface.ts";

export type PlaceableKind = "baseplate" | "road-plate" | "model";

export interface PlaceableCells {
  readonly cellX0: number;
  readonly cellZ0: number;
  readonly width: number;
  readonly depth: number;
  readonly footprint: Uint8Array;
  readonly columnBottom: Int16Array;
  readonly columnTop: Int16Array;
  readonly footprintCells: number;
  readonly flatCells: number;
  readonly heightPlates: number;
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
  readonly worldColor: number;
  readonly parts: ChunkPartInstances;
  readonly partTransforms: PartInstances;
  readonly studs: StudInstances;
  readonly studLattice: StudLattice;
  readonly bakedCoveredStuds: number;
  readonly cells: PlaceableCells;
  readonly box: LocalBox;
  readonly partBoxes: Float32Array;
  readonly frameShift: Vec3;
  readonly farModel: number | null;
  readonly credit: ModelCredit | null;
  readonly road: RoadSurface | null;
  readonly slabDepthLdu: number;
}

const HALF_STUD_LDU = STUD_LDU / 2;
export const FOOTPRINT_NONE = 0;
export const FOOTPRINT_ANTI_STUD = 1;
export const FOOTPRINT_FLAT = 2;

function instanceBoxes(
  instances: ChunkPartInstances,
  parts: ReadonlyArray<PartShapeAsset>,
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

const ROW_X = 0;
const ROW_Y = 1;
const ROW_Z = 2;
const COLUMN_Y = 1;
const COLUMN_TRANSLATION = 3;

function composed(
  outer: Float64Array,
  o: number,
  inner: Float32Array,
  n: number,
  row: number,
  column: number,
): number {
  const translation = column === COLUMN_TRANSLATION ? (outer[o + row * 4 + 3] ?? 0) : 0;
  return (
    (outer[o + row * 4] ?? 0) * (inner[n + column] ?? 0) +
    (outer[o + row * 4 + 1] ?? 0) * (inner[n + 4 + column] ?? 0) +
    (outer[o + row * 4 + 2] ?? 0) * (inner[n + 8 + column] ?? 0) +
    translation
  );
}

function studLattice(
  transforms: PartInstances,
  parts: ReadonlyArray<PartShapeAsset>,
  cover: ModelStudCover | undefined,
  count: number,
): StudLattice {
  const onLattice = new Uint8Array(count);
  const cellX = new Int32Array(count);
  const cellZ = new Int32Array(count);
  const baseLdu = new Int32Array(count);
  const m = transforms.matrices;
  let stud = 0;
  let visible = 0;
  for (let i = 0; i < transforms.count; i++) {
    const part = parts[transforms.partIndex[i] ?? 0];
    if (!part) continue;
    const o = i * INSTANCE_MATRIX_FLOATS;
    for (let s = 0; s < part.studPrimitiveIndex.length; s++, stud++) {
      if (!bakedVisible(cover, stud)) continue;
      const at = visible++;
      const n = s * INSTANCE_MATRIX_FLOATS;
      const local = part.studMatrices;
      const upright =
        composed(m, o, local, n, ROW_X, COLUMN_Y) === 0 &&
        composed(m, o, local, n, ROW_Z, COLUMN_Y) === 0 &&
        composed(m, o, local, n, ROW_Y, COLUMN_Y) > 0;
      const x = latticeCell(composed(m, o, local, n, ROW_X, COLUMN_TRANSLATION));
      const z = latticeCell(composed(m, o, local, n, ROW_Z, COLUMN_TRANSLATION));
      const base = composed(m, o, local, n, ROW_Y, COLUMN_TRANSLATION);
      if (!upright || x === null || z === null || !Number.isInteger(base)) continue;
      onLattice[at] = 1;
      cellX[at] = x;
      cellZ[at] = z;
      baseLdu[at] = base;
    }
  }
  if (visible !== count) {
    throw new Error(
      `the part transforms give ${visible} visible studs but the render has ${count}`,
    );
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
): PlaceableCells {
  const footprint = new Uint8Array(cells.width * cells.depth);
  for (const cell of cells.footprint) footprint[cell] = FOOTPRINT_ANTI_STUD;
  for (const cell of cells.flat) footprint[cell] = FOOTPRINT_FLAT;
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
  return {
    cellX0: wholeCells(cells.originX + shift[0], `${label} cell origin x`),
    cellZ0: wholeCells(cells.originZ + shift[2], `${label} cell origin z`),
    width: cells.width,
    depth: cells.depth,
    footprint,
    columnBottom,
    columnTop,
    footprintCells: cells.footprint.length,
    flatCells: cells.flat.length,
    heightPlates,
  };
}

function partCells(part: PartShapeAsset, shift: Vec3): PlaceableCells {
  const cellX0 = wholeCells(part.boundsMin[0], `${part.id} min x`);
  const cellZ0 = wholeCells(part.boundsMin[2], `${part.id} min z`);
  const width = wholeCells(part.boundsMax[0], `${part.id} max x`) - cellX0;
  const depth = wholeCells(part.boundsMax[2], `${part.id} max z`) - cellZ0;
  const heightPlates = Math.max(0, Math.ceil((part.boundsMax[1] + shift[1]) / PLATE_LDU));
  return {
    cellX0,
    cellZ0,
    width,
    depth,
    footprint: new Uint8Array(width * depth),
    columnBottom: new Int16Array(width * depth),
    columnTop: new Int16Array(width * depth).fill(heightPlates),
    footprintCells: 0,
    flatCells: 0,
    heightPlates,
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

function shiftTranslations(out: Float32Array | Float64Array, count: number, shift: Vec3): void {
  for (let i = 0; i < count; i++) {
    const o = i * INSTANCE_MATRIX_FLOATS;
    out[o + 3] = (out[o + 3] ?? 0) + shift[0];
    out[o + 7] = (out[o + 7] ?? 0) + shift[1];
    out[o + 11] = (out[o + 11] ?? 0) + shift[2];
  }
}

function shifted(matrices: Float32Array, count: number, shift: Vec3): Float32Array {
  const out = Float32Array.from(matrices);
  shiftTranslations(out, count, shift);
  return out;
}

function shiftedTransforms(matrices: Float64Array, count: number, shift: Vec3): Float64Array {
  const out = Float64Array.from(matrices);
  shiftTranslations(out, count, shift);
  return out;
}

function shiftedSubmodels(submodels: SubmodelInstances, shift: Vec3): SubmodelInstances {
  return { ...submodels, matrices: shiftedTransforms(submodels.matrices, submodels.count, shift) };
}

function depthBelowRest(box: LocalBox): number {
  return Math.max(0, -box.min[1]);
}

function shiftedBox(min: Vec3, max: Vec3, shift: Vec3): LocalBox {
  return {
    min: [min[0] + shift[0], min[1] + shift[1], min[2] + shift[2]],
    max: [max[0] + shift[0], max[1] + shift[1], max[2] + shift[2]],
  };
}

function groundTop(model: PartModel, parts: ReadonlyArray<PartShapeAsset>): number | null {
  const boxes = instanceBoxes(
    {
      originX: 0,
      originZ: 0,
      count: model.instanceCount,
      partIndex: model.partIndex,
      colorIndex: new Uint16Array(model.instanceCount),
      matrices: model.matrices,
    },
    parts,
  );
  let top: number | null = null;
  for (let i = 0; i < model.instanceCount; i++) {
    if (parts[model.partIndex[i] ?? 0]?.role !== "ground") continue;
    const y = boxes[i * BOX_FLOATS + 4] ?? 0;
    top = top === null ? y : Math.max(top, y);
  }
  return top;
}

function restingY(
  model: PartModel,
  cells: ModelCells,
  parts: ReadonlyArray<PartShapeAsset>,
  role: ModelRole | undefined,
): number {
  if (role !== "mils-module") return cells.restY;
  const top = groundTop(model, parts);
  if (top === null) throw new Error("a MILS module needs its own baseplate to stand on");
  return top;
}

export function modelPlaceable(
  id: string,
  name: string,
  label: string,
  role: ModelRole | undefined,
  model: PartModel,
  credit: ModelCredit,
  parts: ReadonlyArray<PartShapeAsset>,
  colors: ColorTable,
  farModel: number | null,
): Placeable {
  const { lattice, cells } = model;
  if (lattice === null || cells === null) {
    throw new Error(`model ${name} has no stud lattice from the bake, so it cannot be placed`);
  }
  const restingOn = restingY(model, cells, parts, role);
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
  const studs = withStuds(local, parts, colors, model.studCover).studs;
  const partTransforms: PartInstances = {
    count: model.instanceCount,
    partIndex: model.partIndex,
    matrices: shiftedTransforms(model.partTransforms, model.instanceCount, shift),
    submodels: shiftedSubmodels(model.submodels, shift),
  };
  const restPlates = (cells.restY - restingOn) / PLATE_LDU;
  return {
    id,
    label,
    group: id,
    groupLabel: label,
    kind: "model",
    worldColor: 0,
    parts: local,
    partTransforms,
    studs,
    studLattice: studLattice(partTransforms, parts, model.studCover, studs.count),
    bakedCoveredStuds: model.studCover.covered,
    cells: modelCells(cells, shift, name, restPlates),
    box,
    partBoxes,
    frameShift: shift,
    farModel,
    credit,
    road: null,
    slabDepthLdu: role === "mils-module" ? depthBelowRest(box) : 0,
  };
}

const IDENTITY_MATRIX = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);
const IDENTITY_TRANSFORM = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);

function isBaseplate(part: PartShapeAsset): boolean {
  return part.boundsMax[1] - part.boundsMin[1] < PLATE_LDU;
}

export function partPlaceable(
  part: PartShapeAsset,
  partIndex: number,
  ldrawColor: number,
  colorName: string,
  parts: ReadonlyArray<PartShapeAsset>,
  colors: ColorTable,
): Placeable {
  const shift: Vec3 = [0, isBaseplate(part) ? 0 : -part.boundsMin[1], 0];
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
  const studs = withStuds(local, parts, colors).studs;
  const partTransforms: PartInstances = {
    count: 1,
    partIndex: local.partIndex,
    matrices: shiftedTransforms(IDENTITY_TRANSFORM, 1, shift),
  };
  return {
    id: `${part.id}@${ldrawColor}`,
    label: `${part.id.replace("ldraw:", "")} ${part.title}, ${colorName}`,
    group: part.id,
    groupLabel: `${part.id.replace("ldraw:", "")} ${part.title}`,
    kind: isRoad ? "road-plate" : "baseplate",
    worldColor: ldrawColor,
    parts: local,
    partTransforms,
    studs,
    studLattice: studLattice(partTransforms, parts, undefined, studs.count),
    bakedCoveredStuds: 0,
    cells: partCells(part, shift),
    box,
    partBoxes,
    frameShift: shift,
    farModel: null,
    credit: null,
    road: isRoad ? roadSurface(local, partBoxes, box, parts) : null,
    slabDepthLdu: depthBelowRest(box),
  };
}
