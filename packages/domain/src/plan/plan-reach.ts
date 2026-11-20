import { ExactFrame, exactOverlap, exactUncovered, type ExactRect } from "./exact-rect.ts";
import type { LduRect } from "./plan-region.ts";
import { ALONG_X, EDGE_AXIS, EDGE_FLOATS, EDGE_FROM, EDGE_LINE, EDGE_TO } from "./plan-table-edges.ts";
import { PIECES_PER_CUT, RECT_STRIDE, growTo, subtractCut } from "./rect-cut.ts";

const CERTIFIED_MAGNITUDE = 2 ** 1021;
const INITIAL_PIECE_FLOATS = 64;
const POINT_FLOATS = 2;
const ENDS_PER_EDGE = 2;

export interface ReachContext {
  readonly limitLdu: number;
  readonly free: Float64Array;
  readonly strips: Float64Array;
  readonly ends: Float64Array;
  readonly certified: boolean;
}

export class ReachScratch {
  pieces = new Float64Array(INITIAL_PIECE_FLOATS);
  spare = new Float64Array(INITIAL_PIECE_FLOATS);
  readonly clip = new Float64Array(RECT_STRIDE);
}

function certifiedSum(t: number, q: number): number {
  const s = t + q;
  if (!(Math.abs(t) <= CERTIFIED_MAGNITUDE) || !(Math.abs(q) <= CERTIFIED_MAGNITUDE)) return NaN;
  if (!Number.isFinite(s)) return NaN;
  const bb = s - t;
  return t - (s - bb) + (q - bb) === 0 ? s : NaN;
}

export function reachContext(free: Float64Array, limitLdu: number): ReachContext {
  const edges = free.length / EDGE_FLOATS;
  const strips = new Float64Array(edges * RECT_STRIDE);
  const ends = new Float64Array(edges * ENDS_PER_EDGE * POINT_FLOATS);
  let certified = true;
  for (let e = 0; e < edges; e++) {
    const at = e * EDGE_FLOATS;
    const line = free[at + EDGE_LINE] ?? NaN;
    const from = free[at + EDGE_FROM] ?? NaN;
    const to = free[at + EDGE_TO] ?? NaN;
    const low = certifiedSum(line, -limitLdu);
    const high = certifiedSum(line, limitLdu);
    if (Number.isNaN(low) || Number.isNaN(high)) certified = false;
    const strip = e * RECT_STRIDE;
    const end = e * ENDS_PER_EDGE * POINT_FLOATS;
    if (free[at + EDGE_AXIS] === ALONG_X) {
      strips.set([from, low, to, high], strip);
      ends.set([from, line, to, line], end);
    } else {
      strips.set([low, from, high, to], strip);
      ends.set([line, from, line, to], end);
    }
  }
  return { limitLdu, free, strips, ends, certified };
}

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function squaredGap(low: bigint, high: bigint, at: bigint): bigint {
  const gap = bigMax(bigMax(low - at, at - high), 0n);
  return gap * gap;
}

interface Disks {
  readonly x: ReadonlyArray<bigint>;
  readonly z: ReadonlyArray<bigint>;
  readonly r2: bigint;
}

function covered(disks: Disks, nx: bigint, nz: bigint, d: bigint): boolean {
  const limit = disks.r2 * d * d;
  for (let i = 0; i < disks.x.length; i++) {
    const dx = nx - (disks.x[i] ?? 0n) * d;
    const dz = nz - (disks.z[i] ?? 0n) * d;
    if (dx * dx + dz * dz <= limit) return true;
  }
  return false;
}

function inRange(low: bigint, high: bigint, num: bigint, den: bigint): boolean {
  return low * den <= num && num <= high * den;
}

function bisectorsCovered(rect: ExactRect, disks: Disks): boolean {
  const { x, z } = disks;
  for (let i = 0; i < x.length; i++) {
    for (let j = i + 1; j < x.length; j++) {
      const xi = x[i] ?? 0n;
      const zi = z[i] ?? 0n;
      const xj = x[j] ?? 0n;
      const zj = z[j] ?? 0n;
      const rhs = xj * xj + zj * zj - xi * xi - zi * zi;
      if (zj !== zi) {
        for (const edge of [rect.minX, rect.maxX]) {
          let num = rhs - 2n * edge * (xj - xi);
          let den = 2n * (zj - zi);
          if (den < 0n) [num, den] = [-num, -den];
          if (inRange(rect.minZ, rect.maxZ, num, den) && !covered(disks, edge * den, num, den)) {
            return false;
          }
        }
      }
      if (xj !== xi) {
        for (const edge of [rect.minZ, rect.maxZ]) {
          let num = rhs - 2n * edge * (zj - zi);
          let den = 2n * (xj - xi);
          if (den < 0n) [num, den] = [-num, -den];
          if (inRange(rect.minX, rect.maxX, num, den) && !covered(disks, num, edge * den, den)) {
            return false;
          }
        }
      }
    }
  }
  return true;
}

