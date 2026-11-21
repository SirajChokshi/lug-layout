import { INT8_MAX } from "./track-layout.ts";
import type { TrackMove } from "./track-pose.ts";

const RAMP_CONNECTORS = 2;
const LOW_END = 0;

export function rampRises(
  fromPlates: number,
  toPlates: number,
  preferred: ReadonlyArray<boolean>,
  maxRisePlates: number,
): Int8Array | null {
  if (!Number.isInteger(fromPlates) || !Number.isInteger(toPlates)) {
    throw new RangeError(`ramp heights ${fromPlates} → ${toPlates} must be whole plates`);
  }
  if (!Number.isInteger(maxRisePlates) || maxRisePlates < 0 || maxRisePlates > INT8_MAX) {
    throw new RangeError(
      `a ramp can't rise ${maxRisePlates} plates per piece: a piece's rise is 0 to ${INT8_MAX} plates`,
    );
  }
  const rises = new Int8Array(preferred.length);
  const direction = Math.sign(toPlates - fromPlates);
  let remaining = Math.abs(toPlates - fromPlates);
  for (const wanted of [true, false]) {
    for (let piece = 0; piece < preferred.length && remaining > 0; piece++) {
      if (preferred[piece] !== wanted) continue;
      const step = Math.min(maxRisePlates, remaining);
      rises[piece] = direction * step;
      remaining -= step;
    }
  }
  return remaining === 0 ? rises : null;
}

export function reachablePlates(
  fromPlates: number,
  towardPlates: number,
  pieces: number,
  maxRisePlates: number,
): number {
  const climb = Math.min(Math.abs(towardPlates - fromPlates), pieces * maxRisePlates);
  return fromPlates + Math.sign(towardPlates - fromPlates) * climb;
}

export interface RunHeights {
  readonly yPlates: Int16Array;
  readonly rise: Int8Array;
  readonly endPlates: number;
}

export function runHeights(
  moves: ReadonlyArray<Pick<TrackMove, "piece" | "from" | "to">>,
  startPlates: number,
  rises: Int8Array,
): RunHeights {
  if (rises.length !== moves.length) {
    throw new RangeError(`${rises.length} rises for a run of ${moves.length} pieces`);
  }
  const yPlates = new Int16Array(moves.length);
  const rise = new Int8Array(moves.length);
  let height = startPlates;
  moves.forEach((move, i) => {
    const step = rises[i] ?? 0;
    if (step !== 0 && move.piece.connectors.length !== RAMP_CONNECTORS) {
      throw new RangeError(
        `${move.piece.id} has ${move.piece.connectors.length} ends, so it can't ramp`,
      );
    }
    const entersLow = move.from === LOW_END;
    yPlates[i] = entersLow ? height : height + step;
    rise[i] = entersLow ? step : -step;
    height += step;
  });
  return { yPlates, rise, endPlates: height };
}
