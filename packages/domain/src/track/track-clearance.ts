import { CHUNK_LDU, STUD_LDU, ZETA16_ORDER, chunkKey, zeta16ToStuds, type Pose16 } from "@brr/math";

const OUTLINE_POINT_FLOATS = 2;
export const OUTLINE_BOX_FLOATS = 4;
const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const REPRESENTATION_LDU = 1e-6;

export interface PlacementFrame {
  readonly xLdu: number;
  readonly zLdu: number;
}

export interface TrackOutlineSource {
  readonly footprints: ArrayLike<number>;
  readonly hull?: ArrayLike<number>;
}

const FOOTPRINT_FLOATS = 4;
const MIN_POLYGON_FLOATS = 3 * OUTLINE_POINT_FLOATS;

function clipped(polygon: ReadonlyArray<number>, a: number, b: number, d: number): number[] {
  const out: number[] = [];
  const count = polygon.length / OUTLINE_POINT_FLOATS;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const px = polygon[2 * i] ?? 0;
    const pz = polygon[2 * i + 1] ?? 0;
    const qx = polygon[2 * j] ?? 0;
    const qz = polygon[2 * j + 1] ?? 0;
    const pInside = d - (a * px + b * pz);
    const qInside = d - (a * qx + b * qz);
    if (pInside >= 0) out.push(px, pz);
    if (pInside >= 0 !== qInside >= 0) {
      const t = pInside / (pInside - qInside);
      out.push(px + t * (qx - px), pz + t * (qz - pz));
    }
  }
  return out;
}

function translated(polygon: ArrayLike<number>, frame: PlacementFrame): Float64Array {
  const outline = Float64Array.from(polygon);
  for (let p = 0; p < outline.length; p += OUTLINE_POINT_FLOATS) {
    outline[p] = (outline[p] ?? 0) + frame.xLdu;
    outline[p + 1] = (outline[p + 1] ?? 0) + frame.zLdu;
  }
  return outline;
}

export function footprintOutline(shape: TrackOutlineSource, frame: PlacementFrame): Float64Array {
  if (shape.hull && shape.hull.length >= MIN_POLYGON_FLOATS) return translated(shape.hull, frame);
  const { footprints } = shape;
  const minX = footprints[0] ?? 0;
  const minZ = footprints[1] ?? 0;
  const maxX = footprints[2] ?? 0;
  const maxZ = footprints[3] ?? 0;
  let polygon = [minX, minZ, maxX, minZ, maxX, maxZ, minX, maxZ];
  for (let heading = 1; heading < ZETA16_ORDER; heading++) {
    const o = heading * FOOTPRINT_FLOATS;
    const c = Math.cos(heading * HEADING_RADIANS);
    const s = Math.sin(heading * HEADING_RADIANS);
    polygon = clipped(polygon, c, -s, footprints[o + 2] ?? 0);
    polygon = clipped(polygon, -c, s, -(footprints[o] ?? 0));
    polygon = clipped(polygon, s, c, footprints[o + 3] ?? 0);
    polygon = clipped(polygon, -s, -c, -(footprints[o + 1] ?? 0));
  }
  return translated(polygon, frame);
}

export function rotateOutline(
  outline: Float64Array,
  headingSteps: number,
  offsetX: number,
  offsetZ: number,
): Float64Array {
  return rotateOutlineInto(
    outline,
    headingSteps,
    offsetX,
    offsetZ,
    new Float64Array(outline.length),
  );
}

export function rotateOutlineInto(
  outline: Float64Array,
  headingSteps: number,
  offsetX: number,
  offsetZ: number,
  out: Float64Array,
): Float64Array {
  const theta = headingSteps * HEADING_RADIANS;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  for (let p = 0; p < outline.length; p += 2) {
    const x = outline[p] ?? 0;
    const z = outline[p + 1] ?? 0;
    out[p] = offsetX + c * x - s * z;
    out[p + 1] = offsetZ + s * x + c * z;
  }
  return out;
}

export function outlineBox(outline: Float64Array, out: Float64Array, at: number): void {
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let p = 0; p < outline.length; p += 2) {
    const x = outline[p] ?? 0;
    const z = outline[p + 1] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  out[at] = minX;
  out[at + 1] = minZ;
  out[at + 2] = maxX;
  out[at + 3] = maxZ;
}

