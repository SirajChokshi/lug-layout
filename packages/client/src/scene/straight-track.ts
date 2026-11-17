import type { PartAsset } from "@brr/catalog";
import type { TrackEnd } from "@brr/schema/bundle";

const INTEGER_COEFFICIENT = /^-?\d+$/u;
const REAL_AXIS_COEFFICIENT = 0;

function certifiedCoefficients(end: TrackEnd | undefined): number[] | undefined {
  if (!end?.fieldCertified || !end.coefficients) return undefined;
  if (!end.coefficients.every((c) => INTEGER_COEFFICIENT.test(c))) return undefined;
  return end.coefficients.map(Number);
}

function headingsOpposite(entry: TrackEnd, exit: TrackEnd, basisLength: number): boolean {
  const fullTurnSteps = 2 * basisLength;
  const difference =
    (((entry.headingSteps - exit.headingSteps) % fullTurnSteps) + fullTurnSteps) % fullTurnSteps;
  return difference === fullTurnSteps / 2;
}

export function straightRunPitchStuds(part: PartAsset): number | undefined {
  const ends = part.trackEnds;
  if (!ends || ends.length !== 2) return undefined;
  const [entry, exit] = ends;
  const entryCoefficients = certifiedCoefficients(entry);
  const exitCoefficients = certifiedCoefficients(exit);
  if (!entry || !exit || !entryCoefficients || !exitCoefficients) return undefined;
  if (entryCoefficients.length !== exitCoefficients.length) return undefined;
  if (!headingsOpposite(entry, exit, entryCoefficients.length)) return undefined;
  let pitch = 0;
  for (let k = 0; k < exitCoefficients.length; k++) {
    const delta = (exitCoefficients[k] ?? 0) - (entryCoefficients[k] ?? 0);
    if (k === REAL_AXIS_COEFFICIENT) pitch = delta;
    else if (delta !== 0) return undefined;
  }
  if (pitch <= 0 || exit.xStuds - entry.xStuds !== pitch || exit.zStuds !== entry.zStuds) {
    return undefined;
  }
  return pitch;
}
