import { NO_TRACK_CHANGE, type PlacementHandle } from "@brr/domain";
import type { BufferMemory, ChunkInstances, ISceneBackend, RebaseEvent } from "@brr/render";
import { IDENTIFICATION_ACCEPTED_DEVIATION_LDU, SIXTEENTHS_PER_LDU } from "@brr/math";
import { expect, it } from "vitest";
import { ColorTable } from "../scene/viewer-scene.ts";
import { fixtureBundleLoader } from "./fixture-model.test-support.ts";
import { modelPlaceable, partPlaceable, type Placeable } from "./placeable.ts";
import { PlacedChunks, type PlacedModel } from "./placed-chunks.ts";

const TILE_LDU = 640;
const HALF_TILE_LDU = TILE_LDU / 2;
const COVER_GRID_LDU = 80;
const COVER_HEIGHTS = 4;
const TILES = 2;
const STEPS = 160;
const SEEDS = [1, 2, 3, 4];
const REMOVE_CHANCE = 0.25;
const MAX_REMOVED = 3;
const SWAP_CHANCE = 0.1;
const RESHAPE_CHANCE = 0.3;
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

interface KillableHandle extends PlacementHandle {
  kill(): void;
}

function placementHandle(
  slot: number,
  refId: number,
  x: number,
  z: number,
  yPlates: number,
  rot: number,
): KillableHandle {
  let live = true;
  return {
    chunkKey: 0,
    slot,
    generation: 0,
    get live() {
      return live;
    },
    refId,
    colorId: 0,
    x,
    z,
    get yPlates() {
      if (!live) throw new Error(`placement handle (slot ${slot}) is stale`);
      return yPlates;
    },
    rot,
    kill() {
      live = false;
    },
  };
}

it("keeps every chunk equal to a fresh build of the same placements, whatever was added, removed or swapped beside it", async () => {
  const placeables = await baseplateAndCovers();
  for (const seed of SEEDS) {
    const random = seeded(seed);
    const current = [...placeables];
    const placeableOf = (refId: number) => current[refId] as Placeable;
    const recorder = new ChunkRecorder();
    const chunks = new PlacedChunks(recorder);
    const live: KillableHandle[] = [];
    let slot = 0;
    for (let step = 0; step < STEPS; step++) {
      const roll = random();
      if (live.length > 0 && roll < REMOVE_CHANCE) {
        const removed: KillableHandle[] = [];
        for (let k = 1 + Math.floor(random() * MAX_REMOVED); k > 0 && live.length > 0; k--) {
          const [handle] = live.splice(Math.floor(random() * live.length), 1);
          if (handle) removed.push(handle);
        }
        for (const handle of removed) handle.kill();
        chunks.apply(
          {
            kind: "remove",
            step: "do",
            changes: removed.map((handle) => ({
              placement: { handle: null },
              from: null,
              to: null,
              removed: handle,
              added: null,
            })),
            consists: [],
            track: NO_TRACK_CHANGE,
            plan: null,
            notes: null,
            event: null,
          },
          placeableOf,
        );
      } else if (roll < REMOVE_CHANCE + SWAP_CHANCE) {
        const refId = 1 + Math.floor(random() * 2);
        const previous = placeableOf(refId);
        const next =
          random() < RESHAPE_CHANCE
            ? { ...placeableOf(3 - refId) }
            : { ...previous, studsPending: !previous.studsPending };
        current[refId] = next;
        chunks.replacePlaceable(previous, next);
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
        const yPlates = refId === 0 ? 0 : Math.floor(random() * COVER_HEIGHTS);
        const handle = placementHandle(slot++, refId, x, z, yPlates, rot);
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
            plan: null,
            notes: null,
            event: null,
          },
          placeableOf,
        );
      }
      const freshRecorder = new ChunkRecorder();
      const fresh = new PlacedChunks(freshRecorder);
      fresh.addAll(
        live.map((handle) => ({
          placement: { handle },
          handle,
          placeable: placeableOf(handle.refId),
        })),
      );
      expect(recorder.chunks, `seed ${seed}, step ${step}`).toEqual(freshRecorder.chunks);
    }
  }
}, 120_000);

