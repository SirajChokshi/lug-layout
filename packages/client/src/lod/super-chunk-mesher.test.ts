import { ASSET_FETCHER, PART_BUNDLE_LOADER, type IAssetFetcher } from "@brr/catalog";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { modelFrameShift } from "../edit/placeable.ts";
import { placedVoxels, type PlacedVoxels } from "./placed-voxels.ts";
import { SuperChunkMesher, type VoxelStamp } from "./super-chunk-mesher.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const STUD = 20;
const PLATE = 8;
const BASEPLATE_COLOR = 2;
const FAR_DEADLINE_MS = Number.POSITIVE_INFINITY;

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

function rotateStudCentre(x: number, z: number, rot: number): readonly [number, number] {
  switch (rot) {
    case 0:
      return [x, z];
    case 1:
      return [z, -x];
    case 2:
      return [-x, -z];
    case 3:
      return [-z, x];
    default:
      throw new Error(`rot ${rot}`);
  }
}

function key(x: number, yLdu: number, z: number): string {
  return `${x},${yLdu.toFixed(4)},${z}`;
}

function expectedCells(stamps: ReadonlyArray<VoxelStamp>): Map<string, number> {
  const cells = new Map<string, number>();
  for (const { voxels, x, z, yPlates, rot } of stamps) {
    for (let i = 0; i < voxels.count; i++) {
      const [cx, cz] = rotateStudCentre(
        (voxels.cellX[i] ?? 0) * STUD + STUD / 2,
        (voxels.cellZ[i] ?? 0) * STUD + STUD / 2,
        rot,
      );
      const y = (yPlates + (voxels.cellY[i] ?? 0)) * PLATE + voxels.yPhaseLdu;
      cells.set(
        key((x + cx - STUD / 2) / STUD, y, (z + cz - STUD / 2) / STUD),
        voxels.colorIndex[i] ?? 0,
      );
    }
  }
  return cells;
}

function cellsFromMesh(positions: Float32Array, colorIndex: Uint16Array): Map<string, number> {
  const events = new Map<string, Array<{ y: number; top: boolean; color: number }>>();
  for (let v = 0; v < positions.length / 3; v += 4) {
    const ys = [1, 4, 7, 10].map((k) => positions[v * 3 + k] ?? 0);
    if (!ys.every((y) => y === ys[0])) continue;
    const xs = [0, 3, 6, 9].map((k) => positions[v * 3 + k] ?? 0);
    const zs = [2, 5, 8, 11].map((k) => positions[v * 3 + k] ?? 0);
    const ax = (xs[1] ?? 0) - (xs[0] ?? 0);
    const az = (zs[1] ?? 0) - (zs[0] ?? 0);
    const bx = (xs[2] ?? 0) - (xs[0] ?? 0);
    const bz = (zs[2] ?? 0) - (zs[0] ?? 0);
    const top = az * bx - ax * bz > 0;
    for (let x = Math.min(...xs); x < Math.max(...xs); x += STUD) {
      for (let z = Math.min(...zs); z < Math.max(...zs); z += STUD) {
        const phase = ((((ys[0] ?? 0) % PLATE) + PLATE) % PLATE).toFixed(4);
        const column = `${x / STUD},${z / STUD},${phase}`;
        const list = events.get(column) ?? [];
        list.push({ y: ys[0] ?? 0, top, color: colorIndex[v] ?? 0 });
        events.set(column, list);
      }
    }
  }
  const cells = new Map<string, number>();
  for (const [column, list] of events) {
    const [x, z] = column.split(",").map(Number);
    const sorted = list.toSorted((a, b) => a.y - b.y || Number(a.top) - Number(b.top));
    for (let i = 0; i < sorted.length; i += 2) {
      const bottom = sorted[i];
      const top = sorted[i + 1];
      if (!bottom || !top || bottom.top || !top.top) throw new Error(`unpaired faces in ${column}`);
      const run = Math.round((top.y - bottom.y) / PLATE);
      for (let k = 0; k < run; k++) {
        cells.set(key(x ?? 0, bottom.y + k * PLATE, z ?? 0), k === run - 1 ? top.color : -1);
      }
    }
  }
  return cells;
}

it("meshes a super-chunk as exactly the union of its placed models' rotated voxel cells", async () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const loader = container.get(PART_BUNDLE_LOADER);
  const baseplate = (await loader.load("far", (part) => part.id === "ldraw:3811")).parts[0];
  if (!baseplate?.farVoxels) throw new Error("3811 has no far voxels");
  const sets = ["10264-1", "2150-1", "10190-1", "10133-1"];
  const models: PlacedVoxels[] = [];
  for (const name of sets) {
    const far = await loader.loadModel("far", name);
    const { lattice, cells } = far.model;
    if (!far.farMesh || !lattice || !cells) throw new Error(`${name} has no far mesh or lattice`);
    models.push(
      placedVoxels(far.farMesh.voxels, modelFrameShift(lattice, cells, cells.restY), (c) => c),
    );
  }
  const plate = placedVoxels(baseplate.farVoxels, [0, 0, 0], (c) =>
    c === 16 ? BASEPLATE_COLOR : c,
  );
  const stamps: VoxelStamp[] = [];
  models.forEach((voxels, index) => {
    for (const rot of [0, 1, 2, 3] as const) {
      const x = 700 + rot * 1100;
      const z = 700 + index * 1100;
      stamps.push({ voxels: plate, x, z, yPlates: 0, rot: 0 });
      stamps.push({ voxels, x, z, yPlates: 0, rot });
    }
  });

  const mesher = new SuperChunkMesher();
  mesher.begin(0, 0, stamps, 0);
  mesher.step(FAR_DEADLINE_MS);
  const mesh = mesher.finish();

  const expected = expectedCells(stamps);
  const actual = cellsFromMesh(mesh.positions, mesh.colorIndex);
  expect(actual.size).toBe(expected.size);
  const missing = [...expected.keys()].filter((k) => !actual.has(k));
  expect(missing).toEqual([]);
  const wrongTopColor = [...actual].filter(([k, color]) => color >= 0 && color !== expected.get(k));
  expect(wrongTopColor).toEqual([]);
});
