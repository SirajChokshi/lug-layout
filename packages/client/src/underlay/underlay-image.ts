const PNG_SIGNATURE: ReadonlyArray<number> = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE: ReadonlyArray<number> = [0xff, 0xd8, 0xff];

export const NOT_AN_UNDERLAY_IMAGE = "is not a PNG or JPEG image";

export type UnderlayImageType = "image/png" | "image/jpeg";

function startsWith(bytes: Uint8Array, signature: ReadonlyArray<number>): boolean {
  return signature.every((byte, i) => bytes[i] === byte);
}

export function underlayImageType(bytes: Uint8Array): UnderlayImageType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  return startsWith(bytes, JPEG_SIGNATURE) ? "image/jpeg" : null;
}
