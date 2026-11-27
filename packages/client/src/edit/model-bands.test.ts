import { NO_TRACK_CHANGE, type PlacementHandle } from "@brr/domain";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import type { BufferMemory, ISceneBackend, RebaseEvent } from "@brr/render";
import type { TrackCatalog } from "@brr/schema/bundle";
import { expect, it } from "vitest";
import { modelTrackEnds } from "../connect/model-track-ends.ts";
import { ColorTable } from "../scene/viewer-scene.ts";
import { fixtureBundleLoader } from "./fixture-model.test-support.ts";
import { BOX_FLOATS } from "./local-box.ts";
import { ModelBands } from "./model-bands.ts";
import { modelPlaceable, partPlaceable, type Placeable } from "./placeable.ts";
import { PlacedChunks, type PlacedModel } from "./placed-chunks.ts";
import { PlanReach } from "./plan-reach.ts";
import type { SupportBand } from "./track-bands.ts";
import {
  cellKey,
  sameSeats,
  seatsPending,
  trackObstacles,
  type StudSeats,
} from "./track-obstacles.ts";
import { RecordingPlanScene } from "./plan-scene.test-support.ts";

const SEEDS = [21, 22, 23, 24];
const STEPS = 90;
const QUERIES_PER_STEP = 3;
const WORLD_TILES = 3;
const TILE_LDU = 640;
const HALF_TILE_LDU = TILE_LDU / 2;
const COVER_GRID_LDU = 80;
const MOST_PLATES_UP = 4;
const BASEPLATE = "ldraw:3811";
const ROAD_PLATES = "road-plates";
const USER_BRICK = "brick-2x4";
const USER_BASEPLATE = "baseplate-3811";
const USER_TRACK = "switch-then-reversed-curve";
const BAND_REACHES = [8, 24, 48];
const MOST_REACH_BOXES = 3;
const REACH_BOX_LDU = 400;
const PLACE_CHANCE = 0.34;
const MOVE_CHANCE = 0.48;
const REMOVE_CHANCE = 0.6;
const SWAP_CHANCE = 0.7;
const RELOAD_CHANCE = 0.76;
const CATALOG_CHANCE = 0.82;
const WORLD_CHANCE = 0.88;
const EQUAL_VERSION_BAND = [0, 48] as const;
const WHOLE_BAND_CHANCE = 0.2;
const NOTHING_REACHED_CHANCE = 0.3;
const EVERYTHING_REACHED_CHANCE = 0.4;
const SAME_REACH_CHANCE = 0.6;
const BEYOND_EVERY_MODEL_LDU = 1_000_000;
const NO_PARTS: ReadonlySet<number> = new Set();
const NOTHING_REACHED = PlanReach.of(new Float64Array(0));
const EVERYTHING_REACHED = PlanReach.of(
  Float64Array.of(
    -BEYOND_EVERY_MODEL_LDU,
    -BEYOND_EVERY_MODEL_LDU,
    BEYOND_EVERY_MODEL_LDU,
    BEYOND_EVERY_MODEL_LDU,
  ),
);

