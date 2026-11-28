import {
  HALF_TURN_16,
  POSE16_IDENTITY,
  ZETA16_ORDER,
  normalizeHeading16,
  pose16Equals,
} from "@brr/math";
import { solveClosure, type SearchBudget } from "./closure.ts";
import type { DrawingKit } from "./drawing-kit.ts";
import type { TrackRoute } from "./track-layout.ts";
import {
  connectorPose,
  continuingExit,
  layMoves,
  trackMove,
  type PlacedPiece,
  type TrackMove,
  type TrackPieceDef,
} from "./track-pose.ts";
import { runMoves, type TrackRun } from "./track-solver.ts";

export interface Turnout {
  readonly piece: TrackPieceDef;
  readonly points: number;
  readonly straight: number;
  readonly branch: number;
}

const MAX_MAIN_STRAIGHTS = 16;

export function turnoutOf(piece: TrackPieceDef, routes: ReadonlyArray<TrackRoute>): Turnout | null {
  for (const { from } of routes) {
    const exits = routes.filter((route) => route.from === from).map((route) => route.to);
    const straight = continuingExit(piece, from);
    const branch = exits.find((exit) => exit !== straight);
    if (exits.length !== 2 || straight === null || branch === undefined) continue;
    if (!exits.includes(straight)) continue;
    return { piece, points: from, straight, branch };
  }
  return null;
}

export function ovalBlueprint(kit: DrawingKit, straights: number): ReadonlyArray<PlacedPiece> {
  const side = [
    ...repeated(kit.straight, straights),
    ...repeated(kit.left, HALF_TURN_16 / kit.left.turn),
  ];
  const { placed, end } = layMoves(POSE16_IDENTITY, [...side, ...side]);
  return pose16Equals(end, POSE16_IDENTITY) ? placed : [];
}

export function passingSidingBlueprint(
  kit: DrawingKit,
  turnout: Turnout,
  mirror: Turnout,
  size: number,
  budget: SearchBudget,
): ReadonlyArray<PlacedPiece> {
  let sidings = 0;
  for (let between = 0; between <= MAX_MAIN_STRAIGHTS; between++) {
    const { placed } = layMoves(POSE16_IDENTITY, [
      trackMove(turnout.piece, turnout.points, turnout.straight),
      ...repeated(kit.straight, between),
      trackMove(mirror.piece, mirror.straight, mirror.points),
    ]);
    const [first] = placed;
    const last = placed[placed.length - 1];
    if (!first || !last) return [];
    const from = connectorPose(first, turnout.branch);
    const result = solveClosure(kit, from, connectorPose(last, mirror.branch), budget);
    if (result.kind !== "exact" || curvesOf(result.run) > 2 * divergence(turnout)) continue;
    if (sidings++ < size) continue;
    return [...placed, ...layMoves(from, runMoves(kit, result.run)).placed];
  }
  return [];
}

export function reversingLoopBlueprint(
  kit: DrawingKit,
  turnout: Turnout,
  budget: SearchBudget,
): ReadonlyArray<PlacedPiece> {
  const { placed } = layMoves(POSE16_IDENTITY, [
    trackMove(turnout.piece, turnout.points, turnout.straight),
  ]);
  const [points] = placed;
  if (!points) return [];
  const from = connectorPose(points, turnout.straight);
  const result = solveClosure(kit, from, connectorPose(points, turnout.branch), budget);
  return result.kind === "exact"
    ? [...placed, ...layMoves(from, runMoves(kit, result.run)).placed]
    : [];
}

function repeated(move: TrackMove, count: number): ReadonlyArray<TrackMove> {
  return Array.from({ length: count }, () => move);
}

function divergence({ piece, straight, branch }: Turnout): number {
  const steps = normalizeHeading16(
    (piece.connectors[branch]?.heading ?? 0) - (piece.connectors[straight]?.heading ?? 0),
  );
  return Math.min(steps, ZETA16_ORDER - steps);
}

function curvesOf(run: TrackRun): number {
  let curves = 0;
  for (const segment of run.segments) if (segment.kind === "turn") curves += segment.curves;
  return curves;
}
