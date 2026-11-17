import { layMoves, runMoves, solveClosure, type DrawingKit, type TrackMove } from "@brr/domain";
import { STUD_LDU, pose16Equals, posesJoin16, zeta16ToStuds, type Pose16 } from "@brr/math";

export type SingleChoiceKind = "straight" | "left" | "right";
export type TrackChoiceKind = SingleChoiceKind | "join";

export interface TrackChoice {
  readonly kind: TrackChoiceKind;
  readonly moves: ReadonlyArray<TrackMove>;
  readonly target: Pose16 | null;
}

const JOIN_SEARCH_RADIUS_LDU = 96 * STUD_LDU;
const JOIN_TARGETS = 4;
const JOIN_BUDGET_MS = 12;
const AUTO_JOIN_MAX_PIECES = 4;

function distanceLdu(a: Pose16, b: Pose16): number {
  const pa = zeta16ToStuds(a.position);
  const pb = zeta16ToStuds(b.position);
  return Math.hypot(pa.x - pb.x, pa.z - pb.z) * STUD_LDU;
}

function joinedEnd(
  from: Pose16,
  moves: ReadonlyArray<TrackMove>,
  ends: ReadonlyArray<Pose16>,
): Pose16 | null {
  const { end } = layMoves(from, moves);
  return ends.find((open) => posesJoin16(end, open)) ?? null;
}

export function extensionChoices(
  kit: DrawingKit,
  from: Pose16,
  openEnds: ReadonlyArray<Pose16>,
  now: () => number,
): ReadonlyArray<TrackChoice> {
  const others = openEnds.filter((end) => !pose16Equals(end, from));
  const single = (kind: SingleChoiceKind, move: TrackMove): TrackChoice => ({
    kind,
    moves: [move],
    target: joinedEnd(from, [move], others),
  });
  const choices: TrackChoice[] = [
    single("straight", kit.straight),
    single("left", kit.left),
    single("right", kit.right),
  ];
  const nearest = others
    .map((end) => ({ end, distance: distanceLdu(from, end) }))
    .filter((candidate) => candidate.distance <= JOIN_SEARCH_RADIUS_LDU)
    .toSorted((a, b) => a.distance - b.distance)
    .slice(0, JOIN_TARGETS);
  const joins: TrackChoice[] = [];
  for (const { end } of nearest) {
    const result = solveClosure(kit, from, end, { now, limitMs: JOIN_BUDGET_MS });
    if (result.kind !== "exact") continue;
    const moves = runMoves(kit, result.run);
    if (moves.length <= 1) continue;
    joins.push({ kind: "join", moves, target: end });
  }
  return [...choices, ...joins.toSorted((a, b) => a.moves.length - b.moves.length)];
}

export function defaultChoice(
  choices: ReadonlyArray<TrackChoice>,
  preferred: SingleChoiceKind,
): number {
  let shortestJoin = -1;
  choices.forEach((choice, index) => {
    if (choice.target === null || choice.moves.length > AUTO_JOIN_MAX_PIECES) return;
    const best = choices[shortestJoin];
    if (!best || choice.moves.length < best.moves.length) shortestJoin = index;
  });
  if (shortestJoin >= 0) return shortestJoin;
  return Math.max(
    0,
    choices.findIndex((choice) => choice.kind === preferred),
  );
}
