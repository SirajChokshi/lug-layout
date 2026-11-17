import type { BundleColor, BundleLod } from "@brr/schema/bundle";
import {
  PART_BUNDLE_LOADER,
  type IPartBundleLoader,
  type PartAsset,
  type PartBundle,
} from "@brr/catalog";
import { MergedParts } from "./merged-parts.ts";
import {
  EditHistory,
  RoadNetwork,
  World,
  packedCellKey,
  roomRect,
  type AppliedEdit,
  type EditKind,
  type BaseCells,
  type HistoryStep,
  type OwnerFilter,
  type PendingChange,
  type RoadEdgeSegment,
  type RoadJoinReport,
  type RoadPlacement,
} from "@brr/domain";
import {
  BRICK_LDU,
  PLATE_LDU,
  STUD_LDU,
  chunkOf,
  composePose16,
  mmFromLdu,
  posesJoin16,
  zeta16ToStuds,
} from "@brr/math";
import {
  CAMERA_FOV_DEGREES,
  RAY_FLOATS,
  SCENE_BACKEND,
  type BackendInfo,
  type EdgeMarker,
  type FrameStats,
  type GraphicsApi,
  type ISceneBackend,
  type WorldBox,
} from "@brr/render";
import { inject, injectable } from "inversify";
import { dumpPlacements, type PlacementDump } from "../scene/placements.ts";
import { ColorTable, ldrawColorsSrgb, type ModelCredit } from "../scene/viewer-scene.ts";
import { OrbitCamera } from "./orbit-camera.ts";
import { heldPlacements, latticePose16, latticeSnap } from "./model-track.ts";
import {
  LAID_TRACK_PLATES,
  MAX_RISE_PER_PIECE,
  TRACK_SYSTEM,
  TrackDrawing,
  type CrossingView,
  type HeldTrackRequest,
  type PierPartCount,
  type TrackDragView,
  type TrackEndView,
  type TrackRefusal,
} from "./track-drawing.ts";
import { minifigGauge, trainGauge, type Gauge, type GaugeModel } from "./clearance-gauge.ts";
import type { PierKit, PierPart } from "./track-piers.ts";
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
import { cellExtent, snapToRoadEdge, type CellExtent } from "./road-snap.ts";
import { PLAN_SERVICE } from "../tokens.ts";
import type { IPlanService } from "../plan/plan-service.ts";
import {
  carriesRefusal,
  checkRefusal,
  trackCarriedRefusal,
  trackRunRefusal,
  type Refusal,
  type RefusalRule,
} from "./placement-messages.ts";

export type EditorStatus = "loading" | "ready" | "error";
export type EditAction = EditKind | "track";
export type EditorMode = "place" | "select" | "track";

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
  readonly mismatchedCells: number;
  readonly overlappingCells: number;
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
}

export interface SkippedCatalogModel {
  readonly name: string;
  readonly reason: string;
}

interface SkippedModel extends SkippedCatalogModel {
  readonly credit: ModelCredit;
}

interface LoadedCatalog {
  readonly placeables: ReadonlyArray<Placeable>;
  readonly skipped: ReadonlyArray<SkippedModel>;
  readonly gaugeModels: ReadonlyArray<GaugeModel>;
}

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

export type TrackCommitResult = "laid" | "joined" | `refused-${TrackRefusal}`;

export interface TrackHeightView {
  readonly drawPlates: number;
  readonly rampRate: number;
  readonly maxRampRate: number;
  readonly straightLdu: number;
  readonly curveLdu: number;
  readonly train: Gauge;
  readonly minifig: Gauge | null;
  readonly railTopLdu: number;
}

export type HeightLabelTone = "pier" | "ghost" | "clear";

export interface HeightLabel {
  readonly id: string;
  readonly ndcX: number;
  readonly ndcY: number;
  readonly text: string;
  readonly detail: string;
  readonly tone: HeightLabelTone;
}

export interface TrackView {
  readonly pieces: number;
  readonly bom: ReadonlyArray<TrackBomLine>;
  readonly openEnds: number;
  readonly joins: number;
  readonly coincidentEndIssues: number;
  readonly drag: TrackDragView | null;
  readonly lastCommit: TrackCommitResult | null;
  readonly solve: TrackSolveStats | null;
  readonly selected: {
    readonly piece: number;
    readonly pieceId: string;
    readonly fromPlates: number;
    readonly toPlates: number;
  } | null;
  readonly height: TrackHeightView;
  readonly piers: number;
  readonly pierBom: ReadonlyArray<PierPartCount>;
  readonly crossings: ReadonlyArray<CrossingView>;
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
  readonly placements: number;
  readonly history: HistoryView;
  readonly lastLatency: LatencySample | null;
  readonly latencies: ReadonlyArray<LatencySample>;
  readonly stats: EditorStats | null;
  readonly studs: StudTotals | null;
  readonly credits: EditorCredits | null;
  readonly roads: RoadJoinView;
  readonly showJoins: boolean;
  readonly snapRoads: boolean;
  readonly snap: RoadSnapView | null;
  readonly refusals: number;
  readonly lastRefusal: RefusedEdit | null;
  readonly ghost: GhostCheckView | null;
  readonly track: TrackView | null;
  readonly heightLabels: ReadonlyArray<HeightLabel>;
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
}