export function poseLdu(pose: Pose16): { readonly x: number; readonly z: number } {
  const studs = zeta16ToStuds(pose.position);
  return { x: studs.x * STUD_LDU, z: studs.z * STUD_LDU };
}

export function placedOutline(outline: Float64Array, placement: Pose16): Float64Array {
  return placedOutlineInto(outline, placement, new Float64Array(outline.length));
}

export function placedOutlineInto(
  outline: Float64Array,
  placement: Pose16,
  out: Float64Array,
): Float64Array {
  const at = poseLdu(placement);
  return rotateOutlineInto(outline, placement.heading, at.x, at.z, out);
}

export function outlineContains(outline: Float64Array, x: number, z: number): boolean {
  const count = outline.length / OUTLINE_POINT_FLOATS;
  let sign = 0;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const ax = outline[2 * i] ?? 0;
    const az = outline[2 * i + 1] ?? 0;
    const cross =
      ((outline[2 * j] ?? 0) - ax) * (z - az) - ((outline[2 * j + 1] ?? 0) - az) * (x - ax);
    if (cross === 0) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return count >= MIN_POLYGON_FLOATS / OUTLINE_POINT_FLOATS;
}

function separatedByEdgesOf(
  a: Float64Array,
  ax: number,
  az: number,
  b: Float64Array,
  bx: number,
  bz: number,
): boolean {
  const count = a.length / OUTLINE_POINT_FLOATS;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const ex = (a[2 * j] ?? 0) - (a[2 * i] ?? 0);
    const ez = (a[2 * j + 1] ?? 0) - (a[2 * i + 1] ?? 0);
    const length = Math.hypot(ex, ez);
    if (length === 0) continue;
    const nx = -ez / length;
    const nz = ex / length;
    let minA = Number.POSITIVE_INFINITY;
    let maxA = Number.NEGATIVE_INFINITY;
    for (let p = 0; p < a.length; p += 2) {
      const d = ((a[p] ?? 0) + ax) * nx + ((a[p + 1] ?? 0) + az) * nz;
      if (d < minA) minA = d;
      if (d > maxA) maxA = d;
    }
    let minB = Number.POSITIVE_INFINITY;
    let maxB = Number.NEGATIVE_INFINITY;
    for (let p = 0; p < b.length; p += 2) {
      const d = ((b[p] ?? 0) + bx) * nx + ((b[p + 1] ?? 0) + bz) * nz;
      if (d < minB) minB = d;
      if (d > maxB) maxB = d;
    }
    if (maxA <= minB + REPRESENTATION_LDU || maxB <= minA + REPRESENTATION_LDU) return true;
  }
  return false;
}

export function outlinesOverlap(
  a: Float64Array,
  ax: number,
  az: number,
  b: Float64Array,
  bx: number,
  bz: number,
): boolean {
  return !separatedByEdgesOf(a, ax, az, b, bx, bz) && !separatedByEdgesOf(b, bx, bz, a, ax, az);
}

export function boxesOverlap(
  a: Float64Array,
  ao: number,
  ax: number,
  az: number,
  b: Float64Array,
  bo: number,
): boolean {
  return (
    (a[ao] ?? 0) + ax < (b[bo + 2] ?? 0) - REPRESENTATION_LDU &&
    (b[bo] ?? 0) < (a[ao + 2] ?? 0) + ax - REPRESENTATION_LDU &&
    (a[ao + 1] ?? 0) + az < (b[bo + 3] ?? 0) - REPRESENTATION_LDU &&
    (b[bo + 1] ?? 0) < (a[ao + 3] ?? 0) + az - REPRESENTATION_LDU
  );
}

export const NO_OBSTACLE = -1;
export const RUN_CROSSING = -2;
const FIRST_STUDLESS_TOP = -3;

export function studlessTopBlocker(id: number): number {
  return FIRST_STUDLESS_TOP - id;
}

export function studlessTopOf(blocker: number): number {
  return blocker <= FIRST_STUDLESS_TOP ? FIRST_STUDLESS_TOP - blocker : NO_OBSTACLE;
}

