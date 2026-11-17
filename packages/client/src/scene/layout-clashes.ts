import { EMPTY_COLUMN, type PartAsset } from "@brr/catalog";
import { STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS, type ChunkInstances, type WorldBox } from "@brr/render";
import type { PlacedModel } from "../edit/placed-chunks.ts";

const HALF_STUD_LDU = STUD_LDU / 2;
const CELL_KEY_SPAN = 1 << 20;

interface ColumnSpan {
  readonly owner: PlacedModel;
  readonly bottomPlates: number;
  readonly topPlates: number;
}

function cellKey(cellX: number, cellZ: number): number {
  return cellX * CELL_KEY_SPAN + cellZ;
}

function forEachColumn(
  model: PlacedModel,
  visit: (cellX: number, cellZ: number, bottomPlates: number, topPlates: number) => void,
): void {
  const { handle, placeable } = model;
  if (!isRot90(handle.rot)) throw new Error(`${placeable.label} is not turned a whole quarter`);
  const cos = rot90Cos(handle.rot);
  const sin = rot90Sin(handle.rot);
  const { cells } = placeable;
  for (let j = 0; j < cells.depth; j++) {
    for (let i = 0; i < cells.width; i++) {
      const cell = j * cells.width + i;
      const top = cells.columnTop[cell] ?? EMPTY_COLUMN;
      if (top === EMPTY_COLUMN) continue;
      const lx = (cells.cellX0 + i) * STUD_LDU + HALF_STUD_LDU;
      const lz = (cells.cellZ0 + j) * STUD_LDU + HALF_STUD_LDU;
      visit(
        Math.floor((handle.x + cos * lx + sin * lz) / STUD_LDU),
        Math.floor((handle.z - sin * lx + cos * lz) / STUD_LDU),
        handle.yPlates + (cells.columnBottom[cell] ?? 0),
        handle.yPlates + top,
      );
    }
  }
}

function coveredCells(models: ReadonlyArray<PlacedModel>): Set<number> {
  const covered = new Set<number>();
  for (const { box } of models) {
    const x1 = Math.round(box.maxX / STUD_LDU);
    const z1 = Math.round(box.maxZ / STUD_LDU);
    for (let x = Math.round(box.minX / STUD_LDU); x < x1; x++) {
      for (let z = Math.round(box.minZ / STUD_LDU); z < z1; z++) covered.add(cellKey(x, z));
    }
  }
  return covered;
}

function unsupported(
  models: ReadonlyArray<PlacedModel>,
  supports: ReadonlyArray<PlacedModel>,
): string | null {
  const onModules = coveredCells(supports.filter((s) => s.placeable.kind === "mils-module"));
  const onGround = coveredCells(supports.filter((s) => s.placeable.kind === "baseplate"));
  for (const model of models) {
    const base = model.handle.yPlates;
    const surface = base > 0 ? onModules : onGround;
    let outside = 0;
    forEachColumn(model, (cellX, cellZ, bottom) => {
      if (bottom === base && !surface.has(cellKey(cellX, cellZ))) outside++;
    });
    if (outside > 0) {
      return `${model.placeable.label} stands ${outside} columns off the ${base > 0 ? "module" : "baseplates"} it rests on`;
    }
  }
  return null;
}

function columnClash(models: ReadonlyArray<PlacedModel>): string | null {
  const spans = new Map<number, ColumnSpan[]>();
  let clash: string | null = null;
  for (const model of models) {
    forEachColumn(model, (cellX, cellZ, bottomPlates, topPlates) => {
      const key = cellKey(cellX, cellZ);
      let here = spans.get(key);
      if (!here) {
        here = [];
        spans.set(key, here);
      }
      for (const other of here) {
        if (clash || other.owner === model) continue;
        if (bottomPlates < other.topPlates && other.bottomPlates < topPlates) {
          clash = `${model.placeable.label} runs into ${other.owner.placeable.label} at stud ${cellX}, ${cellZ}`;
        }
      }
      here.push({ owner: model, bottomPlates, topPlates });
    });
  }
  return clash;
}

function separatedOnAxis(
  axisX: number,
  axisZ: number,
  triangle: Float64Array,
  box: WorldBox,
): boolean {
  let triMin = Number.POSITIVE_INFINITY;
  let triMax = Number.NEGATIVE_INFINITY;
  for (let v = 0; v < 3; v++) {
    const p = axisX * (triangle[v * 3] ?? 0) + axisZ * (triangle[v * 3 + 2] ?? 0);
    triMin = Math.min(triMin, p);
    triMax = Math.max(triMax, p);
  }
  const corners = [
    axisX * box.minX + axisZ * box.minZ,
    axisX * box.maxX + axisZ * box.minZ,
    axisX * box.minX + axisZ * box.maxZ,
    axisX * box.maxX + axisZ * box.maxZ,
  ];
  return triMax <= Math.min(...corners) || triMin >= Math.max(...corners);
}

