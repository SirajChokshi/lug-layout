import type {
  BundleColor,
  BundleIndex,
  BundleLod,
  BundleModelEntry,
  NotDrawnSection,
  TrackCatalog,
} from "@brr/schema/bundle";
import {
  BUNDLE_BASE_URL,
  PART_BUNDLE_LOADER,
  withPlaceholderMesh,
  type FetchPriority,
  type IPartBundleLoader,
  type ModelRecord,
  type PartShapeAsset,
  type PartShapeRecord,
} from "@brr/catalog";
import { MergedParts } from "./merged-parts.ts";
import { PartMeshStream, type MeshProgress } from "./part-mesh-stream.ts";
import {
  DirtyShards,
  BomCounter,
  countPlacements,
  EditHistory,
  MODULE_SIDES,
  RoadNetwork,
  World,
  addShards,
  railEdgesMate,
  worldPlacements,
  packedCellKey,
  type AppliedEdit,
  type EditKind,
  type GridPlacement,
  type BaseCells,
  type HistoryStep,
  type ModuleEdgeKind,
  type ModuleSide,
  type PlacementPose,
  type PlacementTarget,
  type PlacementContents,
  type OwnerFilter,
  type PendingChange,
  type RoadEdgeSegment,
  type RoadJoinReport,
  type RoadPlacement,
} from "@brr/domain";
import {
  BRICK_LDU,
  CHUNK_LDU,
  PLATE_LDU,
  STUD_LDU,
  ZETA16_ORDER,
  composePose16,
  pose16,
  posesJoin16,
  zeta16,
  zeta16ToStuds,
} from "@brr/math";
import {
  CAMERA_FOV_DEGREES,
  RAY_FLOATS,
  SCENE_BACKEND,
  type BackendInfo,
  type EdgeMarker,
  type ChunkTier,
  type FrameStats,
  type GraphicsApi,
  type LookSettings,
  type ISceneBackend,
  type WorldBox,
} from "@brr/render";
import { decode, issueText } from "@brr/schema/decode";
import {
  WORLD_NAME_MAX_LENGTH,
  WorldName,
  shardEntry,
  worldHeader,
  worldManifest,
  worldShards,
  worldTrack,
  type SavedViewV1,
  type TrackRecordV1,
  type WorldHeader,
  type WorldIndexEntry,
  type WorldManifestV1,
  type WorldShardV1,
} from "@brr/schema/world";
import {
  WORLD_LOCKS,
  WORLD_REPOSITORY,
  type IWorldLocks,
  type IWorldRepository,
  type WorldLease,
} from "@brr/storage";
import { inject, injectable } from "inversify";
import {
  notDrawnItems,
  type BomInput,
  type BomScope,
  type IBomSource,
} from "../bom/bom-service.ts";
import { dumpPlacements, type PlacementDump } from "../scene/placements.ts";
import { ColorTable, ldrawColors, type ModelCredit } from "../scene/viewer-scene.ts";
import type { ICredits } from "../credits/credits-service.ts";
import type { CreditsView } from "../credits/credits-view.ts";
import { CATALOG_SEARCH, CREDITS, TRADEMARK_DISCLAIMER } from "../tokens.ts";
import type { CatalogSearchView, ICatalogSearch } from "../catalog/catalog-search.ts";
import { heldPlacements, latticePose16, latticeSnap } from "./model-track.ts";
import {
  LAID_TRACK_PLATES,
  TRACK_SYSTEM,
  TrackDrawing,
  type PieceSnap,
  type SwitchLeverView,
  type HeldTrackRequest,
  type TrackDragView,
  type TrackGapView,
  type TrackRouteView,
} from "./track-drawing.ts";
import {
  PlacedChunks,
  type LandingAt,
  type PendingPose,
  type PlacementCheck,
  type PlacedModel,
  type RebuildReport,
  type StudTotals,
  type ViewUpdate,
} from "./placed-chunks.ts";
import { modelPlaceable, partPlaceable, type Placeable } from "./placeable.ts";
import { thumbnailUrls } from "../catalog/thumbnail-urls.ts";
import { cellExtent, snapToRoadEdge, type CellExtent } from "./road-snap.ts";
import { ModuleLayout, type ModuleCandidate } from "./module-layout.ts";
import { quarterTurned, type TurnDirection } from "./turn.ts";
import {
  ROAD_KIT_PREFIX,
  RoadDrawing,
  type RoadPlacementRules,
  type RoadKitView,
  type RoadPreview,
  type RoadStrokeView,
} from "./road-drawing.ts";
import { EDITOR_CAMERA, PLAN_SERVICE } from "../tokens.ts";
import type { IPlanService } from "../plan/plan-service.ts";
import type { IEditorCamera } from "../camera/editor-camera.ts";
import { ViewCamera } from "../camera/view-camera.ts";
import { creditsForWorld, exportFileName } from "./world-credits.ts";
import { playModel, type PlayModel, type PlaySetup } from "../play/play-models.ts";
import {
  carriesRefusal,
  checkRefusal,
  riderRefusal,
  roadFitRefusal,
  trackCarriedRefusal,
  trackRunRefusal,
  type Refusal,
  type RefusalRule,
  type RoadFit,
} from "./placement-messages.ts";

export type { TurnDirection } from "./turn.ts";
export type EditorStatus = "loading" | "ready" | "error";
export type EditAction = EditKind | "track";
export type EditorMode = "place" | "select" | "track" | "road";
export interface RoadStrokeResult {
  readonly result: "laid" | "refused";
  readonly stroke: RoadStrokeView;
}

export interface CatalogColorView {
  readonly code: number;
  readonly name: string;
  readonly rgb: string;
}

export interface CatalogPartView {
  readonly id: string;
  readonly title: string;
}

export interface CatalogItemView {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly groupLabel: string;
  readonly color: CatalogColorView | null;
  readonly kind: Placeable["kind"] | "track";
  readonly parts: number;
  readonly studsWide: number;
  readonly studsDeep: number;
  readonly thumbnail: string | null;
}

export interface LatencySample {
  readonly step: HistoryStep;
  readonly action: EditAction;
  readonly item: string;
  readonly rot: number;
  readonly x: number;
  readonly z: number;
  readonly ms: number;
  readonly rebuildMs: number;
  readonly queueMs: number;
  readonly submitMs: number;
  readonly gpuWaitMs: number;
  readonly rebuiltChunks: number;
  readonly rebuiltInstances: number;
  readonly rebuiltStuds: number;
}

export interface SelectionView {
  readonly item: string;
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
  readonly chunkKey: number;
  readonly slot: number;
  readonly box: WorldBox;
}

export interface HistoryView {
  readonly undo: EditAction | null;
  readonly redo: EditAction | null;
  readonly undoDepth: number;
  readonly redoDepth: number;
}

export interface RoadIssueView {
  readonly status: "open" | "mismatch";
  readonly item: string;
  readonly side: RoadEdgeSegment["side"];
  readonly line: number;
  readonly from: number;
  readonly to: number;
  readonly topLdu: number;
}

export interface RoadJoinView {
  readonly checkMs: number;
  readonly placements: number;
  readonly joinedCells: number;
  readonly openCells: number;
  readonly mismatchedCells: number;
  readonly overlaps: number;
  readonly issues: ReadonlyArray<RoadIssueView>;
}

export type RoadSnapState = "snapped" | "free" | "refused";

export interface RoadSnapView {
  readonly state: RoadSnapState;
  readonly joinedCells: number;
  readonly joinedRoadCells: number;
  readonly mismatchedCells: number;
  readonly overlappingCells: number;
}

export interface ModuleIssueView {
  readonly item: string;
  readonly x: number;
  readonly z: number;
  readonly side: ModuleSide;
  readonly kind: ModuleEdgeKind;
  readonly facing: ModuleEdgeKind | null;
}

export interface ModuleJoinView {
  readonly modules: number;
  readonly joined: number;
  readonly mismatched: number;
  readonly open: number;
  readonly offGrid: number;
  readonly issues: ReadonlyArray<ModuleIssueView>;
}

export interface ModuleFitView {
  readonly column: number;
  readonly row: number;
  readonly rot: number;
  readonly occupied: boolean;
  readonly joined: number;
  readonly mismatched: number;
  readonly open: number;
  readonly sides: ReadonlyArray<{ readonly side: ModuleSide; readonly kind: ModuleEdgeKind }>;
}

export type RefusedAction = "place" | "rotate" | "remove" | "undo" | "redo" | "track";

export interface RefusedEdit {
  readonly action: RefusedAction;
  readonly item: string;
  readonly rule: RefusalRule;
  readonly message: string;
}

export interface GhostCheckView {
  readonly yPlates: number;
  readonly refusal: Refusal | null;
  readonly trackJoins: number;
  readonly uncertifiedTrack: number;
}

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

export type SaveState = "saved" | "saving" | "failed" | "off";

export interface WorldFileView {
  readonly id: string | null;
  readonly name: string;
  readonly placements: number;
  readonly track: number;
  readonly shards: number;
  readonly save: SaveState;
  readonly pinnedBundleVersion: string;
  readonly openMs: number;
}

