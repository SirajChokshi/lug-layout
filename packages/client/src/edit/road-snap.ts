import {
  NO_TOP,
  RoadFit,
  type RoadNetwork,
  type RoadPlacement,
  type RoadSurface,
} from "@brr/domain";
import { SIXTEENTHS_PER_LDU, STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import { quarterTurned, type TurnDirection } from "./turn.ts";

export interface CellExtent {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface PlacedRoads {
  readonly network: RoadNetwork;
  readonly placements: ReadonlyArray<RoadPlacement>;
  readonly extents: ReadonlyArray<CellExtent>;
  readonly index: RoadIndex;
}

export interface RoadSnap {
  readonly x: number;
  readonly z: number;
  readonly rot: number;
  readonly metCells: number;
  readonly joinedCells: number;
  readonly joinedRoadCells: number;
}

const QUARTER_TURNS = 4;
export const NO_ROAD_SURFACE: RoadSurface = {
  minX: 0,
  minZ: 0,
  columns: 0,
  rows: 0,
  topSixteenths: new Int32Array(0),
  studSixteenths: new Int32Array(0),
  road: new Uint8Array(0),
};
export const ANY_TURN = QUARTER_TURNS;
export const HELD_TURN = 1;
const HALF_STUD_LDU = STUD_LDU / 2;

function cornerStep(count: number): number {
  return Math.max(1, count - 1);
}

interface MutableExtent {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const heldExtent: MutableExtent = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };

export function cellExtent(placement: RoadPlacement): CellExtent {
  return cellExtentInto(placement, { minX: 0, maxX: 0, minZ: 0, maxZ: 0 });
}

function cellExtentInto(placement: RoadPlacement, out: MutableExtent): CellExtent {
  const { surface, rot } = placement;
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let row = 0; row < surface.rows; row += cornerStep(surface.rows)) {
    for (let column = 0; column < surface.columns; column += cornerStep(surface.columns)) {
      const localX = surface.minX + column * STUD_LDU + HALF_STUD_LDU;
      const localZ = surface.minZ + row * STUD_LDU + HALF_STUD_LDU;
      const centreX = placement.x + cos * localX + sin * localZ;
      const centreZ = placement.z - sin * localX + cos * localZ;
      minX = Math.min(minX, centreX - HALF_STUD_LDU);
      maxX = Math.max(maxX, centreX + HALF_STUD_LDU);
      minZ = Math.min(minZ, centreZ - HALF_STUD_LDU);
      maxZ = Math.max(maxZ, centreZ + HALF_STUD_LDU);
    }
  }
  out.minX = minX;
  out.maxX = maxX;
  out.minZ = minZ;
  out.maxZ = maxZ;
  return out;
}

function stepsBetween(from: number, to: number): number {
  return Math.max(0, Math.ceil((to - from) / STUD_LDU));
}

function besideZSteps(placed: CellExtent, ghost: CellExtent): number {
  return stepsBetween(placed.minZ - ghost.maxZ + STUD_LDU, placed.maxZ - ghost.minZ);
}

function besideXSteps(placed: CellExtent, ghost: CellExtent): number {
  return stepsBetween(placed.minX - ghost.maxX + STUD_LDU, placed.maxX - ghost.minX);
}

function sideX(placed: CellExtent, ghost: CellExtent, index: number, zSteps: number): number {
  if (index < 2 * zSteps) {
    return index % 2 === 0 ? placed.maxX - ghost.minX : placed.minX - ghost.maxX;
  }
  const step = Math.floor((index - 2 * zSteps) / 2);
  return placed.minX - ghost.maxX + STUD_LDU + step * STUD_LDU;
}

function sideZ(placed: CellExtent, ghost: CellExtent, index: number, zSteps: number): number {
  if (index < 2 * zSteps) {
    return placed.minZ - ghost.maxZ + STUD_LDU + Math.floor(index / 2) * STUD_LDU;
  }
  return (index - 2 * zSteps) % 2 === 0 ? placed.maxZ - ghost.minZ : placed.minZ - ghost.maxZ;
}

function cornerFlush(placed: CellExtent, ghost: CellExtent, x: number, z: number): boolean {
  const besideX = x + ghost.minX === placed.maxX || x + ghost.maxX === placed.minX;
  if (besideX) return z + ghost.minZ === placed.minZ || z + ghost.maxZ === placed.maxZ;
  return x + ghost.minX === placed.minX || x + ghost.maxX === placed.maxX;
}

function within(extent: CellExtent, ghost: CellExtent, x: number, z: number): boolean {
  return (
    x >= extent.minX - (ghost.maxX - ghost.minX) &&
    x <= extent.maxX + (ghost.maxX - ghost.minX) &&
    z >= extent.minZ - (ghost.maxZ - ghost.minZ) &&
    z <= extent.maxZ + (ghost.maxZ - ghost.minZ)
  );
}

const BUCKET_LDU = 32 * STUD_LDU;
const BUCKET_SPAN = 2 ** 21;

function bucketKey(bucketX: number, bucketZ: number): number {
  return (bucketX + BUCKET_SPAN / 2) * BUCKET_SPAN + (bucketZ + BUCKET_SPAN / 2);
}

function bucketOf(ldu: number): number {
  return Math.floor(ldu / BUCKET_LDU);
}

export class RoadIndex {
  private constructor(
    private readonly keys: Float64Array,
    private readonly starts: Int32Array,
    private readonly members: Int32Array,
  ) {}

  static of(extents: ReadonlyArray<CellExtent>): RoadIndex {
    const entries: Array<readonly [number, number]> = [];
    extents.forEach((extent, placement) => {
      for (let bx = bucketOf(extent.minX); bx <= bucketOf(extent.maxX); bx++) {
        for (let bz = bucketOf(extent.minZ); bz <= bucketOf(extent.maxZ); bz++) {
          entries.push([bucketKey(bx, bz), placement]);
        }
      }
    });
    entries.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const keys: number[] = [];
    const starts: number[] = [];
    entries.forEach(([key], at) => {
      if (keys[keys.length - 1] === key) return;
      keys.push(key);
      starts.push(at);
    });
    starts.push(entries.length);
    return new RoadIndex(
      Float64Array.from(keys),
      Int32Array.from(starts),
      Int32Array.from(entries, ([, placement]) => placement),
    );
  }

  private find(key: number): number {
    let low = 0;
    let high = this.keys.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const at = this.keys[mid] ?? 0;
      if (at === key) return mid;
      if (at < key) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  }

  near(minX: number, maxX: number, minZ: number, maxZ: number, out: number[]): number {
    out.length = 0;
    for (let bx = bucketOf(minX); bx <= bucketOf(maxX); bx++) {
      for (let bz = bucketOf(minZ); bz <= bucketOf(maxZ); bz++) {
        const bucket = this.find(bucketKey(bx, bz));
        if (bucket < 0) continue;
        const to = this.starts[bucket + 1] ?? 0;
        for (let m = this.starts[bucket] ?? 0; m < to; m++) out.push(this.members[m] ?? 0);
      }
    }
    return out.length;
  }
}

export function placedRoadsOf(
  network: RoadNetwork,
  placements: ReadonlyArray<RoadPlacement>,
): PlacedRoads {
  const extents = placements.map(cellExtent);
  return { network, placements, extents, index: RoadIndex.of(extents) };
}

function roadAtTop(
  other: RoadPlacement,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  topSixteenths: number,
): boolean {
  const { rot } = other;
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  const fromX = minX - other.x;
  const toX = maxX - other.x;
  const fromZ = minZ - other.z;
  const toZ = maxZ - other.z;
  const ax = cos * fromX - sin * fromZ;
  const bx = cos * toX - sin * toZ;
  const az = sin * fromX + cos * fromZ;
  const bz = sin * toX + cos * toZ;
  const surface = other.surface;
  const fromColumn = Math.max(0, Math.floor((Math.min(ax, bx) - surface.minX) / STUD_LDU));
  const toColumn = Math.min(
    surface.columns - 1,
    Math.ceil((Math.max(ax, bx) - surface.minX) / STUD_LDU) - 1,
  );
  const fromRow = Math.max(0, Math.floor((Math.min(az, bz) - surface.minZ) / STUD_LDU));
  const toRow = Math.min(
    surface.rows - 1,
    Math.ceil((Math.max(az, bz) - surface.minZ) / STUD_LDU) - 1,
  );
  const lift = other.yLdu * SIXTEENTHS_PER_LDU;
  for (let row = fromRow; row <= toRow; row++) {
    for (let column = fromColumn; column <= toColumn; column++) {
      const cell = row * surface.columns + column;
      if (surface.road[cell] !== 1) continue;
      const cellTop = surface.topSixteenths[cell] ?? NO_TOP;
      if (cellTop !== NO_TOP && lift + cellTop === topSixteenths) return true;
    }
  }
  return false;
}

function extentsOverlap(
  extent: CellExtent,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): boolean {
  return minX < extent.maxX && maxX > extent.minX && minZ < extent.maxZ && maxZ > extent.minZ;
}

const nearScratch: number[] = [];
const reachable: number[] = [];
let seenStamp = new Int32Array(0);
let stamp = 0;

function reachablePlacements(roads: PlacedRoads, reach: CellExtent): number {
  const count = roads.index.near(reach.minX, reach.maxX, reach.minZ, reach.maxZ, nearScratch);
  if (seenStamp.length < roads.placements.length) {
    seenStamp = new Int32Array(roads.placements.length);
    stamp = 0;
  }
  stamp++;
  reachable.length = 0;
  for (let n = 0; n < count; n++) {
    const p = nearScratch[n] ?? 0;
    const extent = roads.extents[p];
    if (seenStamp[p] === stamp || !extent) continue;
    seenStamp[p] = stamp;
    if (extentsOverlap(extent, reach.minX, reach.maxX, reach.minZ, reach.maxZ)) reachable.push(p);
  }
  return reachable.length;
}

function roadUnder(
  roads: PlacedRoads,
  candidates: number,
  centreX: number,
  centreZ: number,
  topSixteenths: number,
): boolean {
  const minX = centreX - HALF_STUD_LDU;
  const maxX = centreX + HALF_STUD_LDU;
  const minZ = centreZ - HALF_STUD_LDU;
  const maxZ = centreZ + HALF_STUD_LDU;
  for (let n = 0; n < candidates; n++) {
    const p = reachable[n] ?? 0;
    const extent = roads.extents[p];
    const other = roads.placements[p];
    if (!extent || !other || !extentsOverlap(extent, minX, maxX, minZ, maxZ)) continue;
    if (roadAtTop(other, minX, maxX, minZ, maxZ, topSixteenths)) return true;
  }
  return false;
}

export function roadOverlapCells(roads: PlacedRoads, held: RoadPlacement): number {
  return overlappingRoadCells(roads, held, Number.POSITIVE_INFINITY);
}

export function overlapsPlacedRoad(roads: PlacedRoads, held: RoadPlacement): boolean {
  return overlappingRoadCells(roads, held, 1) > 0;
}

function overlappingRoadCells(roads: PlacedRoads, held: RoadPlacement, enough: number): number {
  const { surface, rot } = held;
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  const candidates = reachablePlacements(roads, cellExtentInto(held, heldExtent));
  if (candidates === 0) return 0;
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  const lift = held.yLdu * SIXTEENTHS_PER_LDU;
  let overlapping = 0;
  for (let row = 0; row < surface.rows; row++) {
    for (let column = 0; column < surface.columns; column++) {
      const cell = row * surface.columns + column;
      if (surface.road[cell] !== 1) continue;
      const top = surface.topSixteenths[cell] ?? NO_TOP;
      if (top === NO_TOP) continue;
      const localX = surface.minX + column * STUD_LDU + HALF_STUD_LDU;
      const localZ = surface.minZ + row * STUD_LDU + HALF_STUD_LDU;
      const centreX = held.x + cos * localX + sin * localZ;
      const centreZ = held.z - sin * localX + cos * localZ;
      if (roadUnder(roads, candidates, centreX, centreZ, lift + top)) overlapping++;
      if (overlapping >= enough) return overlapping;
    }
  }
  return overlapping;
}

export interface RestingHeights {
  restingYLdu(x: number, z: number, rot: number): number;
}

export interface ProbedRoad {
  id: number;
  x: number;
  z: number;
  yLdu: number;
  rot: number;
  surface: RoadSurface;
}

interface Ranked {
  readonly snap: RoadSnap;
  readonly distance: number;
  readonly turn: number;
}

function better(candidate: Ranked, best: Ranked | null): boolean {
  if (!best) return true;
  if (candidate.snap.joinedRoadCells !== best.snap.joinedRoadCells) {
    return candidate.snap.joinedRoadCells > best.snap.joinedRoadCells;
  }
  if (candidate.distance !== best.distance) return candidate.distance < best.distance;
  return candidate.turn < best.turn;
}

interface OpenRun {
  readonly acrossX: boolean;
  readonly outward: number;
  readonly line: number;
  readonly from: number;
  readonly to: number;
}

interface WorldRun {
  acrossX: boolean;
  outward: number;
  line: number;
  from: number;
  to: number;
}

const NO_RUN = -1;
const openRunsBySurface = new WeakMap<RoadSurface, ReadonlyArray<OpenRun>>();

function nothingMeetsAt(surface: RoadSurface, column: number, row: number, top: number): boolean {
  if (column < 0 || row < 0 || column >= surface.columns || row >= surface.rows) return true;
  return (surface.topSixteenths[row * surface.columns + column] ?? NO_TOP) !== top;
}

function openFace(
  surface: RoadSurface,
  column: number,
  row: number,
  stepColumn: number,
  stepRow: number,
): boolean {
  if (column >= surface.columns || row >= surface.rows) return false;
  const cell = row * surface.columns + column;
  if (surface.road[cell] !== 1) return false;
  const top = surface.topSixteenths[cell] ?? NO_TOP;
  return nothingMeetsAt(surface, column + stepColumn, row + stepRow, top);
}

function localOpenRuns(surface: RoadSurface): ReadonlyArray<OpenRun> {
  const known = openRunsBySurface.get(surface);
  if (known) return known;
  const runs: OpenRun[] = [];
  for (const outward of [-1, 1]) {
    const beyond = outward > 0 ? 1 : 0;
    for (let column = 0; column < surface.columns; column++) {
      let start = NO_RUN;
      for (let row = 0; row <= surface.rows; row++) {
        const open = openFace(surface, column, row, outward, 0);
        if (open && start === NO_RUN) start = row;
        if (open || start === NO_RUN) continue;
        runs.push({
          acrossX: true,
          outward,
          line: surface.minX + (column + beyond) * STUD_LDU,
          from: surface.minZ + start * STUD_LDU,
          to: surface.minZ + row * STUD_LDU,
        });
        start = NO_RUN;
      }
    }
    for (let row = 0; row < surface.rows; row++) {
      let start = NO_RUN;
      for (let column = 0; column <= surface.columns; column++) {
        const open = openFace(surface, column, row, 0, outward);
        if (open && start === NO_RUN) start = column;
        if (open || start === NO_RUN) continue;
        runs.push({
          acrossX: false,
          outward,
          line: surface.minZ + (row + beyond) * STUD_LDU,
          from: surface.minX + start * STUD_LDU,
          to: surface.minX + column * STUD_LDU,
        });
        start = NO_RUN;
      }
    }
  }
  openRunsBySurface.set(surface, runs);
  return runs;
}

function worldRun(placed: RoadPlacement, run: OpenRun, out: WorldRun): void {
  const { rot } = placed;
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  const ax = run.acrossX ? run.line : run.from;
  const az = run.acrossX ? run.from : run.line;
  const bx = run.acrossX ? run.line : run.to;
  const bz = run.acrossX ? run.to : run.line;
  const normalX = run.acrossX ? run.outward : 0;
  const normalZ = run.acrossX ? 0 : run.outward;
  const worldNormalX = cos * normalX + sin * normalZ;
  const worldNormalZ = -sin * normalX + cos * normalZ;
  const fromX = placed.x + cos * ax + sin * az;
  const fromZ = placed.z - sin * ax + cos * az;
  const toX = placed.x + cos * bx + sin * bz;
  const toZ = placed.z - sin * bx + cos * bz;
  out.acrossX = worldNormalX !== 0;
  out.outward = out.acrossX ? worldNormalX : worldNormalZ;
  out.line = out.acrossX ? fromX : fromZ;
  out.from = out.acrossX ? Math.min(fromZ, toZ) : Math.min(fromX, toX);
  out.to = out.acrossX ? Math.max(fromZ, toZ) : Math.max(fromX, toX);
}

const snapProbe: ProbedRoad = { id: -1, x: 0, z: 0, yLdu: 0, rot: 0, surface: NO_ROAD_SURFACE };
const snapFit = new RoadFit();
const nearbyPlacements: number[] = [];
const cleanCandidates: Array<Ranked & { readonly yLdu: number }> = [];
const runScratch: WorldRun = { acrossX: true, outward: 1, line: 0, from: 0, to: 0 };

interface SnapQuery {
  readonly roads: PlacedRoads;
  readonly heights: RestingHeights;
  readonly cursorX: number;
  readonly cursorZ: number;
  readonly turn: number;
  readonly rot: number;
  readonly ghost: CellExtent;
}

function consider(query: SnapQuery, x: number, z: number, contactWith: CellExtent | null): void {
  const { ghost, cursorX, cursorZ, rot, roads } = query;
  const inside =
    cursorX >= x + ghost.minX &&
    cursorX <= x + ghost.maxX &&
    cursorZ >= z + ghost.minZ &&
    cursorZ <= z + ghost.maxZ;
  if (!inside) return;
  const probe = snapProbe;
  probe.x = x;
  probe.z = z;
  probe.rot = rot;
  probe.yLdu = query.heights.restingYLdu(x, z, rot);
  const fit =
    roads.network.cleanFit(probe, snapFit) ??
    (contactWith && cornerFlush(contactWith, ghost, x, z)
      ? roads.network.cleanContact(probe, snapFit)
      : null);
  if (!fit) return;
  cleanCandidates.push({
    snap: {
      x,
      z,
      rot,
      metCells: fit.metCells,
      joinedCells: fit.joinedCells,
      joinedRoadCells: fit.joinedRoadCells,
    },
    distance: Math.hypot(
      cursorX - (x + (ghost.minX + ghost.maxX) / 2),
      cursorZ - (z + (ghost.minZ + ghost.maxZ) / 2),
    ),
    turn: query.turn,
    yLdu: probe.yLdu,
  });
}

function besideExtent(query: SnapQuery, extent: CellExtent): void {
  const { ghost } = query;
  const zSteps = besideZSteps(extent, ghost);
  const positions = 2 * zSteps + 2 * besideXSteps(extent, ghost);
  for (let p = 0; p < positions; p++) {
    consider(query, sideX(extent, ghost, p, zSteps), sideZ(extent, ghost, p, zSteps), extent);
  }
}

function alongOpenRuns(query: SnapQuery, placed: RoadPlacement): void {
  const { ghost, cursorX, cursorZ } = query;
  const runs = localOpenRuns(placed.surface);
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    if (!run) continue;
    worldRun(placed, run, runScratch);
    const { acrossX, outward, line, from, to } = runScratch;
    const near = acrossX ? ghost.minX : ghost.minZ;
    const far = acrossX ? ghost.maxX : ghost.maxZ;
    const lowAlong = acrossX ? ghost.minZ : ghost.minX;
    const highAlong = acrossX ? ghost.maxZ : ghost.maxX;
    const across = outward > 0 ? line - near : line - far;
    const cursorAlong = acrossX ? cursorZ : cursorX;
    const first = from - highAlong + STUD_LDU;
    const low = Math.max(first, cursorAlong - highAlong);
    const high = Math.min(to - lowAlong - STUD_LDU, cursorAlong - lowAlong);
    for (let along = first + Math.ceil((low - first) / STUD_LDU) * STUD_LDU; along <= high;) {
      if (acrossX) consider(query, across, along, null);
      else consider(query, along, across, null);
      along += STUD_LDU;
    }
  }
}

