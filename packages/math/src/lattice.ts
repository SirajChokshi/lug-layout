export function isLatticePose(x: number, z: number, yPlates: number): boolean {
  return Number.isInteger(x) && Number.isInteger(z) && Number.isInteger(yPlates);
}
