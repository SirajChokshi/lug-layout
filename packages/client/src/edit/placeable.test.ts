import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
  type PartAsset,
} from "@brr/catalog";
import { STUD_LDU } from "@brr/math";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { ColorTable } from "../scene/viewer-scene.ts";
import { partPlaceable } from "./placeable.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const BASEPLATE = "ldraw:3811";
const ORIGIN_OFF_CENTRE_LDU = 8 * STUD_LDU;

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

it("puts a standalone baseplate's cells under its drawn outline when the part's origin is off the outline centre", async () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const bundle = await container
    .get(PART_BUNDLE_LOADER)
    .load("standard", (part) => part.id === BASEPLATE);
  const [plate] = bundle.parts;
  if (!plate) throw new Error(`the bundle has no ${BASEPLATE}`);
  const offCentre: PartAsset = {
    ...plate,
    boundsMin: [
      plate.boundsMin[0] + ORIGIN_OFF_CENTRE_LDU,
      plate.boundsMin[1],
      plate.boundsMin[2] + ORIGIN_OFF_CENTRE_LDU,
    ],
    boundsMax: [
      plate.boundsMax[0] + ORIGIN_OFF_CENTRE_LDU,
      plate.boundsMax[1],
      plate.boundsMax[2] + ORIGIN_OFF_CENTRE_LDU,
    ],
  };
  const color = bundle.colors[0];
  if (!color) throw new Error("the bundle has no colours");
  const placeable = partPlaceable(
    offCentre,
    0,
    color.code,
    color.name,
    [offCentre],
    new ColorTable(bundle),
    plate.boundsMin[1],
  );
  const { ground, cells } = placeable;
  if (!ground) throw new Error("a baseplate part seats on its own outline");
  expect(placeable.frameShift[0]).toBe(-ORIGIN_OFF_CENTRE_LDU);
  expect({
    minX: cells.cellX0 * STUD_LDU,
    maxX: (cells.cellX0 + cells.width) * STUD_LDU,
    minZ: cells.cellZ0 * STUD_LDU,
    maxZ: (cells.cellZ0 + cells.depth) * STUD_LDU,
  }).toEqual({ minX: ground.minX, maxX: ground.maxX, minZ: ground.minZ, maxZ: ground.maxZ });
});
