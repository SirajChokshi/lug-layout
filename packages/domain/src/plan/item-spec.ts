import { PLATE_LDU, STUD_LDU } from "@brr/math";
import type { LduRect } from "./plan-region.ts";

export interface EdgeFeature {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  readonly levelLdu: number;
}

export interface PartCount {
  readonly part: string;
  readonly ldrawColor: number | null;
  readonly quantity: number;
}

export interface ItemSpec {
  readonly ref: string;
  readonly label: string;
  readonly ground: ReadonlyArray<LduRect>;
  readonly module: LduRect | null;
  readonly joins: ReadonlyArray<EdgeFeature>;
  readonly roadways: ReadonlyArray<EdgeFeature>;
  readonly bom: ReadonlyArray<PartCount>;
}

export interface MilsRecipe {
  readonly groundPart: string;
  readonly edgeJoinCells: ReadonlyArray<readonly [number, number]>;
  readonly surfacePlates: number;
  readonly substructure: ReadonlyArray<PartCount>;
}

export type ModuleProfileId = "free" | "lego-modular" | "mils";

export interface ModuleProfile {
  readonly id: Exclude<ModuleProfileId, "free">;
  readonly moduleStuds: number;
  readonly joinParts: ReadonlyArray<string>;
  readonly joinLevelPlates: number;
  readonly recipe: MilsRecipe | null;
  readonly source: string;
}

export interface ModuleStandards {
  readonly groundParts: ReadonlyArray<string>;
  readonly profiles: ReadonlyArray<ModuleProfile>;
}

const BOX_STRIDE = 6;

export interface InstanceBoxes {
  readonly count: number;
  readonly partIds: ReadonlyArray<string>;
  readonly partIndex: ArrayLike<number>;
  readonly colors: ArrayLike<number>;
  readonly boxes: Float32Array;
}

const LATTICE_IDENTITY_LDU = 1e-3;

function onLattice(value: number): number | null {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) <= LATTICE_IDENTITY_LDU ? rounded + 0 : null;
}

function box(boxes: Float32Array, i: number, axis: number): number {
  return boxes[i * BOX_STRIDE + axis] ?? 0;
}

function bomOf(instances: InstanceBoxes): PartCount[] {
  const counts = new Map<string, { part: string; ldrawColor: number; quantity: number }>();
  for (let i = 0; i < instances.count; i++) {
    const part = instances.partIds[instances.partIndex[i] ?? 0] ?? "";
    const ldrawColor = instances.colors[i] ?? 0;
    const key = `${part} ${ldrawColor}`;
    const line = counts.get(key);
    if (line) line.quantity++;
    else counts.set(key, { part, ldrawColor, quantity: 1 });
  }
  return [...counts.values()];
}

function groundOf(instances: InstanceBoxes, groundParts: ReadonlySet<string>): LduRect[] {
  const rects: LduRect[] = [];
  for (let i = 0; i < instances.count; i++) {
    if (!groundParts.has(instances.partIds[instances.partIndex[i] ?? 0] ?? "")) continue;
    const minX = onLattice(box(instances.boxes, i, 0));
    const minZ = onLattice(box(instances.boxes, i, 2));
    const maxX = onLattice(box(instances.boxes, i, 3));
    const maxZ = onLattice(box(instances.boxes, i, 5));
    if (minX === null || minZ === null || maxX === null || maxZ === null) continue;
    rects.push({ minX, minZ, maxX, maxZ });
  }
  return rects;
}

function groundTopOf(instances: InstanceBoxes, groundParts: ReadonlySet<string>): number | null {
  let top: number | null = null;
  for (let i = 0; i < instances.count; i++) {
    if (!groundParts.has(instances.partIds[instances.partIndex[i] ?? 0] ?? "")) continue;
    const y = box(instances.boxes, i, 4);
    top = top === null ? y : Math.max(top, y);
  }
  return top;
}

function moduleSquare(ground: ReadonlyArray<LduRect>, moduleStuds: number): LduRect | null {
  const [first] = ground;
  if (!first) return null;
  let minX = first.minX;
  let minZ = first.minZ;
  let maxX = first.maxX;
  let maxZ = first.maxZ;
  let area = 0;
  for (const rect of ground) {
    minX = Math.min(minX, rect.minX);
    minZ = Math.min(minZ, rect.minZ);
    maxX = Math.max(maxX, rect.maxX);
    maxZ = Math.max(maxZ, rect.maxZ);
    area += (rect.maxX - rect.minX) * (rect.maxZ - rect.minZ);
  }
  const side = moduleStuds * STUD_LDU;
  const square = maxX - minX === side && maxZ - minZ === side && area === side * side;
  return square ? { minX, minZ, maxX, maxZ } : null;
}

function joinFace(
  module: LduRect,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): Omit<EdgeFeature, "levelLdu"> | null {
  const within =
    minX >= module.minX && maxX <= module.maxX && minZ >= module.minZ && maxZ <= module.maxZ;
  if (!within) return null;
  if (minZ === module.minZ) return { ax: minX, az: minZ, bx: maxX, bz: minZ };
  if (maxZ === module.maxZ) return { ax: minX, az: maxZ, bx: maxX, bz: maxZ };
  if (minX === module.minX) return { ax: minX, az: minZ, bx: minX, bz: maxZ };
  if (maxX === module.maxX) return { ax: maxX, az: minZ, bx: maxX, bz: maxZ };
  return null;
}