function identified(ldu: number): number {
  const sixteenths = ldu * SIXTEENTHS_PER_LDU;
  const whole = Math.round(sixteenths);
  return Math.abs(sixteenths - whole) <= IDENTIFICATION_ACCEPTED_DEVIATION_LDU * SIXTEENTHS_PER_LDU
    ? whole / SIXTEENTHS_PER_LDU
    : ldu;
}

it("finds the highest part top over a point, the parts meeting a plan rectangle and the models over a box exactly as a scan of every part box does, at every turn", async () => {
  const placeables = [
    await fixtureModelPlaceable("switch-then-reversed-curve"),
    await fixtureModelPlaceable(ROAD_PLATES),
  ];
  const chunks = new PlacedChunks(new ChunkRecorder());
  const handles = placeables.flatMap((_, refId) =>
    [0, 1, 2, 3].map((rot) =>
      placementHandle(refId * 4 + rot, refId, 700 * rot - 1020, 900 * refId + 340, rot, rot),
    ),
  );
  chunks.addAll(
    handles.map((handle) => ({
      placement: { handle },
      handle,
      placeable: placeables[handle.refId] as Placeable,
    })),
  );
  const models = chunks.models();
  const random = seeded(7);
  const probes: Array<readonly [number, number]> = [];
  for (const model of models) {
    const boxes = model.worldPartBoxes();
    for (let b = 0; b < boxes.length; b += 6) {
      const [minX = 0, , minZ = 0, maxX = 0, , maxZ = 0] = boxes.subarray(b, b + 6);
      probes.push([minX, minZ], [maxX, maxZ], [minX, (minZ + maxZ) / 2], [maxX, minZ]);
    }
    const { box } = model;
    for (let k = 0; k < 40; k++) {
      probes.push([
        box.minX + random() * (box.maxX - box.minX),
        box.minZ + random() * (box.maxZ - box.minZ),
      ]);
    }
  }
  const found: PlacedModel[] = [];
  for (const [x, z] of probes) {
    const span = (1 + Math.floor(random() * 3)) * 20;
    const rect = {
      minX: x - span,
      maxX: x + span,
      minY: 0,
      maxY: 0,
      minZ: z - span,
      maxZ: z + span,
    };
    for (const box of [rect, { ...rect, minX: x, maxX: x, minZ: z, maxZ: z }]) {
      found.length = chunks.over(box, found);
      const overByScan = models.filter(
        (m) =>
          m.box.minX <= box.maxX &&
          box.minX <= m.box.maxX &&
          m.box.minZ <= box.maxZ &&
          box.minZ <= m.box.maxZ,
      );
      const at = `over ${x}, ${z}`;
      expect({ at, found: found.toSorted((a, b) => a.id - b.id) }).toEqual({
        at,
        found: overByScan,
      });
    }
    for (const model of models) {
      const boxes = model.worldPartBoxes();
      let top = Number.NEGATIVE_INFINITY;
      let meets = false;
      for (let b = 0; b < boxes.length; b += 6) {
        const [minX = 0, , minZ = 0, maxX = 0, maxY = 0, maxZ = 0] = boxes.subarray(b, b + 6);
        if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) top = Math.max(top, maxY);
        const inPlan =
          identified(minX) < rect.maxX &&
          identified(maxX) > rect.minX &&
          identified(minZ) < rect.maxZ &&
          identified(maxZ) > rect.minZ;
        if (inPlan) {
          meets = true;
        }
      }
      const at = `model ${model.id} at ${x}, ${z} ± ${span}`;
      const highest = Float64Array.of(Number.NEGATIVE_INFINITY);
      model.raiseToTopOver(x, z, highest);
      expect({ at, top: highest[0], meets: model.meetsInPlan(rect) }).toEqual({
        at,
        top,
        meets,
      });
    }
  }
}, 120_000);
