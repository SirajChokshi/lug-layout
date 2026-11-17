import { placedCells, type RoadNetwork, type RoadPlacement, type RoadSurface } from "@brr/domain";
import { STUD_LDU } from "@brr/math";

export interface CellExtent {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface RoadSnap {
  readonly x: number;
  readonly z: number;
  readonly rot: number;
  readonly joinedCells: number;
  readonly joinedRoadCells: number;
}

const QUARTER_TURNS = 4;

export function cellExtent(placement: RoadPlacement): CellExtent {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const cell of placedCells(placement)) {
    minX = Math.min(minX, cell.cellX * STUD_LDU);
    maxX = Math.max(maxX, (cell.cellX + 1) * STUD_LDU);
    minZ = Math.min(minZ, cell.cellZ * STUD_LDU);
    maxZ = Math.max(maxZ, (cell.cellZ + 1) * STUD_LDU);
  }
  return { minX, maxX, minZ, maxZ };
}

export function touchingRoads(
  placed: ReadonlyArray<CellExtent>,
  ghost: CellExtent,
): ReadonlyArray<number> {
  const near: number[] = [];
  for (let i = 0; i < placed.length; i++) {
    const extent = placed[i];
    if (!extent) continue;
    const touchesX = extent.minX <= ghost.maxX && extent.maxX >= ghost.minX;
    const touchesZ = extent.minZ <= ghost.maxZ && extent.maxZ >= ghost.minZ;
    if (touchesX && touchesZ) near.push(i);
  }
  return near;
}

function* alongSide(placed: CellExtent, ghost: CellExtent): Generator<readonly [number, number]> {
  for (let z = placed.minZ - ghost.maxZ + STUD_LDU; z < placed.maxZ - ghost.minZ; z += STUD_LDU) {
    yield [placed.maxX - ghost.minX, z];
    yield [placed.minX - ghost.maxX, z];
  }
  for (let x = placed.minX - ghost.maxX + STUD_LDU; x < placed.maxX - ghost.minX; x += STUD_LDU) {
    yield [x, placed.maxZ - ghost.minZ];
    yield [x, placed.minZ - ghost.maxZ];
  }
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

export function snapToRoadEdge(
  network: RoadNetwork,
  placed: ReadonlyArray<CellExtent>,
  surface: RoadSurface,
  preferredRot: number,
  yLdu: number,
  cursorX: number,
  cursorZ: number,
): RoadSnap | null {
  let best: Ranked | null = null;
  for (let turn = 0; turn < QUARTER_TURNS; turn++) {
    const rot = (preferredRot + turn) % QUARTER_TURNS;
    const ghost = cellExtent({ id: -1, x: 0, z: 0, yLdu, rot, surface });
    for (const extent of placed) {
      if (!within(extent, ghost, cursorX, cursorZ)) continue;
      for (const [x, z] of alongSide(extent, ghost)) {
        const inside =
          cursorX >= x + ghost.minX &&
          cursorX <= x + ghost.maxX &&
          cursorZ >= z + ghost.minZ &&
          cursorZ <= z + ghost.maxZ;
        if (!inside) continue;
        const distance = Math.hypot(
          cursorX - (x + (ghost.minX + ghost.maxX) / 2),
          cursorZ - (z + (ghost.minZ + ghost.maxZ) / 2),
        );
        const fit = network.fit({ id: -1, x, z, yLdu, rot, surface });
        if (fit.joinedCells === 0 || fit.mismatchedCells > 0 || fit.overlappingCells > 0) continue;
        if (fit.joinedRoadCells === 0 && !cornerFlush(extent, ghost, x, z)) continue;
        const candidate: Ranked = {
          snap: { x, z, rot, joinedCells: fit.joinedCells, joinedRoadCells: fit.joinedRoadCells },
          distance,
          turn,
        };
        if (better(candidate, best)) best = candidate;
      }
    }
  }
  return best?.snap ?? null;
}
