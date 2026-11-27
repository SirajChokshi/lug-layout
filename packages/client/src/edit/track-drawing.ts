import type { PartBundle, PartShapeAsset } from "@brr/catalog";
import type { PoseStatus, TrackPartFrame, TrackPiece, TrackShape } from "@brr/schema/bundle";
import type { Decoded, Issue } from "@brr/schema/decode";
import { decodeTrackPosition, encodeTrackPosition, type TrackRecordV1 } from "@brr/schema/world";
import {
  BOX_MAX_X,
  BOX_MAX_Y,
  BOX_MAX_Z,
  BOX_MIN_X,
  BOX_MIN_Y,
  BOX_MIN_Z,
  BOX_STRIDE,
  LABEL_AT,
  LABEL_NUMBERED,
  TRACK_OPEN_END,
  TRACK_REVERSING,
  TRACK_SEGMENT,
  TRACK_UNIDENTIFIED,
  TRACK_UNJOINED_ENDS,
  TRACK_UNVERIFIED,
  TRACK_LAID_UNVERIFIED,
  NO_REVERSING_SECTIONS,
  ReversingSectionFinder,
  type PlanDelta,
  type ReversingSections,
  type TrackIssueRows,
  NEAR_MISS_RADIUS_LDU,
  NO_OBSTACLE,
  KitOutlines,
  StrokeRouter,
  drawingKit,
  endGaps,
  FOOTPRINT_FLOATS,
  freePlacement,
  layMoves,
  NO_END,
  NO_TRACK_CHANGE,
  OUTLINE_BOX_FLOATS,
  outlineBox,
  rotateOutline,
  TrackGraph,
  TrackLayout,
  footprintOutline,
  regionHolds,
  outlineContains,
  placedOutline,
  placedOutlineInto,
  studlessTopBlocker,
  PlacedOutline,
  OutlineEdges,
  TrackOutline,
  type TrackClearance,
  type MoveFrame,
  type OutlineRing,
  type BomCounter,
  type PartSink,
  type DrawingKit,
  type EndGap,
  type PlacementPose,
  type PlacementRegion,
  type TrackChange,
  type TrackEnd,
  type TrackFrame,
  type TrackMove,
  type TrackPieceAt,
  type TrackPieceDef,
  type TrackPieceSpec,
  WORLD_TRACK_FRAME,
  boxesOverlap,
  outlinesOverlap,
  rampRises,
  runMoves,
  reachablePlates,
  runHeights,
  rampShear as shearOfRamp,
  type RampShear,
  type RunHeights,
} from "@brr/domain";
import {
  CHUNK_LDU,
  HALF_TURN_16,
  PLATE_LDU,
  STUD_LDU,
  ZETA16_ORDER,
  chunkKey,
  chunkOf,
  attachPose16,
  composePose16,
  normalizeHeading16,
  POSE16_IDENTITY,
  isLatticePose,
  posesJoin16,
  pose16,
  pose16Equals,
  zeta16,
  zeta16Direction,
  zeta16ToStuds,
  type Pose16,
  planeHypot,
} from "@brr/math";
import { INSTANCE_MATRIX_FLOATS, type ChunkInstances, type WorldBox } from "@brr/render";
import type { ChunkPartInstances } from "../scene/placements.ts";
import { withStuds } from "../scene/stud-stream.ts";
import type { ColorTable } from "../scene/viewer-scene.ts";
import type { FramedTrackPiece, TrackPartCount } from "../connect/model-track-ends.ts";
import { FieldClosures } from "./field-closures.ts";
import {
  TrackDrag,
  type DragField,
  type DragEnds,
  type DragRoute,
  type DragTargetView,
  type DragRefusal,
  type JoinWithheld,
  type SupportedPiece,
  type TrackBlockView,
  type TrackDragView,
} from "./track-drag.ts";
import { OBSTACLE_RECT_FLOATS, cellKey, type StudSeats } from "./track-obstacles.ts";
import type { TrackSupport } from "./track-support.ts";
import { writeChunkSquares } from "./plan-reach.ts";
import { TrackBands, type BandPieces, type LayingBand, type SupportBandAt } from "./track-bands.ts";
import { heightText, type LabelView } from "./size-labels.ts";
import type { TallestTrain } from "../trains/tallest-train.ts";
import { TrackPieceSet, type Lever } from "./track-pieces.ts";
import {
  TrackExtension,
  type ExtensionJoin,
  type ExtensionRun,
  type ExtensionSite,
  type PieceFit,
} from "./track-extension.ts";
import { LoopCloser, type LoopCloserSite, type LoopClosure } from "./loop-closer.ts";
import { pieceRelativePose } from "./group-transform.ts";
import { SolveSamples, type TrackSolveStats } from "./solve-samples.ts";

export type {
  ClosureState,
  DragRefusal,
  DragTargetView,
  JoinWithheld,
  TrackBlockView,
  TrackDragView,
  TrackRefusal,
} from "./track-drag.ts";

export const TRACK_SYSTEM = "lego-9v";

export interface TrackSystemView {
  readonly system: string;
  readonly status: PoseStatus;
  readonly straight: KitPart;
  readonly curve: KitPart | null;
}

interface SystemKit extends TrackSystemView {
  readonly kit: DrawingKit;
  readonly outlines: KitOutlines;
  readonly router: StrokeRouter;
  readonly closures: FieldClosures;
  readonly railTopLdu: number;
}
const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const HALF_STEP_RADIANS = HEADING_RADIANS / 2;
const END_PICK_RADIUS_LDU = 3 * STUD_LDU;
const GROUND_PLATES = 0;
const RAMP_HIGH_END = 1;
const RAMP_CONNECTORS = 2;
const INT16_MAX = 2 ** 15 - 1;
const DEFAULT_RAMP_PLATES = 1;
const PERCENT = 100;
const NO_PIECE = -1;
export const RAMP_RATES: ReadonlyArray<number> = [1, 2];
const REFUSED_PIECE_LDRAW_COLOR = 4;
const NO_MISSES: ReadonlyArray<number> = [];
const NO_PLACEMENTS: ReadonlySet<number> = new Set();
const NO_OWNERS: ReadonlySet<number> = new Set();
const PIECE_BOX_FLOATS = 6;

interface SkippedIds {
  readonly moving: ReadonlySet<number>;
  readonly movingOwners: ReadonlySet<number>;
  readonly ids: Int32Array;
}

interface HeadingOutline {
  readonly outline: Float64Array;
  readonly box: Float64Array;
}

function crossingOutlineKey(catalogIndex: number, pose: Pose16): string {
  return `${catalogIndex}:${pose.heading}:${pose.position.join(",")}`;
}

export interface KitPart {
  readonly footprints: Float64Array;
  readonly outline: Float64Array;
  readonly meshY: readonly [number, number];
  readonly catalogIndex: number;
  readonly piece: TrackPiece;
  readonly def: TrackPieceDef;
  readonly partIndex: number;
  readonly color: number;
  readonly yLdu: number;
}

interface CrossingShape {
  readonly planOutline: ReadonlyArray<OutlineRing>;
  readonly bedLdu: number;
  readonly system: string;
}

export interface PlacedTrackPiece {
  readonly placement: number;
  readonly outline: PlacedOutline;
  readonly bedLdu: number;
  readonly system: string;
}

const NO_JOINS: ReadonlyArray<number> = [];
const NO_POSES: ReadonlyArray<Pose16> = [];
const RECT_OUTLINE_FLOATS = 8;

function writeRectOutline(out: Float64Array, rects: Float64Array, at: number): void {
  const minX = rects[at] ?? 0;
  const minZ = rects[at + 1] ?? 0;
  const maxX = rects[at + 2] ?? 0;
  const maxZ = rects[at + 3] ?? 0;
  out.set([minX, minZ, maxX, minZ, maxX, maxZ, minX, maxZ]);
}

export interface RaisedPiece {
  readonly index: number;
  readonly catalogIndex: number;
  readonly placement: Pose16;
  readonly yPlates: number;
}

export interface RampEndRest {
  readonly indices: ReadonlyArray<number>;
  readonly yPlates: number;
  readonly antiStuds: Int32Array;
  readonly rows: ReadonlyArray<Int32Array>;
  readonly xLdu: number;
  readonly zLdu: number;
}

interface RampEndDraft {
  readonly indices: number[];
  readonly rows: Int32Array[];
  readonly yPlates: number;
  readonly xLdu: number;
  readonly zLdu: number;
}

export type StudSeatProbe = (cellX: number, cellZ: number, baseLdu: number) => boolean;

interface RampEndRow {
  readonly piece: number;
  readonly baseLdu: number;
  readonly cells: Int32Array;
}

function endKeyOf(pose: Pose16, yPlates: number): string {
  return `${pose.position.join(",")}@${yPlates}`;
}

interface RunHeightsResult {
  readonly kind: "heights" | "too-steep";
  readonly heights: RunHeights;
}

interface RaisedBlock {
  readonly at: number;
  readonly block: TrackBlockView;
}

export interface LiftedPiece {
  readonly piece: number;
  readonly pose: Pose16;
  readonly yPlates: number;
  readonly rise: number;
}

export type SolidRects = (
  bottomLdu: number,
  topLdu: number,
) => { readonly rects: Float64Array; readonly floats: number };

export interface SupportPart {
  readonly catalogIndex: number;
  readonly partIndex: number;
}

export interface UnsupportedPiece {
  readonly piece: number;
  readonly block: TrackBlockView | null;
  readonly tilted: boolean;
}

export interface DragOutcome {
  readonly change: TrackChange;
  readonly goal: Pose16 | null;
  readonly end: Pose16 | null;
  readonly refusal: DragRefusal | null;
  readonly blocked: TrackBlockView | null;
  readonly withheld: JoinWithheld | null;
}

const NOTHING_LAID: DragOutcome = {
  change: NO_TRACK_CHANGE,
  goal: null,
  end: null,
  refusal: null,
  blocked: null,
  withheld: null,
};

export interface ExtensionPlan {
  readonly run: ExtensionRun;
  readonly change: TrackChange;
  readonly goal: Pose16 | null;
  readonly end: Pose16;
}

export interface LoopPlan {
  readonly closure: LoopClosure;
  readonly change: TrackChange;
}

export interface LoopPartCount {
  readonly part: string;
  readonly title: string;
  readonly count: number;
}

export interface LoopClosureView {
  readonly key: string;
  readonly from: TrackEndView;
  readonly to: TrackEndView;
  readonly gapLdu: number;
  readonly pieces: number;
  readonly parts: ReadonlyArray<LoopPartCount>;
}

export interface TrackLoopsView {
  readonly closures: ReadonlyArray<LoopClosureView>;
  readonly checked: number;
  readonly pairs: number | null;
  readonly waiting: number;
  readonly previewed: string | null;
}

const NO_LOOPS: TrackLoopsView = {
  closures: [],
  checked: 0,
  pairs: null,
  waiting: 0,
  previewed: null,
};

interface PreviewRun {
  readonly start: Pose16;
  readonly moves: ReadonlyArray<TrackMove>;
  readonly refused: TrackMove | null;
  readonly heights: RunHeights;
}

interface DragRun extends PreviewRun {
  readonly route: DragRoute;
  readonly refusal: DragRefusal | null;
  readonly blocked: TrackBlockView | null;
}

export interface LowClearance {
  readonly piece: number;
  readonly needPlates: number;
  readonly hasPlates: number;
  readonly train: TallestTrain;
}

interface OverUnderCrossing {
  readonly upper: number;
  readonly lower: number;
  readonly gapLdu: number;
  readonly x: number;
  readonly z: number;
}

export interface TrackFootprint {
  readonly key: { readonly chunkKey: number; readonly slot: number };
  readonly ref: string;
  readonly label: string;
  readonly box: WorldBox;
}

export interface TrackOwner {
  readonly handle: {
    readonly chunkKey: number;
    readonly slot: number;
    readonly x: number;
    readonly z: number;
  };
  readonly placeable: { readonly label: string };
  readonly box: WorldBox;
}

export interface TrackCarrier {
  readonly model: TrackOwner;
  readonly held: number;
  readonly unverified: ReadonlyArray<TrackPartCount>;
  readonly unidentified: ReadonlyArray<TrackPartCount>;
}

export interface PlayTrack {
  readonly layout: TrackLayout;
  readonly graph: TrackGraph;
  readonly pieces: ReadonlyArray<TrackPiece>;
  readonly railPart: string;
  readonly railTopY: number;
  readonly halfWidthLdu: number;
}

export interface TrackEndView {
  readonly xLdu: number;
  readonly yPlates: number;
  readonly zLdu: number;
  readonly heading: number;
  readonly headingRadians: number;
}

export interface TrackRouteView {
  readonly from: TrackEndView;
  readonly to: TrackEndView;
}

export interface PieceSnap {
  readonly placement: Pose16;
  readonly yPlates: number;
  readonly end: number | null;
  readonly joins: number;
  readonly misses: ReadonlyArray<number>;
}

export interface SwitchThrow {
  readonly change: TrackChange;
  readonly lever: Lever;
}

export interface TrackPieceHit {
  readonly placement: number;
  readonly distance: number;
}

export interface LaidPieceView {
  readonly piece: string;
  readonly xLdu: number;
  readonly zLdu: number;
  readonly yPlates: number;
  readonly heading: number;
  readonly chunkKey: number;
  readonly box: WorldBox;
}

const RAY_ORIGIN_X = 0;
const RAY_ORIGIN_Y = 1;
const RAY_ORIGIN_Z = 2;
const RAY_DIRECTION_X = 3;
const RAY_DIRECTION_Y = 4;
const RAY_DIRECTION_Z = 5;

export interface SwitchLeverView {
  readonly placement: number;
  readonly element: string;
  readonly lever: Lever;
  readonly xLdu: number;
  readonly zLdu: number;
}

export interface TrackBomLine {
  readonly piece: string;
  readonly title: string;
  readonly count: number;
}

export interface PreviewGhost {
  readonly instances: ChunkInstances;
  readonly x: number;
  readonly z: number;
}

type LaidRun = ReturnType<typeof layMoves>;

interface LaidRunEnd {
  readonly run: LaidRun;
  readonly endXStuds: number;
  readonly endZStuds: number;
}

interface LaidPreview {
  readonly run: PreviewRun;
  readonly moves: ReadonlyArray<TrackMove>;
  readonly laid: LaidRun;
}

export interface TrackGapView {
  readonly a: TrackEndView;
  readonly b: TrackEndView;
  readonly xStuds: number;
  readonly zStuds: number;
  readonly gapStuds: number;
  readonly aheadStuds: number;
  readonly asideStuds: number;
  readonly headingErrorSteps: number;
  readonly headingErrorDegrees: number;
}

interface Placed {
  readonly part: KitPart;
  readonly placement: Pose16;
  readonly yPlates: number;
  readonly rise: number;
}

