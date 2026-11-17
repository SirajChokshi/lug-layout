export type TurnDirection = 1 | -1;

const QUARTER_TURNS = 4;

export function quarterTurned(rot: number, turns: number): number {
  return (((rot + turns) % QUARTER_TURNS) + QUARTER_TURNS) % QUARTER_TURNS;
}
