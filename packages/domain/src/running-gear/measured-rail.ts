import {
  compareExactRational,
  exactRationalFromDecimal,
  parseExactDecimal,
  type ExactRational,
} from "@brr/math";
import type { RailHeadText } from "@brr/schema/bundle";

export interface RailHeadBand {
  readonly from: ExactRational;
  readonly to: ExactRational;
}

export interface MeasuredRail {
  readonly railHeads: readonly [RailHeadBand, RailHeadBand];
}

function band(head: RailHeadText): RailHeadBand {
  const from = exactRationalFromDecimal(parseExactDecimal(head.from));
  const to = exactRationalFromDecimal(parseExactDecimal(head.to));
  if (compareExactRational(from, to) >= 0) {
    throw new RangeError(`a rail head band runs from ${head.from} to ${head.to}, not upward`);
  }
  return { from, to };
}

export function measuredRail(railHeads: ReadonlyArray<RailHeadText>): MeasuredRail {
  const [near, far] = railHeads;
  if (railHeads.length !== 2 || !near || !far) {
    throw new RangeError(`a measured rail has two head bands, not ${railHeads.length}`);
  }
  const nearBand = band(near);
  const farBand = band(far);
  if (compareExactRational(nearBand.to, farBand.from) >= 0) {
    throw new RangeError("a measured rail's near head band must lie wholly below its far one");
  }
  return { railHeads: [nearBand, farBand] };
}