function sameStuds(ax: number, az: number, bx: number, bz: number): boolean {
  return ax === bx && az === bz;
}

function latticePose(latticeX: number, latticeZ: number, heading: number): Pose16 {
  return pose16(
    zeta16([BigInt(latticeX / STUD_LDU), 0n, 0n, 0n, BigInt(latticeZ / STUD_LDU), 0n, 0n, 0n]),
    heading,
  );
}

function normalizeConnector(connector: number, count: number): number {
  return ((connector % count) + count) % count;
}

function endView(end: Pose16, frame: TrackFrame, yPlates: number): TrackEndView {
  const studs = zeta16ToStuds(end.position);
  return {
    xLdu: studs.x * STUD_LDU + frame.xLdu,
    yPlates,
    zLdu: studs.z * STUD_LDU + frame.zLdu,
    heading: end.heading,
    headingRadians: end.heading * HEADING_RADIANS,
  };
}

function pieceSpec(piece: TrackPiece): TrackPieceSpec {
  return { connectors: piece.connectors.map((c) => c.pose), routes: piece.routes };
}

function partForPiece(piece: TrackPiece, parts: ReadonlyArray<PartShapeAsset>): number {
  const index = parts.findIndex((part) => part.id === piece.part);
  if (index < 0) throw new Error(`${piece.id}: track part ${piece.part} is not in the bundle`);
  return index;
}

interface PartTransform {
  readonly x: number;
  readonly z: number;
  readonly c: number;
  readonly s: number;
}

interface PlaneRotation {
  readonly c: number;
  readonly s: number;
}

function partRotation(heading: number, frame: TrackPartFrame): PlaneRotation {
  const { x: cosTheta, z: sinTheta } = zeta16Direction(heading);
  const offset = frame.headingHalfSteps * HALF_STEP_RADIANS;
  const cosHalf = Math.cos(offset);
  const sinHalf = Math.sin(offset);
  return {
    c: cosTheta * cosHalf - sinTheta * sinHalf,
    s: sinTheta * cosHalf + cosTheta * sinHalf,
  };
}

function partTransform(placement: Pose16, frame: TrackPartFrame): PartTransform {
  const studs = zeta16ToStuds(placement.position);
  const { x: cosTheta, z: sinTheta } = zeta16Direction(placement.heading);
  const { c, s } = partRotation(placement.heading, frame);
  return {
    x: studs.x * STUD_LDU + cosTheta * frame.xLdu - sinTheta * frame.zLdu,
    z: studs.z * STUD_LDU + sinTheta * frame.xLdu + cosTheta * frame.zLdu,
    c,
    s,
  };
}

function writeMatrix(
  out: Float32Array,
  slot: number,
  placement: Pose16,
  frame: TrackPartFrame,
  yLdu: number,
  originX: number,
  originZ: number,
  ramp: RampShear | null = null,
): void {
  const { x, z, c, s } = partTransform(placement, frame);
  const gx = ramp?.gx ?? 0;
  const gz = ramp?.gz ?? 0;
  const o = slot * INSTANCE_MATRIX_FLOATS;
  out[o] = c;
  out[o + 1] = 0;
  out[o + 2] = -s;
  out[o + 3] = x - originX;
  out[o + 4] = gx * c + gz * s;
  out[o + 5] = 1;
  out[o + 6] = gz * c - gx * s;
  out[o + 7] = yLdu + (ramp ? gx * (x - ramp.lowX) + gz * (z - ramp.lowZ) : 0);
  out[o + 8] = s;
  out[o + 9] = 0;
  out[o + 10] = c;
  out[o + 11] = z - originZ;
}

function partCentre(placed: Placed): { readonly x: number; readonly z: number } {
  const { x, z } = partTransform(placed.placement, placed.part.piece.partFrame);
  return { x, z };
}

function kitFootprints(piece: TrackPiece, shapes: ReadonlyMap<string, TrackShape>): TrackShape {
  const shape = shapes.get(piece.id);
  if (!shape) throw new Error(`${piece.id}: the bundle has no track shape for it`);
  return shape;
}

function partBox(placed: Placed): WorldBox {
  const { x, z } = partTransform(placed.placement, placed.part.piece.partFrame);
  const o = normalizeHeading16(placed.placement.heading) * FOOTPRINT_FLOATS;
  const boxes = placed.part.footprints;
  const [minY, maxY] = placed.part.meshY;
  const low = Math.min(placed.yPlates, placed.yPlates + placed.rise) * PLATE_LDU;
  const high = Math.max(placed.yPlates, placed.yPlates + placed.rise) * PLATE_LDU;
  return {
    minX: x + (boxes[o] ?? 0),
    minY: placed.part.yLdu + minY + low,
    minZ: z + (boxes[o + 1] ?? 0),
    maxX: x + (boxes[o + 2] ?? 0),
    maxY: placed.part.yLdu + maxY + high,
    maxZ: z + (boxes[o + 3] ?? 0),
  };
}

function rampShear(placed: Placed): RampShear | null {
  if (placed.rise === 0) return null;
  const [low, high] = placed.part.def.connectors;
  if (!low || !high) return null;
  return shearOfRamp(
    composePose16(placed.placement, low),
    composePose16(placed.placement, high),
    placed.rise,
  );
}

function framedOutline(outline: Float64Array, placement: Pose16, frame: TrackFrame): Float64Array {
  return framedOutlineInto(outline, placement, frame, new Float64Array(outline.length));
}

function framedOutlineInto(
  outline: Float64Array,
  placement: Pose16,
  frame: TrackFrame,
  out: Float64Array,
): Float64Array {
  const placed = placedOutlineInto(outline, placement, out);
  for (let i = 0; i < placed.length; i += 2) {
    placed[i] = (placed[i] ?? 0) + frame.xLdu;
    placed[i + 1] = (placed[i + 1] ?? 0) + frame.zLdu;
  }
  return placed;
}

export function trackChunkKey(chunkX: number, chunkZ: number): number {
  return -1 - chunkKey(chunkX, chunkZ);
}

export class TrackDrawing implements ExtensionSite, LoopCloserSite {
  readonly extension: TrackExtension;
  readonly closer: LoopCloser;
  private readonly systemKits = new Map<string, SystemKit>();
  private active: SystemKit;
  private readonly byDef = new Map<string, KitPart>();
  private readonly byCatalogIndex = new Map<number, KitPart>();
  private readonly byPieceId = new Map<string, KitPart>();
  private readonly outlines = new Map<number, Float64Array>();
  private readonly framedScratch = new Map<number, Float64Array>();
  readonly pieceSet: TrackPieceSet;
  private readonly layout: TrackLayout;
  private readonly pieces: ReadonlyArray<TrackPiece>;
  private held: ReadonlyArray<FramedTrackPiece> = [];
  private carriers: ReadonlyArray<TrackCarrier> = [];
  private heldCarrier = new Int32Array(0);
  private combined: TrackLayout;
  private graph: TrackGraph;
  private readonly chunkMembers = new Map<number, number[]>();
  private pieceBoxes = new Float64Array(0);
  private pieceKeys = new Float64Array(0);
  private failedEnds = new Uint8Array(0);
  private readonly ownerBox = new Float64Array(PIECE_BOX_FLOATS);
  private readonly headingOutlines = new Map<number, HeadingOutline>();
  private readonly joinedOwners: number[] = [];
  private readonly carriedJoinOwners: number[] = [];
  private readonly scratchBox = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  private ends: Pose16[] = [];
  private endPlates: number[] = [];
  private endOwners: number[] = [];
  private openList: TrackEnd[] = [];
  private support: TrackSupport | null = null;
  private readonly skipped = new Map<DragField, SkippedIds>();
  private readonly bands: TrackBands;
  private framed: Array<Float64Array | null> = [];
  private pieceBands: ReadonlyArray<readonly [number, number]> = [];
  private readonly pieceRanges = new Map<number, readonly [number, number]>();
  private heightPlates = GROUND_PLATES;
  private risePerPiece = DEFAULT_RAMP_PLATES;
  private dragPlates = GROUND_PLATES;
  private dragRunComputed = false;
  private dragRunRoute: DragRoute | null = null;
  private dragRunStartPlates = GROUND_PLATES;
  private dragRunHeightPlates = GROUND_PLATES;
  private dragRunRise = DEFAULT_RAMP_PLATES;
  private dragRunBands = -1;
  private lastDragRun: DragRun | null = null;
  private labelCache: ReadonlyArray<LabelView> | null = null;
  private crossingCache: ReadonlyArray<OverUnderCrossing> | null = null;
  private spanBottom = new Float64Array(0);
  private spanTop = new Float64Array(0);
  private spanRailTop = new Float64Array(0);
  private raisedAt = new Int32Array(0);
  private readonly pieceBoxScratch = new Float64Array(OUTLINE_BOX_FLOATS);
  private tallest: TallestTrain | null = null;
  private readonly crossingShapes = new Map<number, CrossingShape>();
  private readonly planEdges = new Map<number, OutlineEdges>();
  private readonly supportPartList: SupportPart[] = [];
  private crossingOutlines = new Map<string, PlacedOutline>();
  private previousCrossingOutlines = new Map<string, PlacedOutline>();
  private crossingPieceList: ReadonlyArray<PlacedTrackPiece> | null = null;
  private readonly collisionBox = new Float64Array(OUTLINE_BOX_FLOATS);
  private readonly chunkSquareScratch = new Float64Array(OUTLINE_BOX_FLOATS);
  private readonly rectOutline = new Float64Array(RECT_OUTLINE_FLOATS);
  private gapList: ReadonlyArray<EndGap> = [];
  private readonly refusedColor: number;
  private drag: TrackDrag | null = null;
  private lastSolveMs = 0;
  private readonly solveSamples = new SolveSamples();
  private changes = 0;
  private openEndViews: ReadonlyArray<TrackEndView> | null = null;
  private gapViews: ReadonlyArray<TrackGapView> | null = null;
  private gappedSet: ReadonlySet<number> | null = null;
  private leverViews: ReadonlyArray<SwitchLeverView> | null = null;
  private bomList: ReadonlyArray<TrackBomLine> | null = null;
  private endStudFloats: Float64Array | null = null;
  private lastSnap: PieceSnap | null = null;
  private snapCatalogIndex = -1;
  private snapConnector = 0;
  private snapVersion = -1;
  private snapPlates = GROUND_PLATES;
  private snapEnd = NO_END;
  private snapLatticeX = 0;
  private snapLatticeZ = 0;
  private snapHeading = 0;
  private lastPieceGhost: PreviewGhost | null = null;
  private pieceGhostIndex = -1;
  private pieceGhostPlacement: Pose16 | null = null;
  private pieceGhostPlates = GROUND_PLATES;
  private pieceGhostRefused = false;
  private bandsChanges = 0;
  private readonly seatedRampOwners: number[] = [];
  private rampRows: ReadonlyArray<RampEndRow> = [];
  private rampRowsGraph: TrackGraph | null = null;
  private rampRowsSupport: TrackSupport | null = null;
  private readonly reversing = new ReversingSectionFinder();
  private reversingGraph: TrackGraph | null = null;
  private reversingSections: ReversingSections = NO_REVERSING_SECTIONS;
  private laidStart: Pose16 | null = null;
  private laidMoves: ReadonlyArray<TrackMove> | null = null;
  private lastLaid: LaidRunEnd | null = null;
  private previewLaidComputed = false;
  private previewLaidSource: object | null = null;
  private lastPreviewLaid: LaidPreview | null = null;
  private ghostComputed = false;
  private ghostSource: LaidPreview | null = null;
  private lastGhost: PreviewGhost | null = null;
  private previewLabelsComputed = false;
  private previewLabelsSource: LaidPreview | null = null;
  private lastPreviewLabels: ReadonlyArray<LabelView> = [];
  private loopsViewAt = -1;
  private loopsView: TrackLoopsView = NO_LOOPS;
  private readonly loopViews = new WeakMap<LoopClosure, LoopClosureView>();

  constructor(
    { trackCatalog: catalog, trackShapes }: Pick<PartBundle, "trackCatalog" | "trackShapes">,
    private readonly parts: ReadonlyArray<PartShapeAsset>,
    private readonly colors: ColorTable,
  ) {
    this.pieces = catalog.pieces;
    const shapes = new Map(trackShapes.map((shape) => [shape.piece, shape]));
    this.layout = new TrackLayout(catalog.pieces.map(pieceSpec));
    this.combined = this.layout;
    this.graph = new TrackGraph(this.layout);
    const placeable: Array<readonly [number, TrackPiece]> = [];
    catalog.pieces.forEach((piece, catalogIndex) => {
      const shape = kitFootprints(piece, shapes);
      const outline = footprintOutline(shape, piece.partFrame);
      this.outlines.set(catalogIndex, outline);
      const partIndex = partForPiece(piece, parts);
      const part = parts[partIndex];
      if (!part) throw new Error(`${piece.id}: part index ${partIndex} is out of range`);
      this.supportPartList.push({ catalogIndex, partIndex });
      this.planEdges.set(catalogIndex, new OutlineEdges(shape.outline));
      this.pieceRanges.set(catalogIndex, [
        shape.minY - part.boundsMin[1],
        shape.maxY - part.boundsMin[1],
      ]);
      this.crossingShapes.set(catalogIndex, {
        planOutline: shape.outline,
        bedLdu: shape.minY - part.boundsMin[1],
        system: piece.system,
      });
      const inKit = piece.kind === "straight" || piece.kind === "curve";
      if (part.producedColor === undefined) {
        throw new Error(`${piece.id}: track part has no sourced produced colour`);
      }
      const def: TrackPieceDef = { id: piece.id, connectors: piece.connectors.map((c) => c.pose) };
      const kitPart: KitPart = {
        footprints: Float64Array.from(shape.footprints),
        outline,
        meshY: [shape.minY, shape.maxY],
        catalogIndex,
        piece,
        def,
        partIndex,
        color: colors.indexOfCode(part.producedColor),
        yLdu: -part.boundsMin[1],
      };
      if (inKit) this.byDef.set(piece.id, kitPart);
      this.byCatalogIndex.set(catalogIndex, kitPart);
      this.byPieceId.set(piece.id, kitPart);
      placeable.push([catalogIndex, piece]);
    });
    this.pieceSet = new TrackPieceSet(placeable);
    const systems = new Set([TRACK_SYSTEM, ...[...this.byDef.values()].map((p) => p.piece.system)]);
    for (const system of systems) {
      const built = this.systemKit(system);
      if (built) this.systemKits.set(system, built);
    }
    const active = this.systemKits.get(TRACK_SYSTEM) ?? [...this.systemKits.values()][0];
    if (!active) throw new Error("the track catalog has no system to draw: no straight and curve");
    this.active = active;
    this.refusedColor = colors.indexOfCode(REFUSED_PIECE_LDRAW_COLOR);
    const pieces: BandPieces = {
      count: () => this.combined.count,
      outline: (p) => this.framed[p] ?? null,
      bottomLdu: (p) => this.spanBottom[p] ?? 0,
      topLdu: (p) => this.spanTop[p] ?? 0,
    };
    this.bands = new TrackBands(pieces, this.verticalRange(), this.supportedOn);
    this.extension = new TrackExtension(this);
    this.closer = new LoopCloser(this, () => performance.now());
  }

