import { type TrackEnd, decodeZeta16 } from "@brr/schema/bundle";
import {
  attachPose16,
  composePose16,
  POSE16_IDENTITY,
  pose16,
  posesJoin16,
  STUD_LDU,
  ZETA16_ORDER,
  ZETA16_STEP_RADIANS,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";
import type { LdrawLibrary } from "../ldraw/library.ts";
import {
  entryInwardAngle,
  findTrackEnds,
  relativeToEntry,
  type MarkerEnd,
  type TrackEndMarker,
} from "../track/track-ends.ts";
import { rotationY, toLdraw, translated, type ScenePlacement } from "./scenes.ts";

const STRAIGHT = "74746";
const CURVE = "74747";
const RIGHT_SWITCH = "75541-f2";
const LEFT_SWITCH = "75542-f2";
const PLASTIC_CURVE = "53400";
const LOOP_PARTS = [STRAIGHT, CURVE, RIGHT_SWITCH, LEFT_SWITCH, PLASTIC_CURVE];
const CURVES_PER_HALF_TURN = ZETA16_ORDER / 2;
const SIDING_STRAIGHTS = 2;
const MAIN_EXTRA_STRAIGHTS = 2;
const RETURN_EXTRA_STRAIGHTS = 6;
const DRIFT_LAPS = [1, 10, 100, 1000];
const SIGNIFICANT_DIGITS = 3;
const DEGREES_PER_RADIAN = 180 / Math.PI;
const FULL_TURN = 2 * Math.PI;

interface MeasuredPiece {
  readonly part: string;
  readonly entry: MarkerEnd;
  readonly relative: ReadonlyArray<TrackEnd>;
}

interface FloatPose {
  readonly x: number;
  readonly z: number;
  readonly angle: number;
}

interface PoseAlgebra<P> {
  readonly identity: P;
  readonly ends: (piece: MeasuredPiece) => ReadonlyArray<P>;
  readonly attach: (localEnd: P, target: P) => P;
  readonly compose: (frame: P, local: P) => P;
}

interface Closure<P> {
  readonly label: string;
  readonly open: P;
  readonly target: P;
}

interface Placed<P> {
  readonly part: string;
  readonly frame: P;
}

class Layout<P> {
  readonly placements: Placed<P>[] = [];
  readonly ends: P[] = [];
  readonly closures: Closure<P>[] = [];

  private readonly algebra: PoseAlgebra<P>;
  private readonly pieces: ReadonlyMap<string, MeasuredPiece>;

  constructor(algebra: PoseAlgebra<P>, pieces: ReadonlyMap<string, MeasuredPiece>) {
    this.algebra = algebra;
    this.pieces = pieces;
  }

  place(part: string, byEnd: number, target: P | undefined): ReadonlyArray<P> {
    const local = this.algebra.ends(measuredPiece(this.pieces, part));
    const end = at(local, byEnd);
    const frame = target === undefined ? this.algebra.identity : this.algebra.attach(end, target);
    const world = local.map((pose) => this.algebra.compose(frame, pose));
    this.placements.push({ part, frame });
    this.ends.push(...world);
    return world;
  }

  close(label: string, open: P, target: P): void {
    this.closures.push({ label, open, target });
  }
}

function at<T>(values: ReadonlyArray<T>, index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`no element ${index}`);
  return value;
}

function measuredPiece(pieces: ReadonlyMap<string, MeasuredPiece>, part: string): MeasuredPiece {
  const piece = pieces.get(part);
  if (piece === undefined) throw new Error(`track part ${part} was not measured`);
  return piece;
}

function measurePieces(
  library: LdrawLibrary,
  markers: ReadonlyArray<TrackEndMarker>,
): ReadonlyMap<string, MeasuredPiece> {
  return new Map(
    LOOP_PARTS.map((part) => {
      const ends = findTrackEnds(library, part, markers);
      return [part, { part, entry: at(ends, 0), relative: relativeToEntry(ends) }];
    }),
  );
}

function switchEndIndex(piece: MeasuredPiece, route: "straight" | "diverging"): number {
  const index = piece.relative.findIndex(
    (end, i) => i > 0 && (end.headingSteps === 0) === (route === "straight"),
  );
  if (index < 0) throw new Error(`${piece.part} has no ${route} end`);
  return index;
}

const exactAlgebra: PoseAlgebra<Pose16> = {
  identity: POSE16_IDENTITY,
  ends: (piece) =>
    piece.relative.map((end, index) => {
      if (end.coefficients === null) {
        throw new Error(`${piece.part} end ${index} has no certified ℤ[ζ₁₆] pose`);
      }
      return pose16(decodeZeta16(end.coefficients), end.headingSteps);
    }),
  attach: attachPose16,
  compose: composePose16,
};

type Rounding = (value: number) => number;

