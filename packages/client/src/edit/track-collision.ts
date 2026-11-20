import { NO_OBSTACLE, TrackClearance, type ClearanceExcuse } from "@brr/domain";
import { RECT_FLOATS } from "./track-obstacles.ts";

export const OBSTACLE_TRACK = 0;
export const OBSTACLE_PART = 1;

export type Obstacle =
  | { readonly kind: "track"; readonly placement: number }
  | { readonly kind: "part"; readonly rect: number };

export type ObstacleExcuse = (kind: number, ref: number) => boolean;

export interface PlacedTrackOutline {
  readonly placement: number;
  readonly outline: Float64Array;
}

export const NOTHING_EXCUSED: ObstacleExcuse = () => false;
export const RECT_OUTLINE_FLOATS = 8;

export function rectOutlineInto(out: Float64Array, rects: ArrayLike<number>, at: number): void {
  const minX = rects[at] ?? 0;
  const minZ = rects[at + 1] ?? 0;
  const maxX = rects[at + 2] ?? 0;
  const maxZ = rects[at + 3] ?? 0;
  out[0] = minX;
  out[1] = minZ;
  out[2] = maxX;
  out[3] = minZ;
  out[4] = maxX;
  out[5] = maxZ;
  out[6] = minX;
  out[7] = maxZ;
}

export class TrackCollisionField {
  readonly clearance = new TrackClearance();
  readonly tracks: number;
  private readonly kinds: Uint8Array;
  private readonly refs: Int32Array;
  private readonly ids: Int32Array;
  private excuse: ObstacleExcuse = NOTHING_EXCUSED;
  private readonly excused: ClearanceExcuse = (id) =>
    this.excuse(this.kinds[id] ?? OBSTACLE_TRACK, this.refs[id] ?? NO_OBSTACLE);

  constructor(
    placements: number,
    tracks: ReadonlyArray<PlacedTrackOutline>,
    partRects: Float64Array,
  ) {
    this.tracks = tracks.length;
    const count = tracks.length + partRects.length / RECT_FLOATS;
    this.kinds = new Uint8Array(count);
    this.refs = new Int32Array(count);
    this.ids = new Int32Array(placements).fill(NO_OBSTACLE);
    for (const { placement, outline } of tracks) {
      const id = this.clearance.add(outline);
      this.kinds[id] = OBSTACLE_TRACK;
      this.refs[id] = placement;
      this.ids[placement] = id;
    }
    for (let r = 0; r < partRects.length; r += RECT_FLOATS) {
      const id = this.clearance.addRect(
        partRects[r] ?? 0,
        partRects[r + 1] ?? 0,
        partRects[r + 2] ?? 0,
        partRects[r + 3] ?? 0,
      );
      this.kinds[id] = OBSTACLE_PART;
      this.refs[id] = r / RECT_FLOATS;
    }
  }

  idOf(placement: number): number {
    return this.ids[placement] ?? NO_OBSTACLE;
  }

  firstHit(
    outline: Float64Array,
    box: Float64Array,
    boxAt: number,
    excuse: ObstacleExcuse,
  ): Obstacle | null {
    this.excuse = excuse;
    const id = this.clearance.firstBlocker(outline, box, boxAt, 0, 0, this.excused);
    this.excuse = NOTHING_EXCUSED;
    if (id === NO_OBSTACLE) return null;
    const ref = this.refs[id] ?? NO_OBSTACLE;
    return this.kinds[id] === OBSTACLE_PART
      ? { kind: "part", rect: ref }
      : { kind: "track", placement: ref };
  }
}
