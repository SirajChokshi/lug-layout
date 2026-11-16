export type Vec3 = readonly [number, number, number];

export type Affine = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const IDENTITY: Affine = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export function affineFromLdraw(values: ReadonlyArray<number>): Affine {
  const [x, y, z, a, b, c, d, e, f, g, h, i] = values;
  if (
    x === undefined ||
    y === undefined ||
    z === undefined ||
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined ||
    e === undefined ||
    f === undefined ||
    g === undefined ||
    h === undefined ||
    i === undefined
  ) {
    throw new Error(`type-1 line needs 12 numbers, got ${values.length}`);
  }
  return [a, b, c, d, e, f, g, h, i, x, y, z];
}

export function compose(outer: Affine, inner: Affine): Affine {
  const [a, b, c, d, e, f, g, h, i, x, y, z] = outer;
  const [p, q, r, s, t, u, v, w, k, tx, ty, tz] = inner;
  return [
    a * p + b * s + c * v,
    a * q + b * t + c * w,
    a * r + b * u + c * k,
    d * p + e * s + f * v,
    d * q + e * t + f * w,
    d * r + e * u + f * k,
    g * p + h * s + i * v,
    g * q + h * t + i * w,
    g * r + h * u + i * k,
    a * tx + b * ty + c * tz + x,
    d * tx + e * ty + f * tz + y,
    g * tx + h * ty + i * tz + z,
  ];
}

export function applyToPoint(m: Affine, [px, py, pz]: Vec3): Vec3 {
  const [a, b, c, d, e, f, g, h, i, x, y, z] = m;
  return [a * px + b * py + c * pz + x, d * px + e * py + f * pz + y, g * px + h * py + i * pz + z];
}

export function translationOf(m: Affine): Vec3 {
  return [m[9], m[10], m[11]];
}