function floatAlgebra(round: Rounding, source: "measured" | "certified"): PoseAlgebra<FloatPose> {
  const rotate = (angle: number, x: number, z: number): readonly [number, number] => {
    const cos = round(Math.cos(angle));
    const sin = round(Math.sin(angle));
    return [round(round(cos * x) - round(sin * z)), round(round(sin * x) + round(cos * z))];
  };
  const wrap = (angle: number): number => round(angle - FULL_TURN * Math.round(angle / FULL_TURN));
  const localEnd = (end: TrackEnd): FloatPose => {
    if (source === "measured") {
      return {
        x: round(end.xStuds),
        z: round(end.zStuds),
        angle: round(
          end.headingSteps * ZETA16_STEP_RADIANS + end.headingResidualDegrees / DEGREES_PER_RADIAN,
        ),
      };
    }
    if (end.coefficients === null) throw new Error("certified float algebra needs certified ends");
    const studs = zeta16ToStuds(decodeZeta16(end.coefficients));
    return {
      x: round(studs.x),
      z: round(studs.z),
      angle: round(end.headingSteps * ZETA16_STEP_RADIANS),
    };
  };
  return {
    identity: { x: 0, z: 0, angle: 0 },
    ends: (piece) => piece.relative.map(localEnd),
    attach: (local, target) => {
      const angle = wrap(round(round(target.angle + Math.PI) - local.angle));
      const [dx, dz] = rotate(angle, local.x, local.z);
      return { x: round(target.x - dx), z: round(target.z - dz), angle };
    },
    compose: (frame, local) => {
      const [dx, dz] = rotate(frame.angle, local.x, local.z);
      return {
        x: round(frame.x + dx),
        z: round(frame.z + dz),
        angle: wrap(round(frame.angle + local.angle)),
      };
    },
  };
}

const ALGEBRAS = {
  float64Measured: floatAlgebra((value) => value, "measured"),
  float64Certified: floatAlgebra((value) => value, "certified"),
  float32Certified: floatAlgebra(Math.fround, "certified"),
} as const;

type LayoutScript = <P>(layout: Layout<P>) => void;

function circleScript(part: string, laps: number): LayoutScript {
  return (layout) => {
    const first = layout.place(part, 0, undefined);
    let tip = at(first, 1);
    for (let piece = 1; piece < ZETA16_ORDER * laps; piece += 1) {
      tip = at(layout.place(part, 0, tip), 1);
    }
    layout.close(`after ${laps} lap(s), the last curve meets the first`, tip, at(first, 0));
  };
}

function straights<P>(layout: Layout<P>, count: number, from: P): P {
  let tip = from;
  for (let piece = 0; piece < count; piece += 1) tip = at(layout.place(STRAIGHT, 0, tip), 1);
  return tip;
}

function halfTurn<P>(layout: Layout<P>, from: P): P {
  let tip = from;
  for (let piece = 0; piece < CURVES_PER_HALF_TURN; piece += 1) {
    tip = at(layout.place(CURVE, 0, tip), 1);
  }
  return tip;
}

function ovalWithPassingSiding(pieces: ReadonlyMap<string, MeasuredPiece>): LayoutScript {
  const right = measuredPiece(pieces, RIGHT_SWITCH);
  const left = measuredPiece(pieces, LEFT_SWITCH);
  return (layout) => {
    const first = layout.place(RIGHT_SWITCH, 0, undefined);
    let siding = at(layout.place(CURVE, 1, at(first, switchEndIndex(right, "diverging"))), 0);
    siding = straights(layout, SIDING_STRAIGHTS, siding);
    siding = at(layout.place(CURVE, 1, siding), 0);
    const second = layout.place(LEFT_SWITCH, switchEndIndex(left, "diverging"), siding);
    const main = straights(
      layout,
      SIDING_STRAIGHTS + MAIN_EXTRA_STRAIGHTS,
      at(first, switchEndIndex(right, "straight")),
    );
    layout.close(
      "main line meets the second switch's straight route",
      main,
      at(second, switchEndIndex(left, "straight")),
    );
    let loop = halfTurn(layout, at(second, 0));
    loop = straights(layout, SIDING_STRAIGHTS + RETURN_EXTRA_STRAIGHTS, loop);
    loop = halfTurn(layout, loop);
    layout.close("loop returns to the first switch's entry", loop, at(first, 0));
  };
}

function run<P>(
  algebra: PoseAlgebra<P>,
  pieces: ReadonlyMap<string, MeasuredPiece>,
  script: LayoutScript,
): Layout<P> {
  const layout = new Layout(algebra, pieces);
  script(layout);
  return layout;
}

function significant(value: number): number {
  return Number(value.toPrecision(SIGNIFICANT_DIGITS));
}

function floatClosureError(closure: Closure<FloatPose>): {
  readonly gapLdu: number;
  readonly headingErrorDegrees: number;
} {
  const mismatch = closure.open.angle - closure.target.angle - Math.PI;
  const wrapped = mismatch - FULL_TURN * Math.round(mismatch / FULL_TURN);
  return {
    gapLdu: significant(
      Math.hypot(closure.open.x - closure.target.x, closure.open.z - closure.target.z) * STUD_LDU,
    ),
    headingErrorDegrees: significant(Math.abs(wrapped) * DEGREES_PER_RADIAN),
  };
}

