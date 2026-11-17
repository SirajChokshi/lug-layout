import type { Vec3 } from "@brr/schema/bundle";
import {
  INHERIT_COLOR,
  type PartAsset,
  type PartMesh,
  type PartShapeAsset,
} from "./part-bundle.ts";

const FACES: ReadonlyArray<{ readonly axis: number; readonly sign: 1 | -1 }> = [
  { axis: 0, sign: 1 },
  { axis: 0, sign: -1 },
  { axis: 1, sign: 1 },
  { axis: 1, sign: -1 },
  { axis: 2, sign: 1 },
  { axis: 2, sign: -1 },
];
const CORNERS_PER_FACE = 4;
const QUAD_TRIANGLES = [0, 1, 2, 0, 2, 3] as const;

function component(v: Vec3, axis: number): number {
  return v[axis] ?? 0;
}

function faceCorners(axis: number, sign: 1 | -1, min: Vec3, max: Vec3): ReadonlyArray<Vec3> {
  const u = (axis + 1) % 3;
  const w = (axis + 2) % 3;
  const plane = component(sign > 0 ? max : min, axis);
  const corner = (a: number, b: number): Vec3 => {
    const point: [number, number, number] = [0, 0, 0];
    point[axis] = plane;
    point[u] = a;
    point[w] = b;
    return point;
  };
  const [u0, u1, w0, w1] = [
    component(min, u),
    component(max, u),
    component(min, w),
    component(max, w),
  ];
  const square = [corner(u0, w0), corner(u1, w0), corner(u1, w1), corner(u0, w1)];
  return sign > 0 ? square : square.toReversed();
}

export function placeholderMesh(min: Vec3, max: Vec3): PartMesh {
  const positions = new Float32Array(FACES.length * CORNERS_PER_FACE * 3);
  const normals = new Float32Array(positions.length);
  const indices = new Uint32Array(FACES.length * QUAD_TRIANGLES.length);
  FACES.forEach(({ axis, sign }, face) => {
    faceCorners(axis, sign, min, max).forEach((point, corner) => {
      const vertex = face * CORNERS_PER_FACE + corner;
      positions.set(point, vertex * 3);
      normals[vertex * 3 + axis] = sign;
    });
    QUAD_TRIANGLES.forEach((offset, i) => {
      indices[face * QUAD_TRIANGLES.length + i] = face * CORNERS_PER_FACE + offset;
    });
  });
  return { positions, normals, groups: [{ ldrawColor: INHERIT_COLOR, indices }] };
}

export function withPlaceholderMesh(shape: PartShapeAsset): PartAsset {
  return { ...shape, mesh: placeholderMesh(shape.boundsMin, shape.boundsMax) };
}
