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
  readonly joinedCells: number;
}

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

export function snapToRoadEdge(
  network: RoadNetwork,
  placed: ReadonlyArray<CellExtent>,
  surface: RoadSurface,
  rot: number,
  yLdu: number,
  cursorX: number,
  cursorZ: number,
): RoadSnap | null {
  const ghost = cellExtent({ id: -1, x: 0, z: 0, yLdu, rot, surface });
  let best: RoadSnap | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const extent of placed) {
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
      if (distance >= bestDistance) continue;
      const fit = network.fit({ id: -1, x, z, yLdu, rot, surface });
      if (fit.joinedCells === 0 || fit.mismatchedCells > 0 || fit.overlappingCells > 0) continue;
      best = { x, z, joinedCells: fit.joinedCells };
      bestDistance = distance;
    }
  }
  return best;
}
