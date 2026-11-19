import { Mesh, Object3D } from "three/webgpu";
import { expect, it } from "vitest";
import {
  GHOST_EDGE_SLOT,
  NOT_A_PART,
  chunkEdgeSlot,
  edgeIdOf,
  packEdgeId,
  vehicleEdgeSlot,
  writeEdgeId,
} from "./edge-ids.ts";

const CHUNK = 640;
const EVERY_CHUNK_EDGE_SLOT = [0, 1, 2, 3, 4, 5, 6, 7, 8];

function neighbourhoodEdgeSlots(centreX: number, centreZ: number): number[] {
  const slots: number[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      slots.push(chunkEdgeSlot((centreX + dx) * CHUNK, (centreZ + dz) * CHUNK));
    }
  }
  return slots.toSorted((a, b) => a - b);
}

it("chunkEdgeSlot differs across every 3×3 neighbourhood of chunks, including negative origins", () => {
  for (const [x, z] of [
    [0, 0],
    [-1, -1],
    [-5, 7],
    [4, -2],
  ] as const) {
    expect(neighbourhoodEdgeSlots(x, z)).toEqual(EVERY_CHUNK_EDGE_SLOT);
  }
  expect([chunkEdgeSlot(-CHUNK, 0), chunkEdgeSlot(0, -CHUNK), chunkEdgeSlot(-1, -1)]).toEqual([
    2, 6, 8,
  ]);
});

it("vehicleEdgeSlot differs across any six consecutive vehicles, and from every chunkEdgeSlot and GHOST_EDGE_SLOT", () => {
  expect(Array.from({ length: 6 }, (_, i) => vehicleEdgeSlot(i))).toEqual([10, 11, 12, 13, 14, 15]);
  expect(Array.from({ length: 6 }, (_, i) => vehicleEdgeSlot(i + 7))).toEqual([
    11, 12, 13, 14, 15, 10,
  ]);
  expect(GHOST_EDGE_SLOT).toBe(9);
});

it("packs an ordinal and an edge slot into the mesh id and the instance offset", () => {
  expect([
    packEdgeId(0, 0),
    packEdgeId(1, 0),
    packEdgeId(0, 1),
    packEdgeId(1, 1),
    packEdgeId(0, 15),
    packEdgeId(200, 15),
  ]).toEqual([2048, 4096, 264320, 266368, 3936128, 151424]);
});

it("an object reads back the edge id written to it, and NOT_A_PART until one is", () => {
  const tagged = new Mesh();
  const untagged = new Object3D();

  writeEdgeId(tagged, 2, GHOST_EDGE_SLOT);

  expect([edgeIdOf(tagged), edgeIdOf(untagged)]).toEqual([2366592, NOT_A_PART]);
});
