import { zeta16FloorStuds } from "./zeta16-floor.ts";
import type { Zeta16 } from "./zeta16.ts";

export type Sign = -1 | 0 | 1;

function realIsZero([c0, c1, c2, c3, , c5, c6, c7]: Zeta16): boolean {
  return c0 === 0n && c1 === c7 && c2 === c6 && c3 === c5;
}

function imaginaryIsZero([, c1, c2, c3, c4, c5, c6, c7]: Zeta16): boolean {
  return c4 === 0n && c3 === -c5 && c2 === -c6 && c1 === -c7;
}

export function zeta16RealSign(value: Zeta16): Sign {
  if (realIsZero(value)) return 0;
  return zeta16FloorStuds(value).x < 0n ? -1 : 1;
}

export function zeta16ImaginarySign(value: Zeta16): Sign {
  if (imaginaryIsZero(value)) return 0;
  return zeta16FloorStuds(value).z < 0n ? -1 : 1;
}
