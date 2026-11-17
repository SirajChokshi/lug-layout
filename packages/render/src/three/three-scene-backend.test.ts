import { INHERIT_COLOR, type PartAsset, type PartMesh } from "@brr/catalog";
import { expect, it } from "vitest";
import type { ChunkInstances, PartPalette } from "../scene-backend.ts";
import { ThreeSceneBackend } from "./three-scene-backend.ts";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const RED = 4;
const NO_STUDS = {
  count: 0,
  primitiveIndex: new Uint8Array(0),
  colorIndex: new Uint16Array(0),
  matrices: new Float32Array(0),
};

function triangle(size: number): PartMesh {
  return {
    positions: Float32Array.of(0, 0, 0, size, 0, 0, 0, size, 0),
    normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1),
    groups: [{ ldrawColor: INHERIT_COLOR, indices: Uint32Array.of(0, 1, 2) }],
  };
}

function part(id: string, size: number): PartAsset {
  return {
    id,
    title: id,
    role: "detail",
    boundsMin: [0, 0, 0],
    boundsMax: [size, size, 0],
    producedColor: undefined,
    producedColors: [],
    trackEnds: undefined,
    baseplate: false,
    aliasOf: null,
    mesh: triangle(size),
    studPrimitiveIndex: new Uint8Array(0),
    studColors: new Uint16Array(0),
    studMatrices: new Float32Array(0),
    technic: null,
  };
}

function chunkOf(partIndex: number): ChunkInstances {
  return {
    originX: 0,
    originZ: 0,
    count: 1,
    partIndex: Uint16Array.of(partIndex),
    colorIndex: Uint16Array.of(0),
    matrices: Float32Array.from(IDENTITY),
    studs: NO_STUDS,
  };
}

function palette(parts: ReadonlyArray<PartAsset>): PartPalette {
  return {
    detailed: { parts, studPrimitives: [] },
    colorsSrgb: Uint8Array.of(200, 0, 0),
    colorsAlpha: Uint8Array.of(255),
    ldrawColors: new Map([[RED, { srgb: 0xc80000, alpha: 255 }]]),
  };
}

it("swaps meshes, far studs and far model meshes while chunks, a vehicle, a ghost and far models are on the scene", () => {
  const backend = new ThreeSceneBackend();
  backend.setPalette(palette([part("a", 20)]));
  backend.addParts([part("b", 40)]);
  backend.setChunk(1, chunkOf(0));
  backend.setChunk(2, chunkOf(1));
  backend.setVehicle(0, chunkOf(0));
  backend.setGhost(chunkOf(1));
  backend.placeGhost(0, 0, 0, 0);
  backend.setFarModel(7, {
    modelIndex: 0,
    originX: 0,
    originZ: 0,
    matrix: Float32Array.from(IDENTITY),
    chunkKeys: [1, 2],
  });

  backend.setPartMeshes([
    { index: 0, level: "detailed", part: part("a", 20) },
    { index: 1, level: "far", part: part("b", 40) },
  ]);
  backend.setFarStuds([]);
  backend.setPartMeshes([{ index: 1, level: "far", part: part("b", 40) }]);
  backend.setFarModelMesh(0, triangle(80));

  expect(() =>
    backend.setPartMeshes([{ index: 2, level: "detailed", part: part("c", 20) }]),
  ).toThrow("part 2 is not in the palette");
});
