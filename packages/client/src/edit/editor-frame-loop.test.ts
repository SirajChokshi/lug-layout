import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ChunkTier,
  type FrameStats,
  type ISceneBackend,
  type RebaseEvent,
} from "@brr/render";
import { Container } from "inversify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { EDITOR_FRAME_LOOP } from "../tokens.ts";
import type { FrameLoopView, FrameTimes, IEditorFrameLoop } from "./editor-frame-loop.ts";

const DRAW_CALLS = 7;
const RENDER_MS = 2;
const START_WIDTH_PX = 640;
const START_HEIGHT_PX = 480;
const WARMUP_FRAMES = 5;
const MEASURED_FRAMES = 60;

class RecordingBackend implements ISceneBackend {
  needed = false;
  renders = 0;
  failure: Error | null = null;
  holdGpu = false;
  gpuMs: (wait: number) => number = () => 0;
  readonly resizes: Array<readonly [number, number]> = [];
  readonly forcedTiers: Array<ChunkTier | null> = [];
  private gpuWaits = 0;
  private readonly heldGpu: Array<() => void> = [];

  async init(): Promise<BackendInfo> {
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
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  deleteVehicle(): void {}
  setIssueBoxes(): void {}
  rayThrough(): void {}
  setView(): void {}
  resize(width: number, height: number): void {
    this.resizes.push([width, height]);
  }
  renderFrame(out: FrameStats): void {
    if (this.failure) throw this.failure;
    this.renders++;
    out.drawCalls = DRAW_CALLS;
    vi.advanceTimersByTime(RENDER_MS);
  }
  needsFrame(): boolean {
    return this.needed;
  }
  waitForGpu(): Promise<void> {
    vi.advanceTimersByTime(this.gpuMs(this.gpuWaits++));
    if (!this.holdGpu) return Promise.resolve();
    return new Promise((resolve) => this.heldGpu.push(resolve));
  }
  releaseGpu(): void {
    for (const resolve of this.heldGpu.splice(0)) resolve();
  }
  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return [];
  }
  bufferMemory(): BufferMemory {
    return { vertexIndexBytes: 0, otherBytes: 0 };
  }
  forceTier(tier: ChunkTier | null): void {
    this.forcedTiers.push(tier);
  }
  setFarModel(): void {}
}

interface Canvas {
  clientWidth: number;
  clientHeight: number;
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function preparedLoop() {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  let scheduled: FrameRequestCallback | null = null;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    scheduled = callback;
    return 1;
  });
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  const backend = new RecordingBackend();
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const loop = container.get(EDITOR_FRAME_LOOP);
  const published: FrameLoopView[] = [];
  loop.subscribe(() => published.push(loop.view()));
  const canvas: Canvas = { clientWidth: START_WIDTH_PX, clientHeight: START_HEIGHT_PX };
  const failures: unknown[] = [];
  const start = (): void =>
    loop.start(canvas as unknown as HTMLCanvasElement, (error) => failures.push(error));
  const isScheduled = (): boolean => scheduled !== null;
  const frame = (): void => {
    const callback = scheduled;
    if (!callback) throw new Error("no frame is scheduled");
    scheduled = null;
    callback(performance.now());
  };
  const settledFrame = async (): Promise<void> => {
    frame();
    await settle();
  };
  return { loop, backend, canvas, published, failures, start, frame, settledFrame, isScheduled };
}

async function pastFirstFrame() {
  const prepared = preparedLoop();
  prepared.start();
  await prepared.settledFrame();
  prepared.published.length = 0;
  return prepared;
}