function signedArea(polygon: ArrayLike<number>): number {
  const count = polygon.length / OUTLINE_POINT_FLOATS;
  let twice = 0;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    twice +=
      (polygon[2 * i] ?? 0) * (polygon[2 * j + 1] ?? 0) -
      (polygon[2 * j] ?? 0) * (polygon[2 * i + 1] ?? 0);
  }
  return twice / 2;
}

function overlapsOutside(piece: Float64Array, other: Float64Array, joined: Float64Array): boolean {
  const count = joined.length / OUTLINE_POINT_FLOATS;
  const outward = signedArea(joined) < 0 ? -1 : 1;
  const points = Array.from(piece);
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const ax = joined[2 * i] ?? 0;
    const az = joined[2 * i + 1] ?? 0;
    const ex = (joined[2 * j] ?? 0) - ax;
    const ez = (joined[2 * j + 1] ?? 0) - az;
    const length = Math.hypot(ex, ez);
    if (length === 0) continue;
    const nx = (outward * ez) / length;
    const nz = (-outward * ex) / length;
    const beyond = clipped(points, -nx, -nz, -(nx * ax + nz * az + REPRESENTATION_LDU));
    if (beyond.length < MIN_POLYGON_FLOATS) continue;
    if (outlinesOverlap(Float64Array.from(beyond), 0, 0, other, 0, 0)) return true;
  }
  return false;
}

const NO_IDS: ArrayLike<number> = [];

export class TrackClearance {
  private readonly outlines: Float64Array[] = [];
  private boxes = new Float64Array(64 * OUTLINE_BOX_FLOATS);
  private readonly cells = new Map<number, number[]>();
  private readonly queryBox = new Float64Array(OUTLINE_BOX_FLOATS);
  private readonly pieceBox = new Float64Array(OUTLINE_BOX_FLOATS);
  private readonly joinedPair = [NO_OBSTACLE, NO_OBSTACLE];
  private visit = new Uint32Array(64);
  private generation = 0;
  private readonly pointBox = new Float64Array(OUTLINE_BOX_FLOATS);

  get count(): number {
    return this.outlines.length;
  }

  truncate(count: number): void {
    for (let id = this.outlines.length - 1; id >= count; id--) {
      this.forCells(this.boxes, id * OUTLINE_BOX_FLOATS, 0, 0, (key) => {
        const members = this.cells.get(key);
        if (members?.at(-1) === id) members.pop();
        if (members?.length === 0) this.cells.delete(key);
        return false;
      });
      this.outlines.pop();
    }
  }

  add(outline: Float64Array): number {
    const id = this.outlines.length;
    this.outlines.push(outline);
    if ((id + 1) * OUTLINE_BOX_FLOATS > this.boxes.length) {
      const grown = new Float64Array(this.boxes.length * 2);
      grown.set(this.boxes);
      this.boxes = grown;
      const visit = new Uint32Array(this.visit.length * 2);
      visit.set(this.visit);
      this.visit = visit;
    }
    const at = id * OUTLINE_BOX_FLOATS;
    outlineBox(outline, this.boxes, at);
    this.forCells(this.boxes, at, 0, 0, (key) => {
      const members = this.cells.get(key);
      if (members) members.push(id);
      else this.cells.set(key, [id]);
      return false;
    });
    return id;
  }

  addRect(minX: number, minZ: number, maxX: number, maxZ: number): number {
    return this.add(Float64Array.of(minX, minZ, maxX, minZ, maxX, maxZ, minX, maxZ));
  }

  pieceBlocker(outline: Float64Array, placement: Pose16, exceptA: number, exceptB: number): number {
    const placed = placedOutline(outline, placement);
    outlineBox(placed, this.pieceBox, 0);
    return this.blocker(placed, this.pieceBox, 0, 0, 0, exceptA, exceptB);
  }

  blocker(
    outline: Float64Array,
    box: Float64Array,
    boxAt: number,
    x: number,
    z: number,
    exceptA: number,
    exceptB: number,
  ): number {
    const pair = this.joinedPair;
    pair[0] = exceptA;
    pair[1] = exceptB;
    return this.firstOverlap(outline, box, boxAt, x, z, this, pair, NO_IDS);
  }