  private endsChanged(): void {
    this.extension.endsChanged();
    this.closer.endsChanged();
  }

  private systemKit(system: string): SystemKit | null {
    const parts = [...this.byDef.values()].filter((part) => part.piece.system === system);
    const straight = parts.find((part) => part.piece.kind === "straight");
    const straightPart = straight ? this.parts[straight.partIndex] : undefined;
    const result = drawingKit(parts.map((part) => part.def));
    if (!straight || !straightPart || result.kind !== "kit") return null;
    const outlines = new KitOutlines(result.kit, (piece) => this.placeablePiece(piece.id).outline);
    return {
      system,
      status: parts.every((part) => part.piece.status === "certified") ? "certified" : "unverified",
      straight,
      curve: parts.find((part) => part.piece.kind === "curve") ?? null,
      kit: result.kit,
      outlines,
      router: new StrokeRouter(outlines),
      closures: new FieldClosures(result.kit, outlines),
      railTopLdu: straight.yLdu + straightPart.boundsMax[1],
    };
  }

  get kit(): DrawingKit {
    return this.active.kit;
  }

  get activeSystem(): string {
    return this.active.system;
  }

  systems(): ReadonlyArray<TrackSystemView> {
    return [...this.systemKits.values()];
  }

  useSystem(system: string): boolean {
    const chosen = this.systemKits.get(system);
    if (!chosen) return false;
    if (chosen === this.active) return true;
    this.cancelDrag();
    this.active = chosen;
    this.endsChanged();
    return true;
  }

  private railTopOf(catalogIndex: number): number {
    const system = this.pieces[catalogIndex]?.system;
    return (
      (system === undefined ? undefined : this.systemKits.get(system))?.railTopLdu ??
      this.active.railTopLdu
    );
  }

  private measureSpan(placement: number): void {
    const layout = this.combined;
    const [bottom, top] = this.pieceRanges.get(layout.piece(placement)) ?? this.verticalRange();
    const yPlates = layout.yPlates(placement);
    const end = yPlates + layout.rise(placement);
    const low = Math.min(yPlates, end) * PLATE_LDU;
    const high = Math.max(yPlates, end) * PLATE_LDU;
    this.spanBottom[placement] = bottom + low;
    this.spanTop[placement] = top + high;
    this.spanRailTop[placement] = this.railTopOf(layout.piece(placement)) + high;
  }

  get drawingPlates(): number {
    return this.heightPlates;
  }

  get rampPlates(): number {
    return this.risePerPiece;
  }

  get tallestTrain(): TallestTrain | null {
    return this.tallest;
  }

  setDrawingPlates(plates: number): void {
    if (!Number.isInteger(plates) || plates < GROUND_PLATES || plates > INT16_MAX) {
      throw new RangeError(`track can't be drawn ${plates} plates up`);
    }
    if (plates === this.heightPlates) return;
    this.heightPlates = plates;
    if (this.drag && this.drag.fromEnd === null) this.reseatDrag(plates);
    this.extension.endsChanged();
  }

  setRampPlates(plates: number): void {
    if (!RAMP_RATES.includes(plates))
      throw new RangeError(`a ramp can't rise ${plates} plates a piece`);
    if (plates === this.risePerPiece) return;
    this.risePerPiece = plates;
    this.endsChanged();
  }

  gradePercent(): number {
    const runLdu = Number(this.kit.straightStuds) * STUD_LDU;
    return (this.risePerPiece * PLATE_LDU * PERCENT) / runLdu;
  }

  setTallestTrain(train: TallestTrain | null): void {
    this.tallest = train;
    this.labelCache = null;
  }

  private reseatDrag(plates: number): void {
    const drag = this.drag;
    if (!drag) return;
    this.dragPlates = plates;
    const band = this.bands.laying(plates, plates);
    drag.reseat(band.field, band.pending);
  }

  private placeablePiece(id: string): KitPart {
    const part = this.byPieceId.get(id);
    if (!part) throw new Error(`${id} is not a placeable track piece`);
    return part;
  }

  kitParts(): ReadonlyArray<KitPart> {
    return [...this.byDef.values()].filter((part) => part.piece.system === this.active.system);
  }

  private mostLaidSystem(): SystemKit {
    const counts = new Map<SystemKit, number>();
    for (let p = 0; p < this.combined.count; p++) {
      const system = this.pieces[this.combined.piece(p)]?.system;
      const kit = system === undefined ? undefined : this.systemKits.get(system);
      if (kit) counts.set(kit, (counts.get(kit) ?? 0) + 1);
    }
    let most = this.active;
    for (const [kit, count] of counts) if (count > (counts.get(most) ?? 0)) most = kit;
    return most;
  }

  playTrack(): PlayTrack {
    const rail = this.mostLaidSystem();
    const box = rail.straight.footprints;
    return {
      layout: this.combined,
      graph: this.graph,
      pieces: this.pieces,
      railPart: rail.straight.piece.part,
      railTopY: rail.railTopLdu,
      halfWidthLdu: Math.min((box[2] ?? 0) - (box[0] ?? 0), (box[3] ?? 0) - (box[1] ?? 0)) / 2,
    };
  }

  get pieceCount(): number {
    return this.layout.count;
  }

  get trackGraph(): TrackGraph {
    return this.graph;
  }

  pieceParts(): ReadonlyArray<KitPart> {
    return [...this.byCatalogIndex.values()];
  }

  pieceByIndex(catalogIndex: number): KitPart {
    const part = this.byCatalogIndex.get(catalogIndex);
    if (!part) throw new RangeError(`catalog piece ${catalogIndex} is not placeable`);
    return part;
  }

  countOf(catalogIndex: number): number {
    let count = 0;
    for (let p = 0; p < this.layout.count; p++) {
      if (this.layout.piece(p) === catalogIndex) count++;
    }
    return count;
  }

  countParts(counter: BomCounter, region: PlacementRegion | null): number {
    let counted = 0;
    for (let p = 0; p < this.layout.count; p++) {
      const placed = this.placedAt(p);
      if (region !== null) {
        const origin = partCentre(placed);
        if (!regionHolds(region, origin.x, origin.z)) continue;
      }
      this.countPiece(counter, p);
      counted++;
    }
    return counted;
  }

  countPiece(counter: PartSink, placement: number): void {
    const { part } = this.placedAt(placement);
    counter.add(part.partIndex, this.colors.codeAt(part.color), 1);
  }

  coincidentEndIssues(): number {
    return this.graph.issues.length;
  }

  private placedAt(placement: number): Placed {
    const layout = this.layout;
    const part = this.byCatalogIndex.get(layout.piece(placement));
    if (!part) throw new Error(`placement ${placement} is not a placeable track piece`);
    return {
      part,
      placement: layout.pose(placement),
      yPlates: layout.yPlates(placement),
      rise: layout.rise(placement),
    };
  }

  endPoses(): ReadonlyArray<Pose16> {
    return this.ends;
  }

  endHeight(end: number): number {
    const plates = this.endPlates[end];
    if (plates === undefined) throw new RangeError(`there is no open end ${end}`);
    return plates;
  }

  get version(): number {
    return this.changes;
  }

  get bandsVersion(): number {
    return this.bandsChanges;
  }

  openEnds(): ReadonlyArray<TrackEndView> {
    this.openEndViews ??= this.openList.map((end) => endView(end.pose, end.frame, end.yPlates));
    return this.openEndViews;
  }

  gaps(): ReadonlyArray<TrackGapView> {
    this.gapViews ??= this.gapList.map((gap) => {
      const endA = this.openList[gap.a];
      const endB = this.openList[gap.b];
      const a = endA?.pose ?? POSE16_IDENTITY;
      const b = endB?.pose ?? POSE16_IDENTITY;
      const viewA = endView(a, endA?.frame ?? WORLD_TRACK_FRAME, endA?.yPlates ?? GROUND_PLATES);
      const viewB = endView(b, endB?.frame ?? WORLD_TRACK_FRAME, endB?.yPlates ?? GROUND_PLATES);
      const theta = a.heading * HEADING_RADIANS;
      const dx = (viewB.xLdu - viewA.xLdu) / STUD_LDU;
      const dz = (viewB.zLdu - viewA.zLdu) / STUD_LDU;
      return {
        a: viewA,
        b: viewB,
        xStuds: viewA.xLdu / STUD_LDU,
        zStuds: viewA.zLdu / STUD_LDU,
        gapStuds: gap.gapLdu / STUD_LDU,
        aheadStuds: dx * Math.cos(theta) + dz * Math.sin(theta),
        asideStuds: dz * Math.cos(theta) - dx * Math.sin(theta),
        headingErrorSteps: gap.headingErrorSteps,
        headingErrorDegrees: (gap.headingErrorSteps * 360) / ZETA16_ORDER,
      };
    });
    return this.gapViews;
  }

  routes(): ReadonlyArray<TrackRouteView> {
    const routes: TrackRouteView[] = [];
    const layout = this.combined;
    for (let p = 0; p < layout.count; p++) {
      for (const route of this.pieces[layout.piece(p)]?.routes ?? []) {
        routes.push({
          from: endView(
            layout.connectorPose(p, route.from),
            layout.frame(p),
            layout.endYPlates(p, route.from),
          ),
          to: endView(
            layout.connectorPose(p, route.to),
            layout.frame(p),
            layout.endYPlates(p, route.to),
          ),
        });
      }
    }
    return routes;
  }

  syncHeld(held: ReadonlyArray<FramedTrackPiece>, carriers: ReadonlyArray<TrackCarrier>): void {
    const heldCarrier = new Int32Array(held.length);
    let next = 0;
    carriers.forEach((carrier, c) => {
      heldCarrier.fill(c, next, next + carrier.held);
      next += carrier.held;
    });
    if (next !== held.length) {
      throw new Error(`the carriers hold ${next} track pieces, not the ${held.length} given`);
    }
    this.held = held;
    this.carriers = carriers;
    this.heldCarrier = heldCarrier;
    this.recomputeEnds();
  }

  gappedEnds(): ReadonlySet<number> {
    this.gappedSet ??= new Set(this.gapList.flatMap((gap) => [gap.a, gap.b]));
    return this.gappedSet;
  }

  bomLines(): ReadonlyArray<TrackBomLine> {
    this.bomList ??= this.countBomLines();
    return this.bomList;
  }

  private countBomLines(): ReadonlyArray<TrackBomLine> {
    const lines = new Map<string, TrackBomLine>();
    for (const kit of this.pieceParts()) {
      const { element, title } = this.pieceSet.element(kit.catalogIndex);
      const count = this.countOf(kit.catalogIndex);
      const line = lines.get(element);
      lines.set(element, { piece: element, title, count: (line?.count ?? 0) + count });
    }
    return [...lines.values()].filter(
      (line) => line.count > 0 || this.kitParts().some((k) => k.piece.part === line.piece),
    );
  }

  private endStuds(): Float64Array {
    let studs = this.endStudFloats;
    if (!studs) {
      studs = new Float64Array(2 * this.ends.length);
      for (let index = 0; index < this.ends.length; index++) {
        const end = this.ends[index];
        if (!end) continue;
        const at = zeta16ToStuds(end.position);
        studs[2 * index] = at.x;
        studs[2 * index + 1] = at.z;
      }
      this.endStudFloats = studs;
    }
    return studs;
  }

  joinedPairs(): number {
    return this.graph.joinCount;
  }

  private movePart(move: TrackMove): KitPart {
    return this.placeablePiece(move.piece.id);
  }