export interface IEditor {
  start(canvas: HTMLCanvasElement, options: EditorOptions): Promise<void>;
  subscribe(listener: () => void): () => void;
  snapshot(): EditorSnapshot;
  chooseItem(id: string | null): void;
  pointerMove(ndcX: number, ndcY: number): void;
  pointerLeave(): void;
  click(ndcX: number, ndcY: number, eventTimeMs: number): void;
  dragStart(ndcX: number, ndcY: number): boolean;
  dragMove(ndcX: number, ndcY: number): void;
  dragEnd(ndcX: number, ndcY: number, eventTimeMs: number): void;
  rotate(eventTimeMs: number): void;
  deleteSelection(eventTimeMs: number): void;
  undo(eventTimeMs: number): void;
  redo(eventTimeMs: number): void;
  orbit(dxPx: number, dyPx: number): void;
  pan(dxPx: number, dyPx: number): void;
  zoom(wheelDelta: number): void;
  focusSelection(): void;
  centreOnCursor(): void;
  setShowJoins(show: boolean): void;
  setSnapRoads(snap: boolean): void;
  setTrackHeight(plates: number): void;
  setRampRate(platesPerPiece: number): void;
  planOriginHere(): { readonly chunkX: number; readonly chunkZ: number };
  viewPlanFromAbove(planId: string): void;
  dump(): EditorDump;
}

const EDITOR_LOD: BundleLod = "standard";
const NO_LATTICE_REASON = "no stud lattice from the bake";
export const TRACK_ITEM_ID = `track:${TRACK_SYSTEM}`;
const TRACK_ITEM_LABEL = "Track: 9V straights and R40 curves";
const END_MARKER_HALF_LDU = 30;
const TRACK_SNAP_RADIUS_LDU = 3 * STUD_LDU;
const END_MARKER_HEIGHT_LDU = 40;
const P95 = 0.95;
const PIER_BRICK_ID = "ldraw:3001";
const PIER_PLATE_ID = "ldraw:3020";
const PIER_COLOR_NAME = "Light_Bluish_Grey";
const MAX_HEIGHT_LABELS = 160;
const LABEL_MARGIN_NDC = 1.05;
const MM_DECIMALS = 1;
const QUARTER_TURNS = 4;
const STATS_INTERVAL_MS = 500;
const MARKER_WIDTH_LDU = 6;
const MARKER_LIFT_LDU = 1;
const MARKER_HEIGHT_LDU = 2;
const CELL_MARKER_INSET_LDU = 2;
const CELL_MARKER_TOP_LDU = 1;
const LISTED_ROAD_ISSUES = 12;
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

function snapToLattice(ldu: number): number {
  return Math.round(ldu / STUD_LDU) * STUD_LDU + 0;
}

function footprintArea(part: PartAsset): number {
  return (part.boundsMax[0] - part.boundsMin[0]) * (part.boundsMax[2] - part.boundsMin[2]);
}

function colorOf(colors: ReadonlyArray<BundleColor>, code: number): BundleColor {
  const color = colors.find((c) => c.code === code);
  if (!color) throw new Error(`LDConfig has no colour ${code}`);
  return color;
}

function catalogItem(placeable: Placeable, colors: ReadonlyArray<BundleColor>): CatalogItemView {
  const colored = placeable.kind === "baseplate" || placeable.kind === "road-plate";
  return {
    id: placeable.id,
    label: placeable.label,
    group: placeable.group,
    groupLabel: placeable.groupLabel,
    color: colored ? colorOf(colors, placeable.worldColor) : null,
    kind: placeable.kind,
    parts: placeable.parts.count,
    studsWide: Math.round((placeable.box.max[0] - placeable.box.min[0]) / STUD_LDU),
    studsDeep: Math.round((placeable.box.max[2] - placeable.box.min[2]) / STUD_LDU),
  };
}

function undrawableTrack(
  bundleParts: ReadonlyArray<PartAsset>,
  track: TrackDrawing,
  parts: ReadonlyArray<PartAsset>,
): ReadonlyArray<CatalogPartView> {
  const drawable = new Set(track.kitParts().map((kit) => parts[kit.partIndex]?.id));
  return bundleParts
    .filter((part) => part.role === "track" && !drawable.has(part.id))
    .map((part) => ({ id: part.id.replace("ldraw:", ""), title: part.title }));
}

function nineVoltStraightPart(bundle: PartBundle): string {
  const straight = bundle.trackCatalog.pieces.find(
    (piece) =>
      piece.system === TRACK_SYSTEM && piece.kind === "straight" && piece.status === "certified",
  );
  if (!straight) throw new Error(`the track catalog has no certified ${TRACK_SYSTEM} straight`);
  return straight.part;
}

