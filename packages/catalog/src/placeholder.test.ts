import { expect, it } from "vitest";
import { INHERIT_COLOR } from "./part-bundle.ts";
import { placeholderMesh } from "./placeholder.ts";

const MIN: [number, number, number] = [-10, -4, -20];
const MAX: [number, number, number] = [30, 24, 40];

function vertex(positions: Float32Array, index: number): readonly [number, number, number] {
  return [positions[index * 3] ?? 0, positions[index * 3 + 1] ?? 0, positions[index * 3 + 2] ?? 0];
}

it("draws a box exactly at the part's bounds, every triangle facing out, in the instance colour", () => {
  const { positions, normals, groups } = placeholderMesh(MIN, MAX);

  for (let axis = 0; axis < 3; axis++) {
    const values = Array.from(positions.filter((_, i) => i % 3 === axis));
    expect([Math.min(...values), Math.max(...values)]).toEqual([MIN[axis], MAX[axis]]);
  }
  expect(groups).toHaveLength(1);
  const [group] = groups;
  expect(group?.ldrawColor).toBe(INHERIT_COLOR);
  const indices = group?.indices ?? new Uint32Array(0);
  expect(indices).toHaveLength(36);
  const centre = MIN.map((low, axis) => (low + (MAX[axis] ?? 0)) / 2);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => vertex(positions, indices[t + k] ?? 0));
    if (!a || !b || !c) throw new Error("triangle is missing a vertex");
    const u = a.map((value, axis) => (b[axis] ?? 0) - value);
    const v = a.map((value, axis) => (c[axis] ?? 0) - value);
    const winding = [
      (u[1] ?? 0) * (v[2] ?? 0) - (u[2] ?? 0) * (v[1] ?? 0),
      (u[2] ?? 0) * (v[0] ?? 0) - (u[0] ?? 0) * (v[2] ?? 0),
      (u[0] ?? 0) * (v[1] ?? 0) - (u[1] ?? 0) * (v[0] ?? 0),
    ];
    const outward = a.map((value, axis) => value - (centre[axis] ?? 0));
    const stored = vertex(normals, indices[t] ?? 0);
    expect(winding.reduce((sum, w, axis) => sum + w * (stored[axis] ?? 0), 0)).toBeGreaterThan(0);
    expect(outward.reduce((sum, o, axis) => sum + o * (stored[axis] ?? 0), 0)).toBeGreaterThan(0);
  }
});
