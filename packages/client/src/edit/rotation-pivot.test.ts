import type { WorldBox } from "@brr/render";
import { expect, it } from "vitest";
import { quarterTurnAbout, rotationPivot } from "./selection.ts";

const GRID = 160;

function box(minX: number, minZ: number, maxX: number, maxZ: number): WorldBox {
  return { minX, minY: 0, minZ, maxX, maxY: 0, maxZ };
}

function turnedBox(footprint: WorldBox, grid: number): WorldBox {
  const pivot = rotationPivot(footprint, grid);
  const corners = [
    { x: footprint.minX, z: footprint.minZ, rot: 0 },
    { x: footprint.maxX, z: footprint.maxZ, rot: 0 },
  ].map((corner) => quarterTurnAbout(corner, pivot));
  const xs = corners.map((corner) => corner.x);
  const zs = corners.map((corner) => corner.z);
  return box(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs));
}

function onGrid(value: number, grid: number): boolean {
  return Number.isInteger(value / grid);
}

it.each([
  ["a square centred on a grid point", box(-320, -320, 320, 320)],
  ["a square centred on a half-grid point", box(-640, 0, 0, 640)],
  ["a square with an odd number of grid cells", box(0, 0, 480, 480)],
])("turns %s in place, edges still on the grid", (_, footprint) => {
  const turned = turnedBox(footprint, GRID);
  expect(turned).toEqual(footprint);
  for (const edge of [turned.minX, turned.minZ, turned.maxX, turned.maxZ]) {
    expect(onGrid(edge, GRID)).toBe(true);
  }
});

it("keeps a non-square footprint's edges on the grid, shifting its centre by at most one grid step", () => {
  const footprint = box(0, 0, 480, 320);
  const turned = turnedBox(footprint, GRID);
  for (const edge of [turned.minX, turned.minZ, turned.maxX, turned.maxZ]) {
    expect(onGrid(edge, GRID)).toBe(true);
  }
  const centreShift = Math.hypot(
    (turned.minX + turned.maxX - footprint.minX - footprint.maxX) / 2,
    (turned.minZ + turned.maxZ - footprint.minZ - footprint.maxZ) / 2,
  );
  expect(centreShift).toBeLessThanOrEqual(GRID);
});
