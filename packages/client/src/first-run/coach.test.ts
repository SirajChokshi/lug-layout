import { ASSET_FETCHER } from "@brr/catalog";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ISceneBackend,
  type RebaseEvent,
} from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { TRACK_ITEM_ID } from "../edit/editor.ts";
import { SHIPPED_STARTER_LAYOUTS, type StarterLayout } from "../starters/starter-layouts.ts";
import { COACH, EDITOR, STARTER_LAYOUTS, TOUR_MEMORY } from "../tokens.ts";
import type { ITourMemory } from "./tour-memory.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const GROUND_LDU_PER_NDC = 2_000;
const EYE_HEIGHT_LDU = 1_000;

class BundleDirectoryFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

class TopDownBackend implements ISceneBackend {
  async init(): Promise<BackendInfo> {
    return { requestedApi: "webgl2", activeApi: "webgl2", adapter: "none", backgroundSrgb: 0 };
  }
  rayThrough(ndcX: number, ndcY: number, out: Float64Array): void {
    out.set([ndcX * GROUND_LDU_PER_NDC, EYE_HEIGHT_LDU, -ndcY * GROUND_LDU_PER_NDC, 0, -1, 0]);
  }
  setPalette(): void {}
  setChunk(): void {}
  deleteChunk(): void {}
  setGhost(): void {}
  placeGhost(): void {}
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  setIssueBoxes(): void {}
  setView(): void {}
  resize(): void {}
  renderFrame(): void {}
  async waitForGpu(): Promise<void> {}
  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return [];
  }
  bufferMemory(): BufferMemory {
    return { vertexIndexBytes: 0, otherBytes: 0 };
  }
}

class MemoryTourMemory implements ITourMemory {
  private seen = false;
  private done = false;

  visited(): boolean {
    return this.seen;
  }

  markVisited(): void {
    this.seen = true;
  }

  tourDone(): boolean {
    return this.done;
  }

  rememberTourDone(): void {
    this.done = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function startCoach(
  memory: ITourMemory = new MemoryTourMemory(),
  starters: ReadonlyArray<StarterLayout> = SHIPPED_STARTER_LAYOUTS,
) {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  container.rebind(SCENE_BACKEND).toConstantValue(new TopDownBackend());
  container.rebind(TOUR_MEMORY).toConstantValue(memory);
  container.rebind(STARTER_LAYOUTS).toConstantValue(starters);
  const editor = container.get(EDITOR);
  const coach = container.get(COACH);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1 });
  return { editor, coach };
}

it("walks the tour one step at a time, only when the user does each step, and celebrates the end", async () => {
  const { editor, coach } = await startCoach();
  const step = () => coach.snapshot().tour.steps[coach.snapshot().tour.step]?.id;
  coach.startTour();
  expect(step()).toBe("look");

  editor.pointerMove(0, 0);
  expect(step()).toBe("look");
  editor.orbit(12, 0);
  expect(step()).toBe("place");

  editor.chooseItem("ldraw:3811@2");
  expect(step()).toBe("place");
  editor.click(0, 0, 0);
  expect(step()).toBe("rotate");

  editor.rotate(0);
  expect(step()).toBe("track");

  editor.chooseItem(TRACK_ITEM_ID);
  editor.dragStart(-0.12, 0);
  editor.dragMove(0.12, 0);
  expect(step()).toBe("track");
  editor.dragEnd(0.12, 0, 0);
  expect(step()).toBe("undo");

  editor.undo(0);

  expect(coach.snapshot().tour.state).toBe("finished");
  expect(coach.snapshot().toasts.map((toast) => toast.kind)).toContain("celebrate");
}, 120_000);

it("offers the tour on a first visit only, and remembers a finished or skipped tour", async () => {
  const memory = new MemoryTourMemory();
  const first = await startCoach(memory);
  expect(first.coach.snapshot().tour.offered).toBe(true);

  const second = await startCoach(memory);
  expect(second.coach.snapshot().tour.offered).toBe(false);
  expect(memory.tourDone()).toBe(false);

  second.coach.startTour();
  second.coach.endTour();
  expect(memory.tourDone()).toBe(true);
}, 120_000);

it("toasts why a starter was refused, and what is on the table when one loads", async () => {
  const crossroads = SHIPPED_STARTER_LAYOUTS.find((layout) => layout.id === "crossroads-square");
  if (!crossroads) throw new Error("no crossroads starter");
  const refused: StarterLayout = {
    ...crossroads,
    id: "set-on-the-crossroads",
    pieces: [
      ...crossroads.pieces,
      ...crossroads.pieces
        .filter((piece) => piece.item === "omr:10185-1")
        .map((piece) => ({ ...piece, col: 1, row: 1 })),
    ],
  };
  const { editor, coach } = await startCoach(new MemoryTourMemory(), [crossroads, refused]);

  coach.loadStarter(refused.id, 0);

  expect(editor.snapshot().placements).toBe(0);
  expect(coach.snapshot().toasts.map(({ kind, detail }) => ({ kind, detail }))).toEqual([
    { kind: "warn", detail: editor.snapshot().lastRefusal?.message },
  ]);

  coach.loadStarter(crossroads.id, 1);

  expect(coach.snapshot().toasts.at(-1)?.title).toBe(`${crossroads.title} is ready`);
}, 120_000);
