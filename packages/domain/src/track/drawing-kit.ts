import {
  ZETA16_ORDER,
  ZETA16_ZERO,
  addZeta16,
  normalizeHeading16,
  rotateZeta16,
  type Zeta16,
} from "@brr/math";
import { trackMove, type TrackMove, type TrackPieceDef } from "./track-pose.ts";

export type TurnSign = 1 | -1;

export interface DrawingKit {
  readonly straight: TrackMove;
  readonly straightStuds: bigint;
  readonly left: TrackMove;
  readonly right: TrackMove;
  arc(sign: TurnSign, curves: number, heading: number): Zeta16;
}

export type DrawingKitResult =
  | { readonly kind: "kit"; readonly kit: DrawingKit }
  | { readonly kind: "missing"; readonly reason: string };

const LEFT_TURN = 1;
const RIGHT_TURN = ZETA16_ORDER - 1;
export const MAX_TURN_CURVES = ZETA16_ORDER - 1;

function straightLength(move: TrackMove): bigint | undefined {
  if (move.turn !== 0) return undefined;
  const [along, ...rest] = move.delta;
  if (along <= 0n || rest.some((c) => c !== 0n)) return undefined;
  return along;
}

function twoEndedMoves(pieces: ReadonlyArray<TrackPieceDef>): ReadonlyArray<TrackMove> {
  return pieces
    .filter((piece) => piece.connectors.length === 2)
    .flatMap((piece) => [trackMove(piece, 0, 1), trackMove(piece, 1, 0)]);
}

function arcTable(curve: TrackMove, sign: TurnSign): ReadonlyArray<ReadonlyArray<Zeta16>> {
  const sums: Zeta16[] = [ZETA16_ZERO];
  for (let m = 1; m <= MAX_TURN_CURVES; m++) {
    const previous = sums[m - 1] ?? ZETA16_ZERO;
    sums.push(addZeta16(previous, rotateZeta16(curve.delta, sign * (m - 1))));
  }
  return sums.map((sum) =>
    Array.from({ length: ZETA16_ORDER }, (_v, heading) => rotateZeta16(sum, heading)),
  );
}

export function drawingKit(pieces: ReadonlyArray<TrackPieceDef>): DrawingKitResult {
  const moves = twoEndedMoves(pieces);
  const straight = moves.find((m) => straightLength(m) !== undefined);
  const straightStuds = straight ? straightLength(straight) : undefined;
  if (!straight || straightStuds === undefined) {
    return { kind: "missing", reason: "no straight piece along one ℤ[ζ₁₆] basis direction" };
  }
  const left = moves.find((m) => m.turn === LEFT_TURN);
  const right = moves.find((m) => m.turn === RIGHT_TURN);
  if (!left || !right) {
    return { kind: "missing", reason: "no curve piece turning one 22.5° step each way" };
  }
  const leftArcs = arcTable(left, 1);
  const rightArcs = arcTable(right, -1);
  return {
    kind: "kit",
    kit: {
      straight,
      straightStuds,
      left,
      right,
      arc: (sign, curves, heading) => {
        const value = (sign === 1 ? leftArcs : rightArcs)[curves]?.[normalizeHeading16(heading)];
        if (value === undefined) throw new RangeError(`no arc of ${curves} curves`);
        return value;
      },
    },
  };
}