function triangleMeetsBox(triangle: Float64Array, box: WorldBox): boolean {
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let v = 0; v < 3; v++) {
    minY = Math.min(minY, triangle[v * 3 + 1] ?? 0);
    maxY = Math.max(maxY, triangle[v * 3 + 1] ?? 0);
  }
  if (maxY <= box.minY || minY >= box.maxY) return false;
  if (separatedOnAxis(1, 0, triangle, box) || separatedOnAxis(0, 1, triangle, box)) return false;
  for (let e = 0; e < 3; e++) {
    const a = e * 3;
    const b = ((e + 1) % 3) * 3;
    const edgeX = (triangle[b] ?? 0) - (triangle[a] ?? 0);
    const edgeZ = (triangle[b + 2] ?? 0) - (triangle[a + 2] ?? 0);
    if (edgeX === 0 && edgeZ === 0) continue;
    if (separatedOnAxis(-edgeZ, edgeX, triangle, box)) return false;
  }
  return true;
}

function worldVertex(
  chunk: ChunkInstances,
  instance: number,
  positions: Float32Array,
  vertex: number,
  out: Float64Array,
  slot: number,
): void {
  const m = chunk.matrices;
  const o = instance * INSTANCE_MATRIX_FLOATS;
  const px = positions[vertex * 3] ?? 0;
  const py = positions[vertex * 3 + 1] ?? 0;
  const pz = positions[vertex * 3 + 2] ?? 0;
  for (let axis = 0; axis < 3; axis++) {
    const r = o + axis * 4;
    out[slot * 3 + axis] =
      (m[r] ?? 0) * px + (m[r + 1] ?? 0) * py + (m[r + 2] ?? 0) * pz + (m[r + 3] ?? 0);
  }
  out[slot * 3] = (out[slot * 3] ?? 0) + chunk.originX;
  out[slot * 3 + 2] = (out[slot * 3 + 2] ?? 0) + chunk.originZ;
}

function instanceBox(chunk: ChunkInstances, instance: number, part: PartAsset): WorldBox {
  const m = chunk.matrices;
  const o = instance * INSTANCE_MATRIX_FLOATS;
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    let min = m[o + axis * 4 + 3] ?? 0;
    let max = min;
    for (let k = 0; k < 3; k++) {
      const coefficient = m[o + axis * 4 + k] ?? 0;
      const a = coefficient * (part.boundsMin[k] ?? 0);
      const b = coefficient * (part.boundsMax[k] ?? 0);
      min += Math.min(a, b);
      max += Math.max(a, b);
    }
    lo[axis] = min;
    hi[axis] = max;
  }
  return {
    minX: chunk.originX + (lo[0] ?? 0),
    minY: lo[1] ?? 0,
    minZ: chunk.originZ + (lo[2] ?? 0),
    maxX: chunk.originX + (hi[0] ?? 0),
    maxY: hi[1] ?? 0,
    maxZ: chunk.originZ + (hi[2] ?? 0),
  };
}

function boxesMeet(a: WorldBox, b: WorldBox): boolean {
  return (
    a.minX < b.maxX &&
    b.minX < a.maxX &&
    a.minY < b.maxY &&
    b.minY < a.maxY &&
    a.minZ < b.maxZ &&
    b.minZ < a.maxZ
  );
}

function trackClash(
  chunk: ChunkInstances,
  parts: ReadonlyArray<PartAsset>,
  obstacles: ReadonlyArray<PlacedModel>,
): string | null {
  const triangle = new Float64Array(9);
  for (let i = 0; i < chunk.count; i++) {
    const part = parts[chunk.partIndex[i] ?? 0];
    if (!part) continue;
    const box = instanceBox(chunk, i, part);
    const near = obstacles.filter((obstacle) => boxesMeet(box, obstacle.box));
    if (near.length === 0) continue;
    for (const group of part.mesh.groups) {
      for (let t = 0; t + 2 < group.indices.length; t += 3) {
        for (let v = 0; v < 3; v++) {
          worldVertex(chunk, i, part.mesh.positions, group.indices[t + v] ?? 0, triangle, v);
        }
        const hit = near.find((obstacle) => triangleMeetsBox(triangle, obstacle.box));
        if (hit) return `the track's ${part.id} runs into ${hit.placeable.label}`;
      }
    }
  }
  return null;
}

export function layoutClash(
  placed: ReadonlyArray<PlacedModel>,
  trackChunks: ReadonlyArray<ChunkInstances>,
  parts: ReadonlyArray<PartAsset>,
): string | null {
  const models = placed.filter((model) => model.placeable.kind === "model");
  const supports = placed.filter((model) => model.placeable.kind !== "model");
  const obstacles = placed.filter((model) => model.placeable.kind !== "baseplate");
  let found = unsupported(models, supports) ?? columnClash(models);
  for (const chunk of trackChunks) found ??= trackClash(chunk, parts, obstacles);
  return found;
}