function pierPart(palette: MergedParts, id: string, color: number): PierPart {
  const partIndex = palette.indexOf(id);
  const part = palette.parts[partIndex];
  if (!part) throw new Error(`the bundle has no pier part ${id}`);
  return { partIndex, color, part };
}

function pierKit(bundle: PartBundle, palette: MergedParts, colors: ColorTable): PierKit {
  const color = bundle.colors.find((c) => c.name === PIER_COLOR_NAME);
  if (!color) throw new Error(`LDConfig colour ${PIER_COLOR_NAME} is missing`);
  const index = colors.indexOfCode(color.code);
  return {
    brick: pierPart(palette, PIER_BRICK_ID, index),
    plate: pierPart(palette, PIER_PLATE_ID, index),
  };
}

function heightText(plates: number): string {
  const mm = mmFromLdu(plates * PLATE_LDU).toFixed(MM_DECIMALS);
  return `${plates} ${plates === 1 ? "plate" : "plates"} (${mm} mm)`;
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
    placements: 0,
    history: { undo: null, redo: null, undoDepth: 0, redoDepth: 0 },
    lastLatency: null,
    latencies: [],
    stats: null,
    studs: null,
    credits: null,
    roads: EMPTY_ROADS,
    showJoins: true,
    snapRoads: true,
    snap: null,
    refusals: 0,
    lastRefusal: null,
    ghost: null,
    track: null,
    heightLabels: [],
  };
  private readonly world = new World();
  private readonly history = new EditHistory(this.world);
  private readonly camera = new OrbitCamera();
  private readonly ray = new Float64Array(RAY_FLOATS);
  private readonly frameStats: FrameStats = {
    drawCalls: 0,
    triangles: 0,
    nearChunks: 0,
    midChunks: 0,
    farChunks: 0,
    renderOriginChunkX: 0,
    renderOriginChunkZ: 0,
    rebaseCount: 0,
  };
  private placeables: ReadonlyArray<Placeable> = [];
  private placed: PlacedChunks;
  private active: Placeable | null = null;
  private selected: PlacedModel | null = null;
  private ghostRot = 0;
  private hoverX = 0;
  private hoverZ = 0;
  private hoverYPlates = 0;
  private ghostCheck: PlacementCheck | null = null;
  private refusalMarkers: ReadonlyArray<EdgeMarker> = [];
  private tableY = 0;
  private hovering = false;
  private hitX = 0;
  private hitZ = 0;
  private track: TrackDrawing | null = null;
  private lastTrackCommit: TrackCommitResult | null = null;
  private selectedTrack: number | null = null;
  private minifig: Gauge | null = null;
  private pending: PendingAction | null = null;
  private roadModels: ReadonlyArray<PlacedModel> = [];
  private roadExtents: ReadonlyArray<CellExtent> = [];
  private roadNetwork = new RoadNetwork([]);
  private roadReport: RoadJoinReport = new RoadNetwork([]).report();
  private canvas: HTMLCanvasElement | null = null;
  private framesSinceStats = 0;
  private statsSince = 0;

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) private readonly backend: ISceneBackend,
    @inject(PLAN_SERVICE) private readonly plans: IPlanService,
  ) {
    this.placed = new PlacedChunks(backend);
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
      });
      const bundle = await this.loader.load(
        EDITOR_LOD,
        (part) =>
          part.role === "ground" ||
          part.role === "road" ||
          part.role === "track" ||
          part.id === PIER_BRICK_ID ||
          part.id === PIER_PLATE_ID,
      );
      const colors = new ColorTable(bundle);
      const palette = new MergedParts(bundle.parts);
      const { placeables, skipped, gaugeModels } = await this.loadPlaceables(
        bundle,
        palette,
        colors,
      );
      this.placeables = placeables;
      this.plans.setTableTopY(this.baseplateBottomY());
      const railPart = nineVoltStraightPart(bundle);
      const train = trainGauge(gaugeModels, railPart);
      if (!train) throw new Error(`no train in the bundle has a wheel contact on ${railPart}`);
      this.minifig = minifigGauge(gaugeModels);
      this.track = new TrackDrawing(
        bundle.trackCatalog,
        palette.parts,
        colors,
        {
          support: (cells) => this.placed.trackSupport(cells, []),
          overlap: (cells, bottom, top, exempt, ownPiers) =>
            this.placed.trackOverlap(cells, bottom, top, exempt, ownPiers),
          pierOverlap: (cells, bottom, top) => this.placed.pierOverlap(cells, bottom, top),
          neighbours: (cells) => this.placed.trackNeighbours(cells),
          laid: (piece, pieceId, cells, bottom, top) =>
            this.placed.addTrackPiece(piece, pieceId, cells, bottom, top),
          relaid: (pieces) => this.placed.replaceTrackPieces(pieces),
          piers: (piers) => this.placed.setTrackPiers(piers),
        },
        { pier: pierKit(bundle, palette, colors), train },
      );
      this.backend.setPalette({
        detailed: { parts: palette.parts, studPrimitives: bundle.studPrimitives },
        colorsSrgb: colors.toSrgb(),
        ldrawColorsSrgb: ldrawColorsSrgb(bundle),
      });
      this.update({
        status: "ready",
        loadMs: performance.now() - started,
        backend,
        catalog: [
          ...this.placeables.map((placeable) => catalogItem(placeable, bundle.colors)),
          this.trackItem(this.track, palette.parts),
        ],
        catalogSkipped: skipped.map(({ name, reason }) => ({ name, reason })),
        trackNotDrawable: undrawableTrack(bundle.parts, this.track, palette.parts),
        track: this.trackView(),
        credits: {
          partFiles: bundle.credits.length,
          partFilesLod: EDITOR_LOD,
          models: [
            ...this.placeables.flatMap((p) => (p.credit ? [p.credit] : [])),
            ...skipped.map(({ credit }) => credit),
          ],
        },
      });
      this.statsSince = performance.now();
      this.resizeToCanvas();
      this.camera.apply(this.backend);
      requestAnimationFrame(this.step);
    } catch (error) {
      this.update({ status: "error", error: String(error) });
    }
  }

  private baseplateBottomY(): number {
    const baseplate = this.placeables.find((p) => p.kind === "baseplate");
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

  private async loadPlaceables(
    bundle: PartBundle,
    palette: MergedParts,
    colors: ColorTable,
  ): Promise<LoadedCatalog> {
    const groundParts = bundle.parts
      .filter((part) => part.role === "ground")
      .toSorted((a, b) => footprintArea(b) - footprintArea(a));
    const roadParts = bundle.parts.filter((part) => part.role === "road");
    const placeableModels = [
      ...bundle.models.filter((entry) => entry.role === "mils-module"),
      ...bundle.models.filter((entry) => entry.origin === "omr"),
    ];
    const loaded = await Promise.all(
      placeableModels.map((entry) => this.loader.loadModel(EDITOR_LOD, entry.name)),
    );
    const baseplate = groundParts[0];
    if (!baseplate) throw new Error("the bundle has no baseplate");
    this.tableY = baseplate.boundsMin[1];
    const placeables: Placeable[] = [...groundParts, ...roadParts].flatMap((part) => {
      if (part.producedColors.length === 0) {
        throw new Error(`${part.id} has no produced colour in the bundle`);
      }
      return part.producedColors.map((code) =>
        partPlaceable(
          part,
          palette.indexOf(part.id),
          code,
          colorOf(bundle.colors, code).name,
          palette.parts,
          colors,
          this.tableY,
        ),
      );
    });
    const skipped: SkippedModel[] = [];
    for (const { bundle: modelBundle, entry, model } of loaded) {
      const credit = { name: entry.name, source: entry.source, sections: model.sections };
      if (model.lattice === null || model.cells === null) {
        skipped.push({ name: entry.name, reason: NO_LATTICE_REASON, credit });
        continue;
      }
      placeables.push(
        modelPlaceable(
          entry.name,
          entry.role === "mils-module" ? (model.sections[0]?.title ?? entry.name) : entry.name,
          entry.role,
          palette.remap(model, modelBundle.parts),
          credit,
          palette.parts,
          colors,
          this.tableY,
          bundle.trackCatalog,
        ),
      );
    }
    const gaugeModels = loaded.map(({ bundle: modelBundle, entry, model }) => ({
      name: entry.name,
      model,
      parts: modelBundle.parts,
      studPrimitives: modelBundle.studPrimitives,
    }));
    return { placeables, skipped, gaugeModels };
  }

  private readonly step = (): void => {
    void this.frame();
  };

  private async frame(): Promise<void> {
    try {
      this.resizeToCanvas();
      const startMs = performance.now();
      this.camera.apply(this.backend);
      this.backend.renderFrame(this.frameStats);
      const pending = this.pending;
      if (pending) {
        this.pending = null;
        const submittedMs = performance.now();
        await this.backend.waitForGpu();
        this.recordLatency(pending, { startMs, submittedMs, presentedMs: performance.now() });
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
    this.refreshLabels();
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
      },
    });
    this.framesSinceStats = 0;
    this.statsSince = now;
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

  private trackItem(track: TrackDrawing, parts: ReadonlyArray<PartAsset>): CatalogItemView {
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
      bom: track.kitParts().map((k) => ({
        piece: k.piece.id,
        title: k.piece.title,
        count: track.countOf(k.piece.id),
      })),
      openEnds: track.openEnds().length,
      joins: track.joinedPairs(),
      coincidentEndIssues: track.coincidentEndIssues(),
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
          : {
              piece: this.selectedTrack,
              pieceId: track.pieceId(this.selectedTrack),
              ...track.pieceHeights(this.selectedTrack),
            },
      height: {
        drawPlates: track.drawPlates,
        rampRate: track.rampRate,
        maxRampRate: MAX_RISE_PER_PIECE,
        straightLdu: track.straightLdu,
        curveLdu: track.curveLdu,
        train: track.trainGauge,
        minifig: this.minifig,
        railTopLdu: track.railTopLdu,
      },
      piers: track.pierViews().length,
      pierBom: track.pierParts(),
      crossings: track.crossings(),
    };
  }

  private showEndMarker(end: TrackEndView | null): void {
    const base = end ? end.plates * PLATE_LDU : 0;
    this.backend.setSelectionBox(
      end
        ? {
            minX: end.xLdu - END_MARKER_HALF_LDU,
            minY: base,
            minZ: end.zLdu - END_MARKER_HALF_LDU,
            maxX: end.xLdu + END_MARKER_HALF_LDU,
            maxY: base + END_MARKER_HEIGHT_LDU,
            maxZ: end.zLdu + END_MARKER_HALF_LDU,
          }
        : null,
    );
  }

  private refreshLabels(): void {
    const track = this.track;
    const canvas = this.canvas;
    if (!track || !canvas) return;
    const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
    const fov = (CAMERA_FOV_DEGREES * Math.PI) / 180;
    const labels: HeightLabel[] = [];
    const add = (
      id: string,
      x: number,
      y: number,
      z: number,
      text: string,
      detail: string,
      tone: HeightLabelTone,
    ): void => {
      if (labels.length >= MAX_HEIGHT_LABELS) return;
      const at = this.camera.project(x, y, z, fov, aspect);
      if (!at || Math.abs(at[0]) > LABEL_MARGIN_NDC || Math.abs(at[1]) > LABEL_MARGIN_NDC) return;
      labels.push({ id, ndcX: at[0], ndcY: at[1], text, detail, tone });
    };
    const railTop = track.railTopLdu;
    const minifig = this.minifig;
    const headroom = (plates: number): string =>
      minifig && plates * PLATE_LDU >= minifig.heightLdu
        ? "a minifig walks under"
        : "too low for a minifig to walk under";
    const end = track.ghostEnd();
    if (end) {
      const drag = track.dragView();
      const reached = drag && drag.targetPlates !== end.plates ? ` of ${drag.targetPlates}` : "";
      add(
        "ghost-end",
        end.xLdu,
        end.plates * PLATE_LDU + railTop,
        end.zLdu,
        `${end.plates}${reached} pl`,
        `${heightText(end.plates)}; ${headroom(end.plates)}`,
        "ghost",
      );
    }
    for (const pier of track.ghostPiers()) {
      add(
        `ghost-pier:${pier.xLdu},${pier.zLdu}`,
        pier.xLdu,
        pier.plates * PLATE_LDU + railTop,
        pier.zLdu,
        `${pier.plates} pl`,
        heightText(pier.plates),
        "ghost",
      );
    }
    for (const crossing of track.crossings()) {
      add(
        `crossing:${crossing.xLdu},${crossing.zLdu}`,
        crossing.xLdu,
        crossing.upperPlates * PLATE_LDU,
        crossing.zLdu,
        `${crossing.gapLdu} LDU clear`,
        `${(crossing.gapLdu / PLATE_LDU).toFixed(1)} plates from the lower rails (${crossing.lowerPlates} pl) to the upper track (${crossing.upperPlates} pl); ${track.trainGauge.model} needs ${track.trainGauge.heightLdu.toFixed(1)} LDU`,
        "clear",
      );
    }
    for (const pier of track.pierViews()) {
      add(
        `pier:${pier.xLdu},${pier.zLdu}`,
        pier.xLdu,
        pier.plates * PLATE_LDU + railTop,
        pier.zLdu,
        `${pier.plates} pl`,
        `${heightText(pier.plates)}; ${headroom(pier.plates)}`,
        "pier",
      );
    }
    this.update({ heightLabels: labels });
  }

  private showTrackGhost(track: TrackDrawing): void {
    const ghost = track.ghost();
    this.backend.setGhost(ghost ? ghost.instances : null);
    if (ghost) this.backend.placeGhost(ghost.x, 0, ghost.z, 0);
  }

  dragStart(ndcX: number, ndcY: number): boolean {
    const track = this.track;
    if (this.state.mode !== "track" || !track) return false;
    if (!this.groundHit(ndcX, ndcY)) return false;
    this.showRefusalCells(null);
    if (!track.beginDrag(this.ray)) return false;
    this.update({ track: this.trackView() });
    return true;
  }

  dragMove(ndcX: number, ndcY: number): void {
    const track = this.track;
    if (!track) return;
    this.groundHit(ndcX, ndcY);
    this.hoverOnTrackPlane();
    this.redrawDrag(track);
    this.update({ hover: this.hoverView() });
  }

  private redrawDrag(track: TrackDrawing): void {
    track.moveDrag(this.ray);
    this.showTrackGhost(track);
    this.showEndMarker(track.dragTarget());
    this.showRefusalCells(track.dragView()?.blocked?.missing ?? null);
    this.update({ track: this.trackView() });
    this.refreshLabels();
  }

  dragEnd(ndcX: number, ndcY: number, eventTimeMs: number): void {
    const track = this.track;
    if (!track) return;
    this.groundHit(ndcX, ndcY);
    track.moveDrag(this.ray);
    const commit = track.endDrag();
    this.backend.setGhost(null);
    this.showEndMarker(null);
    let instances = 0;
    let studs = 0;
    for (const key of commit.chunks) {
      const chunk = track.chunkInstances(key);
      if (!chunk) {
        this.backend.deleteChunk(key);
        continue;
      }
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
    if (commit.laid > 0) this.syncPlan();
    if (commit.laid === 0 && commit.refusal === null) this.selectTrack(track.pieceAt(this.ray));
    if (commit.refusal) this.lastTrackCommit = `refused-${commit.refusal}`;
    else if (commit.laid > 0) this.lastTrackCommit = commit.joined ? "joined" : "laid";
    this.showRefusalCells(commit.blocked?.missing ?? null);
    if (commit.blocked) this.refuse("track", TRACK_ITEM_ID, trackRunRefusal(commit.blocked));
    this.update({ track: this.trackView() });
    this.refreshLabels();
  }

  chooseItem(id: string | null): void {
    this.showRefusalCells(null);
    if (id === TRACK_ITEM_ID && this.track) {
      this.active = null;
      this.backend.setGhost(null);
      this.select(null);
      this.update({ mode: "track", activeItem: TRACK_ITEM_ID });
      return;
    }
    if (this.state.mode === "track") {
      this.track?.cancelDrag();
      this.selectedTrack = null;
      this.backend.setGhost(null);
      this.showEndMarker(null);
      this.update({ mode: "select", activeItem: null, track: this.trackView() });
      if (id === null) return;
    }
    if (id === null && !this.active) {
      this.select(null);
      return;
    }
    const placeable = id === null ? null : (this.placeables.find((p) => p.id === id) ?? null);
    this.active = placeable;
    this.backend.setGhost(placeable ? { ...placeable.parts, studs: placeable.studs } : null);
    if (placeable) this.select(null);
    this.placeGhost();
    this.update({ mode: placeable ? "place" : "select", activeItem: placeable?.id ?? null });
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
      this.ghostRot,
      [],
      this.cursorLanding(),
    );
    this.ghostCheck = check;
    this.hoverYPlates = check.yPlates;
    const track = this.active.track;
    this.update({
      ghost: {
        yPlates: check.yPlates,
        refusal: checkRefusal(this.active.label, check),
        trackJoins: this.trackJoinsAt(this.active, check.yPlates),
        uncertifiedTrack: track?.uncertified.length ?? 0,
      },
    });
    this.backend.placeGhost(
      this.hoverX,
      this.hoverYPlates * PLATE_LDU + GHOST_LIFT_LDU,
      this.hoverZ,
      this.ghostRot,
    );
  }

  private hoverView(): HoverView | null {
    if (!this.hovering) return null;
    return { x: this.hoverX, z: this.hoverZ, yPlates: this.hoverYPlates };
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
    const track = this.track;
    if (!track) return;
    const keys = track.syncHeld(
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
    this.redrawTrackChunks(track, keys);
    this.update({ track: this.trackView() });
    this.refreshLabels();
  }

  private redrawTrackChunks(track: TrackDrawing, keys: ReadonlyArray<number>): void {
    for (const key of keys) {
      const chunk = track.chunkInstances(key);
      if (chunk) this.backend.setChunk(key, chunk);
      else this.backend.deleteChunk(key);
    }
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
    const heights = track.openEndHeights();
    const frame = latticePose16(this.hoverX, this.hoverZ, this.ghostRot);
    return held.openEnds.filter((end) => {
      const pose = composePose16(frame, end.local);
      return targets.some(
        (target, i) => heights[i] === yPlates + end.plates && posesJoin16(pose, target),
      );
    }).length;
  }

  private snapGhostToTrack(): void {
    const held = this.active?.track;
    const track = this.track;
    if (!held || !track || !this.hovering) return;
    const groundEnds = held.openEnds.filter((end) => end.plates === LAID_TRACK_PLATES);
    if (groundEnds.length === 0) return;
    const heights = track.openEndHeights();
    const targets = track.openEndPoses().filter((_, i) => heights[i] === LAID_TRACK_PLATES);
    const frame = latticePose16(this.hoverX, this.hoverZ, this.ghostRot);
    let best: { readonly xLdu: number; readonly zLdu: number } | null = null;
    let bestDistance = TRACK_SNAP_RADIUS_LDU;
    for (const end of groundEnds) {
      const free = zeta16ToStuds(composePose16(frame, end.local).position);
      for (const target of targets) {
        const snap = latticeSnap(end.local, target, this.ghostRot);
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
      0,
      this.hoverX,
      this.hoverZ,
    );
    if (snap) {
      this.hoverX = snap.x;
      this.hoverZ = snap.z;
      return {
        state: "snapped",
        joinedCells: snap.joinedCells,
        mismatchedCells: 0,
        overlappingCells: 0,
      };
    }
    const fit = this.roadNetwork.fit({
      id: -1,
      x: this.hoverX,
      z: this.hoverZ,
      yLdu: 0,
      rot: this.ghostRot,
      surface,
    });
    const refused = fit.mismatchedCells > 0 || fit.overlappingCells > 0;
    return { state: refused ? "refused" : "free", ...fit };
  }

  private hoverOnTrackPlane(): void {
    const track = this.track;
    if (this.state.mode !== "track" || !track) return;
    const plane = track.drawPlates * PLATE_LDU;
    const directionY = this.ray[4] ?? 0;
    if (directionY >= 0) return;
    const t = (plane - (this.ray[1] ?? 0)) / directionY;
    if (t < 0) return;
    this.hoverX = snapToLattice((this.ray[0] ?? 0) + (this.ray[3] ?? 0) * t);
    this.hoverZ = snapToLattice((this.ray[2] ?? 0) + (this.ray[5] ?? 0) * t);
    this.hoverYPlates = track.drawPlates;
  }

  pointerMove(ndcX: number, ndcY: number): void {
    this.hovering = this.groundHit(ndcX, ndcY);
    this.hoverOnTrackPlane();
    const snap = this.snapGhostToRoad();
    const track = this.track;
    if (this.state.mode === "track" && track && !track.dragView() && this.selectedTrack === null) {
      const end = this.hovering ? track.endNear(this.ray, null) : null;
      this.showEndMarker(end === null ? null : (track.openEnds()[end] ?? null));
    }
    this.snapGhostToTrack();
    this.placeGhost();
    this.update({ hover: this.hoverView(), snap });
  }

  pointerLeave(): void {
    this.hovering = false;
    this.update({ hover: null });
  }

  click(ndcX: number, ndcY: number, eventTimeMs: number): void {
    if (this.state.mode === "track") return;
    if (this.active) {
      if (!this.groundHit(ndcX, ndcY)) return;
      this.hovering = true;
      const snap = this.snapGhostToRoad();
      this.snapGhostToTrack();
      this.placeGhost();
      this.update({ snap });
      if (snap?.state === "refused") {
        this.refuse("place", this.active.id, {
          rule: "road",
          message: `${this.active.label} would leave ${snap.mismatchedCells} road edge cells mismatched and overlap ${snap.overlappingCells} road cells.`,
        });
        return;
      }
      const check = this.ghostCheck;
      const refusal = check ? checkRefusal(this.active.label, check) : null;
      if (refusal) {
        this.refuse("place", this.active.id, refusal);
        return;
      }
      this.placeAt(this.active, this.hoverX, this.hoverZ, this.ghostRot, eventTimeMs);
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
    this.select(best);
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

  private placeableAt(refId: number): Placeable {
    const placeable = this.placeables[refId];
    if (!placeable) throw new Error(`no catalog item has ref id ${refId}`);
    return placeable;
  }

  private show(edit: AppliedEdit, eventTimeMs: number): ViewUpdate {
    const view = this.placed.apply(edit, (refId) => this.placeableAt(refId));
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
    this.refreshRoads();
    this.syncHeldTrack();
    this.placeGhost();
    this.update({
      placements: this.world.size,
      hover: this.hoverView(),
      studs: this.placed.studTotals(),
      history: {
        undo: this.history.nextUndo(),
        redo: this.history.nextRedo(),
        undoDepth: this.history.undoDepth,
        redoDepth: this.history.redoDepth,
      },
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
    const checkMs = performance.now() - started;
    this.showRoadMarkers();
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

  private showRoadMarkers(): void {
    const roads: EdgeMarker[] = this.state.showJoins
      ? this.roadReport.segments.map((segment) => ({
          box: markerBox(segment),
          kind: segment.status,
        }))
      : [];
    this.backend.setMarkers([...roads, ...this.refusalMarkers]);
  }

  setShowJoins(show: boolean): void {
    this.update({ showJoins: show });
    this.showRoadMarkers();
  }

  setTrackHeight(plates: number): void {
    const track = this.track;
    if (!track || plates < LAID_TRACK_PLATES || !Number.isInteger(plates)) return;
    track.setDrawPlates(plates);
    this.afterHeightChange(track);
  }

  setRampRate(platesPerPiece: number): void {
    const track = this.track;
    if (!track) return;
    track.setRampRate(platesPerPiece);
    this.afterHeightChange(track);
  }

  private afterHeightChange(track: TrackDrawing): void {
    if (track.dragView()) {
      this.redrawDrag(track);
      return;
    }
    this.update({ track: this.trackView() });
    this.refreshLabels();
  }

  setSnapRoads(snap: boolean): void {
    this.update({ snapRoads: snap, snap: null });
  }

  private select(model: PlacedModel | null): void {
    this.selected = model;
    this.backend.setSelectionBox(model ? model.box : null);
    this.update({
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

  rotate(eventTimeMs: number): void {
    if (this.active) {
      this.ghostRot = (this.ghostRot + 1) % QUARTER_TURNS;
      this.placeGhost();
      this.update({ ghostRot: this.ghostRot, hover: this.hoverView() });
      return;
    }
    const model = this.selected;
    if (!model) return;
    const pose = model.handle;
    const rot = (pose.rot + 1) % QUARTER_TURNS;
    const check = this.checkAt(model.placeable, pose.x, pose.z, rot, [model], {
      kind: "height",
      yPlates: pose.yPlates,
    });
    const turned = checkRefusal(model.placeable.label, check);
    if (turned) {
      this.refuse("rotate", model.placeable.id, turned);
      return;
    }
    const yPlates = check.yPlates;
    const moved = { placeable: model.placeable, x: pose.x, z: pose.z, yPlates, rot };
    const refusal = this.removalRefusal([model], model.placeable.label, [moved]);
    if (refusal) {
      this.refuse("rotate", model.placeable.id, refusal);
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

  private selectTrack(piece: number | null): void {
    this.selectedTrack = piece;
    this.backend.setSelectionBox(piece === null || !this.track ? null : this.track.pieceBox(piece));
    this.update({ track: this.trackView() });
  }

  private removeSelectedTrack(): void {
    const track = this.track;
    const piece = this.selectedTrack;
    if (!track || piece === null) return;
    this.redrawTrackChunks(track, track.removePiece(piece));
    this.syncPlan();
    this.selectTrack(null);
    this.refreshLabels();
  }

  deleteSelection(eventTimeMs: number): void {
    if (this.state.mode === "track") {
      this.removeSelectedTrack();
      return;
    }
    const model = this.selected;
    if (!model) return;
    const refusal = this.removalRefusal([model], model.placeable.label);
    if (refusal) {
      this.refuse("remove", model.placeable.id, refusal);
      return;
    }
    this.show(this.history.remove(model.placement), eventTimeMs);
    this.select(null);
  }

  undo(eventTimeMs: number): void {
    const refusal = this.replayRefusal(this.history.peekUndo());
    if (refusal) {
      this.refuse("undo", refusal.item, refusal);
      return;
    }
    this.replay(this.history.undo(), eventTimeMs);
  }

  redo(eventTimeMs: number): void {
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
    const off = this.track?.unsupportedPieces((cells) =>
      this.placed.trackSupport(cells, removed, moved),
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
      const placeable = this.placeableAt(to.refId);
      const check = this.checkAt(placeable, to.x, to.z, to.rot, removed, {
        kind: "height",
        yPlates: to.yPlates,
      });
      const refusal = checkRefusal(placeable.label, check);
      if (refusal) return { ...refusal, item: placeable.id };
    }
    return null;
  }

  private refuse(action: RefusedAction, item: string, refusal: Refusal): void {
    this.update({
      refusals: this.state.refusals + 1,
      lastRefusal: { action, item, rule: refusal.rule, message: refusal.message },
    });
  }

  private showRefusalCells(cells: BaseCells | null): void {
    this.refusalMarkers = cells ? cellMarkers(cells, this.tableY) : [];
    this.showRoadMarkers();
  }

  private replay(edit: AppliedEdit | null, eventTimeMs: number): void {
    if (!edit) return;
    const selected = this.selected;
    const restored = this.show(edit, eventTimeMs).added.at(-1);
    if (this.active) return;
    if (restored) this.select(restored);
    else if (selected && !selected.handle.live) this.select(null);
  }

  orbit(dxPx: number, dyPx: number): void {
    this.camera.orbit(dxPx, dyPx);
    this.camera.apply(this.backend);
    this.refreshLabels();
  }

  pan(dxPx: number, dyPx: number): void {
    this.camera.pan(dxPx, dyPx);
    this.camera.apply(this.backend);
    this.refreshLabels();
  }

  zoom(wheelDelta: number): void {
    this.camera.zoom(wheelDelta);
    this.camera.apply(this.backend);
    this.refreshLabels();
  }

  focusSelection(): void {
    if (!this.selected) return;
    this.camera.focus(this.selected.box);
    this.camera.apply(this.backend);
    this.refreshLabels();
  }

  centreOnCursor(): void {
    if (!this.hovering) return;
    this.camera.centreOn(this.hoverX, this.hoverZ);
    this.camera.apply(this.backend);
    this.refreshLabels();
  }

  planOriginHere(): { readonly chunkX: number; readonly chunkZ: number } {
    const [x, z] = this.camera.targetXZ();
    return { chunkX: chunkOf(x), chunkZ: chunkOf(z) };
  }

  viewPlanFromAbove(planId: string): void {
    const plan = this.plans.snapshot().plans.find((p) => p.id === planId);
    if (!plan) return;
    const room = roomRect(plan);
    const canvas = this.canvas;
    const aspect = canvas ? canvas.clientWidth / Math.max(canvas.clientHeight, 1) : 1;
    this.camera.topDown(
      { ...room, minY: 0, maxY: 0 },
      (CAMERA_FOV_DEGREES * Math.PI) / 180,
      aspect,
    );
    this.camera.apply(this.backend);
    this.refreshLabels();
  }

  dump(): EditorDump {
    return {
      refs: this.placeables.map((p) => p.id),
      frameShifts: this.placeables.map((p) => p.frameShift),
      covers: this.placeables.map((p) => ({
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