function wholeCells(face: Omit<EdgeFeature, "levelLdu">): boolean {
  const length = Math.abs(face.bx - face.ax) + Math.abs(face.bz - face.az);
  const start = face.az === face.bz ? Math.min(face.ax, face.bx) : Math.min(face.az, face.bz);
  return length > 0 && length % STUD_LDU === 0 && ((start % STUD_LDU) + STUD_LDU) % STUD_LDU === 0;
}

function joinsOf(
  instances: InstanceBoxes,
  module: LduRect,
  joinParts: ReadonlySet<string>,
  joinLevels: ReadonlySet<number>,
  groundTop: number,
): EdgeFeature[] {
  const joins: EdgeFeature[] = [];
  for (let i = 0; i < instances.count; i++) {
    if (!joinParts.has(instances.partIds[instances.partIndex[i] ?? 0] ?? "")) continue;
    const minX = onLattice(box(instances.boxes, i, 0));
    const minZ = onLattice(box(instances.boxes, i, 2));
    const maxX = onLattice(box(instances.boxes, i, 3));
    const maxZ = onLattice(box(instances.boxes, i, 5));
    const level = onLattice(box(instances.boxes, i, 1) - groundTop);
    if (minX === null || minZ === null || maxX === null || maxZ === null || level === null) {
      continue;
    }
    if (!joinLevels.has(level)) continue;
    const face = joinFace(module, minX, minZ, maxX, maxZ);
    if (face && wholeCells(face)) joins.push({ ...face, levelLdu: level });
  }
  return joins;
}

function largestModuleStuds(standards: ModuleStandards): number {
  return standards.profiles.reduce((most, profile) => Math.max(most, profile.moduleStuds), 0);
}

export function modelSpec(
  ref: string,
  label: string,
  instances: InstanceBoxes,
  standards: ModuleStandards,
): ItemSpec {
  const groundParts = new Set(standards.groundParts);
  const ground = groundOf(instances, groundParts);
  const module = moduleSquare(ground, largestModuleStuds(standards));
  const groundTop = groundTopOf(instances, groundParts);
  const joinParts = new Set(standards.profiles.flatMap((profile) => profile.joinParts));
  const joinLevels = new Set(
    standards.profiles.map((profile) => profile.joinLevelPlates * PLATE_LDU),
  );
  return {
    ref,
    label,
    ground,
    module,
    joins:
      module && groundTop !== null
        ? joinsOf(instances, module, joinParts, joinLevels, groundTop)
        : [],
    roadways: [],
    bom: bomOf(instances),
  };
}

function studlessRuns(
  studded: ReadonlySet<number>,
  cells: number,
  edge: (from: number, to: number) => EdgeFeature,
): EdgeFeature[] {
  const runs: EdgeFeature[] = [];
  let start: number | null = null;
  for (let cell = 0; cell <= cells; cell++) {
    const open = cell < cells && !studded.has(cell);
    if (open && start === null) start = cell;
    if (!open && start !== null) {
      runs.push(edge(start, cell));
      start = null;
    }
  }
  return runs;
}

function cellOf(value: number, min: number): number {
  return Math.floor((value - min) / STUD_LDU);
}

function along(min: number, cell: number): number {
  return min + cell * STUD_LDU;
}

export function roadwaysOf(
  plate: LduRect,
  studXZ: ReadonlyArray<readonly [number, number]>,
): EdgeFeature[] {
  const columns = (plate.maxX - plate.minX) / STUD_LDU;
  const rows = (plate.maxZ - plate.minZ) / STUD_LDU;
  const north = new Set<number>();
  const south = new Set<number>();
  const west = new Set<number>();
  const east = new Set<number>();
  for (const [x, z] of studXZ) {
    const column = cellOf(x, plate.minX);
    const row = cellOf(z, plate.minZ);
    if (row === 0) north.add(column);
    if (row === rows - 1) south.add(column);
    if (column === 0) west.add(row);
    if (column === columns - 1) east.add(row);
  }
  return [
    ...studlessRuns(north, columns, (a, b) => ({
      ax: along(plate.minX, a),
      az: plate.minZ,
      bx: along(plate.minX, b),
      bz: plate.minZ,
      levelLdu: 0,
    })),
    ...studlessRuns(south, columns, (a, b) => ({
      ax: along(plate.minX, a),
      az: plate.maxZ,
      bx: along(plate.minX, b),
      bz: plate.maxZ,
      levelLdu: 0,
    })),
    ...studlessRuns(west, rows, (a, b) => ({
      ax: plate.minX,
      az: along(plate.minZ, a),
      bx: plate.minX,
      bz: along(plate.minZ, b),
      levelLdu: 0,
    })),
    ...studlessRuns(east, rows, (a, b) => ({
      ax: plate.maxX,
      az: along(plate.minZ, a),
      bx: plate.maxX,
      bz: along(plate.minZ, b),
      levelLdu: 0,
    })),
  ];
}

export function plateSpec(
  ref: string,
  label: string,
  part: string,
  ldrawColor: number,
  plate: LduRect,
  roadways: ReadonlyArray<EdgeFeature>,
  standards: ModuleStandards,
): ItemSpec {
  return {
    ref,
    label,
    ground: [plate],
    module: moduleSquare([plate], largestModuleStuds(standards)),
    joins: [],
    roadways,
    bom: [{ part, ldrawColor, quantity: 1 }],
  };
}
