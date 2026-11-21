import { NO_TRACK_CHANGE, type PlacementHandle } from "@brr/domain";
import type { BufferMemory, ChunkInstances, ISceneBackend, RebaseEvent } from "@brr/render";
import { expect, it } from "vitest";
import { ColorTable } from "../scene/viewer-scene.ts";
import { fixtureBundleLoader } from "./fixture-model.test-support.ts";
import { modelPlaceable, partPlaceable, type Placeable } from "./placeable.ts";
import { PlacedChunks } from "./placed-chunks.ts";

const TILE_LDU = 640;
const HALF_TILE_LDU = TILE_LDU / 2;
const COVER_GRID_LDU = 80;
const TILES = 2;
const STEPS = 160;
const SEEDS = [1, 2, 3, 4];
const REMOVE_CHANCE = 0.3;
const BASEPLATE_CHANCE = 0.45;
const ROAD_PLATES_CHANCE = 0.45;
const BASEPLATE = "ldraw:3811";
const ROAD_PLATES = "road-plates";
const BASEPLATE_ROW = "baseplate-row";

class ChunkRecorder implements ISceneBackend {
  readonly chunks = new Map<number, ChunkInstances>();
  async init(): Promise<never> {
    throw new Error("not used");
  }
  setPalette(): void {}
  addParts(): void {}
  setPartMeshes(): void {}
  setFarStuds(): void {}
  setFarModelMesh(): void {}
  setColors(): void {}
  setChunk(key: number, chunk: ChunkInstances): void {
    this.chunks.set(key, chunk);
  }
  deleteChunk(key: number): void {
    this.chunks.delete(key);
  }
  setNeededMeshListener(): void {}
  setGhost(): void {}
  placeGhost(): void {}
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setGround(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  deleteVehicle(): void {}
  setIssueBoxes(): void {}
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

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

async function fixtureModelPlaceable(name: string): Promise<Placeable> {
  const { bundle, model, entry } = await fixtureBundleLoader().loadModel("standard", name);
  return modelPlaceable(
    `${entry.origin}:${name}`,
    name,
    name,
    model,
    { name, source: entry.source, sections: model.sections },
    bundle.parts,
    new ColorTable(bundle),
    null,
  );
}

async function baseplateAndCovers(): Promise<ReadonlyArray<Placeable>> {
  const loader = fixtureBundleLoader();
  const index = await loader.loadIndex("standard");
  const catalogBaseplate = index.catalogParts.find((part) => part.id === BASEPLATE);
  if (!catalogBaseplate) throw new Error(`the fixture bundle has no ${BASEPLATE}`);
  const baseplate = await loader.loadPartShape("standard", catalogBaseplate);
  const { bundle } = await loader.loadModel("standard", ROAD_PLATES);
  return [
    partPlaceable(
      baseplate,
      0,
      baseplate.producedColors?.colors[0]?.ldraw ?? 0,
      "baseplate",
      [baseplate],
      new ColorTable(bundle),
      bundle.tablePlane.depthBelowTopLdu,
    ),
    await fixtureModelPlaceable(ROAD_PLATES),
    await fixtureModelPlaceable(BASEPLATE_ROW),
  ];
}

function freshBuild(
  live: ReadonlyArray<PlacementHandle>,
  placeables: ReadonlyArray<Placeable>,
): ReadonlyMap<number, ChunkInstances> {
  const recorder = new ChunkRecorder();
  new PlacedChunks(recorder).addAll(
    live.map((handle) => ({
      placement: { handle },
      handle,
      placeable: placeables[handle.refId] as Placeable,
    })),
  );
  return recorder.chunks;
}

it("keeps every chunk equal to a fresh build of the same placements, whatever was added or removed beside it", async () => {
  const placeables = await baseplateAndCovers();
  const placeableOf = (refId: number) => placeables[refId] as Placeable;
  for (const seed of SEEDS) {
    const random = seeded(seed);
    const recorder = new ChunkRecorder();
    const chunks = new PlacedChunks(recorder);
    const live: PlacementHandle[] = [];
    let slot = 0;
    for (let step = 0; step < STEPS; step++) {
      if (live.length > 0 && random() < REMOVE_CHANCE) {
        const [handle] = live.splice(Math.floor(random() * live.length), 1);
        if (!handle) throw new Error("no placement to remove");
        chunks.apply(
          {
            kind: "remove",
            step: "do",
            changes: [
              { placement: { handle: null }, from: null, to: null, removed: handle, added: null },
            ],
            consists: [],
            track: NO_TRACK_CHANGE,
          },
          placeableOf,
        );
      } else {
        const pick = random();
        const refId =
          pick < BASEPLATE_CHANCE ? 0 : pick < BASEPLATE_CHANCE + ROAD_PLATES_CHANCE ? 1 : 2;
        const x =
          refId === 0
            ? Math.floor(random() * TILES) * TILE_LDU + HALF_TILE_LDU
            : Math.floor(random() * ((TILES * TILE_LDU) / COVER_GRID_LDU)) * COVER_GRID_LDU;
        const z =
          refId === 0
            ? Math.floor(random() * TILES) * TILE_LDU + HALF_TILE_LDU
            : Math.floor(random() * ((TILES * TILE_LDU) / COVER_GRID_LDU)) * COVER_GRID_LDU;
        const rot = refId === 0 ? 0 : Math.floor(random() * 4);
        const occupied = live.some((h) => h.refId === 0 && refId === 0 && h.x === x && h.z === z);
        if (occupied) continue;
        const yPlates = chunks.restingHeight(placeableOf(refId), x, z, rot, null);
        const handle: PlacementHandle = {
          chunkKey: 0,
          slot: slot++,
          generation: 0,
          live: true,
          refId,
          colorId: 0,
          x,
          z,
          yPlates,
          rot,
        };
        live.push(handle);
        chunks.apply(
          {
            kind: "place",
            step: "do",
            changes: [
              {
                placement: { handle: null },
                from: null,
                to: { refId, colorId: 0, x, z, yPlates, rot },
                removed: null,
                added: handle,
              },
            ],
            consists: [],
            track: NO_TRACK_CHANGE,
          },
          placeableOf,
        );
      }
      expect(recorder.chunks, `seed ${seed}, step ${step}`).toEqual(freshBuild(live, placeables));
    }
  }
}, 120_000);
