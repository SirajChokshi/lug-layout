export const RECT_STRIDE = 4;
export const PIECES_PER_CUT = 4;

export function growTo(buffer: Float64Array<ArrayBuffer>, floats: number): Float64Array<ArrayBuffer> {
  if (buffer.length >= floats) return buffer;
  return new Float64Array(Math.max(floats, buffer.length * 2));
}

export function subtractCut(
  from: Float64Array,
  fromCount: number,
  into: Float64Array,
  cuts: Float64Array,
  cut: number,
): number {
  const cMinX = cuts[cut] ?? Number.NaN;
  const cMinZ = cuts[cut + 1] ?? Number.NaN;
  const cMaxX = cuts[cut + 2] ?? Number.NaN;
  const cMaxZ = cuts[cut + 3] ?? Number.NaN;
  let at = 0;
  for (let p = 0; p < fromCount; p++) {
    const piece = p * RECT_STRIDE;
    const pMinX = from[piece] ?? Number.NaN;
    const pMinZ = from[piece + 1] ?? Number.NaN;
    const pMaxX = from[piece + 2] ?? Number.NaN;
    const pMaxZ = from[piece + 3] ?? Number.NaN;
    if (!(pMinX < cMaxX && cMinX < pMaxX && pMinZ < cMaxZ && cMinZ < pMaxZ)) {
      into[at] = pMinX;
      into[at + 1] = pMinZ;
      into[at + 2] = pMaxX;
      into[at + 3] = pMaxZ;
      at += RECT_STRIDE;
      continue;
    }
    if (pMinX < cMinX) {
      into[at] = pMinX;
      into[at + 1] = pMinZ;
      into[at + 2] = cMinX;
      into[at + 3] = pMaxZ;
      at += RECT_STRIDE;
    }
    if (cMaxX < pMaxX) {
      into[at] = cMaxX;
      into[at + 1] = pMinZ;
      into[at + 2] = pMaxX;
      into[at + 3] = pMaxZ;
      at += RECT_STRIDE;
    }
    const minX = pMinX > cMinX ? pMinX : cMinX;
    const maxX = pMaxX < cMaxX ? pMaxX : cMaxX;
    if (pMinZ < cMinZ) {
      into[at] = minX;
      into[at + 1] = pMinZ;
      into[at + 2] = maxX;
      into[at + 3] = cMinZ;
      at += RECT_STRIDE;
    }
    if (cMaxZ < pMaxZ) {
      into[at] = minX;
      into[at + 1] = cMaxZ;
      into[at + 2] = maxX;
      into[at + 3] = pMaxZ;
      at += RECT_STRIDE;
    }
  }
  return at / RECT_STRIDE;
}
