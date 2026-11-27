import { parseExactRational, type ExactRational } from "@brr/math";
import type { PartExtents as PartExtentsText } from "@brr/schema/bundle";

type Triple = readonly [ExactRational, ExactRational, ExactRational];

export interface PartExtents {
  readonly min: Triple;
  readonly max: Triple;
}

function triple(text: PartExtentsText["min"]): Triple {
  return [parseExactRational(text[0]), parseExactRational(text[1]), parseExactRational(text[2])];
}

export function partExtents(text: PartExtentsText | null): PartExtents | null {
  return text ? { min: triple(text.min), max: triple(text.max) } : null;
}
