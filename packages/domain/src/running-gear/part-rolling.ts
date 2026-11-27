import type { PartRolling, UnreadBand } from "@brr/schema/bundle";

export const NO_ROLLING_AXIS = -1;
const AT_COORDINATES = 2;
const ENDS = 2;

export type UnreadBandReason = UnreadBand["reason"];

export class PartRollingTable {
  private constructor(
    readonly surfaceCount: number,
    readonly axis: Uint8Array,
    readonly at: Int32Array,
    readonly from: Int32Array,
    readonly to: Int32Array,
    readonly radii: Int32Array,
    readonly unreadAxis: Int8Array,
    readonly unreadReason: ReadonlyArray<UnreadBandReason>,
  ) {}

  get unreadCount(): number {
    return this.unreadReason.length;
  }

  static fromRolling(rolling: PartRolling): PartRollingTable {
    const count = rolling.surfaces.length;
    const axis = new Uint8Array(count);
    const at = new Int32Array(count * AT_COORDINATES);
    const from = new Int32Array(count);
    const to = new Int32Array(count);
    const radii = new Int32Array(count * ENDS);
    for (let s = 0; s < count; s++) {
      const surface = rolling.surfaces[s];
      if (!surface) continue;
      axis[s] = surface.axis;
      at[s * AT_COORDINATES] = surface.at[0];
      at[s * AT_COORDINATES + 1] = surface.at[1];
      from[s] = surface.from;
      to[s] = surface.to;
      radii[s * ENDS] = surface.radii[0];
      radii[s * ENDS + 1] = surface.radii[1];
    }
    const unreadAxis = new Int8Array(rolling.unread.length);
    const unreadReason: UnreadBandReason[] = [];
    for (let u = 0; u < rolling.unread.length; u++) {
      const band = rolling.unread[u];
      if (!band) continue;
      unreadAxis[u] = band.reason === "unoriented" ? NO_ROLLING_AXIS : band.axis;
      unreadReason.push(band.reason);
    }
    return new PartRollingTable(count, axis, at, from, to, radii, unreadAxis, unreadReason);
  }
}