  blockerExcept(
    outline: Float64Array,
    box: Float64Array,
    x: number,
    z: number,
    except: ArrayLike<number>,
    skipped: ArrayLike<number> = NO_IDS,
  ): number {
    return this.firstOverlap(outline, box, 0, x, z, this, except, skipped);
  }

  blockerBesideJoins(
    outline: Float64Array,
    box: Float64Array,
    boxAt: number,
    x: number,
    z: number,
    joinedIn: TrackClearance,
    exceptA: number,
    exceptB: number,
  ): number {
    const pair = this.joinedPair;
    pair[0] = exceptA;
    pair[1] = exceptB;
    return this.firstOverlap(outline, box, boxAt, x, z, joinedIn, pair, NO_IDS);
  }

  private nextGeneration(): number {
    this.generation++;
    if (this.generation === 0xffffffff) {
      this.visit.fill(0);
      this.generation = 1;
    }
    return this.generation;
  }

  private markVisited(ids: ArrayLike<number>, generation: number): void {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] ?? NO_OBSTACLE;
      if (id >= 0 && id < this.outlines.length) this.visit[id] = generation;
    }
  }

  private firstOverlap(
    outline: Float64Array,
    box: Float64Array,
    boxAt: number,
    x: number,
    z: number,
    joinedIn: TrackClearance,
    joined: ArrayLike<number>,
    skipped: ArrayLike<number>,
  ): number {
    const generation = this.nextGeneration();
    if (joinedIn === this) this.markVisited(joined, generation);
    this.markVisited(skipped, generation);
    let found = NO_OBSTACLE;
    this.forCells(box, boxAt, x, z, (key) => {
      const members = this.cells.get(key);
      if (!members) return false;
      for (const id of members) {
        if (found !== NO_OBSTACLE && id >= found) break;
        if (this.visit[id] === generation) continue;
        this.visit[id] = generation;
        if (!boxesOverlap(box, boxAt, x, z, this.boxes, id * OUTLINE_BOX_FLOATS)) continue;
        const other = this.outlines[id];
        if (!other || !outlinesOverlap(outline, x, z, other, 0, 0)) continue;
        if (!joinedIn.insideJoined(outline, x, z, other, joined)) found = id;
      }
      return found === 0;
    });
    return found;
  }

  private insideJoined(
    outline: Float64Array,
    x: number,
    z: number,
    other: Float64Array,
    joined: ArrayLike<number>,
  ): boolean {
    let piece: Float64Array | null = null;
    for (let i = 0; i < joined.length; i++) {
      const id = joined[i] ?? NO_OBSTACLE;
      const shape = id < 0 ? undefined : this.outlines[id];
      if (!shape) continue;
      piece ??= translated(outline, { xLdu: x, zLdu: z });
      if (!overlapsOutside(piece, other, shape)) return true;
    }
    return false;
  }

  covers(x: number, z: number): boolean {
    const box = this.pointBox;
    box[0] = x;
    box[1] = z;
    box[2] = x;
    box[3] = z;
    return this.forCells(box, 0, 0, 0, (key) => {
      for (const id of this.cells.get(key) ?? []) {
        const outline = this.outlines[id];
        if (outline && outlineContains(outline, x, z)) return true;
      }
      return false;
    });
  }

  private forCells(
    box: Float64Array,
    at: number,
    x: number,
    z: number,
    visit: (key: number) => boolean,
  ): boolean {
    const box0 = this.queryBox;
    box0[0] = (box[at] ?? 0) + x;
    box0[1] = (box[at + 1] ?? 0) + z;
    box0[2] = (box[at + 2] ?? 0) + x;
    box0[3] = (box[at + 3] ?? 0) + z;
    const cx0 = Math.floor((box0[0] ?? 0) / CHUNK_LDU);
    const cz0 = Math.floor((box0[1] ?? 0) / CHUNK_LDU);
    const cx1 = Math.floor((box0[2] ?? 0) / CHUNK_LDU);
    const cz1 = Math.floor((box0[3] ?? 0) / CHUNK_LDU);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        if (visit(chunkKey(cx, cz))) return true;
      }
    }
    return false;
  }
}
