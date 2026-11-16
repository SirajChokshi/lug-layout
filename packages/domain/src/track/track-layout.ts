import {
  attachPose16,
  composePose16,
  pose16,
  zeta16,
  ZETA16_COEFFICIENT_COUNT,
  type Pose16,
} from "@brr/math";

export interface TrackRoute {
  readonly from: number;
  readonly to: number;
}

export interface TrackPieceSpec {
  readonly connectors: ReadonlyArray<Pose16>;
  readonly routes: ReadonlyArray<TrackRoute>;
}

export interface TrackEndRef {
  readonly placement: number;
  readonly connector: number;
}

const INITIAL_CAPACITY = 64;
const INT64_BITS = 64;
const INT16_MIN = -(2 ** 15);
const INT16_MAX = 2 ** 15 - 1;

function checkPiece(spec: TrackPieceSpec, index: number): void {
  const connectorCount = spec.connectors.length;
  if (connectorCount === 0) throw new Error(`track piece ${index} has no connectors`);
  for (const { from, to } of spec.routes) {
    const valid =
      Number.isInteger(from) &&
      Number.isInteger(to) &&
      from >= 0 &&
      to >= 0 &&
      from < connectorCount &&
      to < connectorCount &&
      from !== to;
    if (!valid)
      throw new Error(`track piece ${index} has route [${from}, ${to}] outside its connectors`);
  }
}

export class TrackLayout {
  private size = 0;
  private capacity = INITIAL_CAPACITY;
  private pieceOf = new Uint32Array(INITIAL_CAPACITY);
  private headingOf = new Uint8Array(INITIAL_CAPACITY);
  private yPlatesOf = new Int16Array(INITIAL_CAPACITY);
  private positionOf = new BigInt64Array(INITIAL_CAPACITY * ZETA16_COEFFICIENT_COUNT);

  constructor(readonly pieces: ReadonlyArray<TrackPieceSpec>) {
    pieces.forEach(checkPiece);
  }

  get count(): number {
    return this.size;
  }

  place(piece: number, placement: Pose16, yPlates: number): number {
    const spec = this.pieces[piece];
    if (!spec || !Number.isInteger(piece))
      throw new RangeError(`track piece ${piece} is not in the layout's piece table`);
    if (!Number.isInteger(yPlates) || yPlates < INT16_MIN || yPlates > INT16_MAX) {
      throw new RangeError(`track height ${yPlates} plates is not an int16`);
    }
    for (const coefficient of placement.position) {
      if (BigInt.asIntN(INT64_BITS, coefficient) !== coefficient) {
        throw new RangeError(`track position coefficient ${coefficient} does not fit int64 studs`);
      }
    }
    if (this.size === this.capacity) this.grow();
    const slot = this.size++;
    this.pieceOf[slot] = piece;
    this.headingOf[slot] = pose16(placement.position, placement.heading).heading;
    this.yPlatesOf[slot] = yPlates;
    this.positionOf.set(placement.position, slot * ZETA16_COEFFICIENT_COUNT);
    return slot;
  }

  attach(piece: number, connector: number, target: TrackEndRef): number {
    const local = this.pieces[piece]?.connectors[connector];
    if (!local) throw new RangeError(`track piece ${piece} has no connector ${connector}`);
    const placement = attachPose16(local, this.connectorPose(target.placement, target.connector));
    return this.place(piece, placement, this.yPlates(target.placement));
  }

  piece(placement: number): number {
    this.checkPlacement(placement);
    return this.pieceOf[placement] ?? 0;
  }

  yPlates(placement: number): number {
    this.checkPlacement(placement);
    return this.yPlatesOf[placement] ?? 0;
  }

  pose(placement: number): Pose16 {
    this.checkPlacement(placement);
    const offset = placement * ZETA16_COEFFICIENT_COUNT;
    return pose16(
      zeta16(Array.from(this.positionOf.subarray(offset, offset + ZETA16_COEFFICIENT_COUNT))),
      this.headingOf[placement] ?? 0,
    );
  }

  connectorPose(placement: number, connector: number): Pose16 {
    const local = this.pieces[this.piece(placement)]?.connectors[connector];
    if (!local) throw new RangeError(`placement ${placement} has no connector ${connector}`);
    return composePose16(this.pose(placement), local);
  }

  private checkPlacement(placement: number): void {
    if (!Number.isInteger(placement) || placement < 0 || placement >= this.size) {
      throw new RangeError(`track placement ${placement} does not exist`);
    }
  }

  private grow(): void {
    this.capacity *= 2;
    const pieceOf = new Uint32Array(this.capacity);
    pieceOf.set(this.pieceOf);
    this.pieceOf = pieceOf;
    const headingOf = new Uint8Array(this.capacity);
    headingOf.set(this.headingOf);
    this.headingOf = headingOf;
    const yPlatesOf = new Int16Array(this.capacity);
    yPlatesOf.set(this.yPlatesOf);
    this.yPlatesOf = yPlatesOf;
    const positionOf = new BigInt64Array(this.capacity * ZETA16_COEFFICIENT_COUNT);
    positionOf.set(this.positionOf);
    this.positionOf = positionOf;
  }
}
