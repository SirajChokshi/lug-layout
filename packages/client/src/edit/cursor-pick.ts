import type { PlacementWindow } from "../connect/placement-search.ts";

export const PRECISE_RADIUS = 0;
export const HELD_TURN_ONLY = 1;
export const HELD_FIRST_TURN = 0;
export const RESTS_ON_TABLE_Y_PLATES = 0;

export class CursorPick implements PlacementWindow {
  x = 0;
  z = 0;
  yPlates = RESTS_ON_TABLE_Y_PLATES;
  rot = 0;
  cells = PRECISE_RADIUS;
  plates = PRECISE_RADIUS;
  radiusLdu = PRECISE_RADIUS;
  turns = HELD_TURN_ONLY;
  firstTurn = HELD_FIRST_TURN;

  copy(from: CursorPick): void {
    this.x = from.x;
    this.z = from.z;
    this.yPlates = from.yPlates;
    this.rot = from.rot;
    this.cells = from.cells;
    this.plates = from.plates;
    this.radiusLdu = from.radiusLdu;
    this.turns = from.turns;
    this.firstTurn = from.firstTurn;
  }
}
