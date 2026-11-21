import {
  HALF_TURN_16,
  STUD_LDU,
  ZETA16_COEFFICIENT_COUNT,
  ZETA16_ORDER,
  normalizeHeading16,
  rotateZeta16,
  zeta16ToStuds,
  type Zeta16,
} from "@brr/math";
import type { DrawingKit } from "./drawing-kit.ts";
import {
  OUTLINE_BOX_FLOATS,
  boxesOverlap,
  outlineBox,
  outlinesOverlap,
  rotateOutline,
  type TrackClearance,
} from "./track-clearance.ts";
import type { TrackMove, TrackPieceDef } from "./track-pose.ts";

const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;

export interface MoveFrame {
  readonly move: TrackMove;
  readonly delta: Float64Array;
  readonly turn: number;
  readonly lengthLdu: number;
  readonly exitX: Float64Array;
  readonly exitZ: Float64Array;
  readonly outlines: ReadonlyArray<Float64Array>;
  readonly boxes: Float64Array;
}

const BASIS_X = Float64Array.from({ length: ZETA16_COEFFICIENT_COUNT }, (_v, k) =>
  Math.cos(k * HEADING_RADIANS),
);
const BASIS_Z = Float64Array.from({ length: ZETA16_COEFFICIENT_COUNT }, (_v, k) =>
  Math.sin(k * HEADING_RADIANS),
);

export function coefficientNumbers(value: Zeta16): Float64Array {
  return Float64Array.from(value, (c) => Number(c));
}

export function coefficientsLdu(coefficients: Float64Array): readonly [number, number] {
  let x = 0;
  let z = 0;
  for (let k = 0; k < ZETA16_COEFFICIENT_COUNT; k++) {
    x += (coefficients[k] ?? 0) * (BASIS_X[k] ?? 0);
    z += (coefficients[k] ?? 0) * (BASIS_Z[k] ?? 0);
  }
  return [x * STUD_LDU, z * STUD_LDU];
}

export function addRotated(
  delta: Float64Array,
  steps: number,
  out: Float64Array,
  sign: number,
): void {
  const turns = normalizeHeading16(steps);
  for (let power = 0; power < ZETA16_COEFFICIENT_COUNT; power++) {
    const source = power - turns;
    let value: number;
    if (source >= 0) value = delta[source] ?? 0;
    else if (source + ZETA16_COEFFICIENT_COUNT >= 0) {
      value = -(delta[source + ZETA16_COEFFICIENT_COUNT] ?? 0);
    } else value = delta[source + ZETA16_ORDER] ?? 0;
    out[power] = (out[power] ?? 0) + sign * value;
  }
}

function arcLengthLdu(move: TrackMove): number {
  const studs = zeta16ToStuds(move.delta);
  const chord = Math.hypot(studs.x, studs.z) * STUD_LDU;
  const steps = Math.min(move.turn, ZETA16_ORDER - move.turn);
  if (steps === 0) return chord;
  const angle = steps * HEADING_RADIANS;
  return (chord * angle) / (2 * Math.sin(angle / 2));
}

export class KitOutlines {
  readonly frames: ReadonlyArray<MoveFrame>;
  readonly maxLengthLdu: number;
  readonly minLengthLdu: number;
  readonly maxStepLdu: number;
  private readonly shifted = new Float64Array(OUTLINE_BOX_FLOATS);

  constructor(
    readonly kit: DrawingKit,
    outlineOf: (piece: TrackPieceDef) => Float64Array,
  ) {
    this.frames = [kit.straight, kit.left, kit.right].map((move) =>
      this.frameOf(move, outlineOf(move.piece)),
    );
    this.maxLengthLdu = Math.max(...this.frames.map((f) => f.lengthLdu));
    this.minLengthLdu = Math.min(...this.frames.map((f) => f.lengthLdu));
    this.maxStepLdu = Math.max(
      ...this.frames.map((f) => {
        const studs = zeta16ToStuds(f.move.delta);
        return Math.hypot(studs.x, studs.z) * STUD_LDU;
      }),
    );
  }