function circumcentresCovered(rect: ExactRect, disks: Disks): boolean {
  const { x, z } = disks;
  for (let a = 0; a < x.length; a++) {
    for (let b = a + 1; b < x.length; b++) {
      for (let c = b + 1; c < x.length; c++) {
        const ax = x[a] ?? 0n;
        const az = z[a] ?? 0n;
        const bx = x[b] ?? 0n;
        const bz = z[b] ?? 0n;
        const cx = x[c] ?? 0n;
        const cz = z[c] ?? 0n;
        let d = 2n * (ax * (bz - cz) + bx * (cz - az) + cx * (az - bz));
        if (d === 0n) continue;
        const sa = ax * ax + az * az;
        const sb = bx * bx + bz * bz;
        const sc = cx * cx + cz * cz;
        let ux = sa * (bz - cz) + sb * (cz - az) + sc * (az - bz);
        let uz = sa * (cx - bx) + sb * (ax - cx) + sc * (bx - ax);
        if (d < 0n) [ux, uz, d] = [-ux, -uz, -d];
        const inside =
          inRange(rect.minX, rect.maxX, ux, d) && inRange(rect.minZ, rect.maxZ, uz, d);
        if (inside && !covered(disks, ux, uz, d)) return false;
      }
    }
  }
  return true;
}

export function disksCover(
  rect: ExactRect,
  centres: ReadonlyArray<readonly [bigint, bigint]>,
  radius: bigint,
): boolean {
  const r2 = radius * radius;
  const x: bigint[] = [];
  const z: bigint[] = [];
  for (const [cx, cz] of centres) {
    if (squaredGap(rect.minX, rect.maxX, cx) + squaredGap(rect.minZ, rect.maxZ, cz) > r2) continue;
    x.push(cx);
    z.push(cz);
  }
  if (x.length === 0) return false;
  const disks: Disks = { x, z, r2 };
  for (const cornerX of [rect.minX, rect.maxX]) {
    for (const cornerZ of [rect.minZ, rect.maxZ]) {
      if (!covered(disks, cornerX, cornerZ, 1n)) return false;
    }
  }
  return bisectorsCovered(rect, disks) && circumcentresCovered(rect, disks);
}

function endCentres(frame: ExactFrame, ends: Float64Array): Array<readonly [bigint, bigint]> {
  const centres: Array<readonly [bigint, bigint]> = [];
  for (let e = 0; e < ends.length; e += POINT_FLOATS) {
    centres.push([frame.of(ends[e] ?? NaN), frame.of(ends[e + 1] ?? NaN)]);
  }
  return centres;
}

function clipDisksCover(reach: ReachContext, clip: Float64Array): boolean {
  const frame = new ExactFrame([...clip, ...reach.ends, reach.limitLdu]);
  const rect: ExactRect = {
    minX: frame.of(clip[0] ?? NaN),
    minZ: frame.of(clip[1] ?? NaN),
    maxX: frame.of(clip[2] ?? NaN),
    maxZ: frame.of(clip[3] ?? NaN),
  };
  return disksCover(rect, endCentres(frame, reach.ends), frame.of(reach.limitLdu));
}

function clipUncovered(
  reach: ReachContext,
  pieces: Float64Array,
  piece: number,
  tables: Float64Array,
  clip: Float64Array,
): boolean {
  const pMinX = pieces[piece] ?? NaN;
  const pMinZ = pieces[piece + 1] ?? NaN;
  const pMaxX = pieces[piece + 2] ?? NaN;
  const pMaxZ = pieces[piece + 3] ?? NaN;
  if (!(pMinX < pMaxX && pMinZ < pMaxZ)) return false;
  for (let t = 0; t < tables.length; t += RECT_STRIDE) {
    const minX = Math.max(pMinX, tables[t] ?? NaN);
    const minZ = Math.max(pMinZ, tables[t + 1] ?? NaN);
    const maxX = Math.min(pMaxX, tables[t + 2] ?? NaN);
    const maxZ = Math.min(pMaxZ, tables[t + 3] ?? NaN);
    if (!(minX < maxX && minZ < maxZ)) continue;
    clip[0] = minX;
    clip[1] = minZ;
    clip[2] = maxX;
    clip[3] = maxZ;
    if (!clipDisksCover(reach, clip)) return true;
  }
  return false;
}

