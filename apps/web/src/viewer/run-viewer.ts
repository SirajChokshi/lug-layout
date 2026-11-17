import type {
  BackendInfo,
  FrameStats,
  IViewerScene,
  PlacementDump,
  RebaseEvent,
  SceneSummary,
} from "@brr/client";
import { FrameCoverage } from "./frame-coverage.ts";
import { measureFrames, type FrameTimings } from "./measure-frames.ts";
import { memoryReport, type MemoryReport } from "./memory-report.ts";
import type { ViewerParams } from "./viewer-params.ts";

const ORBIT_PERIOD_MS = 40_000;
const HUD_REFRESH_MS = 500;

export interface DrawingBuffer {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

export interface ViewerReport {
  readonly backend: BackendInfo;
  readonly drawingBuffer: DrawingBuffer;
  readonly summary: SceneSummary;
  readonly memory: MemoryReport;
  readonly loadMs: number;
  readonly liveFps: number | null;
  readonly liveSceneCoverage: number | null;
  readonly frame: FrameStats;
  readonly rebases: ReadonlyArray<RebaseEvent>;
  readonly timings: FrameTimings | null;
}

export interface ViewerResult {
  readonly params: ViewerParams;
  readonly backend: BackendInfo;
  readonly drawingBuffer: DrawingBuffer;
  readonly summary: SceneSummary;
  readonly memory: MemoryReport;
  readonly loadMs: number;
  readonly timings: FrameTimings;
  readonly drawCalls: number;
  readonly drawnTriangles: number;
  readonly userAgent: string;
  readonly worldPlacements: PlacementDump | null;
  readonly rebases: ReadonlyArray<RebaseEvent>;
}

export async function runViewer(
  scene: IViewerScene,
  canvas: HTMLCanvasElement,
  params: ViewerParams,
  placements: (() => PlacementDump) | null,
  onReport: (report: ViewerReport) => void,
  onResult: (result: ViewerResult) => void,
  onError: (error: unknown) => void,
): Promise<void> {
  const devicePixelRatio = window.devicePixelRatio;
  const backend = await scene.backend.init({
    canvas,
    api: params.api,
    pixelRatio: devicePixelRatio,
    antialias: true,
    look: params.look,
  });
  scene.backend.forceTier(params.tier);
  const drawingBuffer = (): DrawingBuffer => ({
    width: canvas.width,
    height: canvas.height,
    devicePixelRatio,
  });
  const loadStart = performance.now();
  const summary = await scene.load(params.lod);
  const loadMs = performance.now() - loadStart;
  const frame: FrameStats = {
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
  const memory = (): MemoryReport => memoryReport(scene.backend.bufferMemory());
  window.addEventListener("resize", () =>
    scene.backend.resize(canvas.clientWidth, canvas.clientHeight),
  );
  const coverage = new FrameCoverage(backend.backgroundSrgb);
  onReport({
    backend,
    drawingBuffer: drawingBuffer(),
    summary,
    memory: memory(),
    loadMs,
    liveFps: null,
    liveSceneCoverage: null,
    frame: { ...frame },
    rebases: [...scene.backend.rebaseLog()],
    timings: null,
  });

  if (params.measure) {
    const timings = await measureFrames(scene, params, canvas, coverage, frame);
    onReport({
      backend,
      drawingBuffer: drawingBuffer(),
      summary,
      memory: memory(),
      loadMs,
      liveFps: null,
      liveSceneCoverage: null,
      frame: { ...frame },
      rebases: [...scene.backend.rebaseLog()],
      timings,
    });
    onResult({
      params,
      backend,
      drawingBuffer: drawingBuffer(),
      summary,
      memory: memory(),
      loadMs,
      timings,
      drawCalls: timings.medianDrawCalls,
      drawnTriangles: timings.medianDrawnTriangles,
      userAgent: navigator.userAgent,
      worldPlacements: placements ? placements() : null,
      rebases: scene.backend.rebaseLog(),
    });
    return;
  }

  const startedAt = performance.now();
  let frames = 0;
  let windowStart = startedAt;
  const tick = (now: number): void => {
    scene.setCamera(((now - startedAt) % ORBIT_PERIOD_MS) / ORBIT_PERIOD_MS);
    scene.onFrame?.();
    try {
      scene.backend.renderFrame(frame);
    } catch (error) {
      onError(error);
      return;
    }
    frames++;
    if (now - windowStart >= HUD_REFRESH_MS) {
      const liveFps = (frames * 1000) / (now - windowStart);
      onReport({
        backend,
        drawingBuffer: drawingBuffer(),
        summary,
        memory: memory(),
        loadMs,
        liveFps,
        liveSceneCoverage: coverage.sceneFraction(canvas),
        frame: { ...frame },
        rebases: [...scene.backend.rebaseLog()],
        timings: null,
      });
      frames = 0;
      windowStart = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