async function measuredRun(loop: IEditorFrameLoop, settledFrame: () => Promise<void>) {
  loop.measureFrames();
  for (let i = 0; i < WARMUP_FRAMES + MEASURED_FRAMES; i++) await settledFrame();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("editor frame loop", () => {
  it("renders a frame only when the backend needs one, a frame is to be timed or measured, or it is the first frame", async () => {
    const { loop, backend, start, settledFrame } = preparedLoop();
    const rendered: boolean[] = [];
    const counted = async (): Promise<void> => {
      const before = backend.renders;
      await settledFrame();
      rendered.push(backend.renders > before);
    };

    start();
    await counted();
    await counted();
    backend.needed = true;
    await counted();
    backend.needed = false;
    loop.timeNextFrame(() => {});
    await counted();
    loop.measureFrames();
    await counted();

    expect(rendered).toEqual([true, false, true, true, true]);
  });

  it("schedules the next frame at once after a steady frame, and only after the GPU wait resolves after a timed one", async () => {
    const { loop, backend, start, frame, isScheduled } = preparedLoop();
    backend.holdGpu = true;
    start();
    frame();
    await settle();
    backend.releaseGpu();
    await settle();

    frame();
    const afterSteady = isScheduled();
    loop.timeNextFrame(() => {});
    frame();
    await settle();
    const whileGpuWaits = isScheduled();
    backend.releaseGpu();
    await settle();

    expect({ afterSteady, whileGpuWaits, afterGpu: isScheduled() }).toEqual({
      afterSteady: true,
      whileGpuWaits: false,
      afterGpu: true,
    });
  });

  it("reports a timed frame's start, submit and presented times from the clock", async () => {
    const { loop, backend, settledFrame } = await pastFirstFrame();
    const gpuMs = 5;
    backend.gpuMs = () => gpuMs;
    const reported: FrameTimes[] = [];
    vi.advanceTimersByTime(40);
    const startMs = performance.now();

    loop.timeNextFrame((frame) => reported.push(frame));
    await settledFrame();

    expect(reported).toEqual([
      { startMs, submittedMs: startMs + RENDER_MS, presentedMs: startMs + RENDER_MS + gpuMs },
    ]);
  });

  it("publishes the first frame's presented time once", async () => {
    const { backend, published, start, settledFrame } = preparedLoop();
    backend.gpuMs = () => 3;
    start();
    const startMs = performance.now();

    await settledFrame();
    await settledFrame();
    await settledFrame();

    expect(published.map((view) => view.coldStartMs)).toEqual([startMs + RENDER_MS + 3]);
  });

  it("publishes FPS and the backend's frame stats once 500 ms of frames have passed", async () => {
    const { backend, published, start, settledFrame } = preparedLoop();
    backend.needed = true;
    start();
    await settledFrame();
    const framesAfterFirst = 4;
    for (let i = 0; i < framesAfterFirst; i++) {
      vi.advanceTimersByTime(100);
      await settledFrame();
    }
    const beforeInterval = published.filter((view) => view.stats !== null).length;

    vi.advanceTimersByTime(100);
    await settledFrame();

    const stats = published.at(-1)?.stats;
    const frames = framesAfterFirst + 2;
    const elapsedMs = (framesAfterFirst + 2) * RENDER_MS + (framesAfterFirst + 1) * 100;
    expect({ beforeInterval, fps: stats?.fps, drawCalls: stats?.drawCalls }).toEqual({
      beforeInterval: 0,
      fps: (frames * 1000) / elapsedMs,
      drawCalls: DRAW_CALLS,
    });
  });

  it("publishes the median, p95 and CPU submit time of 60 GPU-synced frames measured after 5 warm-up frames", async () => {
    const { loop, backend, settledFrame } = await pastFirstFrame();
    backend.gpuMs = (wait) => wait;

    await measuredRun(loop, settledFrame);

    const lastWarmupWait = 1 + WARMUP_FRAMES - 1;
    const frameMs = (index: number): number => RENDER_MS + lastWarmupWait + 1 + index;
    expect(loop.view()).toMatchObject({
      measuring: false,
      measurement: {
        frames: MEASURED_FRAMES,
        medianFrameMs: frameMs(29),
        p95FrameMs: frameMs(56),
        medianCpuSubmitMs: RENDER_MS,
        drawCalls: DRAW_CALLS,
      },
    });
  });

  it("ignores a measurement request while a run is in progress", async () => {
    const { loop, published, settledFrame } = await pastFirstFrame();
    loop.measureFrames();
    for (let i = 0; i < 3; i++) await settledFrame();

    loop.measureFrames();
    for (let i = 3; i < WARMUP_FRAMES + MEASURED_FRAMES; i++) await settledFrame();

    expect(published.map((view) => view.measuring)).toEqual([true, false]);
  });

  it("a tier change clears the last measurement", async () => {
    const { loop, settledFrame } = await pastFirstFrame();
    await measuredRun(loop, settledFrame);
    const measured = loop.view().measurement !== null;

    loop.cycleTier();

    expect({ measured, measurement: loop.view().measurement }).toEqual({
      measured: true,
      measurement: null,
    });
  });

  it("cycles the forced tier auto, near, mid, far and back to auto", () => {
    const { loop, backend } = preparedLoop();
    const tiers: Array<ChunkTier | null> = [];

    for (let i = 0; i < 4; i++) {
      loop.cycleTier();
      tiers.push(loop.view().tier);
    }

    expect({ tiers, forced: backend.forcedTiers }).toEqual({
      tiers: ["near", "mid", "far", null],
      forced: ["near", "mid", "far", null],
    });
  });

  it("resizes the backend at start, then only when the canvas's CSS size changes", async () => {
    const { backend, canvas, start, settledFrame } = preparedLoop();
    canvas.clientWidth = 0;
    canvas.clientHeight = 0;
    start();
    await settledFrame();
    await settledFrame();

    canvas.clientWidth = 800;
    canvas.clientHeight = 600;
    await settledFrame();
    await settledFrame();

    expect(backend.resizes).toEqual([
      [0, 0],
      [800, 600],
    ]);
  });

  it("a frame that throws stops the loop, reports the error once, and ignores later measurement requests", async () => {
    const { loop, backend, failures, start, frame, isScheduled } = preparedLoop();
    const error = new Error("context lost");
    backend.failure = error;
    start();

    frame();
    await settle();
    loop.measureFrames();

    expect({ failures, scheduled: isScheduled(), measuring: loop.view().measuring }).toEqual({
      failures: [error],
      scheduled: false,
      measuring: false,
    });
  });
});