  endNear(xLdu: number, zLdu: number, except: number | null): number | null {
    const studs = this.endStuds();
    let best = NO_END;
    let bestDistance = END_PICK_RADIUS_LDU;
    for (let slot = 0; slot + 1 < studs.length; slot += 2) {
      const index = slot >> 1;
      if (index === except) continue;
      const distance = planeHypot(
        (studs[slot] ?? 0) * STUD_LDU - xLdu,
        (studs[slot + 1] ?? 0) * STUD_LDU - zLdu,
      );
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    return best === NO_END ? null : best;
  }

  beginDrag(hitX: number, hitZ: number, latticeX: number, latticeZ: number): void {
    const ends: DragEnds = {
      near: (x, z, except) => this.endNear(x, z, except),
      pose: (end) => {
        const pose = this.ends[end];
        if (!pose) throw new RangeError(`open end ${end} is out of range`);
        return pose;
      },
      placement: (end) => this.endOwners[end],
    };
    const from = this.endNear(hitX, hitZ, null);
    this.dragPlates = from === null ? this.heightPlates : this.endHeight(from);
    const band = this.bands.laying(this.dragPlates, this.dragPlates);
    this.drag = new TrackDrag(
      this.active.closures.closeWhole,
      this.active.router,
      ends,
      this.laidRunEnd,
      { hitX, hitZ, latticeX, latticeZ },
      from,
      band.field,
      band.pending,
    );
  }

  setBands(source: SupportBandAt): void {
    this.bandsChanges++;
    this.bands.setSource(source);
    this.skipped.clear();
    this.reseatDrag(this.dragPlates);
    this.endsChanged();
  }

  private readonly supportedOn = (seats: StudSeats): SupportedPiece => {
    const { support } = this;
    return (frame: MoveFrame, pose: Pose16, studlessTops: TrackClearance): boolean => {
      const part = this.byDef.get(frame.move.piece.id);
      if (!part || !support) return false;
      const { catalogIndex, piece } = part;
      return support.supported(catalogIndex, piece.partFrame, pose, seats, studlessTops);
    };
  };

  setSupport(support: TrackSupport): void {
    this.support = support;
    this.bands.clear();
    this.skipped.clear();
    this.reseatDrag(this.dragPlates);
    this.endsChanged();
  }

  unsupportedPieces(): ReadonlyArray<UnsupportedPiece> | null {
    const support = this.support;
    if (!support) return null;
    const box = this.collisionBox;
    const layout = this.combined;
    const bands = this.supportBands(support);
    const found: UnsupportedPiece[] = [];
    const levelHeld = new Uint8Array(layout.count);
    const ramps: number[] = [];
    for (let p = 0; p < layout.count; p++) {
      const catalogIndex = layout.piece(p);
      const outline = this.outlines.get(catalogIndex);
      const piece = this.pieces[catalogIndex];
      if (!outline || !piece) continue;
      const yPlates = layout.yPlates(p);
      const band = bands.get(yPlates);
      if (!band) throw new Error(`no support band was built for ${yPlates} plates up`);
      if (band.pending) return null;
      if (layout.rise(p) !== 0) {
        ramps.push(p);
        continue;
      }
      const onTable = yPlates === GROUND_PLATES;
      const placement = layout.pose(p);
      const frame = layout.frame(p);
      const placed = framedOutlineInto(
        outline,
        placement,
        frame,
        this.framedScratchFor(outline.length),
      );
      outlineBox(placed, box, 0);
      const { studlessTops } = band.field.support;
      const top = studlessTops.blocker(placed, box, 0, 0, 0, NO_OBSTACLE, NO_OBSTACLE);
      const { seats } = band;
      const { partFrame } = piece;
      if (
        (top === NO_OBSTACLE && onTable) ||
        support.supported(catalogIndex, partFrame, placement, seats, studlessTops, frame, onTable)
      ) {
        levelHeld[p] = 1;
        continue;
      }
      const block = top === NO_OBSTACLE ? null : band.field.describe(studlessTopBlocker(top));
      found.push({ piece: p, block, tilted: false });
    }
    for (const p of ramps) {
      const rests = this.rampRests(p, support, bands, levelHeld);
      if (rests === null) return null;
      if (!rests) found.push({ piece: p, block: null, tilted: true });
    }
    return found;
  }

  private rampRests(
    p: number,
    support: TrackSupport,
    bands: ReadonlyMap<number, LayingBand>,
    levelHeld: Uint8Array,
  ): boolean | null {
    const graph = this.graph;
    const layout = this.combined;
    const catalogIndex = layout.piece(p);
    const piece = this.pieces[catalogIndex];
    if (!piece) return false;
    const last = graph.endStart[p + 1] ?? 0;
    for (let end = graph.endStart[p] ?? 0; end < last; end++) {
      const partner = graph.endPartner[end] ?? -1;
      const neighbour = partner < 0 ? -1 : (graph.endPlacement[partner] ?? -1);
      if (neighbour >= 0 && layout.rise(neighbour) === 0 && levelHeld[neighbour] === 1) continue;
      const yPlates = graph.endYPlates[end] ?? GROUND_PLATES;
      const band = bands.get(yPlates);
      if (!band) throw new Error(`no support band was built for ${yPlates} plates up`);
      if (band.pending) return null;
      const at = {
        xLdu: graph.endXLdu[end] ?? 0,
        zLdu: graph.endZLdu[end] ?? 0,
        heading: graph.endHeading[end] ?? 0,
      };
      const rests = support.endRests(
        catalogIndex,
        piece.partFrame,
        layout.pose(p),
        layout.frame(p),
        at,
        band.seats,
        band.field.support.studlessTops,
        yPlates === GROUND_PLATES,
      );
      if (!rests) return false;
    }
    return true;
  }

  private supportBands(support: TrackSupport): ReadonlyMap<number, LayingBand> {
    const box = this.collisionBox;
    const layout = this.combined;
    const reachAt = new Map<number, number[]>();
    for (let p = 0; p < layout.count; p++) {
      const catalogIndex = layout.piece(p);
      const outline = this.outlines.get(catalogIndex);
      const piece = this.pieces[catalogIndex];
      if (!outline || !piece) continue;
      const placement = layout.pose(p);
      const frame = layout.frame(p);
      const heights = layout.rise(p) === 0 ? [layout.yPlates(p)] : this.endHeightsOf(p);
      outlineBox(
        framedOutlineInto(outline, placement, frame, this.framedScratchFor(outline.length)),
        box,
        0,
      );
      const outlineReach = Array.from(box);
      const antiStuds = support.antiStudPoints(catalogIndex, piece.partFrame, placement, frame);
      if (antiStuds.length > 0) outlineBox(antiStuds, box, 0);
      for (const yPlates of heights) {
        const reach = reachAt.get(yPlates) ?? [];
        reachAt.set(yPlates, reach);
        reach.push(...outlineReach);
        if (antiStuds.length > 0) reach.push(...box);
      }
    }
    const bands = new Map<number, LayingBand>();
    for (const [yPlates, reach] of reachAt) {
      bands.set(yPlates, this.bands.reaching(yPlates, yPlates, Float64Array.from(reach)));
    }
    return bands;
  }

  private endHeightsOf(p: number): ReadonlyArray<number> {
    const graph = this.graph;
    const heights: number[] = [];
    const last = graph.endStart[p + 1] ?? 0;
    for (let end = graph.endStart[p] ?? 0; end < last; end++) {
      heights.push(graph.endYPlates[end] ?? GROUND_PLATES);
    }
    return heights;
  }

  supportParts(): ReadonlyArray<SupportPart> {
    return this.supportPartList;
  }

  verticalRange(): readonly [number, number] {
    let bottom = Number.POSITIVE_INFINITY;
    let top = Number.NEGATIVE_INFINITY;
    for (const part of this.byDef.values()) {
      bottom = Math.min(bottom, part.yLdu + part.meshY[0]);
      top = Math.max(top, part.yLdu + part.meshY[1]);
    }
    return [bottom, top];
  }

  private bandOf(yPlates: number, rise: number): LayingBand {
    return this.bands.laying(Math.min(yPlates, yPlates + rise), Math.max(yPlates, yPlates + rise));
  }

  pieceBlock(
    catalogIndex: number,
    placement: Pose16,
    yPlates = GROUND_PLATES,
    rise = 0,
    moving: ReadonlySet<number> = NO_PLACEMENTS,
    movingOwners: ReadonlySet<number> = NO_OWNERS,
  ): TrackBlockView | null {
    const { field } = this.bandOf(yPlates, rise);
    const part = this.pieceByIndex(catalogIndex);
    const joined = this.joinedAt(field, part.def.connectors, placement, yPlates, rise, moving);
    const { outline, box } = this.headingOutline(part, placement.heading);
    const at = zeta16ToStuds(placement.position);
    const blocker = field.clearance.blockerExcept(
      outline,
      box,
      at.x * STUD_LDU,
      at.z * STUD_LDU,
      joined,
      this.skippedIds(field, moving, movingOwners),
    );
    return field.describe(blocker);
  }

  private joinedAt(
    field: DragField,
    connectors: ReadonlyArray<Pose16>,
    placement: Pose16,
    yPlates: number,
    rise: number,
    moving: ReadonlySet<number>,
  ): ReadonlyArray<number> {
    const joined = this.joinedOwners;
    joined.length = 0;
    for (let c = 0; c < connectors.length; c++) {
      const local = connectors[c];
      if (!local) continue;
      const end = composePose16(placement, local);
      const plates = c === RAMP_HIGH_END ? yPlates + rise : yPlates;
      for (let index = 0; index < this.ends.length; index++) {
        const open = this.ends[index];
        const placed = this.endOwners[index];
        if (!open || this.endPlates[index] !== plates || !posesJoin16(open, end)) continue;
        if (placed !== undefined && moving.has(placed)) continue;
        const owner = field.pieceOwner(placed);
        if (!joined.includes(owner)) joined.push(owner);
      }
    }
    return joined;
  }

  private skippedIds(
    field: DragField,
    moving: ReadonlySet<number>,
    movingOwners: ReadonlySet<number>,
  ): ArrayLike<number> {
    if (moving.size === 0 && movingOwners.size === 0) return NO_JOINS;
    const cached = this.skipped.get(field);
    if (cached?.moving === moving && cached.movingOwners === movingOwners) return cached.ids;
    const ids = field.ownedIds(moving, movingOwners);
    this.skipped.set(field, { moving, movingOwners, ids });
    return ids;
  }

  private headingOutline(part: KitPart, heading: number): HeadingOutline {
    const steps = normalizeHeading16(heading);
    const key = part.catalogIndex * ZETA16_ORDER + steps;
    const cached = this.headingOutlines.get(key);
    if (cached) return cached;
    const outline = rotateOutline(part.outline, steps, 0, 0);
    const box = new Float64Array(OUTLINE_BOX_FLOATS);
    outlineBox(outline, box, 0);
    const turned = { outline, box };
    this.headingOutlines.set(key, turned);
    return turned;
  }

  placementsWithin(contains: (box: WorldBox) => boolean, out: number[]): void {
    out.length = 0;
    const boxes = this.pieceBoxes;
    const box = this.scratchBox;
    for (let p = 0; p < this.layout.count; p++) {
      const at = p * PIECE_BOX_FLOATS;
      box.minX = boxes[at] ?? 0;
      box.minY = boxes[at + 1] ?? 0;
      box.minZ = boxes[at + 2] ?? 0;
      box.maxX = boxes[at + 3] ?? 0;
      box.maxY = boxes[at + 4] ?? 0;
      box.maxZ = boxes[at + 5] ?? 0;
      if (contains(box)) out.push(p);
    }
  }

  connectorPose(catalogIndex: number, placement: Pose16, connector: number): Pose16 {
    const local = this.pieces[catalogIndex]?.connectors[connector]?.pose;
    if (!local) throw new RangeError(`catalog piece ${catalogIndex} has no connector ${connector}`);
    return composePose16(placement, local);
  }

  pieceBox(catalogIndex: number, placement: Pose16, yPlates = GROUND_PLATES, rise = 0): WorldBox {
    return partBox({ part: this.pieceByIndex(catalogIndex), placement, yPlates, rise });
  }

  piecesGhost(pieces: ReadonlyArray<LiftedPiece>, frame: PlacementPose): ChunkInstances {
    const count = pieces.length;
    const partIndex = new Uint16Array(count);
    const colorIndex = new Uint16Array(count);
    const matrices = new Float32Array(count * INSTANCE_MATRIX_FLOATS);
    const lift = frame.yPlates * PLATE_LDU;
    pieces.forEach(({ piece, pose, yPlates, rise }, slot) => {
      const part = this.pieceByIndex(piece);
      partIndex[slot] = part.partIndex;
      colorIndex[slot] = part.color;
      const local = pieceRelativePose(pose, frame);
      const placed = { part, placement: local, yPlates, rise };
      const yLdu = part.yLdu + yPlates * PLATE_LDU - lift;
      writeMatrix(matrices, slot, local, part.piece.partFrame, yLdu, 0, 0, rampShear(placed));
    });
    const base: ChunkPartInstances = {
      originX: 0,
      originZ: 0,
      count,
      partIndex,
      colorIndex,
      matrices,
    };
    return withStuds(base, this.parts, this.colors);
  }

  crossingPieces(): ReadonlyArray<PlacedTrackPiece> {
    this.crossingPieceList ??= this.worldCrossingPieces();
    return this.crossingPieceList;
  }

  private worldCrossingPieces(): ReadonlyArray<PlacedTrackPiece> {
    const layout = this.combined;
    const pieces: PlacedTrackPiece[] = [];
    for (let p = 0; p < layout.count; p++) {
      if (layout.frame(p).id !== WORLD_TRACK_FRAME.id) continue;
      const shape = this.crossingShapes.get(layout.piece(p));
      if (!shape) continue;
      pieces.push({
        placement: p,
        outline: this.worldOutline(p, shape),
        bedLdu: layout.yPlates(p) * PLATE_LDU + shape.bedLdu,
        system: shape.system,
      });
    }
    return pieces;
  }

  laidOutline(piece: number): PlacedOutline {
    const shape = this.crossingShapes.get(this.layout.piece(piece));
    if (!shape) throw new Error(`placement ${piece} is not a placeable track piece`);
    return this.worldOutline(piece, shape);
  }

  private worldOutline(p: number, shape: CrossingShape): PlacedOutline {
    const pose = this.combined.pose(p);
    const key = crossingOutlineKey(this.combined.piece(p), pose);
    let outline = this.crossingOutlines.get(key) ?? this.previousCrossingOutlines.get(key);
    if (!outline) outline = PlacedOutline.ofTrackPiece(shape.planOutline, pose);
    this.crossingOutlines.set(key, outline);
    return outline;
  }

  runFrameOutlines(): ReadonlyArray<Float64Array> {
    const layout = this.combined;
    const outlines: Float64Array[] = [];
    for (let p = 0; p < layout.count; p++) {
      if (layout.frame(p).id === WORLD_TRACK_FRAME.id) continue;
      const part = this.byCatalogIndex.get(layout.piece(p));
      if (part) outlines.push(framedOutline(part.outline, layout.pose(p), layout.frame(p)));
    }
    return outlines;
  }

  modelBlocker(
    rectsIn: SolidRects,
    carried: ReadonlyArray<FramedTrackPiece>,
    moving: ReadonlySet<number>,
    movingOwners: ReadonlySet<number>,
    seated: StudSeatProbe | null = null,
  ): TrackBlockView | null {
    const box = this.collisionBox;
    const rect = this.rectOutline;
    for (const [low, high] of this.pieceBands) {
      const field = this.bands.solid(low, high);
      const span = this.bands.span(low, high);
      const skipped = this.skippedIds(field, moving, movingOwners);
      const carriedJoined = this.carriedJoins(field, carried, moving);
      const joined = seated ? this.withSeatedRamps(field, carriedJoined, seated) : carriedJoined;
      const { rects, floats } = rectsIn(span.bottomLdu, span.topLdu);
      for (let r = 0; r < floats; r += OBSTACLE_RECT_FLOATS) {
        writeRectOutline(rect, rects, r);
        outlineBox(rect, box, 0);
        const hit = field.clearance.blockerExcept(rect, box, 0, 0, joined, skipped);
        if (field.isTrack(hit)) return field.describe(hit);
      }
    }
    for (const piece of carried) {
      const pieceOutline = this.outlines.get(piece.catalogIndex);
      if (!pieceOutline) continue;
      const outline = framedOutlineInto(
        pieceOutline,
        piece.placement,
        piece.frame,
        this.framedScratchFor(pieceOutline.length),
      );
      outlineBox(outline, box, 0);
      const squares = writeChunkSquares(box, this.chunkSquareScratch);
      const { field } = this.bands.reaching(piece.yPlates, piece.yPlates, squares);
      const skipped = this.skippedIds(field, moving, movingOwners);
      const joined =
        piece.frame.id === WORLD_TRACK_FRAME.id
          ? this.joinedAt(
              field,
              this.layout.pieces[piece.catalogIndex]?.connectors ?? NO_POSES,
              piece.placement,
              piece.yPlates,
              0,
              moving,
            )
          : NO_JOINS;
      const hit = field.clearance.blockerExcept(outline, box, 0, 0, joined, skipped);
      if (hit !== NO_OBSTACLE) return field.describe(hit);
    }
    return null;
  }

  private withSeatedRamps(
    field: DragField,
    joined: ReadonlyArray<number>,
    seated: StudSeatProbe,
  ): ReadonlyArray<number> {
    const rows = this.rampEndRows();
    if (rows.length === 0) return joined;
    const owners = this.seatedRampOwners;
    owners.length = 0;
    for (const owner of joined) owners.push(owner);
    for (const row of rows) {
      const owner = field.pieceOwner(row.piece);
      if (owners.includes(owner)) continue;
      for (let i = 0; i < row.cells.length; i += 2) {
        if (!seated(row.cells[i] ?? 0, row.cells[i + 1] ?? 0, row.baseLdu)) continue;
        owners.push(owner);
        break;
      }
    }
    return owners;
  }

  private rampEndRows(): ReadonlyArray<RampEndRow> {
    const support = this.support;
    if (this.rampRowsGraph === this.graph && this.rampRowsSupport === support) {
      return this.rampRows;
    }
    this.rampRowsGraph = this.graph;
    this.rampRowsSupport = support;
    const rows: RampEndRow[] = [];
    this.rampRows = rows;
    if (!support) return rows;
    const graph = this.graph;
    const layout = this.combined;
    for (let p = 0; p < layout.count; p++) {
      if (layout.rise(p) === 0 || layout.frame(p).id !== WORLD_TRACK_FRAME.id) continue;
      const catalogIndex = layout.piece(p);
      const piece = this.pieces[catalogIndex];
      if (!piece) continue;
      const last = graph.endStart[p + 1] ?? 0;
      for (let end = graph.endStart[p] ?? 0; end < last; end++) {
        const at = {
          xLdu: graph.endXLdu[end] ?? 0,
          zLdu: graph.endZLdu[end] ?? 0,
          heading: graph.endHeading[end] ?? 0,
        };
        const cells = support.endRowCells(catalogIndex, piece.partFrame, layout.pose(p), at);
        if (cells.length === 0) continue;
        const baseLdu = this.bandBottomLdu(graph.endYPlates[end] ?? GROUND_PLATES);
        rows.push({ piece: p, baseLdu, cells });
      }
    }
    return rows;
  }

  private carriedJoins(
    field: DragField,
    carried: ReadonlyArray<FramedTrackPiece>,
    moving: ReadonlySet<number>,
  ): ReadonlyArray<number> {
    const owners = this.carriedJoinOwners;
    owners.length = 0;
    for (const piece of carried) {
      if (piece.frame.id !== WORLD_TRACK_FRAME.id) continue;
      const connectors = this.layout.pieces[piece.catalogIndex]?.connectors ?? NO_POSES;
      for (const owner of this.joinedAt(
        field,
        connectors,
        piece.placement,
        piece.yPlates,
        0,
        moving,
      )) {
        if (!owners.includes(owner)) owners.push(owner);
      }
    }
    return owners;
  }

  private framedScratchFor(floats: number): Float64Array {
    let scratch = this.framedScratch.get(floats);
    if (!scratch) {
      scratch = new Float64Array(floats);
      this.framedScratch.set(floats, scratch);
    }
    return scratch;
  }

  closure(from: number, to: number): ExtensionJoin {
    const start = this.ends[from];
    const goal = this.ends[to];
    if (!start || !goal) throw new RangeError(`no open ends ${from} and ${to} to join`);
    const startPlates = this.endHeight(from);
    const { field, pending } = this.bands.laying(startPlates, startPlates);
    if (pending) return { kind: "refused", refusal: "pending", blocked: null };
    const result = this.active.closures.closeWhole(
      start,
      goal,
      field,
      field.pieceOwner(this.endOwners[from]),
      field.pieceOwner(this.endOwners[to]),
    );
    switch (result.kind) {
      case "exact": {
        const moves = runMoves(this.kit, result.run);
        const plan = this.runPlan(startPlates, moves, this.endHeight(to));
        if (plan.kind === "too-steep") {
          return { kind: "refused", refusal: "too-steep", blocked: null };
        }
        const blocked = this.raisedBlock(start, startPlates, moves, plan.heights);
        if (blocked) return { kind: "refused", refusal: "blocked", blocked: blocked.block };
        return result;
      }
      case "blocked":
        return { kind: "refused", refusal: "blocked", blocked: field.describe(result.blocker) };
      case "impossible":
      case "limit":
        return { kind: "refused", refusal: result.kind, blocked: null };
      default: {
        const unhandled: never = result;
        throw new Error(`unhandled closure ${String(unhandled)}`);
      }
    }
  }

  joinedEnd(from: number, move: TrackMove): number | null {
    const start = this.ends[from];
    if (!start) throw new RangeError(`no open end ${from} to lay ${move.piece.id} on`);
    const { end } = layMoves(start, [move]);
    return this.openEndJoining(end, this.pieceHeights(from, move).endPlates);
  }

  pieceFit(from: number, move: TrackMove): PieceFit {
    const start = this.ends[from];
    const laid = start ? layMoves(start, [move]) : null;
    const piece = laid?.placed[0];
    if (!laid || !piece) throw new RangeError(`no open end ${from} to lay ${move.piece.id} on`);
    const yPlates = this.endHeight(from);
    return {
      joins: this.openEndJoining(laid.end, yPlates),
      blocked: this.pieceBlock(this.movePart(move).catalogIndex, piece.placement, yPlates),
    };
  }

  pieceLabel(piece: TrackPieceDef): string {
    return this.pieceSet.label(this.placeablePiece(piece.id).catalogIndex);
  }

  private openEndJoining(end: Pose16, plates: number): number | null {
    const joined = this.ends.findIndex(
      (open, index) => this.endPlates[index] === plates && posesJoin16(end, open),
    );
    return joined < 0 ? null : joined;
  }

  private pieceHeights(from: number, move: TrackMove): RunHeights {
    const plan = this.runPlan(this.endHeight(from), [move], null);
    if (plan.kind === "too-steep")
      throw new Error("a run without a goal height is never too steep");
    return plan.heights;
  }

  crosses(from: number, move: TrackMove, joins: number | null): TrackBlockView | null {
    const start = this.ends[from];
    const placed = start ? layMoves(start, [move]).placed[0] : undefined;
    if (!start || !placed) throw new RangeError(`no open end ${from} to lay ${move.piece.id} on`);
    const startPlates = this.endHeight(from);
    const heights = this.pieceHeights(from, move);
    const raised = this.raisedBlock(start, startPlates, [move], heights);
    if (raised) return raised.block;
    const { field } = this.bands.laying(startPlates, startPlates);
    const blocker = field.clearance.pieceBlocker(
      this.movePart(move).outline,
      placed.placement,
      field.pieceOwner(this.endOwners[from]),
      joins === null ? NO_OBSTACLE : field.pieceOwner(this.endOwners[joins]),
    );
    return field.describe(blocker);
  }

  moveDrag(hitX: number, hitZ: number): void {
    const drag = this.drag;
    if (!drag) return;
    const began = performance.now();
    drag.extend(hitX, hitZ);
    this.lastSolveMs = performance.now() - began;
    this.solveSamples.push(this.lastSolveMs);
  }

  solveStats(): TrackSolveStats | null {
    return this.solveSamples.stats();
  }

  isDragging(): boolean {
    return this.drag !== null;
  }

  dragView(): TrackDragView | null {
    const view = this.drag?.view(this.lastSolveMs);
    if (!view) return null;
    const run = this.dragRun();
    if (!run) return view;
    if (run.refusal) return { ...view, closure: run.refusal, blocked: run.blocked };
    if (run.moves.length === view.pieces) return view;
    const straights = run.moves.filter((move) => move.turn === 0).length;
    const curves = run.moves.length - straights;
    return { ...view, pieces: run.moves.length, straights, curves, blocked: run.blocked };
  }

  private runPlan(
    startPlates: number,
    moves: ReadonlyArray<TrackMove>,
    goalPlates: number | null,
  ): RunHeightsResult {
    const toward = goalPlates ?? this.heightPlates;
    const reached = reachablePlates(startPlates, toward, moves.length, this.risePerPiece);
    const straights = moves.map((move) => move.turn === 0);
    const rises = rampRises(startPlates, reached, straights, this.risePerPiece);
    if (!rises) throw new Error(`a run of ${moves.length} pieces can't reach ${reached} plates`);
    const heights = runHeights(moves, startPlates, rises);
    return {
      kind: goalPlates === null || reached === goalPlates ? "heights" : "too-steep",
      heights,
    };
  }

  private raisedBlock(
    start: Pose16,
    startPlates: number,
    moves: ReadonlyArray<TrackMove>,
    heights: RunHeights,
  ): RaisedBlock | null {
    const { placed } = layMoves(start, moves);
    for (let at = 0; at < placed.length; at++) {
      const move = moves[at];
      const piece = placed[at];
      const yPlates = heights.yPlates[at] ?? startPlates;
      const rise = heights.rise[at] ?? 0;
      if (!move || !piece || (rise === 0 && yPlates === startPlates)) continue;
      const block = this.pieceBlock(
        this.movePart(move).catalogIndex,
        piece.placement,
        yPlates,
        rise,
      );
      if (block) return { at, block };
    }
    return null;
  }

  private dragRun(): DragRun | null {
    const drag = this.drag;
    if (!drag) return null;
    const route = drag.route();
    if (
      this.dragRunComputed &&
      route === this.dragRunRoute &&
      this.dragPlates === this.dragRunStartPlates &&
      this.heightPlates === this.dragRunHeightPlates &&
      this.risePerPiece === this.dragRunRise &&
      this.bands.version === this.dragRunBands
    ) {
      return this.lastDragRun;
    }
    const run = this.planDragRun(route);
    this.dragRunComputed = true;
    this.dragRunRoute = route;
    this.dragRunStartPlates = this.dragPlates;
    this.dragRunHeightPlates = this.heightPlates;
    this.dragRunRise = this.risePerPiece;
    this.dragRunBands = this.bands.version;
    this.lastDragRun = run;
    return run;
  }

  private planDragRun(route: DragRoute): DragRun | null {
    if (!route.start) return null;
    const { start } = route;
    const startPlates = this.dragPlates;
    const joining = route.closure === "exact" && route.withheld === null;
    const goalPlates = joining && route.goalEnd !== null ? this.endHeight(route.goalEnd) : null;
    const shown = route.blockedMove ? [...route.moves, route.blockedMove] : route.moves;
    const planned = this.runPlan(startPlates, shown, goalPlates);
    const { heights } = planned;
    const whole = { route, start, heights, moves: route.moves, refused: route.blockedMove };
    if (planned.kind === "too-steep") return { ...whole, refusal: "too-steep", blocked: null };
    const raised = this.raisedBlock(start, startPlates, route.moves, heights);
    if (!raised) return { ...whole, refusal: null, blocked: route.blocked };
    const cut = {
      ...whole,
      moves: route.moves.slice(0, raised.at),
      refused: route.moves[raised.at] ?? null,
    };
    return joining
      ? { ...cut, refusal: "blocked", blocked: raised.block }
      : { ...cut, refusal: null, blocked: raised.block };
  }

  private laidRun(start: Pose16, moves: ReadonlyArray<TrackMove>): LaidRun {
    return this.laidRunEnd(start, moves).run;
  }

  private readonly laidRunEnd = (start: Pose16, moves: ReadonlyArray<TrackMove>): LaidRunEnd => {
    const last = this.lastLaid;
    if (last && start === this.laidStart && moves === this.laidMoves) return last;
    const run = layMoves(start, moves);
    const end = zeta16ToStuds(run.end.position);
    const laid: LaidRunEnd = { run, endXStuds: end.x, endZStuds: end.z };
    this.lastLaid = laid;
    this.laidStart = start;
    this.laidMoves = moves;
    return laid;
  };

  dragTarget(): DragTargetView | null {
    return this.drag?.targetView() ?? null;
  }

  ghost(): PreviewGhost | null {
    const preview = this.previewLaid();
    if (this.ghostComputed && preview === this.ghostSource) return this.lastGhost;
    this.ghostComputed = true;
    this.ghostSource = preview;
    this.lastGhost = preview ? this.buildGhost(preview) : null;
    return this.lastGhost;
  }

  private previewLaid(): LaidPreview | null {
    const source = this.drag
      ? this.dragRun()
      : (this.closer.previewed() ?? this.extension.chosen());
    if (this.previewLaidComputed && source === this.previewLaidSource) return this.lastPreviewLaid;
    this.previewLaidComputed = true;
    this.previewLaidSource = source;
    this.lastPreviewLaid = this.layPreview(this.previewRun());
    return this.lastPreviewLaid;
  }

  private layPreview(run: PreviewRun | null): LaidPreview | null {
    if (!run) return null;
    const moves = run.refused ? [...run.moves, run.refused] : run.moves;
    if (moves.length === 0) return null;
    return { run, moves, laid: this.laidRun(run.start, moves) };
  }

  private previewRun(): PreviewRun | null {
    if (this.drag) return this.dragRun();
    const loop = this.closer.previewed();
    if (loop) {
      const { heights } = this.loopHeights(loop);
      return { start: loop.start, moves: loop.moves, refused: null, heights };
    }
    const run = this.extension.chosen();
    if (!run) return null;
    const { choice } = run;
    const { heights } = this.extensionHeights(run);
    if (choice.blocked === null) {
      return { start: run.start, moves: choice.moves, refused: null, heights };
    }
    return { start: run.start, moves: [], refused: choice.moves[0] ?? null, heights };
  }

  private extensionHeights({ from, choice }: ExtensionRun): RunHeightsResult {
    const startPlates = this.endHeight(from);
    if (choice.kind === "piece") {
      const level = new Int8Array(choice.moves.length);
      return { kind: "heights", heights: runHeights(choice.moves, startPlates, level) };
    }
    const goal = choice.joins === null ? null : this.endHeight(choice.joins);
    return this.runPlan(startPlates, choice.moves, goal);
  }

  private loopHeights(loop: LoopClosure): RunHeightsResult {
    return this.runPlan(this.endHeight(loop.from), loop.moves, this.endHeight(loop.to));
  }

  private buildGhost({ run: route, moves, laid }: LaidPreview): PreviewGhost {
    const { start } = route;
    const { placed } = laid;
    const count = placed.length;
    const partIndex = new Uint16Array(count);
    const colorIndex = new Uint16Array(count);
    const matrices = new Float32Array(count * INSTANCE_MATRIX_FLOATS);
    const origin = zeta16ToStuds(start.position);
    const originX = origin.x * STUD_LDU;
    const originZ = origin.z * STUD_LDU;
    for (let i = 0; i < count; i++) {
      const move = moves[i];
      const piece = placed[i];
      if (!move || !piece) continue;
      const part = this.movePart(move);
      partIndex[i] = part.partIndex;
      colorIndex[i] = i < route.moves.length ? part.color : this.refusedColor;
      const yPlates = route.heights.yPlates[i] ?? GROUND_PLATES;
      const rise = route.heights.rise[i] ?? 0;
      const lifted = { part, placement: piece.placement, yPlates, rise };
      const yLdu = part.yLdu + yPlates * PLATE_LDU;
      const { partFrame } = part.piece;
      const ramp = rampShear(lifted);
      writeMatrix(matrices, i, piece.placement, partFrame, yLdu, originX, originZ, ramp);
    }
    const base: ChunkPartInstances = { originX, originZ, count, partIndex, colorIndex, matrices };
    return {
      instances: withStuds(base, this.parts, this.colors),
      x: originX,
      z: originZ,
    };
  }

  cancelDrag(): void {
    this.drag = null;
  }

  endDrag(): DragOutcome {
    const run = this.dragRun();
    const route = this.drag?.route();
    this.drag = null;
    if (!route) return NOTHING_LAID;
    const { closure, withheld } = route;
    if (run?.refusal) return { ...NOTHING_LAID, refusal: run.refusal, blocked: run.blocked };
    if (
      withheld === null &&
      (closure === "impossible" || closure === "blocked" || closure === "limit")
    ) {
      return { ...NOTHING_LAID, refusal: closure, blocked: route.blocked };
    }
    const blocked = run?.blocked ?? route.blocked;
    if (!run || run.moves.length === 0) return { ...NOTHING_LAID, blocked, withheld };
    const { change, end } = this.runChange(run.start, run.moves, run.heights);
    const whole = run.moves.length === route.moves.length;
    const goal = withheld === null && whole ? route.goal : null;
    return { change, goal, end, refusal: null, blocked, withheld };
  }

  extensionPlan(): ExtensionPlan | null {
    const run = this.drag ? null : this.extension.chosen();
    if (!run) return null;
    const { heights } = this.extensionHeights(run);
    const { change, end } = this.runChange(run.start, run.choice.moves, heights);
    const goal = run.choice.joins === null ? null : (this.ends[run.choice.joins] ?? null);
    return { run, change, goal, end };
  }

  loopPlan(key: string | null): LoopPlan | null {
    const closure = this.drag ? null : this.closer.find(key);
    if (!closure) return null;
    const { heights } = this.loopHeights(closure);
    return { closure, change: this.runChange(closure.start, closure.moves, heights).change };
  }

  loops(): TrackLoopsView {
    const { closer } = this;
    if (closer.version === this.loopsViewAt) return this.loopsView;
    this.loopsViewAt = closer.version;
    this.loopsView = {
      closures: closer.closures().map((closure) => this.loopView(closure)),
      checked: closer.checked,
      pairs: closer.pairCount,
      waiting: closer.waiting,
      previewed: closer.previewing,
    };
    return this.loopsView;
  }

  private loopView(closure: LoopClosure): LoopClosureView {
    const known = this.loopViews.get(closure);
    if (known) return known;
    const counts = new Map<string, LoopPartCount>();
    for (const move of closure.moves) {
      const { element, title } = this.pieceSet.element(this.kitPart(move).catalogIndex);
      const counted = counts.get(element)?.count ?? 0;
      counts.set(element, { part: element.replace(/^[a-z]+:/u, ""), title, count: counted + 1 });
    }
    const view: LoopClosureView = {
      key: closure.key,
      from: endView(closure.start, WORLD_TRACK_FRAME, this.endHeight(closure.from)),
      to: endView(closure.goal, WORLD_TRACK_FRAME, this.endHeight(closure.to)),
      gapLdu: closure.gapLdu,
      pieces: closure.moves.length,
      parts: [...counts.values()].toSorted((a, b) => a.part.localeCompare(b.part)),
    };
    this.loopViews.set(closure, view);
    return view;
  }

  onExtension(xLdu: number, zLdu: number): boolean {
    const run = this.drag ? null : this.extension.chosen();
    if (!run) return false;
    const at = zeta16ToStuds(run.start.position);
    if (planeHypot(at.x * STUD_LDU - xLdu, at.z * STUD_LDU - zLdu) <= END_PICK_RADIUS_LDU) {
      return true;
    }
    return layMoves(run.start, run.choice.moves).placed.some((piece, i) => {
      const move = run.choice.moves[i];
      if (!move) return false;
      const box = this.pieceBox(this.movePart(move).catalogIndex, piece.placement);
      return xLdu >= box.minX && xLdu <= box.maxX && zLdu >= box.minZ && zLdu <= box.maxZ;
    });
  }

  private runChange(
    start: Pose16,
    moves: ReadonlyArray<TrackMove>,
    heights: RunHeights,
  ): { readonly change: TrackChange; readonly end: Pose16 } {
    const { placed, end } = layMoves(start, moves);
    const entries: Placed[] = [];
    placed.forEach((piece, i) => {
      const move = moves[i];
      if (!move) return;
      entries.push({
        part: this.movePart(move),
        placement: piece.placement,
        yPlates: heights.yPlates[i] ?? GROUND_PLATES,
        rise: heights.rise[i] ?? 0,
      });
    });
    return { change: this.appended(entries), end };
  }

  private appended(entries: ReadonlyArray<Placed>): TrackChange {
    return {
      lift: [],
      lay: entries.map((entry, i) => ({
        index: this.layout.count + i,
        piece: entry.part.catalogIndex,
        pose: entry.placement,
        yPlates: entry.yPlates,
        rise: entry.rise,
      })),
    };
  }

  applyTrack(change: TrackChange): ReadonlyArray<number> {
    const touched = new Set<number>();
    for (let i = change.lift.length - 1; i >= 0; i--) {
      const at = change.lift[i];
      if (!at) continue;
      const laid = this.placedAt(at.index);
      const same =
        laid.part.catalogIndex === at.piece &&
        laid.yPlates === at.yPlates &&
        laid.rise === at.rise &&
        pose16Equals(laid.placement, at.pose);
      if (!same) throw new Error(`laid track piece ${at.index} is not the piece the edit lifts`);
      touched.add(this.chunkOfPlaced(laid));
      this.layout.remove(at.index);
    }
    for (const at of change.lay) {
      const part = this.pieceByIndex(at.piece);
      this.layout.insert(at.index, at.piece, at.pose, at.yPlates, at.rise);
      touched.add(this.chunkOfPlaced({ part, placement: at.pose, yPlates: at.yPlates, rise: 0 }));
    }
    this.indexChunks();
    this.recomputeEnds();
    return [...touched];
  }

  private indexChunks(): void {
    this.chunkMembers.clear();
    this.pieceBoxes = new Float64Array(this.layout.count * PIECE_BOX_FLOATS);
    this.pieceKeys = new Float64Array(this.layout.count);
    for (let p = 0; p < this.layout.count; p++) {
      const placed = this.placedAt(p);
      const box = partBox(placed);
      const at = p * PIECE_BOX_FLOATS;
      this.pieceBoxes[at] = box.minX;
      this.pieceBoxes[at + 1] = box.minY;
      this.pieceBoxes[at + 2] = box.minZ;
      this.pieceBoxes[at + 3] = box.maxX;
      this.pieceBoxes[at + 4] = box.maxY;
      this.pieceBoxes[at + 5] = box.maxZ;
      const key = this.chunkOfPlaced(placed);
      this.pieceKeys[p] = key;
      const members = this.chunkMembers.get(key);
      if (members) members.push(p);
      else this.chunkMembers.set(key, [p]);
    }
  }

  private chunkOfPlaced(placed: Placed): number {
    const centre = partCentre(placed);
    return trackChunkKey(chunkOf(centre.x), chunkOf(centre.z));
  }

  snapPiece(
    catalogIndex: number,
    connector: number,
    hitX: number,
    hitZ: number,
    latticeX: number,
    latticeZ: number,
    heading: number,
  ): PieceSnap {
    const end = this.endNear(hitX, hitZ, null) ?? NO_END;
    const last = this.lastSnap;
    if (
      last !== null &&
      catalogIndex === this.snapCatalogIndex &&
      connector === this.snapConnector &&
      this.changes === this.snapVersion &&
      this.heightPlates === this.snapPlates &&
      end === this.snapEnd &&
      latticeX === this.snapLatticeX &&
      latticeZ === this.snapLatticeZ &&
      heading === this.snapHeading
    ) {
      return last;
    }
    const snap = this.buildSnap(catalogIndex, connector, end, latticeX, latticeZ, heading);
    this.lastSnap = snap;
    this.snapCatalogIndex = catalogIndex;
    this.snapConnector = connector;
    this.snapVersion = this.changes;
    this.snapPlates = this.heightPlates;
    this.snapEnd = end;
    this.snapLatticeX = latticeX;
    this.snapLatticeZ = latticeZ;
    this.snapHeading = heading;
    return snap;
  }

  private buildSnap(
    catalogIndex: number,
    connector: number,
    end: number,
    latticeX: number,
    latticeZ: number,
    heading: number,
  ): PieceSnap {
    const part = this.pieceByIndex(catalogIndex);
    const connectors = part.def.connectors;
    const held = normalizeConnector(connector, connectors.length);
    const local = connectors[held];
    if (!local) throw new RangeError(`${part.piece.id} has no connector ${connector}`);
    const target = end === NO_END ? undefined : this.ends[end];
    const placement = target
      ? attachPose16(local, target)
      : freePlacement(part.def, held, latticePose(latticeX, latticeZ, heading));
    const yPlates = end === NO_END ? this.heightPlates : this.endHeight(end);
    const studs = this.endStuds();
    let joins = 0;
    const misses: number[] = [];
    for (let c = 0; c < connectors.length; c++) {
      const own = connectors[c];
      if (!own) continue;
      const pose = composePose16(placement, own);
      const at = zeta16ToStuds(pose.position);
      for (let slot = 0; slot + 1 < studs.length; slot += 2) {
        const index = slot >> 1;
        const endX = studs[slot] ?? 0;
        const endZ = studs[slot + 1] ?? 0;
        const open = this.ends[index];
        if (
          open &&
          this.endPlates[index] === yPlates &&
          sameStuds(endX, endZ, at.x, at.z) &&
          posesJoin16(open, pose)
        ) {
          joins++;
          continue;
        }
        const gapLdu = planeHypot(endX - at.x, endZ - at.z) * STUD_LDU;
        if (gapLdu <= NEAR_MISS_RADIUS_LDU) misses.push(index);
      }
    }
    return {
      placement,
      yPlates,
      end: target ? end : null,
      joins,
      misses: this.stableMisses(misses),
    };
  }

  private stableMisses(misses: number[]): ReadonlyArray<number> {
    if (misses.length === 0) return NO_MISSES;
    const last = this.lastSnap?.misses;
    if (!last || last.length !== misses.length) return misses;
    for (let i = 0; i < misses.length; i++) if (last[i] !== misses[i]) return misses;
    return last;
  }

  pieceGhost(
    catalogIndex: number,
    placement: Pose16,
    yPlates: number,
    refused: boolean,
  ): PreviewGhost {
    const last = this.lastPieceGhost;
    if (
      last &&
      catalogIndex === this.pieceGhostIndex &&
      placement === this.pieceGhostPlacement &&
      yPlates === this.pieceGhostPlates &&
      refused === this.pieceGhostRefused
    ) {
      return last;
    }
    const part = this.pieceByIndex(catalogIndex);
    const origin = zeta16ToStuds(placement.position);
    const originX = origin.x * STUD_LDU;
    const originZ = origin.z * STUD_LDU;
    const partIndex = Uint16Array.of(part.partIndex);
    const colorIndex = Uint16Array.of(refused ? this.refusedColor : part.color);
    const matrices = new Float32Array(INSTANCE_MATRIX_FLOATS);
    const yLdu = part.yLdu + yPlates * PLATE_LDU;
    writeMatrix(matrices, 0, placement, part.piece.partFrame, yLdu, originX, originZ);
    const base: ChunkPartInstances = {
      originX,
      originZ,
      count: 1,
      partIndex,
      colorIndex,
      matrices,
    };
    const ghost: PreviewGhost = {
      instances: withStuds(base, this.parts, this.colors),
      x: originX,
      z: originZ,
    };
    this.lastPieceGhost = ghost;
    this.pieceGhostIndex = catalogIndex;
    this.pieceGhostPlacement = placement;
    this.pieceGhostPlates = yPlates;
    this.pieceGhostRefused = refused;
    return ghost;
  }

  pieceChange(catalogIndex: number, placement: Pose16, yPlates: number): TrackChange {
    return this.appended([{ part: this.pieceByIndex(catalogIndex), placement, yPlates, rise: 0 }]);
  }

  switchAt(xLdu: number, zLdu: number): number | null {
    let best: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let p = 0; p < this.layout.count; p++) {
      const placed = this.placedAt(p);
      if (this.pieceSet.thrown(placed.part.catalogIndex) === null) continue;
      const box = partBox(placed);
      if (xLdu < box.minX || xLdu > box.maxX || zLdu < box.minZ || zLdu > box.maxZ) continue;
      const centre = partCentre(placed);
      const distance = planeHypot(centre.x - xLdu, centre.z - zLdu);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = p;
      }
    }
    return best;
  }

  switchThrow(placement: number): SwitchThrow | null {
    const placed = this.placedAt(placement);
    const thrown = this.pieceSet.thrown(placed.part.catalogIndex);
    if (thrown === null) return null;
    const lever = this.pieceSet.lever(thrown);
    if (lever === null) throw new Error(`catalog piece ${thrown} has no lever position`);
    const lifted = this.laidPiece(placement);
    return { change: { lift: [lifted], lay: [{ ...lifted, piece: thrown }] }, lever };
  }

  removal(placement: number): TrackChange {
    return { lift: [this.laidPiece(placement)], lay: [] };
  }

  laidPiece(placement: number): TrackPieceAt {
    const placed = this.placedAt(placement);
    return {
      index: placement,
      piece: placed.part.catalogIndex,
      pose: placed.placement,
      yPlates: placed.yPlates,
      rise: placed.rise,
    };
  }

  pieceOnRay(ray: Float64Array): TrackPieceHit | null {
    const dy = ray[RAY_DIRECTION_Y] ?? 0;
    if (dy === 0) return null;
    let best: TrackPieceHit | null = null;
    for (let p = 0; p < this.layout.count; p++) {
      const placed = this.placedAt(p);
      const top = partBox(placed).maxY;
      const distance = (top - (ray[RAY_ORIGIN_Y] ?? 0)) / dy;
      if (distance < 0 || (best && distance >= best.distance)) continue;
      const x = (ray[RAY_ORIGIN_X] ?? 0) + distance * (ray[RAY_DIRECTION_X] ?? 0);
      const z = (ray[RAY_ORIGIN_Z] ?? 0) + distance * (ray[RAY_DIRECTION_Z] ?? 0);
      if (outlineContains(placedOutline(placed.part.outline, placed.placement), x, z)) {
        best = { placement: p, distance };
      }
    }
    return best;
  }

  laidPieceView(placement: number): LaidPieceView {
    const placed = this.placedAt(placement);
    const centre = partCentre(placed);
    return {
      piece: placed.part.piece.id,
      xLdu: centre.x,
      zLdu: centre.z,
      yPlates: this.layout.yPlates(placement),
      heading: placed.placement.heading,
      chunkKey: this.chunkOfPlaced(placed),
      box: partBox(placed),
    };
  }

  switchLevers(): ReadonlyArray<SwitchLeverView> {
    this.leverViews ??= this.findSwitchLevers();
    return this.leverViews;
  }

  private findSwitchLevers(): ReadonlyArray<SwitchLeverView> {
    const levers: SwitchLeverView[] = [];
    for (let p = 0; p < this.layout.count; p++) {
      const lever = this.pieceSet.lever(this.layout.piece(p));
      if (lever === null) continue;
      const placed = this.placedAt(p);
      const centre = partCentre(placed);
      levers.push({
        placement: p,
        element: this.pieceSet.element(placed.part.catalogIndex).element,
        lever,
        xLdu: centre.x,
        zLdu: centre.z,
      });
    }
    return levers;
  }

  joinsAt(end: Pose16): boolean {
    const graph = this.graph;
    for (let e = 0; e < graph.endCount; e++) {
      if ((graph.endPartner[e] ?? NO_END) === NO_END) continue;
      if (graph.endFrame[e] !== WORLD_TRACK_FRAME.id) continue;
      const pose = this.combined.connectorPose(
        graph.endPlacement[e] ?? 0,
        graph.endConnector[e] ?? 0,
      );
      if (pose16Equals(pose, end)) return true;
    }
    return false;
  }

  private combine(): TrackLayout {
    if (this.held.length === 0) return this.layout;
    const combined = new TrackLayout(this.pieces.map(pieceSpec));
    for (let p = 0; p < this.layout.count; p++) {
      combined.place(
        this.layout.piece(p),
        this.layout.pose(p),
        this.layout.yPlates(p),
        this.layout.rise(p),
      );
    }
    for (const piece of this.held)
      combined.place(piece.catalogIndex, piece.placement, piece.yPlates, 0, piece.frame);
    return combined;
  }

  private recomputeEnds(): void {
    this.combined = this.combine();
    this.indexBands();
    this.previousCrossingOutlines = this.crossingOutlines;
    this.crossingOutlines = new Map();
    this.crossingPieceList = null;
    this.graph = new TrackGraph(this.combined);
    const world: TrackEnd[] = [];
    const inRunFrames: TrackEnd[] = [];
    const owners: number[] = [];
    for (const end of this.graph.openEnds) {
      const placement = this.graph.endPlacement[end] ?? 0;
      const connector = this.graph.endConnector[end] ?? 0;
      const open: TrackEnd = {
        pose: this.combined.connectorPose(placement, connector),
        yPlates: this.combined.endYPlates(placement, connector),
        frame: this.combined.frame(placement),
      };
      if (open.frame.id !== WORLD_TRACK_FRAME.id) {
        inRunFrames.push(open);
        continue;
      }
      owners.push(placement);
      world.push(open);
    }
    this.ends = world.map((end) => end.pose);
    this.endPlates = world.map((end) => end.yPlates);
    this.endOwners = owners;
    this.openList = [...world, ...inRunFrames];
    this.gapList = endGaps(this.openList);
    this.changes++;
    this.openEndViews = null;
    this.gapViews = null;
    this.gappedSet = null;
    this.leverViews = null;
    this.bomList = null;
    this.endStudFloats = null;
    this.endsChanged();
  }

  private indexBands(): void {
    const layout = this.combined;
    const framed: Array<Float64Array | null> = [];
    const bands = new Map<string, readonly [number, number]>();
    const raised: number[] = [];
    this.spanBottom = new Float64Array(layout.count);
    this.spanTop = new Float64Array(layout.count);
    this.spanRailTop = new Float64Array(layout.count);
    for (let p = 0; p < layout.count; p++) {
      const outline = this.outlines.get(layout.piece(p));
      framed.push(outline ? framedOutline(outline, layout.pose(p), layout.frame(p)) : null);
      const yPlates = layout.yPlates(p);
      const end = yPlates + layout.rise(p);
      const band = [Math.min(yPlates, end), Math.max(yPlates, end)] as const;
      bands.set(`${band[0]}:${band[1]}`, band);
      if (band[1] !== GROUND_PLATES) raised.push(p);
      this.measureSpan(p);
    }
    this.raisedAt = Int32Array.from(raised);
    this.framed = framed;
    this.pieceBands = [...bands.values()];
    this.labelCache = null;
    this.crossingCache = null;
    this.bands.changed();
    this.skipped.clear();
  }

  levelRaisedPieces(change: TrackChange): ReadonlyArray<RaisedPiece> {
    return change.lay.flatMap((at) =>
      at.yPlates > GROUND_PLATES && at.rise === 0
        ? [{ index: at.index, catalogIndex: at.piece, placement: at.pose, yPlates: at.yPlates }]
        : [],
    );
  }

  rampEndsAbove(change: TrackChange): ReadonlyArray<RampEndRest> {
    const support = this.support;
    if (!support || change.lay.every((at) => at.rise === 0)) return [];
    const levelEnds = new Set<string>();
    const layout = this.combined;
    for (let p = 0; p < layout.count; p++) {
      if (layout.rise(p) !== 0) continue;
      const count = this.pieces[layout.piece(p)]?.connectors.length ?? 0;
      for (let c = 0; c < count; c++) {
        levelEnds.add(endKeyOf(layout.connectorPose(p, c), layout.yPlates(p)));
      }
    }
    for (const at of change.lay) {
      if (at.rise !== 0) continue;
      const count = this.pieceByIndex(at.piece).def.connectors.length;
      for (let c = 0; c < count; c++) {
        levelEnds.add(endKeyOf(this.connectorPose(at.piece, at.pose, c), at.yPlates));
      }
    }
    const drafts = new Map<string, RampEndDraft>();
    for (const at of change.lay) {
      if (at.rise === 0) continue;
      const part = this.pieceByIndex(at.piece);
      const ends = [at.yPlates, at.yPlates + at.rise];
      for (let c = 0; c < ends.length; c++) {
        const yPlates = ends[c] ?? GROUND_PLATES;
        if (yPlates <= GROUND_PLATES) continue;
        const pose = this.connectorPose(at.piece, at.pose, c);
        const key = endKeyOf(pose, yPlates);
        if (levelEnds.has(key)) continue;
        const studs = zeta16ToStuds(pose.position);
        const end = { xLdu: studs.x * STUD_LDU, zLdu: studs.z * STUD_LDU, heading: pose.heading };
        const draft = drafts.get(key) ?? { indices: [], rows: [], yPlates, ...end };
        draft.indices.push(at.index);
        draft.rows.push(support.endRowCells(at.piece, part.piece.partFrame, at.pose, end));
        drafts.set(key, draft);
      }
    }
    return [...drafts.values()].map(({ indices, rows, yPlates, xLdu, zLdu }) => ({
      indices,
      yPlates,
      antiStuds: Int32Array.from(rows.flatMap((row) => Array.from(row))),
      rows,
      xLdu,
      zLdu,
    }));
  }

  rampEndSeated(rest: RampEndRest): boolean {
    const { seats } = this.bands.laying(rest.yPlates, rest.yPlates);
    return rest.rows.every((row) => {
      for (let i = 0; i < row.length; i += 2) {
        if (seats.has(cellKey(row[i] ?? 0, row[i + 1] ?? 0))) return true;
      }
      return false;
    });
  }

  raisedCount(): number {
    return this.raisedAt.length;
  }

  seated(piece: RaisedPiece): boolean {
    const support = this.support;
    if (!support) return false;
    const band = this.bands.laying(piece.yPlates, piece.yPlates);
    const { partFrame } = this.pieceByIndex(piece.catalogIndex).piece;
    const { studlessTops } = band.field.support;
    const { placement, catalogIndex } = piece;
    const world = WORLD_TRACK_FRAME;
    return support.supported(
      catalogIndex,
      partFrame,
      placement,
      band.seats,
      studlessTops,
      world,
      false,
    );
  }

  changeOverlaps(change: TrackChange, except: ReadonlyArray<number>, box: WorldBox): boolean {
    const rect = this.rectOutline;
    rect.set([box.minX, box.minZ, box.maxX, box.minZ, box.maxX, box.maxZ, box.minX, box.maxZ]);
    for (const at of change.lay) {
      if (except.includes(at.index)) continue;
      const part = this.pieceByIndex(at.piece);
      const placed = { part, placement: at.pose, yPlates: at.yPlates, rise: at.rise };
      const piece = partBox(placed);
      if (piece.minY >= box.maxY || piece.maxY <= box.minY) continue;
      if (piece.minX >= box.maxX || piece.maxX <= box.minX) continue;
      if (piece.minZ >= box.maxZ || piece.maxZ <= box.minZ) continue;
      if (outlinesOverlap(placedOutline(part.outline, at.pose), 0, 0, rect, 0, 0)) return true;
    }
    return false;
  }

  bandBottomLdu(yPlates: number): number {
    return this.bands.span(yPlates, yPlates).bottomLdu;
  }

  heightLabels(): ReadonlyArray<LabelView> {
    this.labelCache ??= this.measuredLabels();
    return this.labelCache;
  }

  private measuredLabels(): ReadonlyArray<LabelView> {
    const graph = this.graph;
    const layout = this.combined;
    const [, top] = this.verticalRange();
    const labels = new Map<string, LabelView>();
    for (let end = 0; end < graph.endCount; end++) {
      const yPlates = graph.endYPlates[end] ?? GROUND_PLATES;
      if (yPlates === GROUND_PLATES) continue;
      const placement = graph.endPlacement[end] ?? 0;
      const at = endView(
        layout.connectorPose(placement, graph.endConnector[end] ?? 0),
        layout.frame(placement),
        yPlates,
      );
      const id = `height:${yPlates}:${at.xLdu}:${at.zLdu}`;
      labels.set(id, {
        id,
        kind: "height",
        text: heightText(yPlates * PLATE_LDU),
        x: at.xLdu,
        y: top + yPlates * PLATE_LDU,
        z: at.zLdu,
      });
    }
    return [...this.clearanceLabels(), ...labels.values()];
  }

  previewLabels(): ReadonlyArray<LabelView> {
    const preview = this.previewLaid();
    if (this.previewLabelsComputed && preview === this.previewLabelsSource) {
      return this.lastPreviewLabels;
    }
    this.previewLabelsComputed = true;
    this.previewLabelsSource = preview;
    this.lastPreviewLabels = preview ? this.measuredPreviewLabels(preview) : [];
    return this.lastPreviewLabels;
  }

  private measuredPreviewLabels({ run, laid }: LaidPreview): ReadonlyArray<LabelView> {
    const plates = run.heights.endPlates;
    const raised = run.heights.yPlates.some((y) => y !== GROUND_PLATES);
    if (plates === GROUND_PLATES && !raised) return [];
    const at = endView(laid.end, WORLD_TRACK_FRAME, plates);
    const [, top] = this.verticalRange();
    return [
      {
        id: "height:preview",
        kind: "height",
        text: heightText(plates * PLATE_LDU),
        x: at.xLdu,
        y: top + plates * PLATE_LDU,
        z: at.zLdu,
      },
    ];
  }

  raisedTrackOverlaps(
    outline: Float64Array,
    bottomLdu: number,
    topLdu: number,
    standsOn: ReadonlySet<number>,
  ): boolean {
    if (this.raisedAt.length === 0) return false;
    const box = this.collisionBox;
    outlineBox(outline, box, 0);
    const pieceBox = this.pieceBoxScratch;
    for (const p of this.raisedAt) {
      if (standsOn.has(p)) continue;
      const framed = this.framed[p];
      if (!framed) continue;
      if ((this.spanBottom[p] ?? 0) >= topLdu || bottomLdu >= (this.spanTop[p] ?? 0)) continue;
      outlineBox(framed, pieceBox, 0);
      if (!boxesOverlap(box, 0, 0, 0, pieceBox, 0)) continue;
      if (outlinesOverlap(outline, 0, 0, framed, 0, 0)) return true;
    }
    return false;
  }

  lowClearances(): ReadonlyArray<LowClearance> | null {
    const train = this.tallest;
    if (!train) return null;
    const [bottom] = this.verticalRange();
    const worst = new Map<number, LowClearance>();
    for (const crossing of this.crossings()) {
      if (crossing.gapLdu >= train.heightLdu) continue;
      const hasPlates = ((this.spanBottom[crossing.upper] ?? 0) - bottom) / PLATE_LDU;
      const shortPlates = Math.ceil((train.heightLdu - crossing.gapLdu) / PLATE_LDU);
      const needPlates = hasPlates + shortPlates;
      const known = worst.get(crossing.upper);
      if (known && known.needPlates >= needPlates) continue;
      worst.set(crossing.upper, { piece: crossing.upper, needPlates, hasPlates, train });
    }
    return [...worst.values()];
  }

  private crossings(): ReadonlyArray<OverUnderCrossing> {
    this.crossingCache ??= this.overUnderCrossings();
    return this.crossingCache;
  }

  private overUnderCrossings(): ReadonlyArray<OverUnderCrossing> {
    if (this.raisedAt.length === 0) return [];
    const count = this.combined.count;
    const boxes = new Float64Array(count * OUTLINE_BOX_FLOATS);
    const cells = new Map<number, number[]>();
    for (let p = 0; p < count; p++) {
      const outline = this.framed[p];
      if (!outline) continue;
      outlineBox(outline, boxes, p * OUTLINE_BOX_FLOATS);
      this.forCellsOf(boxes, p, (cell) => {
        const listed = cells.get(cell);
        if (listed) listed.push(p);
        else cells.set(cell, [p]);
      });
    }
    const seen = new Int32Array(count).fill(NO_PIECE);
    const crossings: OverUnderCrossing[] = [];
    for (const upper of this.raisedAt) {
      const outline = this.framed[upper];
      if (!outline) continue;
      const underside = this.spanBottom[upper] ?? 0;
      this.forCellsOf(boxes, upper, (cell) => {
        for (const lower of cells.get(cell) ?? []) {
          if (lower === upper || seen[lower] === upper) continue;
          seen[lower] = upper;
          if (underside < (this.spanTop[lower] ?? 0)) continue;
          const under = this.framed[lower];
          if (
            !under ||
            !boxesOverlap(
              boxes,
              upper * OUTLINE_BOX_FLOATS,
              0,
              0,
              boxes,
              lower * OUTLINE_BOX_FLOATS,
            )
          )
            continue;
          if (!outlinesOverlap(outline, 0, 0, under, 0, 0)) continue;
          crossings.push(this.crossingOf(boxes, upper, lower));
        }
      });
    }
    return crossings;
  }

  private forCellsOf(boxes: Float64Array, placement: number, visit: (cell: number) => void): void {
    const at = placement * OUTLINE_BOX_FLOATS;
    const minX = Math.floor((boxes[at] ?? 0) / CHUNK_LDU);
    const minZ = Math.floor((boxes[at + 1] ?? 0) / CHUNK_LDU);
    const maxX = Math.floor((boxes[at + 2] ?? 0) / CHUNK_LDU);
    const maxZ = Math.floor((boxes[at + 3] ?? 0) / CHUNK_LDU);
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) visit(cellKey(x, z));
    }
  }

  private crossingOf(boxes: Float64Array, upper: number, lower: number): OverUnderCrossing {
    const u = upper * OUTLINE_BOX_FLOATS;
    const l = lower * OUTLINE_BOX_FLOATS;
    const middle = (axis: number): number =>
      (Math.max(boxes[u + axis] ?? 0, boxes[l + axis] ?? 0) +
        Math.min(boxes[u + axis + 2] ?? 0, boxes[l + axis + 2] ?? 0)) /
      2;
    return {
      upper,
      lower,
      gapLdu: (this.spanBottom[upper] ?? 0) - (this.spanRailTop[lower] ?? 0),
      x: middle(0),
      z: middle(1),
    };
  }

  private clearanceLabels(): ReadonlyArray<LabelView> {
    const train = this.tallest;
    return this.crossings().map((crossing) => {
      const clear = `${heightText(crossing.gapLdu)} clear`;
      const low = train !== null && crossing.gapLdu < train.heightLdu;
      return {
        id: `clearance:${crossing.upper}:${crossing.lower}`,
        kind: "height",
        text: low ? `${clear}: too low for ${train.model}` : clear,
        x: crossing.x,
        y: this.spanBottom[crossing.upper] ?? 0,
        z: crossing.z,
      };
    });
  }

  footprintAt(piece: number): TrackFootprint {
    const placed = this.placedAt(piece);
    const centre = partCentre(placed);
    return {
      key: { chunkKey: trackChunkKey(chunkOf(centre.x), chunkOf(centre.z)), slot: piece },
      ref: placed.part.piece.id,
      label: `${placed.part.piece.title} #${piece + 1}`,
      box: partBox(placed),
    };
  }

  writeFootprint(piece: number, delta: PlanDelta, kind: number): void {
    const footprint = this.footprintAt(piece);
    const entry = delta.write(
      kind,
      TRACK_SEGMENT,
      piece,
      footprint.key.slot,
      footprint.ref,
      LABEL_NUMBERED,
      this.placedAt(piece).part.piece.title,
    );
    delta.chunkKey[entry] = footprint.key.chunkKey;
    delta.labelA[entry] = piece + 1;
    delta.labelB[entry] = 0;
    delta.outline[entry] = this.planOutline(piece);
    const { box } = footprint;
    const at = entry * BOX_STRIDE;
    delta.box[at + BOX_MIN_X] = box.minX;
    delta.box[at + BOX_MIN_Y] = box.minY;
    delta.box[at + BOX_MIN_Z] = box.minZ;
    delta.box[at + BOX_MAX_X] = box.maxX;
    delta.box[at + BOX_MAX_Y] = box.maxY;
    delta.box[at + BOX_MAX_Z] = box.maxZ;
  }

  private planOutline(piece: number): TrackOutline {
    return this.outlineAt(this.layout.piece(piece), this.layout.pose(piece));
  }

  outlineAt(catalogIndex: number, pose: Pose16): TrackOutline {
    const edges = this.planEdges.get(catalogIndex);
    const connectors = this.pieces[catalogIndex]?.connectors;
    if (!edges || !connectors) {
      throw new Error(`track catalog piece ${catalogIndex} has no plan outline`);
    }
    return new TrackOutline(
      edges,
      pose,
      connectors.map((connector) => connector.pose),
    );
  }

  writeIssues(delta: PlanDelta): void {
    const rows = delta.writeTrackIssues();
    const graph = this.graph;
    const failed = this.markFailedEnds();
    for (let k = 0; k < graph.openEnds.length; k++) {
      const end = graph.openEnds[k] ?? 0;
      if (failed[end] === 1) continue;
      const issue = rows.add(TRACK_OPEN_END, "", "");
      rows.x[issue] = graph.endXLdu[end] ?? 0;
      rows.z[issue] = graph.endZLdu[end] ?? 0;
      this.addEndOwner(rows, issue, graph.endPlacement[end] ?? 0);
    }
    const groups = graph.issues;
    for (let g = 0; g < groups.length; g++) {
      const ends = groups[g]?.ends ?? [];
      const first = ends[0] ?? 0;
      const issue = rows.add(TRACK_UNJOINED_ENDS, "", "");
      rows.x[issue] = graph.endXLdu[first] ?? 0;
      rows.z[issue] = graph.endZLdu[first] ?? 0;
      rows.quantity[issue] = ends.length;
      const second = ends[1];
      if (ends.length === 2 && second !== undefined) {
        const off = normalizeHeading16(
          (graph.endHeading[first] ?? 0) - (graph.endHeading[second] ?? 0) - HALF_TURN_16,
        );
        rows.headingOffset[issue] = Math.min(off, ZETA16_ORDER - off);
      }
      for (let e = 0; e < ends.length; e++) {
        this.addEndOwner(rows, issue, graph.endPlacement[ends[e] ?? 0] ?? 0);
      }
    }
    this.addReversingRows(rows);
    const carriers = this.carriers;
    for (let c = 0; c < carriers.length; c++) {
      const carrier = carriers[c];
      if (!carrier) continue;
      this.addPartRows(rows, TRACK_UNVERIFIED, carrier.unverified, carrier.model);
      this.addPartRows(rows, TRACK_UNIDENTIFIED, carrier.unidentified, carrier.model);
    }
    this.addLaidUnverifiedRows(rows);
  }

  private addReversingRows(rows: TrackIssueRows): void {
    const graph = this.graph;
    const sections = this.reversingSectionsOfGraph();
    for (let s = 0; s < sections.count; s++) {
      const turning = sections.turningEnd[s] ?? 0;
      const issue = rows.add(TRACK_REVERSING, "", "");
      rows.x[issue] = graph.endXLdu[turning] ?? 0;
      rows.z[issue] = graph.endZLdu[turning] ?? 0;
      const last = sections.placementStart[s + 1] ?? 0;
      for (let k = sections.placementStart[s] ?? 0; k < last; k++) {
        this.addEndOwner(rows, issue, sections.placements[k] ?? 0);
      }
    }
  }

  private reversingSectionsOfGraph(): ReversingSections {
    if (this.reversingGraph !== this.graph) {
      this.reversingGraph = this.graph;
      this.reversingSections = this.reversing.find(this.graph);
    }
    return this.reversingSections;
  }

  private addLaidUnverifiedRows(rows: TrackIssueRows): void {
    const laid = new Map<number, number[]>();
    for (let p = 0; p < this.layout.count; p++) {
      const catalogIndex = this.layout.piece(p);
      if (this.pieces[catalogIndex]?.status !== "unverified") continue;
      const placements = laid.get(catalogIndex) ?? [];
      placements.push(p);
      laid.set(catalogIndex, placements);
    }
    for (const [catalogIndex, placements] of laid) {
      const piece = this.pieces[catalogIndex];
      if (!piece) continue;
      const issue = rows.add(TRACK_LAID_UNVERIFIED, piece.part, piece.title);
      rows.quantity[issue] = placements.length;
      for (const placement of placements) this.addEndOwner(rows, issue, placement);
    }
  }

  private addPartRows(
    rows: TrackIssueRows,
    kind: number,
    parts: ReadonlyArray<TrackPartCount>,
    model: TrackOwner,
  ): void {
    for (let k = 0; k < parts.length; k++) {
      const counted = parts[k];
      const piece = counted ? this.pieces[counted.catalogIndex] : undefined;
      if (!counted || !piece) throw new RangeError(`track part ${k} is not in the catalog`);
      const issue = rows.add(kind, piece.part, piece.title);
      rows.quantity[issue] = counted.count;
      this.addModelOwner(rows, issue, model);
    }
  }

  private markFailedEnds(): Uint8Array {
    const graph = this.graph;
    if (this.failedEnds.length < graph.endCount) this.failedEnds = new Uint8Array(graph.endCount);
    const failed = this.failedEnds;
    failed.fill(0, 0, graph.endCount);
    const groups = graph.issues;
    for (let g = 0; g < groups.length; g++) {
      const ends = groups[g]?.ends ?? [];
      for (let e = 0; e < ends.length; e++) failed[ends[e] ?? 0] = 1;
    }
    return failed;
  }

  private addEndOwner(rows: TrackIssueRows, issue: number, placement: number): void {
    const laid = this.layout.count;
    if (placement >= laid) {
      const carrier = this.carriers[this.heldCarrier[placement - laid] ?? -1];
      if (!carrier) throw new RangeError(`held track piece ${placement - laid} has no carrier`);
      this.addModelOwner(rows, issue, carrier.model);
      return;
    }
    if (this.ownsLaidPiece(rows, issue, placement)) return;
    const owner = rows.addOwner(
      issue,
      LABEL_NUMBERED,
      this.pieceByIndex(this.layout.piece(placement)).piece.title,
      placement,
    );
    rows.ownerChunkKey[owner] = this.pieceKeys[placement] ?? 0;
    rows.ownerLabelA[owner] = placement + 1;
    rows.ownerLabelB[owner] = 0;
    rows.setOwnerBox(owner, this.pieceBoxes, placement * PIECE_BOX_FLOATS);
  }

  private addModelOwner(rows: TrackIssueRows, issue: number, model: TrackOwner): void {
    const { handle, placeable, box } = model;
    if (this.ownsModel(rows, issue, handle)) return;
    const owner = rows.addOwner(issue, LABEL_AT, placeable.label, handle.slot);
    rows.ownerChunkKey[owner] = handle.chunkKey;
    rows.ownerLabelA[owner] = handle.x;
    rows.ownerLabelB[owner] = handle.z;
    const scratch = this.ownerBox;
    scratch[0] = box.minX;
    scratch[1] = box.minY;
    scratch[2] = box.minZ;
    scratch[3] = box.maxX;
    scratch[4] = box.maxY;
    scratch[5] = box.maxZ;
    rows.setOwnerBox(owner, scratch, 0);
  }

  private ownsLaidPiece(rows: TrackIssueRows, issue: number, placement: number): boolean {
    const last = rows.ownerStart[issue + 1] ?? 0;
    for (let owner = rows.ownerStart[issue] ?? 0; owner < last; owner++) {
      if (
        rows.ownerSlot[owner] === placement &&
        rows.ownerChunkKey[owner] === this.pieceKeys[placement]
      ) {
        return true;
      }
    }
    return false;
  }

  private ownsModel(rows: TrackIssueRows, issue: number, handle: TrackOwner["handle"]): boolean {
    const last = rows.ownerStart[issue + 1] ?? 0;
    for (let owner = rows.ownerStart[issue] ?? 0; owner < last; owner++) {
      if (rows.ownerSlot[owner] === handle.slot && rows.ownerChunkKey[owner] === handle.chunkKey) {
        return true;
      }
    }
    return false;
  }

  records(): TrackRecordV1[] {
    const records: TrackRecordV1[] = [];
    for (let index = 0; index < this.layout.count; index++) {
      const placed = this.placedAt(index);
      records.push({
        index,
        ref: placed.part.piece.id,
        heading: placed.placement.heading,
        position: encodeTrackPosition(placed.placement.position),
        yPlates: placed.yPlates,
        ...(placed.rise === 0 ? {} : { rise: placed.rise }),
      });
    }
    return records;
  }

  restore(records: ReadonlyArray<TrackRecordV1>): Decoded<ReadonlyArray<number>> {
    if (this.layout.count > 0) {
      return {
        ok: false,
        issues: [{ path: "track", message: "can only be restored into an empty drawing" }],
      };
    }
    const lay = this.laidPieces(records);
    return lay.ok ? { ok: true, value: this.applyTrack({ lift: [], lay: lay.value }) } : lay;
  }

  laidPieces(records: ReadonlyArray<TrackRecordV1>): Decoded<ReadonlyArray<TrackPieceAt>> {
    const issues: Issue[] = [];
    records.forEach((record, position) => {
      if (record.index !== position) {
        issues.push({ path: `track ${record.index}`, message: `is out of order at ${position}` });
      }
      if (!this.byPieceId.has(record.ref)) {
        issues.push({
          path: `track ${record.index}`,
          message: `"${record.ref}" isn't a placeable track piece`,
        });
      }
      const rise = record.rise ?? 0;
      if (!isLatticePose(0, 0, record.yPlates + rise)) {
        issues.push({
          path: `track ${record.index}`,
          message: `rises to ${record.yPlates + rise} plates, outside the int16 plate range`,
        });
      }
      const ends = this.byPieceId.get(record.ref)?.def.connectors.length ?? 0;
      if (rise !== 0 && ends !== RAMP_CONNECTORS) {
        issues.push({
          path: `track ${record.index}`,
          message: `"${record.ref}" has ${ends} ends, so it can't ramp`,
        });
      }
    });
    if (issues.length > 0) return { ok: false, issues };
    const lay = records.flatMap((record, index) => {
      const part = this.byPieceId.get(record.ref);
      if (!part) return [];
      const pose = pose16(decodeTrackPosition(record.position), record.heading);
      const rise = record.rise ?? 0;
      return [{ index, piece: part.catalogIndex, pose, yPlates: record.yPlates, rise }];
    });
    return { ok: true, value: lay };
  }

  chunkKeys(): ReadonlyArray<number> {
    return [...this.chunkMembers.keys()];
  }

  chunkInstances(key: number): ChunkInstances | null {
    const members = this.chunkMembers.get(key);
    if (!members || members.length === 0) return null;
    const centre = partCentre(this.placedAt(members[0] ?? 0));
    const originX = chunkOf(centre.x) * CHUNK_LDU;
    const originZ = chunkOf(centre.z) * CHUNK_LDU;
    const count = members.length;
    const partIndex = new Uint16Array(count);
    const colorIndex = new Uint16Array(count);
    const matrices = new Float32Array(count * INSTANCE_MATRIX_FLOATS);
    members.forEach((member, i) => {
      const piece = this.placedAt(member);
      partIndex[i] = piece.part.partIndex;
      colorIndex[i] = piece.part.color;
      writeMatrix(
        matrices,
        i,
        piece.placement,
        piece.part.piece.partFrame,
        piece.part.yLdu + piece.yPlates * PLATE_LDU,
        originX,
        originZ,
        rampShear(piece),
      );
    });
    const base: ChunkPartInstances = { originX, originZ, count, partIndex, colorIndex, matrices };
    return withStuds(base, this.parts, this.colors);
  }
}
