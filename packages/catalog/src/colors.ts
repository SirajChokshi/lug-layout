const DIRECT_COLOR_MIN = 0x2000000;
const DIRECT_COLOR_MAX = 0x2ffffff;
const RGB_MASK = 0xffffff;
export const DIRECT_COLOR_ALPHA = 255;

export function isDirectColor(code: number): boolean {
  return Number.isInteger(code) && code >= DIRECT_COLOR_MIN && code <= DIRECT_COLOR_MAX;
}

export function directColorSrgb(code: number): number {
  return code & RGB_MASK;
}