function ranked(a: Ranked, b: Ranked): number {
  if (better(a, b)) return -1;
  return better(b, a) ? 1 : 0;
}

export function snapToRoadEdge(
  roads: PlacedRoads,
  surface: RoadSurface,
  preferredRot: number,
  direction: TurnDirection,
  heights: RestingHeights,
  cursorX: number,
  cursorZ: number,
  turns: number,
): RoadSnap | null {
  const probe = snapProbe;
  probe.surface = surface;
  cleanCandidates.length = 0;
  for (let turn = 0; turn < turns; turn++) {
    const rot = quarterTurned(preferredRot, direction * turn);
    const ghost = cellExtent({ id: -1, x: 0, z: 0, yLdu: 0, rot, surface });
    const query: SnapQuery = { roads, heights, cursorX, cursorZ, turn, rot, ghost };
    nearbyPlacements.length = 0;
    const count = roads.index.near(
      cursorX - (ghost.maxX - ghost.minX),
      cursorX + (ghost.maxX - ghost.minX),
      cursorZ - (ghost.maxZ - ghost.minZ),
      cursorZ + (ghost.maxZ - ghost.minZ),
      nearScratch,
    );
    for (let n = 0; n < count; n++) {
      const placement = nearScratch[n] ?? 0;
      const extent = roads.extents[placement];
      if (!extent || !within(extent, ghost, cursorX, cursorZ)) continue;
      if (!nearbyPlacements.includes(placement)) nearbyPlacements.push(placement);
    }
    for (let n = 0; n < nearbyPlacements.length; n++) {
      const placement = nearbyPlacements[n] ?? 0;
      const extent = roads.extents[placement];
      const placed = roads.placements[placement];
      if (!extent || !placed) continue;
      besideExtent(query, extent);
      alongOpenRuns(query, placed);
    }
  }
  cleanCandidates.sort(ranked);
  let chosen: RoadSnap | null = null;
  for (let c = 0; c < cleanCandidates.length && !chosen; c++) {
    const candidate = cleanCandidates[c];
    if (!candidate) continue;
    probe.x = candidate.snap.x;
    probe.z = candidate.snap.z;
    probe.rot = candidate.snap.rot;
    probe.yLdu = candidate.yLdu;
    if (roadOverlapCells(roads, probe) === 0) chosen = candidate.snap;
  }
  probe.surface = NO_ROAD_SURFACE;
  cleanCandidates.length = 0;
  return chosen;
}
