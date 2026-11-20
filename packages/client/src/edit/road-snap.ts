import { RoadFit, type RoadNetwork, type RoadPlacement, type RoadSurface } from "@brr/domain";
import { STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import { quarterTurned, type TurnDirection } from "./turn.ts";

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
  readonly metCells: number;
  readonly joinedCells: number;
  readonly joinedRoadCells: number;
}

const QUARTER_TURNS = 4;
export const ANY_TURN = QUARTER_TURNS;
export const HELD_TURN = 1;
const HALF_STUD_LDU = STUD_LDU / 2;

function cornerStep(count: number): number {
  return Math.max(1, count - 1);
}

export function cellExtent(placement: RoadPlacement): CellExtent {
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
      const cellX = Math.floor((placement.x + cos * localX + sin * localZ) / STUD_LDU);
      const cellZ = Math.floor((placement.z - sin * localX + cos * localZ) / STUD_LDU);
      minX = Math.min(minX, cellX * STUD_LDU);
      maxX = Math.max(maxX, (cellX + 1) * STUD_LDU);
      minZ = Math.min(minZ, cellZ * STUD_LDU);
      maxZ = Math.max(maxZ, (cellZ + 1) * STUD_LDU);
    }
  }
  return { minX, maxX, minZ, maxZ };
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

function hitsAny(
  extents: ReadonlyArray<CellExtent>,
  ghost: CellExtent,
  x: number,
  z: number,
): boolean {
  for (const extent of extents) {
    if (
      x + ghost.minX < extent.maxX &&
      x + ghost.maxX > extent.minX &&
      z + ghost.minZ < extent.maxZ &&
      z + ghost.maxZ > extent.minZ
    ) {
      return true;
    }
  }
  return false;
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
  direction: TurnDirection,
  yLdu: number,
  cursorX: number,
  cursorZ: number,
  turns: number,
): RoadSnap | null {
  let best: Ranked | null = null;
  const probe = { id: -1, x: 0, z: 0, yLdu, rot: 0, surface };
  const probeFit = new RoadFit();
  const nearby: CellExtent[] = [];
  for (let turn = 0; turn < turns; turn++) {
    const rot = quarterTurned(preferredRot, direction * turn);
    const ghost = cellExtent({ id: -1, x: 0, z: 0, yLdu, rot, surface });
    probe.rot = rot;
    nearby.length = 0;
    for (const extent of placed) {
      if (within(extent, ghost, cursorX, cursorZ)) nearby.push(extent);
    }
    for (const extent of nearby) {
      const zSteps = besideZSteps(extent, ghost);
      const positions = 2 * zSteps + 2 * besideXSteps(extent, ghost);
      for (let p = 0; p < positions; p++) {
        const x = sideX(extent, ghost, p, zSteps);
        const z = sideZ(extent, ghost, p, zSteps);
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
        probe.x = x;
        probe.z = z;
        const fit =
          network.cleanFit(probe, probeFit) ??
          (cornerFlush(extent, ghost, x, z) ? network.cleanContact(probe, probeFit) : null);
        if (!fit || hitsAny(nearby, ghost, x, z)) continue;
        const candidate: Ranked = {
          snap: {
            x,
            z,
            rot,
            metCells: fit.metCells,
            joinedCells: fit.joinedCells,
            joinedRoadCells: fit.joinedRoadCells,
          },
          distance,
          turn,
        };
        if (better(candidate, best)) best = candidate;
      }
    }
  }
  return best?.snap ?? null;
}
