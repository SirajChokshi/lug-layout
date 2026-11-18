import { SCENE_BACKEND, type ChunkTier, type FrameStats, type ISceneBackend } from "@brr/render";
import { inject, injectable } from "inversify";
import type { IEditorCamera } from "../camera/editor-camera.ts";
import { EDITOR_CAMERA, WORLD_SESSION } from "../tokens.ts";
import type { IWorldSession } from "./world-session.ts";

export interface EditorStats {
  readonly fps: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly renderOriginChunkX: number;
  readonly renderOriginChunkZ: number;
  readonly rebases: number;
  readonly nearChunks: number;
  readonly midChunks: number;
  readonly farChunks: number;
  readonly nearestStudPitchPx: number;
}

export interface FrameMeasurement {
  readonly frames: number;
  readonly medianFrameMs: number;
  readonly p95FrameMs: number;
  readonly medianCpuSubmitMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly nearChunks: number;
  readonly midChunks: number;
  readonly farChunks: number;
  readonly nearestStudPitchPx: number;
}

export interface FrameTimes {
  readonly startMs: number;
  readonly submittedMs: number;
  readonly presentedMs: number;
}

export interface FrameLoopView {
  readonly tier: ChunkTier | null;
  readonly stats: EditorStats | null;
  readonly measuring: boolean;
  readonly measurement: FrameMeasurement | null;
  readonly coldStartMs: number | null;
}

export interface IEditorFrameLoop {
  view(): FrameLoopView;
  subscribe(listener: () => void): () => void;
  forceTier(tier: ChunkTier | null): void;
  cycleTier(): void;
  start(canvas: HTMLCanvasElement, reportFailure: (error: unknown) => void): void;
  measureFrames(): void;
  timeNextFrame(onPresented: (frame: FrameTimes) => void): void;
}

const STATS_INTERVAL_MS = 500;
const MEASURE_WARMUP_FRAMES = 5;
const MEASURED_FRAMES = 60;
const TIER_CYCLE: ReadonlyArray<ChunkTier | null> = [null, "near", "mid", "far"];
const UNSET_CSS_PX = -1;

function quantileOfSorted(sorted: Float64Array, fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? Number.NaN;
}

@injectable()
export class EditorFrameLoop implements IEditorFrameLoop {
  private readonly listeners = new Set<() => void>();
  private state: FrameLoopView = {
    tier: null,
    stats: null,
    measuring: false,
    measurement: null,
    coldStartMs: null,
  };
  private readonly frameStats: FrameStats = {
    drawCalls: 0,
    triangles: 0,
    nearChunks: 0,
    midChunks: 0,
    farChunks: 0,
    nearestStudPitchPx: 0,
    renderOriginChunkX: 0,
    renderOriginChunkZ: 0,
    rebaseCount: 0,
  };
  private canvas: HTMLCanvasElement | null = null;
  private cssWidth = UNSET_CSS_PX;
  private cssHeight = UNSET_CSS_PX;
  private reportFailure: ((error: unknown) => void) | null = null;
  private stopped = false;
  private firstFrame = false;
  private onPresented: ((frame: FrameTimes) => void) | null = null;
  private measureFrame = -1;
  private readonly measuredFrameMs = new Float64Array(MEASURED_FRAMES);
  private readonly measuredCpuMs = new Float64Array(MEASURED_FRAMES);
  private framesSinceStats = 0;
  private statsSince = 0;

  constructor(
    @inject(SCENE_BACKEND)
    private readonly backend: Pick<
      ISceneBackend,
      "resize" | "forceTier" | "needsFrame" | "renderFrame" | "waitForGpu"
    >,
    @inject(EDITOR_CAMERA) private readonly camera: Pick<IEditorCamera, "frame" | "resize">,
    @inject(WORLD_SESSION) private readonly session: Pick<IWorldSession, "pollCamera">,
  ) {}

