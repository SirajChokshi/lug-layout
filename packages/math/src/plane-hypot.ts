export function planeHypot(dx: number, dz: number): number {
  const x = Math.abs(dx);
  const z = Math.abs(dz);
  if (x === Infinity) return x;
  if (z === Infinity) return z;
  if (Number.isNaN(x) || Number.isNaN(z)) return x + z;
  const largest = x > z ? x : z;
  if (largest === 0) return largest;
  const a = x / largest;
  const b = z / largest;
  return Math.sqrt(a * a + b * b) * largest;
}
