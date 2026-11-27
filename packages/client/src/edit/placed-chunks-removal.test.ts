import { ASSET_FETCHER, PART_BUNDLE_LOADER, type IAssetFetcher } from "@brr/catalog";
import { EditHistory, World, type PlacementRef } from "@brr/domain";
import {
  SCENE_BACKEND,
  type BufferMemory,
  type ISceneBackend,
  type RebaseEvent,
} from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { ColorTable } from "../scene/viewer-scene.ts";
import { partPlaceable } from "./placeable.ts";
import { PlacedChunks } from "./placed-chunks.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const BASEPLATE = "ldraw:3811";
const ROW_Z = 320;

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

class NullBackend implements ISceneBackend {
  async init(): Promise<never> {
    throw new Error("not used");
  }
  setPalette(): void {}
  addParts(): void {}
  setPartMeshes(): void {}
  setFarStuds(): void {}
  setFarModelMesh(): void {}
  setColors(): void {}
  setChunk(): void {}
  deleteChunk(): void {}
  setNeededMeshListener(): void {}
  setGhost(): void {}
  placeGhost(): void {}
  setGhostVerdict(): void {}
  setSelectionBoxes(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setGround(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  deleteVehicle(): void {}
  setIssueBoxes(): void {}
  setGuides(): void {}
  setNoteShapes(): void {}
  projectToNdc(): void {}
  rayThrough(): void {}
  setView(): void {}
  resize(): void {}
  renderFrame(): void {}
  needsFrame(): boolean {
    return true;
  }
  async waitForGpu(): Promise<void> {}
  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return [];
  }
  bufferMemory(): BufferMemory {
    return { vertexIndexBytes: 0, otherBytes: 0 };
  }
  forceTier(): void {}
  setFarModel(): void {}
}

it("removes, in one edit, two placements whose columns share a chunk", async () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  container.rebind(SCENE_BACKEND).toConstantValue(new NullBackend());
  const bundle = await container
    .get(PART_BUNDLE_LOADER)
    .load("standard", (part) => part.id === BASEPLATE);
  const index = bundle.parts.findIndex((part) => part.id === BASEPLATE);
  const part = bundle.parts[index];
  const color = part?.producedColor;
  if (!part || color === undefined) throw new Error(`${BASEPLATE} has no produced colour`);
  const placeable = partPlaceable(
    part,
    index,
    color,
    String(color),
    bundle.parts,
    new ColorTable(bundle),
    bundle.tablePlane.depthBelowTopLdu,
  );
  const history = new EditHistory(new World());
  const placed = new PlacedChunks(new NullBackend());
  const placeAt = (x: number): PlacementRef | null => {
    const edit = history.place({ refId: index, colorId: color, x, z: ROW_Z, yPlates: 0, rot: 0 });
    placed.apply(edit, () => placeable);
    return edit.changes[0]?.placement ?? null;
  };
  const west = placeAt(0);
  const east = placeAt(640);

  const both = history.commit("remove", [
    { placement: west, to: null },
    { placement: east, to: null },
  ]);

  expect(() => placed.apply(both, () => placeable)).not.toThrow();
  expect(placed.models()).toEqual([]);
});
