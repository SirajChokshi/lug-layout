import type { PartAsset, PartMesh, StudPrimitiveAsset } from "@brr/catalog";
import { CHUNK_STUDS } from "@brr/math";

export type GraphicsApi = "webgpu" | "webgl2";

const GUIDE_LINES_PER_CHUNK = 4;
export const GUIDE_GRID_STUDS = CHUNK_STUDS / GUIDE_LINES_PER_CHUNK;

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

export type PaletteLevel = "detailed" | "far";

export interface NeededMeshListener {
  hold(detailedIndices: Uint32Array, farIndices: Uint32Array): void;
  release(detailedIndices: Uint32Array, farIndices: Uint32Array): void;
}

export interface PartMeshUpdate {
  readonly index: number;
  readonly level: PaletteLevel;
  readonly part: PartAsset;
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

export interface FrameStats {
  drawCalls: number;
  triangles: number;
  nearChunks: number;
  midChunks: number;
  farChunks: number;
  nearestStudPitchPx: number;
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

export type GhostTone = "fits" | "mates" | "refused";

export interface GhostVerdict {
  readonly tone: GhostTone | null;
  readonly hit: WorldBox | null;
  readonly precise: boolean;
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

export interface GroundSettings {
  readonly topYLdu: number;
  readonly grid: boolean;
}

export type GuideKind = "ruler" | "axis" | "draft" | "refused";

export interface GuideSegment {
  readonly kind: GuideKind;
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
}

export interface NoteArea {
  readonly outline: Float64Array;
  readonly rgb: number;
}

export interface NotePath {
  readonly points: Float64Array;
  readonly closed: boolean;
  readonly rgb: number;
}

export interface NoteShapes {
  readonly y: number;
  readonly areas: ReadonlyArray<NoteArea>;
  readonly paths: ReadonlyArray<NotePath>;
}

export const PROJECTED_NDC_X = 0;
export const PROJECTED_NDC_Y = 1;
export const PROJECTED_IN_VIEW = 2;
export const PROJECTION_FLOATS = 3;

export interface PlanTableOverlay extends WorldBox {
  readonly srgb: number | null;
}

export interface PlanOverlay {
  readonly room: WorldBox;
  readonly tables: ReadonlyArray<PlanTableOverlay>;
  readonly obstacles: ReadonlyArray<WorldBox>;
  readonly active: boolean;
}

export interface ThumbnailRequest {
  readonly model: ChunkInstances;
  readonly box: WorldBox;
  readonly sizePx: number;
}

export interface IThumbnailRenderer {
  renderThumbnail(request: ThumbnailRequest): Promise<string>;
}

export interface ISceneBackend {
  init(config: SceneBackendConfig): Promise<BackendInfo>;
  setPalette(palette: PartPalette): void;
  addParts(parts: ReadonlyArray<PartAsset>): void;
  setPartMeshes(updates: ReadonlyArray<PartMeshUpdate>): void;
  setFarStuds(studPrimitives: ReadonlyArray<StudPrimitiveAsset>): void;
  setFarModelMesh(modelIndex: number, mesh: PartMesh): void;
  setColors(colorsSrgb: Uint8Array, colorsAlpha: Uint8Array): void;
  setChunk(key: number, chunk: ChunkInstances): void;
  deleteChunk(key: number): void;
  setNeededMeshListener(listener: NeededMeshListener | null): void;
  setGhost(model: ChunkInstances | null): void;
  placeGhost(x: number, yLdu: number, z: number, rot: number): void;
  setGhostVerdict(verdict: GhostVerdict | null): void;
  setSelectionBoxes(boxes: ReadonlyArray<WorldBox>): void;
  setMarkers(markers: ReadonlyArray<EdgeMarker>): void;
  setTrackEnds(markers: ReadonlyArray<TrackEndMarker>): void;
  setGround(ground: GroundSettings | null): void;
  setPlanOverlays(overlays: ReadonlyArray<PlanOverlay>): void;
  setIssueBoxes(boxes: ReadonlyArray<WorldBox>): void;
  setGuides(segments: ReadonlyArray<GuideSegment>): void;
  setNoteShapes(shapes: NoteShapes): void;
  rayThrough(ndcX: number, ndcY: number, out: Float64Array): void;
  projectToNdc(x: number, y: number, z: number, out: Float64Array, offset: number): void;
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
  needsFrame(): boolean;
  waitForGpu(): Promise<void>;
  bufferMemory(): BufferMemory;
  rebaseLog(): ReadonlyArray<RebaseEvent>;
  forceTier(tier: ChunkTier | null): void;
  setFarModel(id: number, placement: FarModelPlacement | null): void;
}

export const INSTANCE_MATRIX_FLOATS = 12;
export const COLOR_CHANNELS = 3;
