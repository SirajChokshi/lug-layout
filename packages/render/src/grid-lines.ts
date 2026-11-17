import type { GridLevel } from "./scene-backend.ts";

export function gridAnchorStep(levels: ReadonlyArray<GridLevel>): number {
  const anchor = Math.max(...levels.map((level) => level.stepLdu));
  for (const level of levels) {
    if (anchor % level.stepLdu !== 0) {
      throw new Error(`grid step ${level.stepLdu} LDU does not divide the coarsest step ${anchor}`);
    }
  }
  return anchor;
}

export function gridAnchor(target: number, anchorStep: number): number {
  return Math.round(target / anchorStep) * anchorStep + 0;
}

export function levelReachSteps(level: GridLevel, anchorStep: number): number {
  return level.halfSteps + anchorStep / level.stepLdu;
}

export function levelLineOffsets(
  level: GridLevel,
  levels: ReadonlyArray<GridLevel>,
): ReadonlyArray<number> {
  const anchorStep = gridAnchorStep(levels);
  const coarser = levels
    .filter((other) => other.stepLdu > level.stepLdu)
    .map((other) => other.stepLdu);
  const reach = levelReachSteps(level, anchorStep);
  const offsets: number[] = [];
  for (let i = -reach; i <= reach; i++) {
    const offset = i * level.stepLdu + 0;
    if (!coarser.some((step) => offset % step === 0)) offsets.push(offset);
  }
  return offsets;
}