class NoSceneBackend implements ISceneBackend {
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
  projectToNdc(): void {}
  rayThrough(): void {}
  setView(): void {}
  resize(): void {}
  renderFrame(): void {}
  needsFrame(): boolean {
    return false;
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

interface ModelPair {
  readonly pending: Placeable;
  readonly checked: Placeable;
  readonly carried: ReadonlySet<number>;
  readonly trackCatalog: TrackCatalog;
}

async function modelPair(name: string): Promise<ModelPair> {
  const { bundle, model, entry } = await fixtureBundleLoader().loadModel("standard", name);
  const placeable = (studCover: typeof model.studCover | null): Placeable =>
    modelPlaceable(
      `${entry.origin}:${name}`,
      name,
      name,
      { ...model, studCover },
      { name, source: entry.source, sections: model.sections },
      bundle.parts,
      new ColorTable(bundle),
      null,
    );
  const checked = placeable(model.studCover);
  const track = modelTrackEnds(checked.partTransforms, bundle.parts, bundle.trackCatalog);
  const carried = new Set(
    [...track.pieces, ...track.runs.flatMap((run) => run.pieces)].map((piece) => piece.instance),
  );
  return { pending: placeable(null), checked, carried, trackCatalog: bundle.trackCatalog };
}

async function baseplate(): Promise<Placeable> {
  const loader = fixtureBundleLoader();
  const index = await loader.loadIndex("standard");
  const part = index.catalogParts.find((catalogPart) => catalogPart.id === BASEPLATE);
  if (!part) throw new Error(`the fixture bundle has no ${BASEPLATE}`);
  const shape = await loader.loadPartShape("standard", part);
  const { bundle } = await loader.loadModel("standard", ROAD_PLATES);
  return partPlaceable(
    shape,
    0,
    shape.producedColors?.colors[0]?.ldraw ?? 0,
    "baseplate",
    [shape],
    new ColorTable(bundle),
    bundle.tablePlane.depthBelowTopLdu,
  );
}

interface LiveHandle extends PlacementHandle {
  kill(): void;
}

function liveHandle(
  slot: number,
  refId: number,
  x: number,
  z: number,
  yPlates: number,
  rot: number,
): LiveHandle {
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

class GeneratedWorld {
  readonly chunks = new PlacedChunks(new NoSceneBackend(), new RecordingPlanScene());
  readonly live: LiveHandle[] = [];

  constructor(private readonly placeableOf: (refId: number) => Placeable) {}

  place(handle: LiveHandle): void {
    this.live.push(handle);
    this.edit([], [handle]);
  }

  remove(handle: LiveHandle): void {
    this.live.splice(this.live.indexOf(handle), 1);
    handle.kill();
    this.edit([handle], []);
  }

  move(handle: LiveHandle, to: LiveHandle): void {
    this.live.splice(this.live.indexOf(handle), 1, to);
    handle.kill();
    this.edit([handle], [to]);
  }

  reload(): void {
    this.chunks.clear();
    this.chunks.addAll(
      this.live.map((handle) => ({
        placement: { handle },
        handle,
        placeable: this.placeableOf(handle.refId),
      })),
    );
  }

  private edit(removed: ReadonlyArray<LiveHandle>, added: ReadonlyArray<LiveHandle>): void {
    this.chunks.apply(
      {
        kind: "place",
        step: "do",
        changes: [
          ...removed.map((handle) => ({
            placement: { handle: null },
            from: null,
            to: null,
            removed: handle,
            added: null,
          })),
          ...added.map((handle) => ({
            placement: { handle: null },
            from: null,
            to: {
              refId: handle.refId,
              colorId: 0,
              x: handle.x,
              z: handle.z,
              yPlates: handle.yPlates,
              rot: handle.rot,
            },
            removed: null,
            added: handle,
          })),
        ],
        consists: [],
        track: NO_TRACK_CHANGE,
        plan: null,
        notes: null,
      },
      this.placeableOf,
    );
  }
}

function seatProbe(seats: StudSeats, models: ReadonlyArray<PlacedModel>): boolean[] {
  const probed: boolean[] = [];
  for (const model of models) {
    const boxes = model.worldPartBoxes();
    for (let b = 0; b < boxes.length; b += BOX_FLOATS) {
      const cellX1 = Math.ceil((boxes[b + 3] ?? 0) / STUD_LDU);
      const cellZ1 = Math.ceil((boxes[b + 5] ?? 0) / STUD_LDU);
      for (let cellZ = Math.floor((boxes[b + 2] ?? 0) / STUD_LDU); cellZ < cellZ1; cellZ++) {
        for (let cellX = Math.floor((boxes[b] ?? 0) / STUD_LDU); cellX < cellX1; cellX++) {
          probed.push(seats.has(cellKey(cellX, cellZ)));
        }
      }
    }
  }
  return probed;
}

function bandFacts(band: SupportBand, models: ReadonlyArray<PlacedModel>) {
  const { obstacles, pending } = band;
  return {
    rects: Array.from(obstacles.rects),
    owners: Array.from(obstacles.owners),
    unseated: Array.from(obstacles.unseated),
    outlines: obstacles.outlines.map((outline) => Array.from(outline)),
    outlineOwners: Array.from(obstacles.outlineOwners),
    labels: obstacles.labels,
    pending,
    seated: seatProbe(obstacles.seats, models),
  };
}

function heightsOf(models: ReadonlyArray<PlacedModel>): number[] {
  const heights = new Set<number>([0]);
  for (const model of models) {
    const boxes = model.worldPartBoxes();
    for (let b = 0; b < boxes.length; b += BOX_FLOATS) {
      heights.add(boxes[b + 1] ?? 0);
      heights.add(boxes[b + 4] ?? 0);
    }
  }
  return [...heights].toSorted((a, b) => a - b);
}

function randomReach(random: () => number): PlanReach {
  const count = 1 + Math.floor(random() * MOST_REACH_BOXES);
  const boxes = new Float64Array(count * 4);
  const span = WORLD_TILES * TILE_LDU;
  for (let k = 0; k < count; k++) {
    const x = random() * span - REACH_BOX_LDU;
    const z = random() * span - REACH_BOX_LDU;
    boxes.set([x, z, x + random() * REACH_BOX_LDU, z + random() * REACH_BOX_LDU], k * 4);
  }
  return PlanReach.of(boxes);
}

it("answers every band and every reach exactly as a fresh build over the same models, through placements, moves, removals, stud landings, reloads, a catalog arriving and a second world at the same version", async () => {
  const brick = await modelPair(USER_BRICK);
  const userBaseplate = await modelPair(USER_BASEPLATE);
  const carrier = await modelPair(USER_TRACK);
  const roadPlates = await modelPair(ROAD_PLATES);
  const pairs = [roadPlates, brick, userBaseplate, carrier];
  const carriedBy = new Map<Placeable, ReadonlySet<number>>();
  for (const pair of pairs) {
    carriedBy.set(pair.pending, pair.carried);
    carriedBy.set(pair.checked, pair.carried);
  }
  const plate = await baseplate();
  expect(carrier.carried.size).toBeGreaterThan(0);
  const seen = { pending: 0, carriedLeftOut: 0, reaching: 0, whole: 0 };

  for (const seed of SEEDS) {
    const random = seeded(seed);
    const current: Placeable[] = [plate, ...pairs.map((pair) => pair.pending)];
    const placeableOf = (refId: number): Placeable => {
      const placeable = current[refId];
      if (!placeable) throw new Error(`no placeable ${refId}`);
      return placeable;
    };
    let catalog: TrackCatalog | null = null;
    const trackParts = (model: PlacedModel): ReadonlySet<number> =>
      catalog === null ? NO_PARTS : (carriedBy.get(model.placeable) ?? NO_PARTS);
    const bands = new ModelBands(trackParts);
    const worlds = [new GeneratedWorld(placeableOf), new GeneratedWorld(placeableOf)];
    let slot = 0;
    let active = 0;
    let previousReach: PlanReach | null = null;
    const randomBand = (models: ReadonlyArray<PlacedModel>): readonly [number, number] => {
      const heights = heightsOf(models);
      const bottom = heights[Math.floor(random() * heights.length)] ?? 0;
      return [
        bottom,
        bottom + (BAND_REACHES[Math.floor(random() * BAND_REACHES.length)] ?? PLATE_LDU),
      ];
    };
    const randomlyReaching = (): PlanReach | null => {
      const pick = random();
      const reach =
        pick < WHOLE_BAND_CHANCE
          ? null
          : pick < NOTHING_REACHED_CHANCE
            ? NOTHING_REACHED
            : pick < EVERYTHING_REACHED_CHANCE
              ? EVERYTHING_REACHED
              : pick < SAME_REACH_CHANCE && previousReach
                ? previousReach
                : randomReach(random);
      previousReach = reach ?? previousReach;
      return reach;
    };
    const ask = (
      label: string,
      band: (models: ReadonlyArray<PlacedModel>) => readonly [number, number] = randomBand,
      reaching: () => PlanReach | null = randomlyReaching,
    ) => {
      const world = worlds[active];
      if (!world) throw new Error("no active world");
      const models = world.chunks.models();
      const range = band(models);
      const reach = reaching();
      const answered = bands.band(world.chunks, catalog, range, reach);
      const fresh = {
        obstacles: trackObstacles(
          models,
          range,
          trackParts,
          reach === null ? undefined : (model) => reach.reaches(model.box),
        ),
        pending: seatsPending(models, range),
      };
      expect(bandFacts(answered, models), `${label}`).toEqual(bandFacts(fresh, models));
      expect(sameSeats(answered.obstacles.seats, fresh.obstacles.seats), `${label}`).toBe(true);
      if (fresh.pending) seen.pending++;
      if (reach === null) seen.whole++;
      else seen.reaching++;
      if (
        catalog !== null &&
        models.some(
          (model) => model.placeable === carrier.pending || model.placeable === carrier.checked,
        )
      ) {
        seen.carriedLeftOut++;
      }
    };

    const first = worlds[0];
    const second = worlds[1];
    if (!first || !second) throw new Error("no worlds");
    first.place(liveHandle(slot++, 1, HALF_TILE_LDU, HALF_TILE_LDU, 0, 0));
    second.place(liveHandle(slot++, 2, HALF_TILE_LDU, HALF_TILE_LDU, 0, 0));
    expect(first.chunks.version).toBe(second.chunks.version);
    for (const reach of [null, EVERYTHING_REACHED]) {
      for (const world of [0, 1, 0, 1]) {
        active = world;
        ask(
          `seed ${seed}, equal versions, world ${world}`,
          () => EQUAL_VERSION_BAND,
          () => reach,
        );
      }
    }

    for (let step = 0; step < STEPS; step++) {
      const world = worlds[active];
      if (!world) throw new Error("no active world");
      const roll = random();
      const label = `seed ${seed}, step ${step}`;
      const target = world.live[Math.floor(random() * world.live.length)];
      if (roll < PLACE_CHANCE || !target) {
        const refId = Math.floor(random() * current.length);
        const x =
          Math.floor(random() * ((WORLD_TILES * TILE_LDU) / COVER_GRID_LDU)) * COVER_GRID_LDU;
        const z =
          Math.floor(random() * ((WORLD_TILES * TILE_LDU) / COVER_GRID_LDU)) * COVER_GRID_LDU;
        const yPlates = refId === 0 ? 0 : Math.floor(random() * MOST_PLATES_UP);
        const rot = refId === 0 ? 0 : Math.floor(random() * 4);
        world.place(liveHandle(slot++, refId, x, z, yPlates, rot));
      } else if (roll < MOVE_CHANCE) {
        const to = liveHandle(
          slot++,
          target.refId,
          target.x + COVER_GRID_LDU * (Math.floor(random() * 3) - 1),
          target.z + COVER_GRID_LDU * (Math.floor(random() * 3) - 1),
          target.refId === 0 ? 0 : Math.floor(random() * MOST_PLATES_UP),
          target.refId === 0 ? 0 : Math.floor(random() * 4),
        );
        world.move(target, to);
      } else if (roll < REMOVE_CHANCE) {
        world.remove(target);
      } else if (roll < SWAP_CHANCE) {
        const refId = 1 + Math.floor(random() * pairs.length);
        const pair = pairs[refId - 1];
        const previous = current[refId];
        if (!pair || !previous) throw new Error(`no pair ${refId}`);
        const next = previous === pair.pending ? pair.checked : pair.pending;
        current[refId] = next;
        for (const each of worlds) each.chunks.replacePlaceable(previous, next);
      } else if (roll < RELOAD_CHANCE) {
        world.reload();
      } else if (roll < CATALOG_CHANCE) {
        catalog = catalog === null ? carrier.trackCatalog : null;
      } else if (roll < WORLD_CHANCE) {
        active = 1 - active;
      }
      for (let query = 0; query < QUERIES_PER_STEP; query++) ask(`${label}, query ${query}`);
    }
  }

  expect(seen.pending).toBeGreaterThan(0);
  expect(seen.carriedLeftOut).toBeGreaterThan(0);
  expect(seen.whole).toBeGreaterThan(0);
  expect(seen.reaching).toBeGreaterThan(0);
}, 120_000);
