import type { LduRect } from "./plan-region.ts";

export interface Segment {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
}

export interface Seam extends Segment {
  readonly tables: readonly [number, number];
}

export interface TableEdges {
  readonly exterior: ReadonlyArray<Segment>;
  readonly seams: ReadonlyArray<Seam>;
}

const NONE = -1;

function sortedUnique(values: ReadonlyArray<number>): number[] {
  return [...new Set(values)].toSorted((a, b) => a - b);
}

function containsPoint(rect: LduRect, x: number, z: number): boolean {
  return x > rect.minX && x < rect.maxX && z > rect.minZ && z < rect.maxZ;
}

export function tableEdges(tables: ReadonlyArray<LduRect>): TableEdges {
  const xs = sortedUnique(tables.flatMap((t) => [t.minX, t.maxX]));
  const zs = sortedUnique(tables.flatMap((t) => [t.minZ, t.maxZ]));
  const columns = Math.max(0, xs.length - 1);
  const rows = Math.max(0, zs.length - 1);
  const owner = new Int16Array(columns * rows).fill(NONE);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const x = ((xs[c] ?? 0) + (xs[c + 1] ?? 0)) / 2;
      const z = ((zs[r] ?? 0) + (zs[r + 1] ?? 0)) / 2;
      owner[r * columns + c] = tables.findIndex((t) => containsPoint(t, x, z));
    }
  }
  const at = (c: number, r: number): number =>
    c < 0 || r < 0 || c >= columns || r >= rows ? NONE : (owner[r * columns + c] ?? NONE);
  const exterior: Segment[] = [];
  const seams: Seam[] = [];
  const classify = (a: number, b: number, segment: Segment): void => {
    if (a === b) return;
    if (a === NONE || b === NONE) exterior.push(segment);
    else seams.push({ ...segment, tables: [Math.min(a, b), Math.max(a, b)] });
  };
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c < columns; c++) {
      const z = zs[r] ?? 0;
      classify(at(c, r - 1), at(c, r), { ax: xs[c] ?? 0, az: z, bx: xs[c + 1] ?? 0, bz: z });
    }
  }
  for (let c = 0; c <= columns; c++) {
    for (let r = 0; r < rows; r++) {
      const x = xs[c] ?? 0;
      classify(at(c - 1, r), at(c, r), { ax: x, az: zs[r] ?? 0, bx: x, bz: zs[r + 1] ?? 0 });
    }
  }
  return { exterior, seams };
}

function isHorizontal(segment: Segment): boolean {
  return segment.az === segment.bz;
}

function interval(segment: Segment): readonly [number, number] {
  return isHorizontal(segment)
    ? [Math.min(segment.ax, segment.bx), Math.max(segment.ax, segment.bx)]
    : [Math.min(segment.az, segment.bz), Math.max(segment.az, segment.bz)];
}

function withInterval(segment: Segment, from: number, to: number): Segment {
  return isHorizontal(segment)
    ? { ax: from, az: segment.az, bx: to, bz: segment.az }
    : { ax: segment.ax, az: from, bx: segment.ax, bz: to };
}

function blockedSpan(segment: Segment, block: LduRect): readonly [number, number] | null {
  if (isHorizontal(segment)) {
    const z = segment.az;
    if (z < block.minZ || z > block.maxZ) return null;
    return [block.minX, block.maxX];
  }
  const x = segment.ax;
  if (x < block.minX || x > block.maxX) return null;
  return [block.minZ, block.maxZ];
}

function subtract(segment: Segment, block: LduRect): Segment[] {
  const span = blockedSpan(segment, block);
  if (!span) return [segment];
  const [from, to] = interval(segment);
  const pieces: Segment[] = [];
  if (span[0] > from) pieces.push(withInterval(segment, from, Math.min(to, span[0])));
  if (span[1] < to) pieces.push(withInterval(segment, Math.max(from, span[1]), to));
  return pieces;
}

function onRoomWall(segment: Segment, room: LduRect): boolean {
  return isHorizontal(segment)
    ? segment.az === room.minZ || segment.az === room.maxZ
    : segment.ax === room.minX || segment.ax === room.maxX;
}

export function accessibleEdges(
  exterior: ReadonlyArray<Segment>,
  room: LduRect,
  obstacles: ReadonlyArray<LduRect>,
): Segment[] {
  let edges = exterior.filter((segment) => !onRoomWall(segment, room));
  for (const obstacle of obstacles) edges = edges.flatMap((segment) => subtract(segment, obstacle));
  return edges.filter((segment) => {
    const [from, to] = interval(segment);
    return to > from;
  });
}

export function segmentPointDistance(segment: Segment, x: number, z: number): number {
  const dx = segment.bx - segment.ax;
  const dz = segment.bz - segment.az;
  const lengthSquared = dx * dx + dz * dz;
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((x - segment.ax) * dx + (z - segment.az) * dz) / lengthSquared));
  return Math.hypot(x - (segment.ax + t * dx), z - (segment.az + t * dz));
}

export function crossesInterior(segment: Segment, rect: LduRect): boolean {
  const [from, to] = interval(segment);
  if (isHorizontal(segment)) {
    return (
      segment.az > rect.minZ &&
      segment.az < rect.maxZ &&
      Math.min(to, rect.maxX) > Math.max(from, rect.minX)
    );
  }
  return (
    segment.ax > rect.minX &&
    segment.ax < rect.maxX &&
    Math.min(to, rect.maxZ) > Math.max(from, rect.minZ)
  );
}