function exactJoinCensus(ends: ReadonlyArray<Pose16>): {
  readonly ends: number;
  readonly joins: number;
  readonly openEnds: number;
  readonly endsWithSeveralPartners: number;
} {
  const partners = ends.map(
    (end, index) => ends.filter((other, j) => j !== index && posesJoin16(end, other)).length,
  );
  return {
    ends: ends.length,
    joins: partners.reduce((sum, count) => sum + count, 0) / 2,
    openEnds: partners.filter((count) => count === 0).length,
    endsWithSeveralPartners: partners.filter((count) => count > 1).length,
  };
}

function partCounts(placements: ReadonlyArray<Placed<unknown>>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { part } of placements) counts[part] = (counts[part] ?? 0) + 1;
  return counts;
}

function closureReport(
  pieces: ReadonlyMap<string, MeasuredPiece>,
  script: LayoutScript,
  census: boolean,
): object {
  const exact = run(exactAlgebra, pieces, script);
  const floats = Object.entries(ALGEBRAS).map(
    ([name, algebra]) => [name, run(algebra, pieces, script).closures] as const,
  );
  return {
    pieces: partCounts(exact.placements),
    ...(census ? { exactJoins: exactJoinCensus(exact.ends) } : {}),
    closures: exact.closures.map((closure, index) => ({
      label: closure.label,
      exactJoin: posesJoin16(closure.open, closure.target),
      exactOpenEnd: closure.open,
      ...Object.fromEntries(
        floats.map(([name, closures]) => [name, floatClosureError(at(closures, index))]),
      ),
    })),
  };
}

function uncertifiedCircle(pieces: ReadonlyMap<string, MeasuredPiece>): object {
  const piece = measuredPiece(pieces, PLASTIC_CURVE);
  const float = run(ALGEBRAS.float64Measured, pieces, circleScript(PLASTIC_CURVE, 1));
  return {
    pieces: partCounts(float.placements),
    certifiedEnds: piece.relative.map((end) => end.fieldCertified),
    candidatesPerEnd: piece.relative.map((end) => end.fieldSearch?.solutionCount ?? 0),
    exact: "refused: no certified ℤ[ζ₁₆] pose, so no exact join can be claimed",
    float64Measured: floatClosureError(at(float.closures, 0)),
  };
}

export function trackLoopReport(
  library: LdrawLibrary,
  markers: ReadonlyArray<TrackEndMarker>,
): object {
  const pieces = measurePieces(library, markers);
  return {
    method:
      "Every piece is placed by attaching one of its ends to the previous open end. exactJoin composes the certified ℤ[ζ₁₆] poses (@brr/math attachPose16/composePose16) and tests posesJoin16: equal coefficients and headings 8 steps apart, no tolerance. float64Measured chains the measured LDraw decimals (positions and unrounded headings) in float64. float64Certified and float32Certified evaluate the same certified poses with cos/sin in float64 and float32. Gaps are in LDU at the closing joint.",
    layouts: {
      "r40-circle-9v": closureReport(pieces, circleScript(CURVE, 1), true),
      "oval-passing-siding-9v": closureReport(pieces, ovalWithPassingSiding(pieces), true),
    },
    driftProbe: Object.fromEntries(
      DRIFT_LAPS.map((laps) => [
        `${CURVE} x${ZETA16_ORDER * laps}`,
        closureReport(pieces, circleScript(CURVE, laps), false),
      ]),
    ),
    uncertified: { [`${PLASTIC_CURVE}-circle`]: uncertifiedCircle(pieces) },
  };
}

function scenePlacement(piece: MeasuredPiece, frame: Pose16): ScenePlacement {
  const angle = frame.heading * ZETA16_STEP_RADIANS - entryInwardAngle(piece.entry);
  const rotation = rotationY(angle);
  const origin = zeta16ToStuds(frame.position);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    part: piece.part,
    transform: translated(
      rotation,
      origin.x * STUD_LDU - (cos * piece.entry.x - sin * piece.entry.z),
      origin.z * STUD_LDU - (sin * piece.entry.x + cos * piece.entry.z),
    ),
  };
}

function exactScene(
  library: LdrawLibrary,
  markers: ReadonlyArray<TrackEndMarker>,
  title: string,
  script: (pieces: ReadonlyMap<string, MeasuredPiece>) => LayoutScript,
): string {
  const pieces = measurePieces(library, markers);
  const layout = run(exactAlgebra, pieces, script(pieces));
  return toLdraw(
    title,
    "placed from exact ℤ[ζ₁₆] track-end poses (@brr/math)",
    layout.placements.map(({ part, frame }) => scenePlacement(measuredPiece(pieces, part), frame)),
  );
}

export function r40CircleScene(
  library: LdrawLibrary,
  markers: ReadonlyArray<TrackEndMarker>,
): string {
  return exactScene(library, markers, "R40 Circle 9V", () => circleScript(CURVE, 1));
}

export function ovalPassingSidingScene(
  library: LdrawLibrary,
  markers: ReadonlyArray<TrackEndMarker>,
): string {
  return exactScene(library, markers, "Oval Passing Siding 9V", ovalWithPassingSiding);
}
