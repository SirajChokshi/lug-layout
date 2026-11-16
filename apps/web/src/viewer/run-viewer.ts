import type { BackendInfo, FrameStats, IViewerScene, SceneSummary } from "@brr/client";
import { measureFrames, type FrameTimings } from "./measure-frames.ts";
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
  readonly loadMs: number;
  readonly liveFps: number | null;
  readonly frame: FrameStats;
  readonly timings: FrameTimings | null;
}

export interface ViewerResult {
  readonly params: ViewerParams;
  readonly backend: BackendInfo;
  readonly drawingBuffer: DrawingBuffer;
  readonly summary: SceneSummary;
  readonly loadMs: number;
  readonly timings: FrameTimings;
  readonly drawCalls: number;
  readonly drawnTriangles: number;
  readonly userAgent: string;
}

export async function runViewer(
  scene: IViewerScene,
  canvas: HTMLCanvasElement,
  params: ViewerParams,
  onReport: (report: ViewerReport) => void,
  onResult: (result: ViewerResult) => void,
  onError: (error: unknown) => void,
): Promise<void> {
  const devicePixelRatio = window.devicePixelRatio;
  const backend = await scene.attach({
    canvas,
    api: params.api,
    strategy: params.strategy,
    pixelRatio: devicePixelRatio,
    antialias: true,
  });
  const drawingBuffer = (): DrawingBuffer => ({
    width: canvas.width,
    height: canvas.height,
    devicePixelRatio,
  });
  const loadStart = performance.now();
  const summary = await scene.load(params.lod);
  const loadMs = performance.now() - loadStart;
  const frame: FrameStats = { drawCalls: 0, triangles: 0 };
  window.addEventListener("resize", () => scene.resize(canvas.clientWidth, canvas.clientHeight));
  onReport({
    backend,
    drawingBuffer: drawingBuffer(),
    summary,
    loadMs,
    liveFps: null,
    frame: { ...frame },
    timings: null,
  });

  if (params.measure) {
    const timings = await measureFrames(scene, params, frame);
    onReport({
      backend,
      drawingBuffer: drawingBuffer(),
      summary,
      loadMs,
      liveFps: null,
      frame: { ...frame },
      timings,
    });
    onResult({
      params,
      backend,
      drawingBuffer: drawingBuffer(),
      summary,
      loadMs,
      timings,
      drawCalls: frame.drawCalls,
      drawnTriangles: frame.triangles,
      userAgent: navigator.userAgent,
    });
    return;
  }

  const startedAt = performance.now();
  let frames = 0;
  let windowStart = startedAt;
  const tick = (now: number): void => {
    scene.setCamera(((now - startedAt) % ORBIT_PERIOD_MS) / ORBIT_PERIOD_MS);
    try {
      scene.renderFrame(frame);
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
        loadMs,
        liveFps,
        frame: { ...frame },
        timings: null,
      });
      frames = 0;
      windowStart = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