export interface ExportedWorld {
  readonly fileName: string;
  readonly bytes: Uint8Array;
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

export interface SkippedCatalogModel {
  readonly name: string;
  readonly reason: string;
}

interface SkippedModel extends SkippedCatalogModel {
  readonly credit: ModelCredit;
}

interface CatalogSlot {
  readonly id: string;
  readonly group: string;
  readonly worldColor: number;
  readonly view: CatalogItemView;
  readonly model: string | null;
  readonly credit: ModelCredit | null;
}

interface StartedCatalog {
  readonly slots: ReadonlyArray<CatalogSlot>;
  readonly placeables: Array<Placeable | null>;
  readonly skipped: ReadonlyArray<SkippedModel>;
  readonly trains: ReadonlyArray<PlayModel>;
}

export type FarTierStatus = "loading" | "ready" | "unavailable";

export interface TrackBomLine {
  readonly piece: string;
  readonly title: string;
  readonly count: number;
}

export interface TrackSolveStats {
  readonly samples: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export type TrackCommitResult =
  | "laid"
  | "joined"
  | "refused-impossible"
  | "refused-limit"
  | "switch-straight"
  | "switch-branching"
  | "refused-off-baseplate"
  | "refused-overlap"
  | "refused-crosses-track";

export interface TrackPieceView {
  readonly item: string;
  readonly label: string;
  readonly snapped: boolean;
  readonly joins: number;
  readonly misses: number;
  readonly connector: number;
  readonly connectors: number;
  readonly mirror: string | null;
}

export interface TrackView {
  readonly pieces: number;
  readonly bom: ReadonlyArray<TrackBomLine>;
  readonly openEnds: number;
  readonly joins: number;
  readonly coincidentEndIssues: number;
  readonly gaps: ReadonlyArray<TrackGapView>;
  readonly switches: ReadonlyArray<SwitchLeverView>;
  readonly held: TrackPieceView | null;
  readonly drag: TrackDragView | null;
  readonly lastCommit: TrackCommitResult | null;
  readonly solve: TrackSolveStats | null;
  readonly selected: { readonly piece: number; readonly pieceId: string } | null;
}

export interface HoverView {
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
}

export interface PlaceableCoverView {
  readonly id: string;
  readonly studsDrawnPerPlacement: number;
  readonly studsCulledAtBake: number;
  readonly footprintCells: number;
  readonly flatCells: number;
  readonly heightPlates: number;
}

export interface EditorSnapshot {
  readonly status: EditorStatus;
  readonly error: string | null;
  readonly loadMs: number | null;
  readonly backend: BackendInfo | null;
  readonly catalog: ReadonlyArray<CatalogItemView>;
  readonly catalogSkipped: ReadonlyArray<SkippedCatalogModel>;
  readonly trackNotDrawable: ReadonlyArray<CatalogPartView>;
  readonly mode: EditorMode;
  readonly activeItem: string | null;
  readonly ghostRot: number;
  readonly hover: HoverView | null;
  readonly selection: SelectionView | null;
  readonly selectionRefusal: string | null;
  readonly placements: number;
  readonly history: HistoryView;
  readonly lastLatency: LatencySample | null;
  readonly latencies: ReadonlyArray<LatencySample>;
  readonly stats: EditorStats | null;
  readonly studs: StudTotals | null;
  readonly tier: ChunkTier | null;
  readonly farTier: FarTierStatus;
  readonly farTierError: string | null;
  readonly pendingItem: string | null;
  readonly meshes: MeshProgress;
  readonly measuring: boolean;
  readonly measurement: FrameMeasurement | null;
  readonly credits: EditorCredits | null;
  readonly roads: RoadJoinView;
  readonly showJoins: boolean;
  readonly snapRoads: boolean;
  readonly snap: RoadSnapView | null;
  readonly modules: ModuleJoinView;
  readonly moduleFit: ModuleFitView | null;
  readonly snapModules: boolean;
  readonly refusals: number;
  readonly lastRefusal: RefusedEdit | null;
  readonly ghost: GhostCheckView | null;
  readonly track: TrackView | null;
  readonly bundleVersion: string | null;
  readonly world: WorldFileView | null;
  readonly worlds: ReadonlyArray<WorldIndexEntry>;
  readonly fileError: string | null;
  readonly storageError: string | null;
  readonly readOnly: boolean;
  readonly unsavedEdits: boolean;
  readonly coldStartMs: number | null;
  readonly roadKits: ReadonlyArray<RoadKitView>;
  readonly roadKit: string | null;
  readonly roadStroke: RoadStrokeView | null;
  readonly lastRoadStroke: RoadStrokeResult | null;
  readonly roadErase: boolean;
  readonly catalogSearch: CatalogSearchView;
}

export interface EditorCredits {
  readonly partFiles: number;
  readonly partFilesLod: BundleLod;
  readonly models: ReadonlyArray<ModelCredit>;
}

export interface RoadPlacementDump {
  readonly id: number;
  readonly item: string;
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
}

export interface EditorDump {
  readonly refs: ReadonlyArray<string>;
  readonly chunkCounts: ReadonlyArray<readonly [number, number, number]>;
  readonly trackEnds: ReturnType<TrackDrawing["openEnds"]>;
  readonly frameShifts: ReadonlyArray<readonly [number, number, number]>;
  readonly covers: ReadonlyArray<PlaceableCoverView>;
  readonly placements: PlacementDump;
  readonly roadPlacements: ReadonlyArray<RoadPlacementDump>;
  readonly roads: RoadJoinReport;
  readonly studs: StudTotals;
}

export interface EditorOptions {
  readonly api: GraphicsApi;
  readonly pixelRatio: number;
  readonly look: LookSettings;
  readonly tier: ChunkTier | null;
}

export interface IEditor extends IBomSource {
  start(canvas: HTMLCanvasElement, options: EditorOptions): Promise<void>;
  subscribe(listener: () => void): () => void;
  snapshot(): EditorSnapshot;
  prefetch(id: string): Promise<boolean>;
  chooseItem(id: string | null): void;
  pointerMove(ndcX: number, ndcY: number): void;
  pointerLeave(): void;
  click(ndcX: number, ndcY: number, eventTimeMs: number): void;
  dragStart(ndcX: number, ndcY: number): boolean;
  dragMove(ndcX: number, ndcY: number): void;
  dragEnd(ndcX: number, ndcY: number, eventTimeMs: number): void;
  rotate(eventTimeMs: number, direction?: TurnDirection): void;
  mirrorPiece(): void;
  cycleConnector(): void;
  deleteSelection(eventTimeMs: number): void;
  undo(eventTimeMs: number): void;
  redo(eventTimeMs: number): void;
  setShowJoins(show: boolean): void;
  setSnapRoads(snap: boolean): void;
  setSnapModules(snap: boolean): void;
  goTo(x: number, z: number): void;
  readonly worldNameMaxLength: number;
  worldNameIssue(name: string): string | null;
  newWorld(name: string): Promise<boolean>;
  openWorld(id: string): Promise<boolean>;
  deleteWorld(id: string): Promise<boolean>;
  retrySave(): Promise<void>;
  exportWorld(): Promise<ExportedWorld>;
  importWorld(bytes: Uint8Array): Promise<boolean>;
  measureFrames(): void;
  cycleTier(): void;
  trackRoutes(): ReadonlyArray<TrackRouteView>;
  setRoadErase(erase: boolean): void;
  playSetup(): PlaySetup | null;
  loadPlayMeshes(): void;
  searchCatalog(query: string): void;
  dump(): EditorDump;
}

const EDITOR_LOD: BundleLod = "standard";
const FAR_LOD: BundleLod = "far";
const NO_LATTICE_REASON = "no stud lattice from the bake";
export const TRACK_ITEM_ID = `track:${TRACK_SYSTEM}`;
export const TRACK_PIECE_PREFIX = "track-piece:";
const TRACK_PIECE_GROUP = "track-pieces";
const TRACK_PIECE_GROUP_LABEL = "Track pieces";
const TRACK_ITEM_LABEL = "Track: 9V straights and R40 curves";
const TRACK_HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const TRACK_SNAP_RADIUS_LDU = 3 * STUD_LDU;
const P95 = 0.95;
const DEGREES_PER_QUARTER_TURN = 90;
const EDGE_KIND_NAMES: Readonly<Record<ModuleEdgeKind, string>> = {
  terrain: "terrain",
  road: "paved road",
  track: "earth track",
  path: "path",
  river: "river",
  rail: "rail",
  other: "non-MILS",
};
const STATS_INTERVAL_MS = 500;
const MEASURE_WARMUP_FRAMES = 5;
const MEASURED_FRAMES = 60;
const TIER_CYCLE: ReadonlyArray<ChunkTier | null> = [null, "near", "mid", "far"];

const MARKER_WIDTH_LDU = 6;
const MARKER_LIFT_LDU = 1;
const MARKER_HEIGHT_LDU = 2;
const CELL_MARKER_INSET_LDU = 2;
const CELL_MARKER_TOP_LDU = 1;
const LISTED_ROAD_ISSUES = 12;
const LISTED_MODULE_ISSUES = 12;
const EMPTY_MODULES: ModuleJoinView = {
  modules: 0,
  joined: 0,
  mismatched: 0,
  open: 0,
  offGrid: 0,
  issues: [],
};
const EMPTY_ROADS: RoadJoinView = {
  checkMs: 0,
  placements: 0,
  joinedCells: 0,
  openCells: 0,
  mismatchedCells: 0,
  overlaps: 0,
  issues: [],
};

function cellMarkers(cells: BaseCells, bottomY: number): EdgeMarker[] {
  const markers: EdgeMarker[] = [];
  for (let c = 0; c < cells.count; c++) {
    const x = (cells.cellX[c] ?? 0) * STUD_LDU;
    const z = (cells.cellZ[c] ?? 0) * STUD_LDU;
    markers.push({
      kind: "mismatch",
      box: {
        minX: x + CELL_MARKER_INSET_LDU,
        maxX: x + STUD_LDU - CELL_MARKER_INSET_LDU,
        minY: bottomY,
        maxY: CELL_MARKER_TOP_LDU,
        minZ: z + CELL_MARKER_INSET_LDU,
        maxZ: z + STUD_LDU - CELL_MARKER_INSET_LDU,
      },
    });
  }
  return markers;
}

function markerBox(segment: RoadEdgeSegment): EdgeMarker["box"] {
  const minY = segment.topLdu + MARKER_LIFT_LDU;
  const maxY = minY + MARKER_HEIGHT_LDU;
  switch (segment.side) {
    case "minX":
      return {
        minX: segment.line,
        maxX: segment.line + MARKER_WIDTH_LDU,
        minY,
        maxY,
        minZ: segment.from,
        maxZ: segment.to,
      };
    case "maxX":
      return {
        minX: segment.line - MARKER_WIDTH_LDU,
        maxX: segment.line,
        minY,
        maxY,
        minZ: segment.from,
        maxZ: segment.to,
      };
    case "minZ":
      return {
        minX: segment.from,
        maxX: segment.to,
        minY,
        maxY,
        minZ: segment.line,
        maxZ: segment.line + MARKER_WIDTH_LDU,
      };
    case "maxZ":
      return {
        minX: segment.from,
        maxX: segment.to,
        minY,
        maxY,
        minZ: segment.line - MARKER_WIDTH_LDU,
        maxZ: segment.line,
      };
    default: {
      const unhandled: never = segment.side;
      throw new Error(`unhandled side ${String(unhandled)}`);
    }
  }
}
const GHOST_LIFT_LDU = BRICK_LDU;
const VIEW_SAVE_DELAY_MS = 500;
const FIRST_WORLD_NAME = "World 1";

interface HeldPiece {
  readonly catalogIndex: number;
  readonly connector: number;
  readonly heading: number;
  readonly snap: PieceSnap | null;
}

const EDITOR_WORLD_NAME = "editor-world";
const FILE_NAME_UNSAFE = /[^A-Za-z0-9.-]+/gu;

interface EditorBomTables {
  readonly palette: MergedParts;
  readonly colors: ColorTable;
  readonly ldrawColors: ReadonlyArray<number>;
}

interface PendingAction {
  readonly step: HistoryStep;
  readonly action: EditAction;
  readonly item: string;
  readonly rot: number;
  readonly x: number;
  readonly z: number;
  readonly startMs: number;
  readonly rebuiltMs: number;
  readonly report: RebuildReport;
}

interface FrameTimes {
  readonly startMs: number;
  readonly submittedMs: number;
  readonly presentedMs: number;
}

function quantileOfSorted(sorted: Float64Array, fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? Number.NaN;
}

interface OpenWorld {
  readonly id: string | null;
  readonly name: string;
  readonly pinnedBundleVersion: string;
  readonly openMs: number;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\.+$/, "");
}

function snapToLattice(ldu: number): number {
  return Math.round(ldu / STUD_LDU) * STUD_LDU + 0;
}

function footprintArea(part: PartShapeAsset): number {
  return (part.boundsMax[0] - part.boundsMin[0]) * (part.boundsMax[2] - part.boundsMin[2]);
}

function colorOf(colors: ReadonlyArray<BundleColor>, code: number): BundleColor {
  const color = colors.find((c) => c.code === code);
  if (!color) throw new Error(`LDConfig has no colour ${code}`);
  return color;
}

function catalogItem(
  placeable: Placeable,
  colors: ReadonlyArray<BundleColor>,
  thumbnails: ReadonlyMap<string, string>,
): CatalogItemView {
  const colored = placeable.kind === "baseplate" || placeable.kind === "road-plate";
  const moduleStuds = placeable.module?.studs;
  return {
    id: placeable.id,
    label: placeable.label,
    group: placeable.group,
    groupLabel: placeable.groupLabel,
    color: colored ? colorOf(colors, placeable.worldColor) : null,
    kind: placeable.kind,
    parts: placeable.parts.count,
    studsWide: moduleStuds ?? Math.round((placeable.box.max[0] - placeable.box.min[0]) / STUD_LDU),
    studsDeep: moduleStuds ?? Math.round((placeable.box.max[2] - placeable.box.min[2]) / STUD_LDU),
    thumbnail: thumbnails.get(placeable.id) ?? null,
  };
}

function placeableSlot(
  placeable: Placeable,
  model: string | null,
  colors: ReadonlyArray<BundleColor>,
  thumbnails: ReadonlyMap<string, string>,
): CatalogSlot {
  return {
    id: placeable.id,
    group: placeable.group,
    worldColor: placeable.worldColor,
    view: catalogItem(placeable, colors, thumbnails),
    model,
    credit: placeable.credit,
  };
}

function studsAcross(min: number, max: number): number {
  return Math.round((max - min) / STUD_LDU);
}

function lazySlot(entry: BundleModelEntry, thumbnails: ReadonlyMap<string, string>): CatalogSlot {
  const id = `omr:${entry.name}`;
  const label = setLabel(entry);
  const aabb = entry.lattice?.aabb;
  return {
    id,
    group: id,
    worldColor: 0,
    view: {
      id,
      label,
      group: id,
      groupLabel: label,
      color: null,
      kind: "model",
      parts: entry.instances,
      studsWide: aabb ? studsAcross(aabb.min[0], aabb.max[0]) : 0,
      studsDeep: aabb ? studsAcross(aabb.min[2], aabb.max[2]) : 0,
      thumbnail: thumbnails.get(id) ?? null,
    },
    model: entry.name,
    credit: { name: entry.name, source: entry.source, sections: entry.sections },
  };
}

function setLabel(entry: {
  readonly name: string;
  readonly set: { readonly name: string; readonly year: number } | null;
}): string {
  return entry.set ? `${entry.name} ${entry.set.name} (${entry.set.year})` : entry.name;
}

function undrawableTrack(
  bundleParts: ReadonlyArray<PartShapeAsset>,
  track: TrackDrawing,
  parts: ReadonlyArray<PartShapeAsset>,
): ReadonlyArray<CatalogPartView> {
  const drawable = new Set(track.pieceParts().map((kit) => parts[kit.partIndex]?.id));
  return bundleParts
    .filter((part) => part.role === "track" && !drawable.has(part.id))
    .map((part) => ({ id: part.id.replace("ldraw:", ""), title: part.title }));
}

@injectable()
export class Editor implements IEditor {
  private readonly listeners = new Set<() => void>();
  private state: EditorSnapshot = {
    status: "loading",
    error: null,
    loadMs: null,
    backend: null,
    catalog: [],
    catalogSkipped: [],
    trackNotDrawable: [],
    mode: "select",
    activeItem: null,
    ghostRot: 0,
    hover: null,
    selection: null,
    selectionRefusal: null,
    placements: 0,
    history: { undo: null, redo: null, undoDepth: 0, redoDepth: 0 },
    lastLatency: null,
    latencies: [],
    stats: null,
    studs: null,
    tier: null,
    farTier: "loading",
    farTierError: null,
    pendingItem: null,
    meshes: { wanted: 0, loaded: 0, failed: 0 },
    measuring: false,
    measurement: null,
    credits: null,
    roads: EMPTY_ROADS,
    showJoins: true,
    snapRoads: true,
    snap: null,
    modules: EMPTY_MODULES,
    moduleFit: null,
    snapModules: true,
    refusals: 0,
    lastRefusal: null,
    ghost: null,
    track: null,
    bundleVersion: null,
    world: null,
    worlds: [],
    fileError: null,
    storageError: null,
    readOnly: false,
    unsavedEdits: false,
    coldStartMs: null,
    roadKits: [],
    roadKit: null,
    roadStroke: null,
    lastRoadStroke: null,
    roadErase: false,
    catalogSearch: { query: "", status: "off", hits: [] },
  };
  private world = new World();
  private history = new EditHistory(this.world);
  private readonly dirty = new DirtyShards();
  private current: OpenWorld | null = null;
  private bundleVersion = "";
  private viewDirty = false;
  private lastView: SavedViewV1 | null = null;
  private saveScheduled = false;
  private viewTimer: ReturnType<typeof setTimeout> | null = null;
  private fileQueue: Promise<void> = Promise.resolve();
  private firstWorldFrame = false;
  private creditsView: Promise<CreditsView> | null = null;
  private lease: WorldLease | null = null;
  private readOnly = false;
  private storageError: string | null = null;
  private saveFailed = false;
  private lastSaveError: string | null = null;
  private readonly ray = new Float64Array(RAY_FLOATS);
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
  private placeables: Array<Placeable | null> = [];
  private slots: ReadonlyArray<CatalogSlot> = [];
  private readonly placeableLoads = new Map<number, Promise<Placeable>>();
  private palette: MergedParts | null = null;
  private colors: ColorTable | null = null;
  private meshes: PartMeshStream | null = null;
  private installedColors = 0;
  private readonly farModelIndex = new Map<string, number>();
  private farReady = false;
  private placed: PlacedChunks;
  private active: Placeable | null = null;
  private selected: PlacedModel | null = null;
  private ghostRot = 0;
  private placeRot = 0;
  private turnDirection: TurnDirection = 1;
  private hoverX = 0;
  private hoverZ = 0;
  private hoverYPlates = 0;
  private hoverRefusal: Refusal | null = null;
  private ghostCheck: PlacementCheck | null = null;
  private refusalMarkers: ReadonlyArray<EdgeMarker> = [];
  private tableY = 0;
  private trackCatalog: TrackCatalog = { n: ZETA16_ORDER, pieces: [] };
  private hovering = false;
  private hitX = 0;
  private hitZ = 0;
  private track: TrackDrawing | null = null;
  private newTrack: (() => TrackDrawing) | null = null;
  private roadDrawing: RoadDrawing | null = null;
  private roadPreviewMarkers: ReadonlyArray<EdgeMarker> = [];
  private play: Omit<PlaySetup, "track"> | null = null;
  private lastTrackCommit: TrackCommitResult | null = null;
  private trackEndTarget = "";
  private held: HeldPiece | null = null;
  private selectedTrack: number | null = null;
  private pending: PendingAction | null = null;
  private roadModels: ReadonlyArray<PlacedModel> = [];
  private roadExtents: ReadonlyArray<CellExtent> = [];
  private roadNetwork = new RoadNetwork([]);
  private roadReport: RoadJoinReport = new RoadNetwork([]).report();
  private modules: ModuleLayout | null = null;
  private moduleGhost: ModuleCandidate | null = null;
  private refusalPlacement: GridPlacement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private framesSinceStats = 0;
  private measureFrame = -1;
  private readonly measuredFrameMs = new Float64Array(MEASURED_FRAMES);
  private readonly measuredCpuMs = new Float64Array(MEASURED_FRAMES);
  private statsSince = 0;
  private bomTables: EditorBomTables | null = null;
  private readonly notDrawnByPlaceable = new Map<Placeable, ReadonlyArray<NotDrawnSection>>();
  private readonly modelPlaceables = new Map<string, Placeable>();
  private readonly modelNames = new Map<Placeable, string>();
  private readonly trainParts = new Map<string, Uint16Array>();

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) private readonly backend: ISceneBackend,
    @inject(PLAN_SERVICE) private readonly plans: IPlanService,
    @inject(EDITOR_CAMERA) private readonly camera: IEditorCamera,
    @inject(WORLD_REPOSITORY) private readonly repository: IWorldRepository,
    @inject(TRADEMARK_DISCLAIMER) private readonly disclaimer: string,
    @inject(CREDITS) private readonly credits: ICredits,
    @inject(WORLD_LOCKS) private readonly locks: IWorldLocks,
    @inject(CATALOG_SEARCH) private readonly catalogSearch: ICatalogSearch,
    @inject(BUNDLE_BASE_URL) private readonly bundleBaseUrl: string,
  ) {
    this.placed = new PlacedChunks(backend);
    this.state = { ...this.state, catalogSearch: catalogSearch.view() };
    catalogSearch.subscribe(() => this.update({ catalogSearch: catalogSearch.view() }));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): EditorSnapshot {
    return this.state;
  }

  private update(patch: Partial<EditorSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  async start(canvas: HTMLCanvasElement, options: EditorOptions): Promise<void> {
    try {
      const started = performance.now();
      this.canvas = canvas;
      const backend = await this.backend.init({
        canvas,
        api: options.api,
        pixelRatio: options.pixelRatio,
        antialias: true,
        look: options.look,
      });
      this.backend.forceTier(options.tier);
      this.update({ tier: options.tier });
      const index = await this.loader.loadIndex(EDITOR_LOD);
      this.bundleVersion = index.bundleVersion;
      this.trackCatalog = index.trackCatalog;
      const colorSource = { colors: index.colors, parts: [] };
      const colors = new ColorTable(colorSource);
      for (const color of index.colors) colors.indexOfCode(color.code);
      this.colors = colors;
      const startModels = index.models.filter(
        (entry) => entry.role === "mils-module" || (entry.origin === "omr" && entry.vehicles > 0),
      );
      const [studPrimitives, shapes, startRecords, trackSilhouettes] = await Promise.all([
        this.loader.loadStudPrimitives(EDITOR_LOD),
        Promise.all(index.catalogParts.map((part) => this.loader.loadPartShape(EDITOR_LOD, part))),
        Promise.all(
          startModels.map((entry) => this.loader.loadModelRecord(EDITOR_LOD, entry.name)),
        ),
        this.loader.loadTrackSilhouettes(EDITOR_LOD),
      ]);
      const palette = new MergedParts(shapes.map(withPlaceholderMesh));
      this.palette = palette;
      this.meshes = new PartMeshStream(this.loader, this.backend, palette, EDITOR_LOD, (meshes) =>
        this.update({ meshes }),
      );
      for (const shape of shapes) this.meshes.register(palette.indexOf(shape.id), shape.meshFile);
      const { slots, placeables, skipped, trains } = this.buildCatalog(index, shapes, startRecords);
      this.slots = slots;
      this.placeables = placeables;
      this.modules = new ModuleLayout(index.milsEdgeRules);
      this.play = { models: trains, parts: palette.parts, colors };
      this.plans.setTableTopY(this.baseplateBottomY());
      this.newTrack = () =>
        new TrackDrawing({ ...index, trackSilhouettes }, palette.parts, colors, {
          support: (cells) => this.placed.trackSupport(cells, []),
          overlap: (cells, bottom, top, exempt) =>
            this.placed.trackOverlap(cells, bottom, top, exempt),
          neighbours: (cells) => this.placed.trackNeighbours(cells),
          laid: (piece, pieceId, cells, bottom, top) =>
            this.placed.addTrackPiece(piece, pieceId, cells, bottom, top),
          relaid: (pieces) => this.placed.replaceTrackPieces(pieces),
        });
      this.track = this.newTrack();
      this.bomTables = { palette, colors, ldrawColors: index.colors.map((color) => color.code) };
      this.roadDrawing = new RoadDrawing(
        this.loadedPlaceables(),
        (family, placeable) =>
          family === "mils"
            ? "MILS road modules"
            : `${colorOf(index.colors, placeable.worldColor).name.replaceAll("_", " ")} road plates`,
        this.roadRules,
      );
      this.backend.setPalette({
        detailed: { parts: palette.parts, studPrimitives },
        colorsSrgb: colors.toSrgb(),
        colorsAlpha: colors.toAlpha(),
        ldrawColors: ldrawColors(colorSource),
      });
      this.installedColors = colors.size;
      const loadMs = performance.now() - started;
      await this.openFirstWorld();
      this.firstWorldFrame = true;
      this.update({
        status: "ready",
        loadMs,
        bundleVersion: index.bundleVersion,
        backend,
        catalog: [
          ...slots.map((slot) => slot.view),
          this.trackItem(this.track, palette.parts),
          ...this.trackPieceItems(this.track, palette.parts),
        ],
        catalogSkipped: skipped.map(({ name, reason }) => ({ name, reason })),
        trackNotDrawable: undrawableTrack(shapes, this.track, palette.parts),
        roadKits: this.roadDrawing.kitViews(),
        roadKit: this.roadDrawing.activeKit()?.id ?? null,
        track: this.trackView(),
        credits: {
          partFiles: 0,
          partFilesLod: EDITOR_LOD,
          models: [
            ...slots.flatMap((slot) => (slot.credit ? [slot.credit] : [])),
            ...skipped.map(({ credit }) => credit),
          ],
        },
      });
      this.statsSince = performance.now();
      this.resizeToCanvas();
      this.camera.frame(performance.now());
      requestAnimationFrame(this.step);
      void this.startFarTier();
      void this.countCreditedFiles();
    } catch (error) {
      this.update({ status: "error", error: String(error) });
    }
  }

  private async startFarTier(): Promise<void> {
    try {
      const [studPrimitives, farFiles] = await Promise.all([
        this.loader.loadStudPrimitives(FAR_LOD),
        this.loader.loadPartFiles(FAR_LOD),
      ]);
      this.backend.setFarStuds(studPrimitives);
      this.meshes?.useFarFiles(farFiles);
      this.farReady = true;
      for (const model of this.placed.models()) this.requestFarModel(model.placeable);
      this.update({ farTier: "ready" });
    } catch (error) {
      this.update({ farTier: "unavailable", farTierError: errorText(error) });
    }
  }

  private requestFarModel(placeable: Placeable): void {
    if (!this.farReady) return;
    const name = this.modelNames.get(placeable);
    if (name === undefined || this.farModelIndex.has(name)) return;
    const farModel = this.farModelIndex.size;
    this.farModelIndex.set(name, farModel);
    void this.loader.loadFarModelMesh(name, "low").then(
      (mesh) => {
        if (!mesh) return;
        this.backend.setFarModelMesh(farModel, mesh);
        this.placed.useFarModel(placeable, farModel);
      },
      (error: unknown) => this.update({ farTierError: errorText(error) }),
    );
  }

  private async countCreditedFiles(): Promise<void> {
    try {
      const manifest = await this.loader.loadManifest(EDITOR_LOD);
      const credits = this.state.credits;
      if (credits) this.update({ credits: { ...credits, partFiles: manifest.credits.length } });
    } catch (error) {
      this.update({ fileError: `the part credits can't be loaded: ${errorText(error)}` });
    }
  }

  private loadedPlaceables(): ReadonlyArray<Placeable> {
    return this.placeables.filter((placeable) => placeable !== null);
  }

  private buildCatalog(
    index: BundleIndex,
    shapes: ReadonlyArray<PartShapeRecord>,
    startRecords: ReadonlyArray<ModelRecord>,
  ): StartedCatalog {
    const palette = this.requirePalette();
    const colors = this.requireColors();
    const thumbnails = thumbnailUrls(this.bundleBaseUrl, EDITOR_LOD, index.thumbnails);
    const shapeById = new Map(shapes.map((shape) => [shape.id, shape]));
    const shapeOf = (id: string): PartShapeRecord => {
      const shape = shapeById.get(id);
      if (!shape) throw new Error(`${id} has no shape in the bundle`);
      return shape;
    };
    const groundParts = index.catalogParts
      .filter((part) => part.role === "ground")
      .map((part) => shapeOf(part.id))
      .toSorted((a, b) => footprintArea(b) - footprintArea(a));
    const roadParts = index.catalogParts
      .filter((part) => part.role === "road")
      .map((part) => shapeOf(part.id));
    const baseplate = groundParts[0];
    if (!baseplate) throw new Error("the bundle has no baseplate");
    this.tableY = baseplate.boundsMin[1];
    const placeables: Array<Placeable | null> = [...groundParts, ...roadParts].flatMap((part) => {
      if (part.producedColors.length === 0) {
        throw new Error(`${part.id} has no produced colour in the bundle`);
      }
      return part.producedColors.map((code) =>
        partPlaceable(
          part,
          palette.indexOf(part.id),
          code,
          colorOf(index.colors, code).name,
          palette.parts,
          colors,
          this.tableY,
        ),
      );
    });
    const slots: CatalogSlot[] = placeables.flatMap((placeable) =>
      placeable ? [placeableSlot(placeable, null, index.colors, thumbnails)] : [],
    );
    const records = new Map(startRecords.map((record) => [record.entry.name, record]));
    const skipped: SkippedModel[] = [];
    const models = [
      ...index.models.filter((entry) => entry.role === "mils-module"),
      ...index.models.filter((entry) => entry.origin === "omr"),
    ];
    for (const entry of models) {
      if (entry.lattice === null) {
        skipped.push({
          name: entry.name,
          reason: NO_LATTICE_REASON,
          credit: { name: entry.name, source: entry.source, sections: entry.sections },
        });
        continue;
      }
      const record = records.get(entry.name);
      const placeable = record ? this.modelPlaceableFrom(record) : null;
      placeables.push(placeable);
      slots.push(
        placeable
          ? placeableSlot(placeable, entry.name, index.colors, thumbnails)
          : lazySlot(entry, thumbnails),
      );
    }
    const trains = startRecords
      .filter((record) => record.model.vehicles.length > 0)
      .map((record) => this.playModelFrom(record));
    return { slots, placeables, skipped, trains };
  }

  private playModelFrom(record: ModelRecord): PlayModel {
    const palette = this.requirePalette();
    const parts = record.parts.map(withPlaceholderMesh);
    const model = playModel(record.entry, record.model, { parts }, palette, this.requireColors());
    for (const part of record.parts) this.meshes?.register(palette.indexOf(part.id), part.meshFile);
    this.trainParts.set(record.entry.name, model.model.partIndex);
    return model;
  }

  loadPlayMeshes(): void {
    for (const partIndex of this.trainParts.values()) {
      this.meshes?.request(new Set(partIndex), "high");
    }
  }

  private requirePalette(): MergedParts {
    if (!this.palette) throw new Error("the editor has no palette before it starts");
    return this.palette;
  }

  private requireColors(): ColorTable {
    if (!this.colors) throw new Error("the editor has no colour table before it starts");
    return this.colors;
  }

  private modelPlaceableFrom(record: ModelRecord): Placeable {
    const palette = this.requirePalette();
    const colors = this.requireColors();
    const { entry, model } = record;
    const before = palette.parts.length;
    const merged = palette.remap(model, record.parts.map(withPlaceholderMesh));
    for (const part of record.parts) this.meshes?.register(palette.indexOf(part.id), part.meshFile);
    const placeable = modelPlaceable(
      entry.name,
      entry.role === "mils-module" ? (model.sections[0]?.title ?? entry.name) : setLabel(entry),
      entry.role,
      merged,
      { name: entry.name, source: entry.source, sections: model.sections },
      palette.parts,
      colors,
      null,
      this.tableY,
      this.trackCatalog,
    );
    if (this.palette === palette && this.installedColors > 0) {
      this.backend.addParts(palette.parts.slice(before));
      this.syncColors();
    }
    this.notDrawnByPlaceable.set(placeable, entry.notDrawn ?? []);
    this.modelPlaceables.set(entry.name, placeable);
    this.modelNames.set(placeable, entry.name);
    return placeable;
  }

  private syncColors(): void {
    const colors = this.requireColors();
    if (colors.size === this.installedColors) return;
    this.installedColors = colors.size;
    this.backend.setColors(colors.toSrgb(), colors.toAlpha());
  }

  private ensurePlaceable(refId: number): Promise<Placeable> {
    const loaded = this.placeables[refId];
    if (loaded) return Promise.resolve(loaded);
    const pending = this.placeableLoads.get(refId);
    if (pending) return pending;
    const model = this.slots[refId]?.model;
    if (model === undefined || model === null) {
      return Promise.reject(new Error(`no catalog item has ref id ${refId}`));
    }
    const loading = this.loader.loadModelRecord(EDITOR_LOD, model).then((record) => {
      const placeable = this.placeables[refId] ?? this.modelPlaceableFrom(record);
      this.placeables[refId] = placeable;
      return placeable;
    });
    this.placeableLoads.set(refId, loading);
    loading.then(
      () => this.placeableLoads.delete(refId),
      () => this.placeableLoads.delete(refId),
    );
    return loading;
  }

  private requestMeshes(placeable: Placeable, priority: FetchPriority): void {
    this.meshes?.request(new Set(placeable.parts.partIndex), priority);
  }

  private requestTrackMeshes(track: TrackDrawing): void {
    this.meshes?.request(
      track.pieceParts().map((kit) => kit.partIndex),
      "high",
    );
  }

  async prefetch(id: string): Promise<boolean> {
    const refId = this.slots.findIndex((slot) => slot.id === id);
    if (refId < 0) return false;
    try {
      await this.ensurePlaceable(refId);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureShardPlaceables(shards: ReadonlyArray<WorldShardV1>): Promise<void> {
    const refIds = new Set<number>();
    for (const shard of shards) {
      for (const placement of shard.placements) {
        const target = this.resolveRef(placement.ref, placement.color);
        if (target) refIds.add(target.refId);
      }
    }
    await Promise.all([...refIds].map((refId) => this.ensurePlaceable(refId)));
  }

  private baseplateBottomY(): number {
    const baseplate = this.loadedPlaceables().find((p) => p.kind === "baseplate");
    if (!baseplate) throw new Error("the bundle has no baseplate");
    return baseplate.box.min[1];
  }

  private syncPlan(): void {
    this.plans.setPlacements([
      ...this.placed.models().map((model) => ({
        key: { chunkKey: model.handle.chunkKey, slot: model.handle.slot },
        ref: model.placeable.id,
        label: `${model.placeable.label} at ${model.handle.x}, ${model.handle.z}`,
        box: model.box,
      })),
      ...(this.track?.planFootprints() ?? []),
    ]);
  }

  private readonly step = (): void => {
    void this.frame();
  };

  private async frame(): Promise<void> {
    try {
      this.resizeToCanvas();
      const startMs = performance.now();
      this.camera.frame(startMs);
      this.watchView();
      this.backend.renderFrame(this.frameStats);
      const pending = this.pending;
      if (pending) {
        this.pending = null;
        const submittedMs = performance.now();
        await this.backend.waitForGpu();
        this.recordLatency(pending, { startMs, submittedMs, presentedMs: performance.now() });
      } else if (this.measureFrame >= 0) {
        const submittedMs = performance.now();
        await this.backend.waitForGpu();
        this.recordMeasuredFrame(startMs, submittedMs, performance.now());
      }
      if (this.firstWorldFrame) {
        this.firstWorldFrame = false;
        await this.backend.waitForGpu();
        this.update({ coldStartMs: performance.now() });
      }
      this.tallyStats();
      requestAnimationFrame(this.step);
    } catch (error) {
      this.update({ status: "error", error: String(error) });
    }
  }

  private resizeToCanvas(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.dataset["cssSize"] === `${width}x${height}`) return;
    canvas.dataset["cssSize"] = `${width}x${height}`;
    this.backend.resize(width, height);
    this.camera.resize(width, height);
  }

  private tallyStats(): void {
    this.framesSinceStats++;
    const now = performance.now();
    const elapsed = now - this.statsSince;
    if (elapsed < STATS_INTERVAL_MS) return;
    this.update({
      stats: {
        fps: (this.framesSinceStats * 1000) / elapsed,
        drawCalls: this.frameStats.drawCalls,
        triangles: this.frameStats.triangles,
        renderOriginChunkX: this.frameStats.renderOriginChunkX,
        renderOriginChunkZ: this.frameStats.renderOriginChunkZ,
        rebases: this.frameStats.rebaseCount,
        nearChunks: this.frameStats.nearChunks,
        midChunks: this.frameStats.midChunks,
        farChunks: this.frameStats.farChunks,
        nearestStudPitchPx: this.frameStats.nearestStudPitchPx,
      },
    });
    this.framesSinceStats = 0;
    this.statsSince = now;
  }

  cycleTier(): void {
    const next = TIER_CYCLE[(TIER_CYCLE.indexOf(this.state.tier) + 1) % TIER_CYCLE.length] ?? null;
    this.backend.forceTier(next);
    this.update({ tier: next, measurement: null });
  }

  measureFrames(): void {
    if (this.measureFrame >= 0 || this.state.status !== "ready") return;
    this.measureFrame = 0;
    this.update({ measuring: true });
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
    this.update({
      measuring: false,
      measurement: {
        frames: MEASURED_FRAMES,
        medianFrameMs: quantileOfSorted(frames, 0.5),
        p95FrameMs: quantileOfSorted(frames, P95),
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

  private recordLatency(pending: PendingAction, frame: FrameTimes): void {
    const sample: LatencySample = {
      step: pending.step,
      action: pending.action,
      item: pending.item,
      rot: pending.rot,
      x: pending.x,
      z: pending.z,
      ms: frame.presentedMs - pending.startMs,
      rebuildMs: pending.rebuiltMs - pending.startMs,
      queueMs: frame.startMs - pending.rebuiltMs,
      submitMs: frame.submittedMs - frame.startMs,
      gpuWaitMs: frame.presentedMs - frame.submittedMs,
      rebuiltChunks: pending.report.chunks,
      rebuiltInstances: pending.report.instances,
      rebuiltStuds: pending.report.studs,
    };
    this.update({ lastLatency: sample, latencies: [...this.state.latencies, sample] });
  }

  private trackItem(track: TrackDrawing, parts: ReadonlyArray<PartShapeAsset>): CatalogItemView {
    const straight = track.kitParts().find((k) => k.piece.kind === "straight");
    const part = straight ? parts[straight.partIndex] : undefined;
    return {
      id: TRACK_ITEM_ID,
      label: TRACK_ITEM_LABEL,
      group: TRACK_ITEM_ID,
      groupLabel: TRACK_ITEM_LABEL,
      color: null,
      kind: "track",
      parts: track.kitParts().length,
      studsWide: part ? Math.round((part.boundsMax[0] - part.boundsMin[0]) / STUD_LDU) : 0,
      studsDeep: part ? Math.round((part.boundsMax[2] - part.boundsMin[2]) / STUD_LDU) : 0,
      thumbnail: null,
    };
  }

  private trackPieceItems(
    track: TrackDrawing,
    parts: ReadonlyArray<PartShapeAsset>,
  ): ReadonlyArray<CatalogItemView> {
    return track.pieceSet.palette().map((catalogIndex) => {
      const kit = track.pieceByIndex(catalogIndex);
      const part = parts[kit.partIndex];
      const { element, title } = track.pieceSet.element(catalogIndex);
      return {
        id: `${TRACK_PIECE_PREFIX}${kit.piece.id}`,
        label: `${element.replace(/^[a-z]+:/u, "")} ${title}`,
        group: TRACK_PIECE_GROUP,
        groupLabel: TRACK_PIECE_GROUP_LABEL,
        color: null,
        kind: "track",
        parts: 1,
        studsWide: part ? Math.round((part.boundsMax[0] - part.boundsMin[0]) / STUD_LDU) : 0,
        studsDeep: part ? Math.round((part.boundsMax[2] - part.boundsMin[2]) / STUD_LDU) : 0,
        thumbnail: null,
      };
    });
  }

  private bomLines(track: TrackDrawing): ReadonlyArray<TrackBomLine> {
    const lines = new Map<string, TrackBomLine>();
    for (const kit of track.pieceParts()) {
      const { element, title } = track.pieceSet.element(kit.catalogIndex);
      const count = track.countOf(kit.catalogIndex);
      const line = lines.get(element);
      lines.set(element, { piece: element, title, count: (line?.count ?? 0) + count });
    }
    return [...lines.values()].filter(
      (line) => line.count > 0 || track.kitParts().some((k) => k.piece.part === line.piece),
    );
  }

  private heldView(track: TrackDrawing): TrackPieceView | null {
    const held = this.held;
    if (!held) return null;
    const kit = track.pieceByIndex(held.catalogIndex);
    const { element, title } = track.pieceSet.element(held.catalogIndex);
    const mirror = track.pieceSet.mirrored(held.catalogIndex);
    const count = kit.def.connectors.length;
    return {
      item: kit.piece.id,
      label: `${element.replace(/^[a-z]+:/u, "")} ${title}`,
      snapped: held.snap?.end !== null && held.snap !== null,
      joins: held.snap?.joins ?? 0,
      misses: held.snap?.misses.length ?? 0,
      connector: ((held.connector % count) + count) % count,
      connectors: count,
      mirror: mirror === null ? null : track.pieceSet.element(mirror).title,
    };
  }

  private trackView(): TrackView | null {
    const track = this.track;
    if (!track) return null;
    const samples = track.solveSamplesMs.toSorted((a, b) => a - b);
    const at = (q: number): number =>
      samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ?? 0;
    return {
      pieces: track.pieceCount,
      bom: this.bomLines(track),
      openEnds: track.openEnds().length,
      joins: track.joinedPairs(),
      coincidentEndIssues: track.coincidentEndIssues(),
      gaps: track.gaps(),
      switches: track.switchLevers(),
      held: this.heldView(track),
      drag: track.dragView(),
      lastCommit: this.lastTrackCommit,
      solve:
        samples.length === 0
          ? null
          : {
              samples: samples.length,
              medianMs: at(0.5),
              p95Ms: at(P95),
              maxMs: samples.at(-1) ?? 0,
            },
      selected:
        this.selectedTrack === null
          ? null
          : { piece: this.selectedTrack, pieceId: track.pieceId(this.selectedTrack) },
    };
  }

  private showTrackEnds(target: number | null, misses: ReadonlyArray<number> = []): void {
    const track = this.track;
    if (!track) return;
    this.trackEndTarget = `${target}|${misses.join(",")}`;
    const gapped = track.gappedEnds();
    this.backend.setTrackEnds(
      track.openEnds().map((end, index) => ({
        xLdu: end.xLdu,
        yLdu: 0,
        zLdu: end.zLdu,
        headingRadians: end.heading * TRACK_HEADING_RADIANS,
        kind:
          index === target
            ? "target"
            : gapped.has(index) || misses.includes(index)
              ? "gap"
              : "open",
      })),
    );
  }

  private targetTrackEnd(target: number | null, misses: ReadonlyArray<number> = []): void {
    if (`${target}|${misses.join(",")}` !== this.trackEndTarget) this.showTrackEnds(target, misses);
  }

  private showTrackGhost(track: TrackDrawing): void {
    const ghost = track.ghost();
    this.backend.setGhost(ghost ? ghost.instances : null);
    if (ghost) this.backend.placeGhost(ghost.x, 0, ghost.z, 0);
  }

  private roadNeighbours(): readonly [ReadonlyArray<PlacedModel>, ReadonlyArray<PlacedModel>] {
    return [this.roadModels, this.placed.models().filter((model) => model.placeable.road === null)];
  }

  private showRoadPreview(preview: RoadPreview | null): void {
    if (!preview) return;
    this.backend.setGhost(preview.ghost);
    if (preview.ghost) this.backend.placeGhost(preview.ghost.originX, 0, preview.ghost.originZ, 0);
    this.roadPreviewMarkers = preview.markers;
    this.showMarkers();
    this.update({ roadStroke: preview.view });
  }

  private clearRoadPreview(): void {
    this.backend.setGhost(null);
    this.roadPreviewMarkers = [];
    this.showMarkers();
  }

  private roadDragStart(ndcX: number, ndcY: number): boolean {
    const roads = this.roadDrawing;
    if (!roads || this.readOnly || !this.groundHit(ndcX, ndcY)) return false;
    this.showRoadPreview(roads.begin(this.hitX, this.hitZ, ...this.roadNeighbours()));
    return true;
  }

  private roadDragEnd(ndcX: number, ndcY: number, eventTimeMs: number): void {
    const roads = this.roadDrawing;
    if (!roads) return;
    if (this.readOnly) {
      roads.cancel();
      this.clearRoadPreview();
      return;
    }
    if (this.groundHit(ndcX, ndcY)) roads.extend(this.hitX, this.hitZ);
    const stroke = roads.end(...this.roadNeighbours());
    this.clearRoadPreview();
    if (!stroke) return;
    if (stroke.requests.length === 0) {
      this.update({
        roadStroke: stroke.view,
        lastRoadStroke:
          stroke.view.issues.length > 0 ? { result: "refused", stroke: stroke.view } : null,
      });
      return;
    }
    this.show(this.history.commit("road", stroke.requests), eventTimeMs);
    this.update({ roadStroke: null, lastRoadStroke: { result: "laid", stroke: stroke.view } });
  }

  dragStart(ndcX: number, ndcY: number): boolean {
    if (this.state.mode === "road") return this.roadDragStart(ndcX, ndcY);
    const track = this.track;
    if (this.state.mode !== "track" || !track || this.readOnly || this.held) return false;
    if (!this.groundHit(ndcX, ndcY)) return false;
    this.showRefusalCells(null);
    track.beginDrag(this.hitX, this.hitZ, this.hoverX, this.hoverZ);
    this.update({ track: this.trackView() });
    return true;
  }

  dragMove(ndcX: number, ndcY: number): void {
    if (this.state.mode === "road") {
      if (this.roadDrawing && this.groundHit(ndcX, ndcY)) {
        this.showRoadPreview(this.roadDrawing.move(this.hitX, this.hitZ, ...this.roadNeighbours()));
      }
      return;
    }
    const track = this.track;
    if (!track || !this.groundHit(ndcX, ndcY)) return;
    track.moveDrag(this.hitX, this.hitZ);
    this.showTrackGhost(track);
    const target = track.dragTarget();
    this.targetTrackEnd(
      target?.joins ? target.end : null,
      target && !target.joins ? [target.end] : [],
    );
    this.showRefusalCells(track.dragView()?.blocked?.missing ?? null);
    this.update({ track: this.trackView() });
  }

  dragEnd(ndcX: number, ndcY: number, eventTimeMs: number): void {
    if (this.state.mode === "road") {
      this.roadDragEnd(ndcX, ndcY, eventTimeMs);
      return;
    }
    const track = this.track;
    if (!track) return;
    const hit = this.groundHit(ndcX, ndcY);
    if (hit) track.moveDrag(this.hitX, this.hitZ);
    const stayed = (track.dragView()?.pieces ?? 0) === 0;
    const commit = track.endDrag();
    if (hit && stayed && this.throwSwitchAt(this.hitX, this.hitZ, eventTimeMs)) {
      this.backend.setGhost(null);
      this.showTrackEnds(null);
      return;
    }
    this.backend.setGhost(null);
    this.showTrackEnds(null);
    let instances = 0;
    let studs = 0;
    for (const key of commit.chunks) {
      const chunk = track.chunkInstances(key);
      if (!chunk) continue;
      this.backend.setChunk(key, chunk);
      instances += chunk.count;
      studs += chunk.studs.count;
    }
    if (commit.laid > 0) {
      this.pending = {
        step: "do",
        action: "track",
        item: TRACK_ITEM_ID,
        rot: 0,
        x: this.hoverX,
        z: this.hoverZ,
        startMs: eventTimeMs,
        rebuiltMs: performance.now(),
        report: { chunks: commit.chunks.length, instances, studs },
      };
    }
    if (commit.laid > 0) {
      this.syncPlan();
      this.trackEdited();
    }
    if (commit.laid === 0 && commit.refusal === null)
      this.selectTrack(track.pieceAt(this.hitX, this.hitZ));
    if (commit.refusal) this.lastTrackCommit = `refused-${commit.refusal}`;
    else if (commit.laid > 0) this.lastTrackCommit = commit.joined ? "joined" : "laid";
    this.showRefusalCells(commit.blocked?.missing ?? null);
    if (commit.blocked) this.refuse("track", TRACK_ITEM_ID, trackRunRefusal(commit.blocked));
    this.update({ track: this.trackView() });
  }

  private requestKitMeshes(kitId: string): void {
    const kit = this.roadDrawing?.kitViews().find((view) => view.id === kitId);
    for (const piece of kit?.pieces ?? []) {
      const placeable = this.placeables[this.slots.findIndex((slot) => slot.id === piece.item)];
      if (placeable) this.requestMeshes(placeable, "high");
    }
  }

  private enterRoadMode(id: string): void {
    this.requestKitMeshes(id);
    this.ghostRot = this.placeRot;
    if (this.roadDrawing) this.roadDrawing.preferredRot = this.placeRot;
    if (this.state.mode === "track") {
      this.held = null;
      this.track?.cancelDrag();
      this.targetTrackEnd(null);
    }
    this.active = null;
    this.backend.setGhost(null);
    this.select(null);
    if (this.roadDrawing) this.roadDrawing.erasing = false;
    this.update({
      roadErase: false,
      mode: "road",
      activeItem: id,
      ghostRot: this.ghostRot,
      roadKit: id,
      roadStroke: null,
      lastRoadStroke: null,
      track: this.trackView(),
    });
  }

  private leaveRoadMode(): void {
    this.roadDrawing?.cancel();
    if (this.roadDrawing) this.roadDrawing.erasing = false;
    this.clearRoadPreview();
    this.update({ mode: "select", activeItem: null, roadStroke: null, roadErase: false });
  }

  chooseItem(id: string | null): void {
    if (id !== null && this.readOnly) return;
    this.showRefusalCells(null);
    if (this.state.mode === "road" && id !== this.state.activeItem) this.leaveRoadMode();
    if (id?.startsWith(ROAD_KIT_PREFIX) && this.roadDrawing?.choose(id)) {
      this.enterRoadMode(id);
      return;
    }
    const track = this.track;
    const pieceIndex = id === null || !track ? null : this.trackPieceIndex(track, id);
    if ((id === TRACK_ITEM_ID || pieceIndex !== null) && track) {
      this.active = null;
      this.moduleGhost = null;
      this.showMarkers();
      track.cancelDrag();
      this.held =
        pieceIndex === null
          ? null
          : { catalogIndex: pieceIndex, connector: 0, heading: 0, snap: null };
      this.backend.setGhost(null);
      this.select(null);
      this.requestTrackMeshes(track);
      this.update({ mode: "track", activeItem: id, pendingItem: null, track: this.trackView() });
      this.showHeldPiece();
      return;
    }
    if (this.state.mode === "track") {
      this.held = null;
      this.track?.cancelDrag();
      this.selectedTrack = null;
      this.backend.setGhost(null);
      this.targetTrackEnd(null);
      this.update({ mode: "select", activeItem: null, track: this.trackView() });
      if (id === null) return;
    }
    const refId = id === null ? -1 : this.slots.findIndex((slot) => slot.id === id);
    if (id !== null && refId >= 0 && !this.placeables[refId]) {
      this.choosePending(id, refId);
      return;
    }
    if (id === null && this.state.pendingItem !== null) {
      this.update({ mode: "select", activeItem: null, pendingItem: null });
    }
    if (id === null && !this.active) {
      this.select(null);
      return;
    }
    const placeable = refId < 0 ? null : (this.placeables[refId] ?? null);
    if (placeable) {
      this.requestMeshes(placeable, "high");
      this.requestFarModel(placeable);
    }
    this.active = placeable;
    this.backend.setGhost(placeable ? { ...placeable.parts, studs: placeable.studs } : null);
    if (placeable) this.select(null);
    const { moduleFit, snap } = this.snapGhost();
    this.placeGhost();
    if (!moduleFit) this.showMarkers();
    this.update({
      mode: placeable ? "place" : "select",
      activeItem: placeable?.id ?? null,
      pendingItem: null,
      moduleFit,
      snap,
      ghostRot: this.placeRot,
    });
  }

  private choosePending(id: string, refId: number): void {
    this.active = null;
    this.moduleGhost = null;
    this.backend.setGhost(null);
    this.select(null);
    this.showMarkers();
    this.update({
      mode: "place",
      activeItem: id,
      pendingItem: id,
      moduleFit: null,
      snap: null,
      ghostRot: this.placeRot,
    });
    void this.ensurePlaceable(refId).then(
      () => {
        if (this.state.pendingItem === id) this.chooseItem(id);
      },
      (error: unknown) => {
        if (this.state.pendingItem !== id) return;
        this.update({
          mode: "select",
          activeItem: null,
          pendingItem: null,
          fileError: `${this.labelOf(id)} can't be loaded: ${errorText(error)}`,
        });
      },
    );
  }

  private trackPieceIndex(track: TrackDrawing, id: string): number | null {
    if (!id.startsWith(TRACK_PIECE_PREFIX)) return null;
    const pieceId = id.slice(TRACK_PIECE_PREFIX.length);
    const kit = track.pieceParts().find((part) => part.piece.id === pieceId);
    return kit ? kit.catalogIndex : null;
  }

  private showHeldPiece(): void {
    const track = this.track;
    const held = this.held;
    if (!track || !held) return;
    if (!this.hovering) {
      this.backend.setGhost(null);
      return;
    }
    const free = pose16(
      zeta16([
        BigInt(this.hoverX / STUD_LDU),
        0n,
        0n,
        0n,
        BigInt(this.hoverZ / STUD_LDU),
        0n,
        0n,
        0n,
      ]),
      held.heading,
    );
    const snap = track.snapPiece(held.catalogIndex, held.connector, this.hitX, this.hitZ, free);
    this.held = { ...held, snap };
    const ghost = track.pieceGhost(held.catalogIndex, snap.placement);
    this.backend.setGhost(ghost.instances);
    this.backend.placeGhost(ghost.x, 0, ghost.z, 0);
    this.targetTrackEnd(snap.end, snap.misses);
    this.update({ track: this.trackView() });
  }

  private placeHeldPiece(eventTimeMs: number): void {
    const track = this.track;
    const held = this.held;
    const snap = held?.snap;
    if (!track || !held || !snap) return;
    const commit = track.placePiece(held.catalogIndex, snap.placement);
    this.showRefusalCells(commit.blocked?.missing ?? null);
    if (commit.blocked) {
      this.lastTrackCommit = `refused-${commit.blocked.kind}`;
      this.refuse("track", TRACK_ITEM_ID, trackRunRefusal(commit.blocked));
      this.update({ track: this.trackView() });
      return;
    }
    const report = this.rebuildTrackChunks(track, commit.chunks);
    this.pending = {
      step: "do",
      action: "track",
      item: `${TRACK_PIECE_PREFIX}${track.pieceByIndex(held.catalogIndex).piece.id}`,
      rot: held.heading,
      x: this.hoverX,
      z: this.hoverZ,
      startMs: eventTimeMs,
      rebuiltMs: performance.now(),
      report,
    };
    this.syncPlan();
    this.trackEdited();
    this.lastTrackCommit = commit.joined ? "joined" : "laid";
    this.held = { ...held, snap: null };
    this.showTrackEnds(null);
    this.showHeldPiece();
    this.update({ track: this.trackView() });
  }

  private rebuildTrackChunks(track: TrackDrawing, chunks: ReadonlyArray<number>): RebuildReport {
    let instances = 0;
    let studs = 0;
    for (const key of chunks) {
      const chunk = track.chunkInstances(key);
      if (!chunk) continue;
      this.backend.setChunk(key, chunk);
      instances += chunk.count;
      studs += chunk.studs.count;
    }
    return { chunks: chunks.length, instances, studs };
  }

  private throwSwitchAt(xLdu: number, zLdu: number, eventTimeMs: number): boolean {
    const track = this.track;
    if (!track || this.readOnly) return false;
    const placement = track.switchAt(xLdu, zLdu);
    if (placement === null) return false;
    const thrown = track.throwSwitch(placement);
    if (!thrown) return false;
    const report = this.rebuildTrackChunks(track, [thrown.chunk]);
    this.pending = {
      step: "do",
      action: "track",
      item: `switch #${placement + 1}`,
      rot: 0,
      x: Math.round(xLdu),
      z: Math.round(zLdu),
      startMs: eventTimeMs,
      rebuiltMs: performance.now(),
      report,
    };
    this.syncPlan();
    this.trackEdited();
    this.lastTrackCommit = thrown.lever === "straight" ? "switch-straight" : "switch-branching";
    this.update({ track: this.trackView() });
    return true;
  }

  cycleConnector(): void {
    const held = this.held;
    if (!held) return;
    this.held = { ...held, connector: held.connector + 1 };
    this.showHeldPiece();
  }

  mirrorPiece(): void {
    const track = this.track;
    const held = this.held;
    if (!track || !held) return;
    const mirror = track.pieceSet.mirrored(held.catalogIndex);
    if (mirror === null) return;
    this.held = { ...held, catalogIndex: mirror };
    this.update({ activeItem: `${TRACK_PIECE_PREFIX}${track.pieceByIndex(mirror).piece.id}` });
    this.showHeldPiece();
  }

  private groundHit(ndcX: number, ndcY: number): boolean {
    this.backend.rayThrough(ndcX, ndcY, this.ray);
    const originY = this.ray[1] ?? 0;
    const directionY = this.ray[4] ?? 0;
    if (directionY >= 0) return false;
    const t = -originY / directionY;
    this.hitX = (this.ray[0] ?? 0) + (this.ray[3] ?? 0) * t;
    this.hitZ = (this.ray[2] ?? 0) + (this.ray[5] ?? 0) * t;
    this.hoverX = snapToLattice(this.hitX);
    this.hoverZ = snapToLattice(this.hitZ);
    return true;
  }

  private cursorLanding(): LandingAt {
    return {
      kind: "cursor",
      cellX: Math.floor(this.hitX / STUD_LDU),
      cellZ: Math.floor(this.hitZ / STUD_LDU),
    };
  }

  private placeGhost(): void {
    if (!this.active || !this.hovering) return;
    const check = this.checkAt(
      this.active,
      this.hoverX,
      this.hoverZ,
      this.placeRot,
      [],
      this.cursorLanding(),
    );
    this.ghostCheck = check;
    this.hoverYPlates = check.yPlates;
    this.hoverRefusal = this.placementRefusal(
      this.active,
      this.hoverX,
      this.hoverZ,
      this.placeRot,
      check.yPlates,
      null,
    );
    const track = this.active.track;
    this.update({
      ghost: {
        yPlates: check.yPlates,
        refusal: checkRefusal(this.active.label, check) ?? this.hoverRefusal,
        trackJoins: this.trackJoinsAt(this.active, check.yPlates),
        uncertifiedTrack: track?.uncertified.length ?? 0,
      },
    });
    this.backend.placeGhost(
      this.hoverX,
      this.hoverYPlates * PLATE_LDU + GHOST_LIFT_LDU,
      this.hoverZ,
      this.placeRot,
    );
  }

  private hoverView(): HoverView | null {
    if (!this.hovering) return null;
    return {
      x: this.hoverX,
      z: this.hoverZ,
      yPlates: this.hoverYPlates,
    };
  }

  private snapGhost(): {
    readonly moduleFit: ModuleFitView | null;
    readonly snap: RoadSnapView | null;
  } {
    this.placeRot = this.ghostRot;
    const moduleFit = this.snapGhostToModuleGrid();
    const snap = this.snapGhostToRoad();
    this.snapGhostToTrack();
    return { moduleFit, snap };
  }

  private heldRequests(
    placeable: Placeable,
    x: number,
    z: number,
    yPlates: number,
    rot: number,
    owner: number,
  ): ReadonlyArray<HeldTrackRequest> {
    const held = placeable.track;
    if (!held) return [];
    return heldPlacements(held, x, z, yPlates, rot).map((piece) => ({
      owner,
      label: placeable.label,
      catalogIndex: piece.catalogIndex,
      placement: piece.placement,
      plates: piece.plates,
    }));
  }

  private syncHeldTrack(): void {
    this.track?.syncHeld(
      this.placed
        .models()
        .flatMap((model) =>
          this.heldRequests(
            model.placeable,
            model.handle.x,
            model.handle.z,
            model.handle.yPlates,
            model.handle.rot,
            this.placed.ownerOf(model),
          ),
        ),
    );
    this.update({ track: this.trackView() });
  }

  private trackExempt(
    placeable: Placeable,
    x: number,
    z: number,
    yPlates: number,
    rot: number,
  ): OwnerFilter {
    const track = this.track;
    const requests = this.heldRequests(placeable, x, z, yPlates, rot, 0);
    if (!track || requests.length === 0) return () => false;
    const cellsByOwner = new Map<number, ReadonlySet<number>>();
    for (const joint of track.heldJoints(requests)) {
      const owner = this.placed.trackOwnerOf(joint.laid);
      if (owner !== null) cellsByOwner.set(owner, joint.heldCells);
    }
    if (cellsByOwner.size === 0) return () => false;
    return (owner, cellX, cellZ) =>
      cellsByOwner.get(owner)?.has(packedCellKey(cellX, cellZ)) ?? false;
  }

  private checkAt(
    placeable: Placeable,
    x: number,
    z: number,
    rot: number,
    ignore: ReadonlyArray<PlacedModel>,
    at: LandingAt,
  ): PlacementCheck {
    const guess = at.kind === "height" ? at.yPlates : LAID_TRACK_PLATES;
    const first = this.placed.check(
      placeable,
      x,
      z,
      rot,
      ignore,
      at,
      this.trackExempt(placeable, x, z, guess, rot),
    );
    if (first.yPlates === guess) return first;
    return this.placed.check(
      placeable,
      x,
      z,
      rot,
      ignore,
      at,
      this.trackExempt(placeable, x, z, first.yPlates, rot),
    );
  }

  private trackJoinsAt(placeable: Placeable, yPlates: number): number {
    const held = placeable.track;
    const track = this.track;
    if (!held || !track) return 0;
    const targets = track.openEndPoses();
    const frame = latticePose16(this.hoverX, this.hoverZ, this.placeRot);
    return held.openEnds.filter((end) => {
      if (yPlates + end.plates !== LAID_TRACK_PLATES) return false;
      const pose = composePose16(frame, end.local);
      return targets.some((target) => posesJoin16(pose, target));
    }).length;
  }

  private snapGhostToTrack(): void {
    const held = this.active?.track;
    const track = this.track;
    if (!held || !track || !this.hovering) return;
    const groundEnds = held.openEnds.filter((end) => end.plates === LAID_TRACK_PLATES);
    if (groundEnds.length === 0) return;
    const targets = track.openEndPoses();
    const frame = latticePose16(this.hoverX, this.hoverZ, this.placeRot);
    let best: { readonly xLdu: number; readonly zLdu: number } | null = null;
    let bestDistance = TRACK_SNAP_RADIUS_LDU;
    for (const end of groundEnds) {
      const free = zeta16ToStuds(composePose16(frame, end.local).position);
      for (const target of targets) {
        const snap = latticeSnap(end.local, target, this.placeRot);
        if (!snap) continue;
        const at = zeta16ToStuds(target.position);
        const distance = Math.hypot(free.x - at.x, free.z - at.z) * STUD_LDU;
        if (distance > bestDistance) continue;
        best = snap;
        bestDistance = distance;
      }
    }
    if (!best) return;
    this.hoverX = best.xLdu;
    this.hoverZ = best.zLdu;
  }

  private snapGhostToRoad(): RoadSnapView | null {
    const surface = this.active?.road;
    if (!surface || !this.hovering || !this.state.snapRoads) return null;
    const snap = snapToRoadEdge(
      this.roadNetwork,
      this.roadExtents,
      surface,
      this.ghostRot,
      this.turnDirection,
      0,
      this.hoverX,
      this.hoverZ,
    );
    if (snap) {
      this.hoverX = snap.x;
      this.hoverZ = snap.z;
      this.placeRot = snap.rot;
      return {
        state: "snapped",
        joinedCells: snap.joinedCells,
        joinedRoadCells: snap.joinedRoadCells,
        mismatchedCells: 0,
        overlappingCells: 0,
      };
    }
    const fit = this.roadNetwork.fit({
      id: -1,
      x: this.hoverX,
      z: this.hoverZ,
      yLdu: 0,
      rot: this.placeRot,
      surface,
    });
    const refused = fit.mismatchedCells > 0 || fit.overlappingCells > 0;
    return { state: refused ? "refused" : "free", ...fit };
  }

  pointerMove(ndcX: number, ndcY: number): void {
    this.hovering = this.groundHit(ndcX, ndcY);
    const { moduleFit, snap } = this.snapGhost();
    if (this.state.mode === "road" && this.roadDrawing && this.hovering) {
      this.showRoadPreview(this.roadDrawing.hover(this.hitX, this.hitZ, ...this.roadNeighbours()));
    }
    const track = this.track;
    if (this.held) this.showHeldPiece();
    else if (
      this.state.mode === "track" &&
      track &&
      !track.dragView() &&
      this.selectedTrack === null
    ) {
      this.targetTrackEnd(this.hovering ? track.endNear(this.hitX, this.hitZ, null) : null);
    }
    this.placeGhost();
    this.update({
      hover: this.hoverView(),
      snap,
      moduleFit,
      ghostRot: this.placeRot,
    });
  }

  pointerLeave(): void {
    this.hovering = false;
    this.moduleGhost = null;
    this.showMarkers();
    this.update({ hover: null, moduleFit: null });
  }

  click(ndcX: number, ndcY: number, eventTimeMs: number): void {
    if (this.state.mode === "road") return;
    if (this.state.mode === "track") {
      if (!this.held || this.readOnly || !this.groundHit(ndcX, ndcY)) return;
      this.hovering = true;
      this.showHeldPiece();
      this.placeHeldPiece(eventTimeMs);
      return;
    }
    const pendingItem = this.state.pendingItem;
    if (pendingItem !== null) {
      if (this.readOnly || !this.groundHit(ndcX, ndcY)) return;
      this.refuse("place", pendingItem, {
        rule: "loading",
        message: `${this.labelOf(pendingItem)} is still loading`,
      });
      return;
    }
    if (this.active && !this.readOnly) {
      if (!this.groundHit(ndcX, ndcY)) return;
      this.hovering = true;
      const { moduleFit, snap } = this.snapGhost();
      if (moduleFit?.occupied) {
        this.placeGhost();
        this.update({ moduleFit });
        this.refuse("place", this.active.id, {
          rule: "module-grid",
          message: `${this.active.label} would take module cell (${moduleFit.column}, ${moduleFit.row}), which another module already fills.`,
        });
        return;
      }
      this.placeGhost();
      this.update({ snap });
      if (snap?.state === "refused") {
        this.refuse("place", this.active.id, roadFitRefusal(this.active.label, snap));
        return;
      }
      const check = this.ghostCheck;
      const refusal = check ? checkRefusal(this.active.label, check) : null;
      if (refusal) {
        this.refuse("place", this.active.id, refusal);
        return;
      }
      if (this.hoverRefusal) {
        this.refuse("place", this.active.id, this.hoverRefusal);
        return;
      }
      this.placeAt(this.active, this.hoverX, this.hoverZ, this.placeRot, eventTimeMs);
      return;
    }
    this.backend.rayThrough(ndcX, ndcY, this.ray);
    let best: PlacedModel | null = null;
    let bestT = Number.POSITIVE_INFINITY;
    for (const model of this.placed.models()) {
      const t = model.rayHit(this.ray);
      if (t < bestT) {
        bestT = t;
        best = model;
      }
    }
    if (
      !best &&
      this.groundHit(ndcX, ndcY) &&
      this.throwSwitchAt(this.hitX, this.hitZ, eventTimeMs)
    ) {
      return;
    }
    this.select(best);
  }

  private placementRefusal(
    placeable: Placeable,
    x: number,
    z: number,
    rot: number,
    yPlates: number,
    ignore: PlacedModel | null,
  ): Refusal | null {
    const layout = this.modules;
    const own = this.gridPlacement(placeable, x, z, rot);
    if (own && layout) {
      const clash = layout.railEdgeClash(own);
      if (clash) {
        const neighbour = this.labelOf(layout.module(clash.neighbour)?.item ?? "");
        return {
          rule: "rail-edge",
          message: `${placeable.label}: its ${EDGE_KIND_NAMES[clash.kind]} edge on the ${clash.side} side would face the ${EDGE_KIND_NAMES[clash.facing]} edge of ${neighbour}. A rail edge only joins another rail edge, where the track ends mate.`,
        };
      }
    }
    this.refusalPlacement = own;
    const clash = this.placed.tongueClash(placeable, x, z, rot, yPlates, ignore, this.matesRefusal);
    this.refusalPlacement = null;
    if (!clash) return null;
    const other = clash.other.placeable.label;
    return {
      rule: "track-end",
      message: clash.ownTongue
        ? `${placeable.label}: its track end would run into ${other}. Only a rail module whose rail edge faces it can take the track end.`
        : `${placeable.label} would fill the space where the track end of ${other} reaches past its edge. Only a rail module whose rail edge faces it can take the track end.`,
    };
  }

  private gridPlacement(
    placeable: Placeable,
    x: number,
    z: number,
    rot: number,
  ): GridPlacement | null {
    const layout = this.modules;
    const surface = placeable.module;
    if (!layout || !surface) return null;
    const ghost = this.moduleGhost;
    if (placeable === this.active && ghost && ghost.x === x && ghost.z === z && ghost.rot === rot) {
      return ghost;
    }
    return layout.placement(surface, x, z, rot);
  }

  private readonly matesRefusal = (other: PlacedModel): boolean => {
    const own = this.refusalPlacement;
    if (!own) return false;
    const theirs = this.modules?.placementOf(other) ?? null;
    return theirs !== null && railEdgesMate(own, theirs);
  };

  private labelOf(id: string): string {
    return this.slots.find((slot) => slot.id === id)?.view.label ?? id;
  }

  private placeAt(
    placeable: Placeable,
    x: number,
    z: number,
    rot: number,
    eventTimeMs: number,
  ): void {
    this.show(
      this.history.place({
        refId: this.placeables.indexOf(placeable),
        colorId: placeable.worldColor,
        x,
        z,
        yPlates: this.checkAt(placeable, x, z, rot, [], this.cursorLanding()).yPlates,
        rot,
      }),
      eventTimeMs,
    );
  }

  private historyView(): HistoryView {
    return {
      undo: this.history.nextUndo(),
      redo: this.history.nextRedo(),
      undoDepth: this.history.undoDepth,
      redoDepth: this.history.redoDepth,
    };
  }

  private placeableAt(refId: number): Placeable {
    const placeable = this.placeables[refId];
    if (!placeable) throw new Error(`no catalog item has ref id ${refId}`);
    return placeable;
  }

  private show(edit: AppliedEdit, eventTimeMs: number): ViewUpdate {
    const view = this.placed.apply(edit, (refId) => this.placeableAt(refId));
    for (const placeable of new Set(view.added.map((model) => model.placeable))) {
      this.requestMeshes(placeable, "high");
      this.requestFarModel(placeable);
    }
    this.edited(edit);
    const primary = edit.changes[0];
    const pose = primary?.to ?? primary?.from ?? null;
    if (pose) {
      this.pending = {
        step: edit.step,
        action: edit.kind,
        item: this.placeableAt(pose.refId).id,
        rot: pose.rot,
        x: pose.x,
        z: pose.z,
        startMs: eventTimeMs,
        rebuiltMs: performance.now(),
        report: view.report,
      };
    }
    this.refreshModules();
    this.refreshRoads();
    this.syncHeldTrack();
    this.placeGhost();
    this.update({
      selectionRefusal: null,
      placements: this.world.size,
      hover: this.hoverView(),
      studs: this.placed.studTotals(),
      history: this.historyView(),
    });
    this.syncPlan();
    return view;
  }

  private roadPlacements(): ReadonlyArray<RoadPlacement> {
    const placements: RoadPlacement[] = [];
    for (let id = 0; id < this.roadModels.length; id++) {
      const model = this.roadModels[id];
      const surface = model?.placeable.road;
      if (!model || !surface) continue;
      placements.push({
        id,
        x: model.handle.x,
        z: model.handle.z,
        yLdu: model.handle.yPlates * PLATE_LDU,
        rot: model.handle.rot,
        surface,
      });
    }
    return placements;
  }

  private refreshRoads(): void {
    const started = performance.now();
    this.roadModels = this.placed.models().filter((model) => model.placeable.road !== null);
    const placements = this.roadPlacements();
    this.roadNetwork = new RoadNetwork(placements);
    this.roadExtents = placements.map(cellExtent);
    this.roadReport = this.roadNetwork.report();
    const roads = this.roadDrawing;
    if (roads) {
      roads.worldChanged();
      if (roads.isDragging()) this.showRoadPreview(roads.rerun(...this.roadNeighbours()));
    }
    const checkMs = performance.now() - started;
    this.showMarkers();
    const report = this.roadReport;
    const issues: RoadIssueView[] = [];
    for (const segment of report.segments) {
      if (segment.status === "joined" || issues.length >= LISTED_ROAD_ISSUES) continue;
      issues.push({
        status: segment.status,
        item: this.roadModels[segment.placement]?.placeable.id ?? "",
        side: segment.side,
        line: segment.line,
        from: segment.from,
        to: segment.to,
        topLdu: segment.topLdu,
      });
    }
    this.update({
      roads: {
        checkMs,
        placements: report.placements,
        joinedCells: report.joinedCells,
        openCells: report.openCells,
        mismatchedCells: report.mismatchedCells,
        overlaps: report.overlaps.length,
        issues,
      },
    });
  }

  private showMarkers(): void {
    const ghost = this.moduleGhost;
    const surface = this.active?.module;
    const joins: EdgeMarker[] = this.state.showJoins
      ? [
          ...this.roadReport.segments.map((segment) => ({
            box: markerBox(segment),
            kind: segment.status,
          })),
          ...(this.modules?.markers() ?? []),
          ...(ghost && surface && this.modules ? this.modules.ghostMarkers(ghost, surface) : []),
        ]
      : [];
    this.backend.setMarkers([...joins, ...this.roadPreviewMarkers, ...this.refusalMarkers]);
  }

  private refreshModules(): void {
    const layout = this.modules;
    if (!layout) return;
    const report = layout.refresh(this.placed.models());
    const issues: ModuleIssueView[] = [];
    for (const edge of report.edges) {
      if (edge.status !== "mismatch" || issues.length >= LISTED_MODULE_ISSUES) continue;
      const module = layout.module(edge.module);
      if (!module) continue;
      issues.push({
        item: module.item,
        x: module.x,
        z: module.z,
        side: edge.side,
        kind: edge.kind,
        facing: edge.facing,
      });
    }
    this.update({
      modules: {
        modules: report.modules,
        joined: report.joined,
        mismatched: report.mismatched,
        open: report.open,
        offGrid: layout.offGrid,
        issues,
      },
    });
    this.showMarkers();
  }

  private snapGhostToModuleGrid(): ModuleFitView | null {
    const surface = this.active?.module;
    const layout = this.modules;
    if (!surface || !layout || !this.hovering || !layout.fitsGrid(surface)) {
      this.moduleGhost = null;
      return null;
    }
    const candidate = this.state.snapModules
      ? layout.bestCandidate(surface, this.ghostRot, this.turnDirection, this.hitX, this.hitZ)
      : layout.candidate(surface, this.ghostRot, this.hitX, this.hitZ);
    this.moduleGhost = candidate;
    this.placeRot = candidate.rot;
    this.hoverX = candidate.x;
    this.hoverZ = candidate.z;
    this.showMarkers();
    return {
      column: candidate.column,
      row: candidate.row,
      rot: candidate.rot,
      occupied: layout.isOccupied(candidate.column, candidate.row),
      joined: candidate.fit.joined,
      mismatched: candidate.fit.mismatched,
      open: candidate.fit.open,
      sides: MODULE_SIDES.map((side, index) => ({
        side,
        kind: candidate.edges[index]?.kind ?? "other",
      })),
    };
  }

  setShowJoins(show: boolean): void {
    this.update({ showJoins: show });
    this.showMarkers();
  }

  setSnapModules(snap: boolean): void {
    this.update({ snapModules: snap });
  }

  searchCatalog(query: string): void {
    this.catalogSearch.search(query);
  }

  setRoadErase(erase: boolean): void {
    const roads = this.roadDrawing;
    if (!roads) return;
    roads.erasing = erase;
    this.update({ roadErase: erase, lastRoadStroke: null });
    this.showRoadPreview(roads.rerun(...this.roadNeighbours()));
  }

  setSnapRoads(snap: boolean): void {
    this.update({ snapRoads: snap, snap: null });
  }

  bomInput(scope: BomScope): BomInput {
    const tables = this.bomTables;
    if (!tables) throw new Error("the editor has not loaded");
    const counter = new BomCounter(
      tables.palette.parts.map((part) => part.id),
      tables.ldrawColors,
    );
    const placedCounts = new Map<number, number>();
    const contents: PlacementContents = {
      addTo: (target, refId) => {
        const placeable = this.placeables[refId];
        if (!placeable) throw new Error(`world holds unknown placeable ${refId}`);
        placedCounts.set(refId, (placedCounts.get(refId) ?? 0) + 1);
        const { parts } = placeable;
        for (let i = 0; i < parts.count; i++) {
          target.add(parts.partIndex[i] ?? 0, tables.colors.codeAt(parts.colorIndex[i] ?? 0), 1);
        }
      },
    };
    const uncounted = (): BomInput["uncounted"] =>
      [...placedCounts].flatMap(([refId, count]) => {
        const placeable = this.placeables[refId];
        if (!placeable) return [];
        return notDrawnItems(placeable.id, this.notDrawnByPlaceable.get(placeable) ?? [], count);
      });
    if (scope.kind !== "selection") {
      const placements = countPlacements(
        this.world,
        contents,
        counter,
        scope.kind === "region" ? scope.region : null,
      );
      return {
        name: EDITOR_WORLD_NAME,
        lod: "standard",
        placements,
        counter,
        uncounted: uncounted(),
      };
    }
    const selected = this.selected;
    if (!selected?.handle.live) throw new Error("nothing is selected");
    contents.addTo(counter, selected.handle.refId, selected.handle.colorId);
    return {
      name: `selection-${selected.placeable.id.replace(FILE_NAME_UNSAFE, "_")}`,
      lod: "standard",
      placements: 1,
      counter,
      uncounted: uncounted(),
    };
  }

  private select(model: PlacedModel | null): void {
    this.selected = model;
    this.backend.setSelectionBox(model ? model.box : null);
    this.update({
      selectionRefusal: null,
      selection: model
        ? {
            item: model.placeable.id,
            x: model.handle.x,
            z: model.handle.z,
            yPlates: model.handle.yPlates,
            rot: model.handle.rot,
            chunkKey: model.handle.chunkKey,
            slot: model.handle.slot,
            box: model.box,
          }
        : null,
    });
  }

  rotate(eventTimeMs: number, direction: TurnDirection = 1): void {
    const roads = this.roadDrawing;
    if (this.state.mode === "road" && roads) {
      this.placeRot = quarterTurned(this.placeRot, direction);
      this.ghostRot = this.placeRot;
      roads.preferredRot = this.placeRot;
      this.showRoadPreview(roads.rerun(...this.roadNeighbours()));
      this.update({ ghostRot: this.placeRot });
      return;
    }
    const held = this.held;
    if (held) {
      this.held =
        held.snap?.end === null || !held.snap
          ? { ...held, heading: (held.heading + direction + ZETA16_ORDER) % ZETA16_ORDER }
          : { ...held, connector: held.connector + direction };
      this.showHeldPiece();
      return;
    }
    if (this.active) {
      this.turnDirection = direction;
      this.ghostRot = quarterTurned(this.placeRot, direction);
      if (this.hovering) {
        this.hoverX = snapToLattice(this.hitX);
        this.hoverZ = snapToLattice(this.hitZ);
      }
      const { moduleFit, snap } = this.snapGhost();
      this.placeGhost();
      this.update({
        ghostRot: this.placeRot,
        snap,
        hover: this.hoverView(),
        ...(moduleFit ? { moduleFit } : {}),
      });
      return;
    }
    const model = this.selected;
    if (!model || this.readOnly) return;
    this.turnSelection(model, quarterTurned(model.handle.rot, direction), eventTimeMs);
  }

  private turnSelection(model: PlacedModel, rot: number, eventTimeMs: number): void {
    const pose = model.handle;
    const label = model.placeable.label;
    const refuseTurn = (refusal: Refusal): void => {
      this.refuse("rotate", model.placeable.id, refusal);
      this.update({
        selectionRefusal: `Can't turn to ${rot * DEGREES_PER_QUARTER_TURN}°. ${refusal.message}`,
      });
    };
    const rider = this.placed.riderOn(model);
    if (rider) {
      refuseTurn(riderRefusal(label, rider.placeable.label));
      return;
    }
    const check = this.checkAt(model.placeable, pose.x, pose.z, rot, [model], {
      kind: "height",
      yPlates: pose.yPlates,
    });
    const turned =
      checkRefusal(label, check) ??
      this.placementRefusal(model.placeable, pose.x, pose.z, rot, check.yPlates, model);
    if (turned) {
      refuseTurn(turned);
      return;
    }
    const yPlates = check.yPlates;
    const moved = { placeable: model.placeable, x: pose.x, z: pose.z, yPlates, rot };
    const refusal = this.removalRefusal([model], label, [moved]);
    if (refusal) {
      refuseTurn(refusal);
      return;
    }
    const road = this.turnedRoadFit(model, rot, yPlates);
    if (road && (road.mismatchedCells > 0 || road.overlappingCells > 0)) {
      refuseTurn(roadFitRefusal(label, road));
      return;
    }
    const edit = this.history.commit("rotate", [
      {
        placement: model.placement,
        to: { refId: pose.refId, colorId: pose.colorId, x: pose.x, z: pose.z, yPlates, rot },
      },
    ]);
    this.select(this.show(edit, eventTimeMs).added[0] ?? null);
  }

  private turnedRoadFit(model: PlacedModel, rot: number, yPlates: number): RoadFit | null {
    const surface = model.placeable.road;
    if (!surface || !this.state.snapRoads) return null;
    const others = this.roadPlacements().filter(({ id }) => this.roadModels[id] !== model);
    return new RoadNetwork(others).fit({
      id: -1,
      x: model.handle.x,
      z: model.handle.z,
      yLdu: yPlates * PLATE_LDU,
      rot,
      surface,
    });
  }

  private selectTrack(piece: number | null): void {
    this.selectedTrack = piece;
    this.backend.setSelectionBox(piece === null || !this.track ? null : this.track.pieceBox(piece));
    this.update({ track: this.trackView() });
  }

  private removeSelectedTrack(): void {
    const track = this.track;
    const piece = this.selectedTrack;
    if (!track || piece === null || this.readOnly) return;
    const before = this.trackRecords();
    for (const key of track.removePiece(piece)) {
      const chunk = track.chunkInstances(key);
      if (chunk) this.backend.setChunk(key, chunk);
      else this.backend.deleteChunk(key);
    }
    this.syncPlan();
    this.dirty.touchTrack(before);
    this.trackEdited();
    this.selectTrack(null);
  }

  deleteSelection(eventTimeMs: number): void {
    if (this.state.mode === "track") {
      this.removeSelectedTrack();
      return;
    }
    const model = this.selected;
    if (!model || this.readOnly) return;
    const refusal = this.removalRefusal([model], model.placeable.label);
    if (refusal) {
      this.refuse("remove", model.placeable.id, refusal);
      this.update({ selectionRefusal: `Can't delete. ${refusal.message}` });
      return;
    }
    this.show(this.history.remove(model.placement), eventTimeMs);
    this.select(null);
  }

  undo(eventTimeMs: number): void {
    if (this.readOnly) return;
    const refusal = this.replayRefusal(this.history.peekUndo());
    if (refusal) {
      this.refuse("undo", refusal.item, refusal);
      return;
    }
    this.replay(this.history.undo(), eventTimeMs);
  }

  redo(eventTimeMs: number): void {
    if (this.readOnly) return;
    const refusal = this.replayRefusal(this.history.peekRedo());
    if (refusal) {
      this.refuse("redo", refusal.item, refusal);
      return;
    }
    this.replay(this.history.redo(), eventTimeMs);
  }

  private modelOf(change: PendingChange): PlacedModel | null {
    const handle = change.placement.handle;
    return this.placed.models().find((model) => model.handle === handle) ?? null;
  }

  private removalRefusal(
    removed: ReadonlyArray<PlacedModel>,
    label: string,
    moved: ReadonlyArray<PendingPose> = [],
  ): Refusal | null {
    const carried = carriesRefusal(label, this.placed.lostSupport(removed, moved));
    if (carried) return carried;
    const off = this.placed.trackSupportWithout(removed, moved, (support) =>
      this.track?.unsupportedPieces(support),
    );
    const first = off?.[0];
    return first ? trackCarriedRefusal(label, first) : null;
  }

  private replayRefusal(
    changes: ReadonlyArray<PendingChange> | null,
  ): (Refusal & { readonly item: string }) | null {
    if (!changes) return null;
    const removed: PlacedModel[] = [];
    for (const change of changes) {
      const model = change.from ? this.modelOf(change) : null;
      if (model) removed.push(model);
    }
    const moved: PendingPose[] = [];
    for (const change of changes) {
      const to = change.to;
      if (to) moved.push({ placeable: this.placeableAt(to.refId), ...to });
    }
    const first = removed[0];
    if (first) {
      const refusal = this.removalRefusal(removed, first.placeable.label, moved);
      if (refusal) return { ...refusal, item: first.placeable.id };
    }
    for (const change of changes) {
      const to = change.to;
      if (!to) continue;
      const refusal = this.poseRefusal(to, removed);
      if (refusal) return { ...refusal, item: this.placeableAt(to.refId).id };
    }
    return null;
  }

  private poseRefusal(to: PlacementPose, removed: ReadonlyArray<PlacedModel>): Refusal | null {
    const placeable = this.placeableAt(to.refId);
    const check = this.checkAt(placeable, to.x, to.z, to.rot, removed, {
      kind: "height",
      yPlates: to.yPlates,
    });
    return checkRefusal(placeable.label, check);
  }

  private readonly roadRules: RoadPlacementRules = {
    carried: (plate) => {
      const track = this.track;
      const pieces = track
        ? track.piecesIn(plate.box).map((piece) => ({ thing: piece, box: track.pieceBox(piece) }))
        : [];
      const models = this.placed
        .models()
        .filter(
          (model) =>
            model.placeable.layer !== "first" &&
            model.box.minX < plate.box.maxX &&
            model.box.maxX > plate.box.minX &&
            model.box.minZ < plate.box.maxZ &&
            model.box.maxZ > plate.box.minZ,
        )
        .map((model) => ({ thing: model, box: model.box }));
      return [...pieces, ...models];
    },
    layRefusal: (pose, lifted) => this.poseRefusal(pose, lifted)?.message ?? null,
    carriedRefusal: (thing, lifted, poses) => {
      const first = lifted[0];
      if (!first) return null;
      const label = first.placeable.label;
      const moved = poses.map((pose) => ({ placeable: this.placeableAt(pose.refId), ...pose }));
      if (typeof thing === "number") {
        const off = this.placed.trackSupportWithout(
          lifted,
          moved,
          (support) => this.track?.unsupportedPiece(thing, support) ?? null,
        );
        return off ? trackCarriedRefusal(label, off).message : null;
      }
      const lost = this.placed.lostSupport(lifted, moved).filter((loss) => loss.model === thing);
      return carriesRefusal(label, lost)?.message ?? null;
    },
  };

  private refuse(action: RefusedAction, item: string, refusal: Refusal): void {
    this.update({
      refusals: this.state.refusals + 1,
      lastRefusal: { action, item, rule: refusal.rule, message: refusal.message },
    });
  }

  private showRefusalCells(cells: BaseCells | null): void {
    this.refusalMarkers = cells ? cellMarkers(cells, this.tableY) : [];
    this.showMarkers();
  }

  private replay(edit: AppliedEdit | null, eventTimeMs: number): void {
    if (!edit) return;
    const selected = this.selected;
    const restored = this.show(edit, eventTimeMs).added.at(-1);
    if (this.active) return;
    if (restored) this.select(restored);
    else if (selected && !selected.handle.live) this.select(null);
  }

  goTo(x: number, z: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    this.camera.lookAt(x, z, false);
  }

  private readonly resolveRef = (ref: string, color: number): PlacementTarget | null => {
    const refId = this.slots.findIndex((slot) => slot.group === ref && slot.worldColor === color);
    const slot = this.slots[refId];
    return slot ? { refId, colorId: slot.worldColor } : null;
  };

  private refs(): string[] {
    return this.slots.map((slot) => slot.group);
  }

  private trackRecords(): TrackRecordV1[] {
    return this.track?.records() ?? [];
  }

  private worldShardsNow(): WorldShardV1[] {
    return worldShards(worldPlacements(this.world, this.refs()), this.trackRecords());
  }

  private header(current: OpenWorld): WorldHeader {
    return {
      name: current.name,
      bundleVersion: this.bundleVersion,
      view: this.camera.savedView(),
      disclaimer: this.disclaimer,
    };
  }

  private inFileQueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.fileQueue.then(task);
    this.fileQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private edited(edit: AppliedEdit): void {
    for (const change of edit.changes) {
      if (change.from) this.dirty.touch(change.from.x, change.from.z);
      if (change.to) this.dirty.touch(change.to.x, change.to.z);
    }
    this.scheduleSave();
  }

  private trackEdited(): void {
    this.roadDrawing?.worldChanged();
    this.dirty.touchTrack(this.trackRecords());
    this.scheduleSave();
  }

  private scheduleSave(): void {
    this.syncUnsaved();
    if (this.saveScheduled) return;
    this.saveScheduled = true;
    setTimeout(() => {
      this.saveScheduled = false;
      void this.inFileQueue(() => this.saveNow());
    }, 0);
  }

  private watchView(): void {
    const view = this.camera.savedView();
    const last = this.lastView;
    const same =
      last !== null &&
      last.targetX === view.targetX &&
      last.targetY === view.targetY &&
      last.targetZ === view.targetZ &&
      last.distance === view.distance &&
      last.yaw === view.yaw &&
      last.pitch === view.pitch;
    if (same) return;
    this.lastView = view;
    if (this.current !== null) this.viewChanged();
  }

  private viewChanged(): void {
    this.viewDirty = true;
    if (this.viewTimer !== null) clearTimeout(this.viewTimer);
    this.viewTimer = setTimeout(() => {
      this.viewTimer = null;
      void this.inFileQueue(() => this.saveNow());
    }, VIEW_SAVE_DELAY_MS);
  }

  private canSave(): boolean {
    return (
      this.current !== null &&
      this.current.id !== null &&
      this.storageError === null &&
      !this.readOnly
    );
  }

  private async saveNow(): Promise<void> {
    const current = this.current;
    if (!current || current.id === null || !this.canSave()) return;
    if (this.dirty.size === 0 && !this.viewDirty) return;
    const change = this.dirty.take(this.world, this.refs(), this.trackRecords());
    const viewWasDirty = this.viewDirty;
    this.viewDirty = false;
    this.setWorldView(current, { save: "saving" });
    try {
      const summary = await this.repository.save(current.id, {
        header: this.header(current),
        put: change.put,
        drop: change.drop,
      });
      this.current = { ...current, pinnedBundleVersion: this.bundleVersion };
      const unsaved = this.dirty.size > 0 || this.viewDirty;
      this.setWorldView(this.current, {
        save: unsaved ? "saving" : "saved",
        placements: summary.placements,
        track: summary.track,
        shards: summary.shards,
      });
      this.update({
        worlds: this.state.worlds.map((item) => (item.id === summary.id ? summary : item)),
        ...(this.saveFailed ? { fileError: null } : {}),
      });
      this.saveFailed = false;
      this.lastSaveError = null;
      this.syncUnsaved();
    } catch (error) {
      this.dirty.restore(change);
      this.viewDirty ||= viewWasDirty;
      this.saveFailed = true;
      this.lastSaveError = errorText(error);
      this.syncUnsaved();
      this.setWorldView(current, { save: "failed" });
      this.update({
        fileError: `saving failed: ${errorText(error)}. The edits stay in this tab and are saved with the next change.`,
      });
    }
  }

  private syncUnsaved(): void {
    const unsavedEdits = this.dirty.size > 0 || (this.storageError !== null && this.world.size > 0);
    if (unsavedEdits !== this.state.unsavedEdits) this.update({ unsavedEdits });
  }

  retrySave(): Promise<void> {
    return this.inFileQueue(() => this.saveNow());
  }

  private setWorldView(current: OpenWorld, patch: Partial<WorldFileView>): void {
    const previous = this.state.world?.id === current.id ? this.state.world : null;
    this.update({
      world: {
        id: current.id,
        name: current.name,
        placements: previous?.placements ?? 0,
        track: previous?.track ?? 0,
        shards: previous?.shards ?? 0,
        save: previous?.save ?? "saved",
        pinnedBundleVersion: current.pinnedBundleVersion,
        openMs: current.openMs,
        ...patch,
      },
    });
  }

  private async refreshWorlds(): Promise<void> {
    if (this.storageError !== null) return;
    this.update({ worlds: await this.repository.list() });
  }

  private async openFirstWorld(): Promise<void> {
    let worlds: ReadonlyArray<WorldIndexEntry>;
    try {
      worlds = await this.repository.list();
    } catch (error) {
      this.startWithoutStorage(errorText(error));
      return;
    }
    const [latest] = worlds;
    try {
      if (latest) await this.openStored(latest.id);
      else await this.createWorld(FIRST_WORLD_NAME);
    } catch (error) {
      try {
        await this.createWorld(`World ${worlds.length + 1}`);
      } catch (fallback) {
        this.startWithoutStorage(errorText(fallback));
        return;
      }
      this.update({ fileError: `opening "${latest?.name ?? ""}" failed: ${errorText(error)}` });
    }
    await this.refreshWorlds();
  }

  private startWithoutStorage(reason: string): void {
    this.storageError = reason;
    const current = {
      id: null,
      name: FIRST_WORLD_NAME,
      pinnedBundleVersion: this.bundleVersion,
      openMs: 0,
    };
    this.install(new World(), null, current);
    this.refreshRoads();
    this.syncPlan();
    this.setWorldView(current, { placements: 0, shards: 0, save: "off" });
    this.update({ storageError: reason, worlds: [] });
  }

  private setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    if (readOnly && (this.active || this.held || this.state.mode === "road")) {
      this.chooseItem(null);
    }
    this.update({ readOnly });
  }

  private async takeLease(id: string): Promise<void> {
    this.lease?.release();
    const lease = await this.locks.hold(id);
    this.lease = lease;
    this.setReadOnly(!lease.exclusive);
    if (lease.exclusive) return;
    void lease.whenExclusive.then(() =>
      this.fileAction("reopen", async () => {
        if (this.lease !== lease) return;
        try {
          await this.loadWorld(id);
          this.setReadOnly(false);
        } catch (error) {
          const name = this.current?.name ?? "";
          lease.release();
          this.lease = null;
          this.setReadOnly(false);
          await this.openLatestOrNew();
          this.update({
            fileError: `"${name}" can't be reopened after the other tab let it go: ${errorText(error)}`,
          });
        }
        await this.refreshWorlds();
      }),
    );
  }

  private async openLatestOrNew(): Promise<void> {
    const [next] = await this.repository.list();
    if (next) await this.openStored(next.id);
    else await this.createWorld(FIRST_WORLD_NAME);
  }

  private async openStored(id: string): Promise<void> {
    await this.takeLease(id);
    await this.loadWorld(id);
  }

  private install(
    world: World,
    view: SavedViewV1 | null,
    current: OpenWorld,
    track: TrackDrawing | null = this.newTrack?.() ?? null,
  ): void {
    this.select(null);
    this.selectedTrack = null;
    this.showRefusalCells(null);
    this.placed.clear();
    for (const key of this.track?.chunkKeys() ?? []) this.backend.deleteChunk(key);
    this.track = track;
    track?.registerWithHost();
    for (const key of track?.chunkKeys() ?? []) {
      const chunk = track?.chunkInstances(key);
      if (chunk) this.backend.setChunk(key, chunk);
    }
    this.showTrackEnds(null);
    this.world = world;
    this.history = new EditHistory(world);
    this.camera.restoreView(view);
    this.lastView = this.camera.savedView();
    this.current = current;
    this.dirty.clear();
    this.viewDirty = false;
    this.saveFailed = false;
    this.lastSaveError = null;
    this.update({
      placements: world.size,
      history: this.historyView(),
      track: this.trackView(),
      fileError: null,
      refusals: 0,
      lastRefusal: null,
    });
    this.syncUnsaved();
  }

  private async createWorld(name: string): Promise<void> {
    const started = performance.now();
    const summary = await this.repository.create(
      {
        name,
        bundleVersion: this.bundleVersion,
        view: new ViewCamera(CAMERA_FOV_DEGREES).savedView(),
        disclaimer: this.disclaimer,
      },
      [],
    );
    await this.takeLease(summary.id);
    const current = {
      id: summary.id,
      name,
      pinnedBundleVersion: this.bundleVersion,
      openMs: performance.now() - started,
    };
    this.install(new World(), null, current);
    this.refreshRoads();
    this.syncPlan();
    this.setWorldView(current, { placements: 0, shards: 0, save: "saved" });
  }

  private installShards(
    id: string | null,
    manifest: WorldManifestV1,
    shards: ReadonlyArray<WorldShardV1>,
    started: number,
  ): void {
    const world = new World();
    const handles = addShards(world, shards, this.resolveRef);
    if (!handles.ok) {
      throw new Error(`world "${manifest.name}" can't be opened: ${issueText(handles.issues)}`);
    }
    const track = this.newTrack?.() ?? null;
    const restored = track?.restore(worldTrack(shards));
    if (restored && !restored.ok) {
      throw new Error(`world "${manifest.name}" can't be opened: ${issueText(restored.issues)}`);
    }
    const current = {
      id,
      name: manifest.name,
      pinnedBundleVersion: manifest.bundleVersion,
      openMs: 0,
    };
    this.install(world, manifest.view, current, track);
    this.placed.addAll(
      handles.value.flatMap((handle) => {
        const placeable = this.placeables[handle.refId];
        return placeable ? [{ placement: this.history.adopt(handle), handle, placeable }] : [];
      }),
    );
    this.syncHeldTrack();
    this.update({ studs: this.placed.studTotals() });
    for (const placeable of new Set(this.placed.models().map((model) => model.placeable))) {
      this.requestMeshes(placeable, "high");
      this.requestFarModel(placeable);
    }
    if (track && track.pieceCount > 0) this.requestTrackMeshes(track);
    this.refreshRoads();
    this.syncPlan();
    const opened = { ...current, openMs: performance.now() - started };
    this.current = opened;
    this.setWorldView(opened, {
      placements: manifest.placements,
      track: manifest.track,
      shards: manifest.shards.length,
      save: id === null ? "off" : "saved",
    });
  }

  private async loadWorld(id: string): Promise<void> {
    const started = performance.now();
    const stored = await this.repository.read(id);
    if (!stored.ok) throw new Error(`world ${id} can't be read: ${issueText(stored.issues)}`);
    await this.ensureShardPlaceables(stored.value.shards);
    this.installShards(id, stored.value.manifest, stored.value.shards, started);
  }

  private unsavedRefusal(action: string): string | null {
    if (this.storageError !== null || this.dirty.size === 0) return null;
    const reason = this.lastSaveError === null ? "" : ` (saving failed: ${this.lastSaveError})`;
    return `${action} refused: "${this.current?.name ?? ""}" has unsaved edits${reason}. Retry the save, or export the world first.`;
  }

  private fileAction(
    action: string,
    task: () => Promise<void>,
    keepsCurrentEdits = false,
  ): Promise<boolean> {
    return this.inFileQueue(async () => {
      await this.saveNow();
      const refusal = keepsCurrentEdits ? null : this.unsavedRefusal(action);
      if (refusal !== null) {
        this.update({ fileError: refusal });
        return false;
      }
      try {
        await task();
        return true;
      } catch (error) {
        this.update({ fileError: `${action} failed: ${errorText(error)}` });
        return false;
      }
    });
  }

  readonly worldNameMaxLength = WORLD_NAME_MAX_LENGTH;

  worldNameIssue(name: string): string | null {
    const trimmed = name.trim();
    if (trimmed === "") return null;
    const checked = decode(WorldName, trimmed, "name");
    return checked.ok ? null : checked.issues.map((issue) => issue.message).join("; ");
  }

  newWorld(name: string): Promise<boolean> {
    return this.fileAction("new world", async () => {
      if (this.storageError !== null) throw new Error("storage is unavailable");
      const issue = this.worldNameIssue(name);
      if (issue !== null) throw new Error(`the name ${issue}`);
      const trimmed = name.trim();
      await this.createWorld(trimmed === "" ? `World ${this.state.worlds.length + 1}` : trimmed);
      await this.refreshWorlds();
    });
  }

  openWorld(id: string): Promise<boolean> {
    return this.fileAction("open", async () => {
      if (this.storageError !== null || this.current?.id === id) return;
      await this.openStored(id);
      await this.refreshWorlds();
    });
  }

  deleteWorld(id: string): Promise<boolean> {
    return this.fileAction(
      "delete",
      async () => {
        if (this.storageError !== null) throw new Error("storage is unavailable");
        const current = this.current?.id === id;
        if (current && this.readOnly) throw new Error("this world is open in another tab");
        const lease = current ? this.lease : await this.locks.hold(id);
        if (!lease?.exclusive) {
          lease?.release();
          throw new Error("this world is open in another tab");
        }
        await this.repository.remove(id);
        lease.release();
        if (current) {
          this.lease = null;
          await this.openLatestOrNew();
        }
        await this.refreshWorlds();
      },
      true,
    );
  }

  exportWorld(): Promise<ExportedWorld> {
    return this.inFileQueue(async () => {
      await this.saveNow();
      const current = this.current;
      if (!current) throw new Error("no world is open");
      this.creditsView ??= this.credits.load().catch((error: unknown) => {
        this.creditsView = null;
        throw error;
      });
      const credits = this.credits.exportText(
        creditsForWorld(
          await this.creditsView,
          this.placed.models().map((model) => model.placeable),
        ),
      );
      const shards = this.worldShardsNow();
      const manifest = worldManifest(this.header(current), shards.map(shardEntry));
      return {
        fileName: exportFileName(current.name),
        bytes: this.repository.packArchive({ manifest, shards, credits }),
      };
    });
  }

  importWorld(bytes: Uint8Array): Promise<boolean> {
    return this.fileAction("import", async () => {
      const started = performance.now();
      const archive = await this.repository.readArchive(bytes);
      if (!archive.ok) throw new Error(issueText(archive.issues));
      const { manifest, shards } = archive.value;
      const check = addShards(new World(), shards, this.resolveRef);
      if (!check.ok) throw new Error(issueText(check.issues));
      const trackCheck = this.newTrack?.().restore(worldTrack(shards));
      if (trackCheck && !trackCheck.ok) throw new Error(issueText(trackCheck.issues));
      if (this.storageError !== null) {
        await this.ensureShardPlaceables(shards);
        this.installShards(null, manifest, shards, started);
        return;
      }
      const summary = await this.repository.create(worldHeader(manifest), shards);
      await this.openStored(summary.id);
      await this.refreshWorlds();
    });
  }

  trackRoutes(): ReadonlyArray<TrackRouteView> {
    return this.track?.routes() ?? [];
  }

  playSetup(): PlaySetup | null {
    const track = this.track;
    const play = this.play;
    if (!track || !play) return null;
    return { ...play, track: track.playTrack() };
  }

  dump(): EditorDump {
    return {
      refs: this.slots.map((slot) => slot.id),
      chunkCounts: this.world
        .chunks()
        .filter((chunk) => chunk.liveCount > 0)
        .map(
          (chunk) =>
            [chunk.originX / CHUNK_LDU, chunk.originZ / CHUNK_LDU, chunk.liveCount] as const,
        )
        .toSorted((a, b) => a[0] - b[0] || a[1] - b[1]),
      trackEnds: this.track?.openEnds() ?? [],
      frameShifts: this.loadedPlaceables().map((p) => p.frameShift),
      covers: this.loadedPlaceables().map((p) => ({
        id: p.id,
        studsDrawnPerPlacement: p.studs.count,
        studsCulledAtBake: p.bakedCoveredStuds,
        footprintCells: p.cells.footprintCells,
        flatCells: p.cells.flatCells,
        heightPlates: p.cells.heightPlates,
      })),
      placements: dumpPlacements(this.world),
      roadPlacements: this.roadModels.map((model, id) => ({
        id,
        item: model.placeable.id,
        x: model.handle.x,
        z: model.handle.z,
        yPlates: model.handle.yPlates,
        rot: model.handle.rot,
      })),
      roads: this.roadReport,
      studs: this.placed.studTotals(),
    };
  }
}