function exactStrips(frame: ExactFrame, reach: ReachContext): ExactRect[] {
  const radius = frame.of(reach.limitLdu);
  const strips: ExactRect[] = [];
  const { free } = reach;
  for (let at = 0; at < free.length; at += EDGE_FLOATS) {
    const line = frame.of(free[at + EDGE_LINE] ?? NaN);
    const from = frame.of(free[at + EDGE_FROM] ?? NaN);
    const to = frame.of(free[at + EDGE_TO] ?? NaN);
    strips.push(
      free[at + EDGE_AXIS] === ALONG_X
        ? { minX: from, minZ: line - radius, maxX: to, maxZ: line + radius }
        : { minX: line - radius, minZ: from, maxX: line + radius, maxZ: to },
    );
  }
  return strips;
}

function exactClip(a: ExactRect, b: ExactRect): ExactRect {
  return {
    minX: a.minX > b.minX ? a.minX : b.minX,
    minZ: a.minZ > b.minZ ? a.minZ : b.minZ,
    maxX: a.maxX < b.maxX ? a.maxX : b.maxX,
    maxZ: a.maxZ < b.maxZ ? a.maxZ : b.maxZ,
  };
}

function hasArea(rect: ExactRect): boolean {
  return rect.minX < rect.maxX && rect.minZ < rect.maxZ;
}

function reachFailsExact(
  reach: ReachContext,
  surfaces: ReadonlyArray<LduRect>,
  rects: Float64Array,
  count: number,
): boolean {
  const values = [...rects.subarray(0, count * RECT_STRIDE), ...reach.free, reach.limitLdu];
  for (const s of surfaces) values.push(s.minX, s.minZ, s.maxX, s.maxZ);
  const frame = new ExactFrame(values);
  const strips = exactStrips(frame, reach);
  const tables = surfaces.map((s) => frame.rect(s));
  const centres = endCentres(frame, reach.ends);
  const radius = frame.of(reach.limitLdu);
  for (let r = 0; r < count; r++) {
    const at = r * RECT_STRIDE;
    const rect: ExactRect = {
      minX: frame.of(rects[at] ?? NaN),
      minZ: frame.of(rects[at + 1] ?? NaN),
      maxX: frame.of(rects[at + 2] ?? NaN),
      maxZ: frame.of(rects[at + 3] ?? NaN),
    };
    for (const piece of exactUncovered(rect, strips)) {
      if (!hasArea(piece)) continue;
      for (const table of tables) {
        if (!exactOverlap(piece, table)) continue;
        const clip = exactClip(piece, table);
        if (hasArea(clip) && !disksCover(clip, centres, radius)) return true;
      }
    }
  }
  return false;
}

export function reachFails(
  reach: ReachContext,
  tables: Float64Array,
  surfaces: ReadonlyArray<LduRect>,
  rects: Float64Array,
  count: number,
  scratch: ReachScratch,
): boolean {
  if (!reach.certified) return reachFailsExact(reach, surfaces, rects, count);
  const strips = reach.strips;
  for (let r = 0; r < count; r++) {
    let current = growTo(scratch.pieces, RECT_STRIDE);
    let next = scratch.spare;
    const at = r * RECT_STRIDE;
    current[0] = rects[at] ?? NaN;
    current[1] = rects[at + 1] ?? NaN;
    current[2] = rects[at + 2] ?? NaN;
    current[3] = rects[at + 3] ?? NaN;
    let left = 1;
    for (let cut = 0; cut < strips.length && left > 0; cut += RECT_STRIDE) {
      next = growTo(next, left * PIECES_PER_CUT * RECT_STRIDE);
      left = subtractCut(current, left, next, strips, cut);
      const swap = current;
      current = next;
      next = swap;
    }
    scratch.pieces = current;
    scratch.spare = next;
    for (let p = 0; p < left; p++) {
      if (clipUncovered(reach, current, p * RECT_STRIDE, tables, scratch.clip)) return true;
    }
  }
  return false;
}
