import type { PartAsset, StudPrimitiveAsset } from "@brr/catalog";

export type GraphicsApi = "webgpu" | "webgl2";

export interface SceneBackendConfig {
  readonly canvas: HTMLCanvasElement;
  readonly api: GraphicsApi;
  readonly pixelRatio: number;
  readonly antialias: boolean;
}

export interface BackendInfo {
  readonly requestedApi: GraphicsApi;
  readonly activeApi: GraphicsApi;
  readonly adapter: string;
  readonly backgroundSrgb: number;
}

export interface GeometrySet {
  readonly parts: ReadonlyArray<PartAsset>;
  readonly studPrimitives: ReadonlyArray<StudPrimitiveAsset>;
}

export interface PartPalette {
  readonly detailed: GeometrySet;
  readonly far: GeometrySet;
  readonly colorsSrgb: Uint8Array;
  readonly ldrawColorsSrgb: ReadonlyMap<number, number>;
}

export interface StudInstances {
  readonly count: number;
  readonly primitiveIndex: Uint8Array;
  readonly colorIndex: Uint16Array;
  readonly matrices: Float32Array;
}

export interface ChunkInstances {
  readonly originX: number;
  readonly originZ: number;
  readonly count: number;
  readonly partIndex: Uint16Array;
  readonly colorIndex: Uint16Array;
  readonly matrices: Float32Array;
  readonly studs: StudInstances;
}

export interface FrameStats {
  drawCalls: number;
  triangles: number;
  nearChunks: number;
  midChunks: number;
  farChunks: number;
}

export interface BufferMemory {
  readonly geometryBytes: number;
  readonly instanceBytes: number;
}

export interface ISceneBackend {
  init(config: SceneBackendConfig): Promise<BackendInfo>;
  setPalette(palette: PartPalette): void;
  setChunk(key: number, chunk: ChunkInstances): void;
  setView(eyeX: number, eyeY: number, eyeZ: number, atX: number, atY: number, atZ: number): void;
  resize(width: number, height: number): void;
  renderFrame(out: FrameStats): void;
  waitForGpu(): Promise<void>;
  bufferMemory(): BufferMemory;
}

export const INSTANCE_MATRIX_FLOATS = 12;
export const COLOR_CHANNELS = 3;
