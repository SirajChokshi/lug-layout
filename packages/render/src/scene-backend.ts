import type { PartAsset, PartMesh, StudPrimitiveAsset } from "@brr/catalog";

export type GraphicsApi = "webgpu" | "webgl2";

export const LOOK_FEATURES = ["plastic", "gtao", "outlines", "bevel", "shadows", "oit"] as const;

export type LookFeature = (typeof LOOK_FEATURES)[number];

export const DEFAULT_LOOK_FEATURES: ReadonlyArray<LookFeature> = ["plastic", "outlines", "bevel"];

export type LookSettings = Readonly<Record<LookFeature, boolean>>;

export interface SceneBackendConfig {
  readonly canvas: HTMLCanvasElement;
  readonly api: GraphicsApi;
  readonly pixelRatio: number;
  readonly antialias: boolean;
  readonly look: LookSettings;
}

export interface BackendInfo {
  readonly requestedApi: GraphicsApi;
  readonly activeApi: GraphicsApi;
  readonly adapter: string;
  readonly backgroundSrgb: number;
  readonly look: LookSettings;
}

export interface GeometrySet {
  readonly parts: ReadonlyArray<PartAsset>;
  readonly studPrimitives: ReadonlyArray<StudPrimitiveAsset>;
}

export interface PartPalette {
  readonly detailed: GeometrySet;
  readonly far?: GeometrySet;
  readonly farModels?: ReadonlyArray<PartMesh>;
  readonly colorsSrgb: Uint8Array;
  readonly colorsAlpha: Uint8Array;
  readonly ldrawColors: ReadonlyMap<number, LdrawColor>;
}

export interface LdrawColor {
  readonly srgb: number;
  readonly alpha: number;
}

export interface StudInstances {
  readonly count: number;
  readonly primitiveIndex: Uint8Array;
  readonly colorIndex: Uint16Array;
  readonly matrices: Float32Array;
}

export interface FarModelPlacement {
  readonly modelIndex: number;
  readonly originX: number;
  readonly originZ: number;
  readonly matrix: Float32Array;
  readonly chunkKeys: ReadonlyArray<number>;
}

export interface ChunkInstances {
  readonly originX: number;
  readonly originZ: number;
  readonly count: number;
  readonly partIndex: Uint16Array;
  readonly colorIndex: Uint16Array;
  readonly matrices: Float32Array;
  readonly studs: StudInstances;
  readonly voxelized?: Uint8Array;
}

export type ChunkTier = "near" | "mid" | "far";

export interface SuperChunkMesh {
  readonly originX: number;
  readonly originZ: number;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly positions: Float32Array;
  readonly normals: Int8Array;
  readonly colorIndex: Uint16Array;
  readonly indices: Uint16Array | Uint32Array;
}

export interface FrameStats {
  drawCalls: number;
  triangles: number;
  nearChunks: number;
  midChunks: number;
  farChunks: number;
  nearestStudPitchPx: number;

  superChunks: number;
  renderOriginChunkX: number;
  renderOriginChunkZ: number;
  rebaseCount: number;
}

export interface RebaseEvent {
  readonly frame: number;
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly chunks: number;
  readonly ms: number;
}

export interface BufferMemory {
  readonly vertexIndexBytes: number;
  readonly otherBytes: number;
}

export interface WorldBox {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

export type MarkerKind = "joined" | "open" | "mismatch";

export interface EdgeMarker {
  readonly box: WorldBox;
  readonly kind: MarkerKind;
}

export type TrackEndKind = "open" | "gap" | "target";

export interface TrackEndMarker {
  readonly xLdu: number;
  readonly yLdu: number;
  readonly zLdu: number;
  readonly headingRadians: number;
  readonly kind: TrackEndKind;
}

export const RAY_FLOATS = 6;
export const CAMERA_FOV_DEGREES = 40;

export interface PlanOverlay {
  readonly room: WorldBox;
  readonly tables: ReadonlyArray<WorldBox>;
  readonly obstacles: ReadonlyArray<WorldBox>;
  readonly gridStepLdu: number;
  readonly active: boolean;
}

export interface ISceneBackend {
  init(config: SceneBackendConfig): Promise<BackendInfo>;
  setPalette(palette: PartPalette): void;
  setChunk(key: number, chunk: ChunkInstances): void;
  deleteChunk(key: number): void;
  setSuperChunk(key: number, mesh: SuperChunkMesh): void;
  setSuperChunkVisible(key: number, visible: boolean): void;
  deleteSuperChunk(key: number): void;
  studPitchesPx(distancesLdu: Float64Array, count: number, out: Float64Array): void;
  setGhost(model: ChunkInstances | null): void;
  placeGhost(x: number, yLdu: number, z: number, rot: number): void;
  setSelectionBox(box: WorldBox | null): void;
  setMarkers(markers: ReadonlyArray<EdgeMarker>): void;
  setTrackEnds(markers: ReadonlyArray<TrackEndMarker>): void;
  setPlanOverlays(overlays: ReadonlyArray<PlanOverlay>): void;
  setIssueBoxes(boxes: ReadonlyArray<WorldBox>): void;
  rayThrough(ndcX: number, ndcY: number, out: Float64Array): void;
  setVehicle(vehicle: number, model: ChunkInstances): void;
  setVehiclePose(
    vehicle: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch?: number,
    roll?: number,
  ): void;
  deleteVehicle(vehicle: number): void;
  setView(
    eyeX: number,
    eyeY: number,
    eyeZ: number,
    atX: number,
    atY: number,
    atZ: number,
    orthoHalfHeightLdu?: number,
  ): void;
  resize(width: number, height: number): void;
  renderFrame(out: FrameStats): void;
  waitForGpu(): Promise<void>;
  bufferMemory(): BufferMemory;
  rebaseLog(): ReadonlyArray<RebaseEvent>;
  forceTier(tier: ChunkTier | null): void;
  setFarModel(id: number, placement: FarModelPlacement | null): void;
}

export const INSTANCE_MATRIX_FLOATS = 12;
export const COLOR_CHANNELS = 3;