  view(): FrameLoopView {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(patch: Partial<FrameLoopView>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  forceTier(tier: ChunkTier | null): void {
    this.backend.forceTier(tier);
    this.publish({ tier, measurement: null });
  }

  cycleTier(): void {
    const next = TIER_CYCLE[(TIER_CYCLE.indexOf(this.state.tier) + 1) % TIER_CYCLE.length] ?? null;
    this.forceTier(next);
  }

  start(canvas: HTMLCanvasElement, reportFailure: (error: unknown) => void): void {
    this.canvas = canvas;
    this.reportFailure = reportFailure;
    this.firstFrame = true;
    this.statsSince = performance.now();
    this.resizeToCanvas();
    this.camera.frame(performance.now());
    requestAnimationFrame(this.step);
  }

  measureFrames(): void {
    if (this.measureFrame >= 0 || this.stopped) return;
    this.measureFrame = 0;
    this.publish({ measuring: true });
  }

  timeNextFrame(onPresented: (frame: FrameTimes) => void): void {
    this.onPresented = onPresented;
  }

  private readonly step = (): void => {
    try {
      this.resizeToCanvas();
      const startMs = performance.now();
      this.camera.frame(startMs);
      this.session.pollCamera();
      const onPresented = this.onPresented;
      const edge = onPresented !== null || this.measureFrame >= 0 || this.firstFrame;
      if (edge || this.backend.needsFrame()) this.backend.renderFrame(this.frameStats);
      if (edge) {
        void this.finishEdgeFrame(startMs, onPresented);
        return;
      }
      this.tallyStats();
      requestAnimationFrame(this.step);
    } catch (error) {
      this.fail(error);
    }
  };

  private async finishEdgeFrame(
    startMs: number,
    onPresented: ((frame: FrameTimes) => void) | null,
  ): Promise<void> {
    try {
      if (onPresented !== null) {
        this.onPresented = null;
        const submittedMs = performance.now();
        await this.backend.waitForGpu();
        onPresented({ startMs, submittedMs, presentedMs: performance.now() });
      } else if (this.measureFrame >= 0) {
        const submittedMs = performance.now();
        await this.backend.waitForGpu();
        this.recordMeasuredFrame(startMs, submittedMs, performance.now());
      }
      if (this.firstFrame) {
        this.firstFrame = false;
        await this.backend.waitForGpu();
        this.publish({ coldStartMs: performance.now() });
      }
      this.tallyStats();
      requestAnimationFrame(this.step);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.stopped = true;
    this.reportFailure?.(error);
  }

  private resizeToCanvas(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === this.cssWidth && height === this.cssHeight) return;
    this.cssWidth = width;
    this.cssHeight = height;
    this.backend.resize(width, height);
    this.camera.resize(width, height);
  }

  private tallyStats(): void {
    this.framesSinceStats++;
    const now = performance.now();
    const elapsed = now - this.statsSince;
    if (elapsed < STATS_INTERVAL_MS) return;
    const stats = this.frameStats;
    this.publish({
      stats: {
        fps: (this.framesSinceStats * 1000) / elapsed,
        drawCalls: stats.drawCalls,
        triangles: stats.triangles,
        renderOriginChunkX: stats.renderOriginChunkX,
        renderOriginChunkZ: stats.renderOriginChunkZ,
        rebases: stats.rebaseCount,
        nearChunks: stats.nearChunks,
        midChunks: stats.midChunks,
        farChunks: stats.farChunks,
        nearestStudPitchPx: stats.nearestStudPitchPx,
      },
    });
    this.framesSinceStats = 0;
    this.statsSince = now;
  }

  private recordMeasuredFrame(startMs: number, submittedMs: number, presentedMs: number): void {
    const index = this.measureFrame - MEASURE_WARMUP_FRAMES;
    this.measureFrame++;
    if (index < 0) return;
    this.measuredFrameMs[index] = presentedMs - startMs;
    this.measuredCpuMs[index] = submittedMs - startMs;
    if (index < MEASURED_FRAMES - 1) return;
    this.measureFrame = -1;
    const frames = this.measuredFrameMs.toSorted();
    const cpu = this.measuredCpuMs.toSorted();
    const stats = this.frameStats;
    this.publish({
      measuring: false,
      measurement: {
        frames: MEASURED_FRAMES,
        medianFrameMs: quantileOfSorted(frames, 0.5),
        p95FrameMs: quantileOfSorted(frames, 0.95),
        medianCpuSubmitMs: quantileOfSorted(cpu, 0.5),
        drawCalls: stats.drawCalls,
        triangles: stats.triangles,
        nearChunks: stats.nearChunks,
        midChunks: stats.midChunks,
        farChunks: stats.farChunks,
        nearestStudPitchPx: stats.nearestStudPitchPx,
      },
    });
  }
}