  private frameOf(move: TrackMove, outline: Float64Array): MoveFrame {
    const entry = move.piece.connectors[move.from];
    if (!entry) throw new RangeError(`${move.piece.id} has no connector ${move.from}`);
    const outlines: Float64Array[] = [];
    const boxes = new Float64Array(ZETA16_ORDER * OUTLINE_BOX_FLOATS);
    const exitX = new Float64Array(ZETA16_ORDER);
    const exitZ = new Float64Array(ZETA16_ORDER);
    for (let heading = 0; heading < ZETA16_ORDER; heading++) {
      const placementHeading = heading + HALF_TURN_16 - entry.heading;
      const offset = zeta16ToStuds(rotateZeta16(entry.position, placementHeading));
      const placed = rotateOutline(
        outline,
        placementHeading,
        -offset.x * STUD_LDU,
        -offset.z * STUD_LDU,
      );
      outlines.push(placed);
      outlineBox(placed, boxes, heading * OUTLINE_BOX_FLOATS);
      const exit = zeta16ToStuds(rotateZeta16(move.delta, heading));
      exitX[heading] = exit.x * STUD_LDU;
      exitZ[heading] = exit.z * STUD_LDU;
    }
    return {
      move,
      delta: coefficientNumbers(move.delta),
      turn: move.turn,
      lengthLdu: arcLengthLdu(move),
      exitX,
      exitZ,
      outlines,
      boxes,
    };
  }

  frameFor(move: TrackMove): MoveFrame {
    const frame = this.frames.find((f) => f.move === move);
    if (!frame) throw new Error(`${move.piece.id} is not a drawing-kit move`);
    return frame;
  }

  outline(frame: MoveFrame, heading: number): Float64Array {
    const outline = frame.outlines[heading];
    if (!outline) throw new RangeError(`no outline at heading ${heading}`);
    return outline;
  }

  blocker(
    clearance: TrackClearance,
    frame: MoveFrame,
    heading: number,
    x: number,
    z: number,
    exceptA: number,
    exceptB: number,
  ): number {
    return clearance.blocker(
      this.outline(frame, heading),
      frame.boxes,
      heading * OUTLINE_BOX_FLOATS,
      x,
      z,
      exceptA,
      exceptB,
    );
  }

  blockerBesideJoins(
    clearance: TrackClearance,
    joinedIn: TrackClearance,
    frame: MoveFrame,
    heading: number,
    x: number,
    z: number,
    exceptA: number,
    exceptB: number,
  ): number {
    return clearance.blockerBesideJoins(
      this.outline(frame, heading),
      frame.boxes,
      heading * OUTLINE_BOX_FLOATS,
      x,
      z,
      joinedIn,
      exceptA,
      exceptB,
    );
  }

  addTo(
    clearance: TrackClearance,
    frame: MoveFrame,
    heading: number,
    x: number,
    z: number,
  ): number {
    return clearance.add(rotateOutline(this.outline(frame, heading), 0, x, z));
  }

  meet(
    a: MoveFrame,
    aHeading: number,
    ax: number,
    az: number,
    b: MoveFrame,
    bHeading: number,
    bx: number,
    bz: number,
  ): boolean {
    const shifted = this.shifted;
    const bo = bHeading * OUTLINE_BOX_FLOATS;
    shifted[0] = (b.boxes[bo] ?? 0) + bx;
    shifted[1] = (b.boxes[bo + 1] ?? 0) + bz;
    shifted[2] = (b.boxes[bo + 2] ?? 0) + bx;
    shifted[3] = (b.boxes[bo + 3] ?? 0) + bz;
    if (!boxesOverlap(a.boxes, aHeading * OUTLINE_BOX_FLOATS, ax, az, shifted, 0)) return false;
    return outlinesOverlap(this.outline(a, aHeading), ax, az, this.outline(b, bHeading), bx, bz);
  }
}
