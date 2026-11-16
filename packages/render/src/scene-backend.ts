import type { PartAsset, StudPrimitiveAsset } from "@brr/catalog";

export type GraphicsApi = "webgpu" | "webgl2";
export type InstancingStrategy = "instanced" | "batched";

export interface SceneBackendConfig {
  readonly canvas: HTMLCanvasElement;
  readonly api: GraphicsApi;
  readonly strategy: InstancingStrategy;
  readonly pixelRatio: number;
  readonly antialias: boolean;
}

export interface BackendInfo {
  readonly requestedApi: GraphicsApi;
  readonly activeApi: GraphicsApi;
  readonly adapter: string;
  readonly strategy: InstancingStrategy;
}

export interface PartPalette {
  readonly parts: ReadonlyArray<PartAsset>;
  readonly studPrimitives: ReadonlyArray<StudPrimitiveAsset>;
  readonly colorsSrgb: Uint8Array;
}

export interface ChunkInstances {
  readonly originX: number;
  readonly originZ: number;
  readonly count: number;
  readonly partIndex: Uint16Array;
  readonly colorIndex: Uint16Array;
  readonly matrices: Float32Array;
}

export interface FrameStats {
  drawCalls: number;
  triangles: number;
}

export interface ISceneBackend {
  init(config: SceneBackendConfig): Promise<BackendInfo>;
  setPalette(palette: PartPalette): void;
  setChunk(key: number, chunk: ChunkInstances): void;
  clearChunks(): void;
  setView(eyeX: number, eyeY: number, eyeZ: number, atX: number, atY: number, atZ: number): void;
  resize(width: number, height: number): void;
  renderFrame(out: FrameStats): void;
  waitForGpu(): Promise<void>;
  dispose(): void;
}

export const INSTANCE_MATRIX_FLOATS = 12;
export const COLOR_CHANNELS = 3;
