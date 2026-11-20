import type { PartBundle, PartShapeAsset } from "@brr/catalog";
import type { TrackPartFrame, TrackPiece, TrackShape } from "@brr/schema/bundle";
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
  TRACK_SEGMENT,
  TRACK_UNIDENTIFIED,
  TRACK_UNJOINED_ENDS,
  TRACK_UNVERIFIED,
  type PlanDelta,
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
  solveClosure,
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
  posesJoin16,
  pose16,
  pose16Equals,
  zeta16Direction,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";
import { INSTANCE_MATRIX_FLOATS, type ChunkInstances, type WorldBox } from "@brr/render";
import type { ChunkPartInstances } from "../scene/placements.ts";
import { withStuds } from "../scene/stud-stream.ts";
import type { ColorTable } from "../scene/viewer-scene.ts";
import type { FramedTrackPiece, TrackPartCount } from "../connect/model-track-ends.ts";
import {
  CLOSURE_BUDGET_MS,
  DragField,
  TrackDrag,
  type DragEnds,
  type DragTargetView,
  type DragRefusal,
  type JoinWithheld,
  type TrackBlockView,
  type TrackDragView,
} from "./track-drag.ts";
import {
  NO_TRACK_OBSTACLES,
  OBSTACLE_RECT_FLOATS,
  type TrackObstacles,
} from "./track-obstacles.ts";
import type { TrackSupport } from "./track-support.ts";
import { TrackPieceSet, type Lever } from "./track-pieces.ts";
import {
  TrackExtension,
  type ExtensionJoin,
  type ExtensionRun,
  type ExtensionSite,
} from "./track-extension.ts";
import { pieceRelativePose } from "./group-transform.ts";

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
const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const HALF_STEP_RADIANS = HEADING_RADIANS / 2;
const END_PICK_RADIUS_LDU = 3 * STUD_LDU;
const GROUND_PLATES = 0;
const GHOST_SCRATCH_PIECES = 64;
const REFUSED_PIECE_LDRAW_COLOR = 4;
const NO_PLACEMENTS: ReadonlySet<number> = new Set();
const NO_OWNERS: ReadonlySet<number> = new Set();
const PIECE_BOX_FLOATS = 6;

interface SkippedIds {
  readonly field: DragField;
  readonly moving: ReadonlySet<number>;
  readonly movingOwners: ReadonlySet<number>;
  readonly ids: Int32Array;
}

interface HeadingOutline {
  readonly outline: Float64Array;
  readonly box: Float64Array;
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

export interface SupportBand {
  readonly obstacles: TrackObstacles;
  readonly pending: boolean;
}

export type SupportBandAt = (yPlates: number) => SupportBand;

interface JudgedBand {
  readonly field: DragField;
  readonly seats: ReadonlySet<number>;
  readonly onTable: boolean;
}

export interface SupportPart {
  readonly catalogIndex: number;
  readonly partIndex: number;
}

export interface UnsupportedPiece {
  readonly piece: number;
  readonly block: TrackBlockView | null;
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

interface PreviewRun {
  readonly start: Pose16;
  readonly moves: ReadonlyArray<TrackMove>;
  readonly refused: TrackMove | null;
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
  readonly pieces: ReadonlyArray<TrackPiece>;
  readonly railPart: string;
  readonly railTopY: number;
  readonly halfWidthLdu: number;
}

export interface TrackEndView {
  readonly xLdu: number;
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

export interface JoinEndView {
  readonly placement: number;
  readonly connector: number;
  readonly pose: Pose16;
  readonly yPlates: number;
}

export interface TrackJoinView {
  readonly end: JoinEndView;
  readonly partner: JoinEndView;
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
}

function normalizeConnector(connector: number, count: number): number {
  return ((connector % count) + count) % count;
}

function endView(end: Pose16, frame: TrackFrame = WORLD_TRACK_FRAME): TrackEndView {
  const studs = zeta16ToStuds(end.position);
  return {
    xLdu: studs.x * STUD_LDU + frame.xLdu,
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
): void {
  const { x, z, c, s } = partTransform(placement, frame);
  const o = slot * INSTANCE_MATRIX_FLOATS;
  out[o] = c;
  out[o + 1] = 0;
  out[o + 2] = -s;
  out[o + 3] = x - originX;
  out[o + 4] = 0;
  out[o + 5] = 1;
  out[o + 6] = 0;
  out[o + 7] = yLdu;
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
  return {
    minX: x + (boxes[o] ?? 0),
    minY: placed.part.yLdu + minY,
    minZ: z + (boxes[o + 1] ?? 0),
    maxX: x + (boxes[o + 2] ?? 0),
    maxY: placed.part.yLdu + maxY,
    maxZ: z + (boxes[o + 3] ?? 0),
  };
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

export class TrackDrawing implements ExtensionSite {
  readonly kit: DrawingKit;
  readonly extension: TrackExtension;
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
  private readonly scratchBox = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  private ends: Pose16[] = [];
  private endPlates: number[] = [];
  private endOwners: number[] = [];
  private openList: TrackEnd[] = [];
  private obstacles: TrackObstacles = NO_TRACK_OBSTACLES;
  private support: TrackSupport | null = null;
  private field: DragField | null = null;
  private skipped: SkippedIds | null = null;
  private readonly crossingShapes = new Map<number, CrossingShape>();
  private readonly planEdges = new Map<number, OutlineEdges>();
  private readonly supportPartList: SupportPart[] = [];
  private readonly crossingOutlines = new Map<number, PlacedOutline>();
  private readonly collisionBox = new Float64Array(OUTLINE_BOX_FLOATS);
  private readonly rectOutline = new Float64Array(RECT_OUTLINE_FLOATS);
  private seatsPending = false;
  private gapList: ReadonlyArray<EndGap> = [];
  private readonly kitOutlines: KitOutlines;
  private readonly router: StrokeRouter;
  private readonly refusedColor: number;
  private drag: TrackDrag | null = null;
  private lastSolveMs = 0;
  private ghostParts = new Uint16Array(GHOST_SCRATCH_PIECES);
  private ghostColors = new Uint16Array(GHOST_SCRATCH_PIECES);
  private ghostMatrices = new Float32Array(GHOST_SCRATCH_PIECES * INSTANCE_MATRIX_FLOATS);
  readonly solveSamplesMs: number[] = [];

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
      if (piece.status !== "certified") return;
      const shape = kitFootprints(piece, shapes);
      const outline = footprintOutline(shape, piece.partFrame);
      this.outlines.set(catalogIndex, outline);
      const partIndex = partForPiece(piece, parts);
      const part = parts[partIndex];
      if (!part) throw new Error(`${piece.id}: part index ${partIndex} is out of range`);
      this.supportPartList.push({ catalogIndex, partIndex });
      this.planEdges.set(catalogIndex, new OutlineEdges(shape.outline));
      this.crossingShapes.set(catalogIndex, {
        planOutline: shape.outline,
        bedLdu: shape.minY - part.boundsMin[1],
        system: piece.system,
      });
      if (piece.system !== TRACK_SYSTEM) return;
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
    const result = drawingKit([...this.byDef.values()].map((k) => k.def));
    if (result.kind !== "kit") throw new Error(`no ${TRACK_SYSTEM} drawing kit: ${result.reason}`);
    this.kit = result.kit;
    this.kitOutlines = new KitOutlines(this.kit, (piece) => this.placeablePiece(piece.id).outline);
    this.router = new StrokeRouter(this.kitOutlines);
    this.refusedColor = colors.indexOfCode(REFUSED_PIECE_LDRAW_COLOR);
    this.extension = new TrackExtension(this);
  }

  private placeablePiece(id: string): KitPart {
    const part = this.byPieceId.get(id);
    if (!part) throw new Error(`${id} is not a placeable track piece`);
    return part;
  }

  kitParts(): ReadonlyArray<KitPart> {
    return [...this.byDef.values()];
  }

  playTrack(): PlayTrack {
    const straight = this.kitParts().find((k) => k.piece.kind === "straight");
    const part = straight ? this.parts[straight.partIndex] : undefined;
    if (!straight || !part) throw new Error(`the ${TRACK_SYSTEM} kit has no straight to run on`);
    const box = straight.footprints;
    return {
      layout: this.combined,
      pieces: this.pieces,
      railPart: straight.piece.part,
      railTopY: straight.yLdu + part.boundsMax[1],
      halfWidthLdu: Math.min((box[2] ?? 0) - (box[0] ?? 0), (box[3] ?? 0) - (box[1] ?? 0)) / 2,
    };
  }

  get pieceCount(): number {
    return this.layout.count;
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
    const part = this.byCatalogIndex.get(this.layout.piece(placement));
    if (!part) throw new Error(`placement ${placement} is not a placeable track piece`);
    return { part, placement: this.layout.pose(placement) };
  }

  endPoses(): ReadonlyArray<Pose16> {
    return this.ends;
  }

  layableEnd(end: number): boolean {
    return this.endPlates[end] === GROUND_PLATES;
  }

  openEnds(): ReadonlyArray<TrackEndView> {
    return this.openList.map((end) => endView(end.pose, end.frame));
  }

  gaps(): ReadonlyArray<TrackGapView> {
    return this.gapList.map((gap) => {
      const endA = this.openList[gap.a];
      const endB = this.openList[gap.b];
      const a = endA?.pose ?? POSE16_IDENTITY;
      const b = endB?.pose ?? POSE16_IDENTITY;
      const viewA = endView(a, endA?.frame);
      const viewB = endView(b, endB?.frame);
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
  }

  routes(): ReadonlyArray<TrackRouteView> {
    const routes: TrackRouteView[] = [];
    const layout = this.combined;
    for (let p = 0; p < layout.count; p++) {
      for (const route of this.pieces[layout.piece(p)]?.routes ?? []) {
        routes.push({
          from: endView(layout.connectorPose(p, route.from), layout.frame(p)),
          to: endView(layout.connectorPose(p, route.to), layout.frame(p)),
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
    return new Set(this.gapList.flatMap((gap) => [gap.a, gap.b]));
  }

  joinedPairs(): number {
    return this.graph.joinCount;
  }

  private kitPart(move: TrackMove): KitPart {
    const part = this.byDef.get(move.piece.id);
    if (!part) throw new Error(`${move.piece.id} is not in the drawing kit`);
    return part;
  }

  endNear(xLdu: number, zLdu: number, except: number | null): number | null {
    let best: number | null = null;
    let bestDistance = END_PICK_RADIUS_LDU;
    this.ends.forEach((end, index) => {
      if (index === except) return;
      const studs = zeta16ToStuds(end.position);
      const distance = Math.hypot(studs.x * STUD_LDU - xLdu, studs.z * STUD_LDU - zLdu);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
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
    this.drag = new TrackDrag(
      this.kit,
      this.router,
      ends,
      () => performance.now(),
      { hitX, hitZ, latticeX, latticeZ },
      this.endNear(hitX, hitZ, null),
      this.cachedField(),
      this.seatsPending,
    );
  }

  setObstacles(obstacles: TrackObstacles, seatsPending: boolean): void {
    this.obstacles = obstacles;
    this.seatsPending = seatsPending;
    this.field = null;
    this.drag?.reseat(this.cachedField(), seatsPending);
    this.extension.endsChanged();
  }

  private readonly supportedMove = (
    frame: MoveFrame,
    pose: Pose16,
    studlessTops: TrackClearance,
  ): boolean => {
    const part = this.byDef.get(frame.move.piece.id);
    if (!part || !this.support) return false;
    const { catalogIndex, piece } = part;
    const { seats } = this.obstacles;
    return this.support.supported(catalogIndex, piece.partFrame, pose, seats, studlessTops);
  };

  setSupport(support: TrackSupport): void {
    this.support = support;
    this.field = null;
    this.drag?.reseat(this.cachedField(), this.seatsPending);
    this.extension.endsChanged();
  }

  unsupportedPieces(bandAt: SupportBandAt): ReadonlyArray<UnsupportedPiece> | null {
    const support = this.support;
    if (!support || this.seatsPending) return null;
    const bands = new Map<number, JudgedBand>([
      [GROUND_PLATES, { field: this.cachedField(), seats: this.obstacles.seats, onTable: true }],
    ]);
    const box = this.collisionBox;
    const layout = this.combined;
    const found: UnsupportedPiece[] = [];
    for (let p = 0; p < layout.count; p++) {
      const catalogIndex = layout.piece(p);
      const outline = this.outlines.get(catalogIndex);
      const piece = this.pieces[catalogIndex];
      if (!outline || !piece) continue;
      const band = this.judgedBand(bands, layout.yPlates(p), bandAt);
      if (!band) return null;
      const placement = layout.pose(p);
      const frame = layout.frame(p);
      const placed = framedOutline(outline, placement, frame);
      outlineBox(placed, box, 0);
      const { studlessTops } = band.field.support;
      const top = studlessTops.blocker(placed, box, 0, 0, 0, NO_OBSTACLE, NO_OBSTACLE);
      if (top === NO_OBSTACLE && band.onTable) continue;
      const { seats, onTable } = band;
      const { partFrame } = piece;
      if (
        support.supported(catalogIndex, partFrame, placement, seats, studlessTops, frame, onTable)
      ) {
        continue;
      }
      const block = top === NO_OBSTACLE ? null : band.field.describe(studlessTopBlocker(top));
      found.push({ piece: p, block });
    }
    return found;
  }

  private judgedBand(
    bands: Map<number, JudgedBand>,
    yPlates: number,
    bandAt: SupportBandAt,
  ): JudgedBand | null {
    const known = bands.get(yPlates);
    if (known) return known;
    const { obstacles, pending } = bandAt(yPlates);
    if (pending) return null;
    const band = {
      field: new DragField([], obstacles, this.supportedMove),
      seats: obstacles.seats,
      onTable: false,
    };
    bands.set(yPlates, band);
    return band;
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

  private cachedField(): DragField {
    this.field ??= this.buildField();
    return this.field;
  }

  private buildField(): DragField {
    const [, top] = this.verticalRange();
    const layout = this.combined;
    const outlines: Array<Float64Array | null> = [];
    for (let p = 0; p < layout.count; p++) {
      const outline = this.outlines.get(layout.piece(p));
      if (!outline || layout.yPlates(p) * PLATE_LDU >= top) {
        outlines.push(null);
        continue;
      }
      outlines.push(framedOutline(outline, layout.pose(p), layout.frame(p)));
    }
    return new DragField(outlines, this.obstacles, this.supportedMove);
  }

  pieceBlock(
    catalogIndex: number,
    placement: Pose16,
    yPlates = GROUND_PLATES,
    moving: ReadonlySet<number> = NO_PLACEMENTS,
    movingOwners: ReadonlySet<number> = NO_OWNERS,
  ): TrackBlockView | null {
    const [, top] = this.verticalRange();
    if (yPlates * PLATE_LDU >= top) return null;
    const field = this.cachedField();
    const part = this.pieceByIndex(catalogIndex);
    const joined = this.joinedAt(field, part.def.connectors, placement, yPlates, moving);
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
    moving: ReadonlySet<number>,
  ): ReadonlyArray<number> {
    const joined = this.joinedOwners;
    joined.length = 0;
    for (const local of connectors) {
      const end = composePose16(placement, local);
      for (let index = 0; index < this.ends.length; index++) {
        const open = this.ends[index];
        const placed = this.endOwners[index];
        if (!open || this.endPlates[index] !== yPlates || !posesJoin16(open, end)) continue;
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
    const cached = this.skipped;
    if (
      cached?.field === field &&
      cached.moving === moving &&
      cached.movingOwners === movingOwners
    ) {
      return cached.ids;
    }
    const ids = field.ownedIds(moving, movingOwners);
    this.skipped = { field, moving, movingOwners, ids };
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

  joinsTouching(inside: ReadonlySet<number>): ReadonlyArray<TrackJoinView> {
    const graph = this.graph;
    const joins: TrackJoinView[] = [];
    for (let end = 0; end < graph.endCount; end++) {
      const partnerEnd = graph.endPartner[end] ?? NO_END;
      if (partnerEnd === NO_END || graph.endFrame[end] !== WORLD_TRACK_FRAME.id) continue;
      const placement = graph.endPlacement[end] ?? 0;
      const partner = graph.endPlacement[partnerEnd] ?? 0;
      if (!inside.has(placement)) continue;
      if (inside.has(partner) && partnerEnd < end) continue;
      joins.push({ end: this.joinEnd(end), partner: this.joinEnd(partnerEnd) });
    }
    return joins;
  }

  private joinEnd(end: number): JoinEndView {
    const graph = this.graph;
    const placement = graph.endPlacement[end] ?? 0;
    const connector = graph.endConnector[end] ?? 0;
    return {
      placement,
      connector,
      pose: this.combined.connectorPose(placement, connector),
      yPlates: graph.endYPlates[end] ?? 0,
    };
  }

  connectorPose(catalogIndex: number, placement: Pose16, connector: number): Pose16 {
    const local = this.pieces[catalogIndex]?.connectors[connector]?.pose;
    if (!local) throw new RangeError(`catalog piece ${catalogIndex} has no connector ${connector}`);
    return composePose16(placement, local);
  }

  pieceBox(catalogIndex: number, placement: Pose16): WorldBox {
    return partBox({ part: this.pieceByIndex(catalogIndex), placement });
  }

  piecesGhost(
    pieces: ReadonlyArray<{ readonly piece: number; readonly pose: Pose16 }>,
    frame: PlacementPose,
  ): ChunkInstances {
    const count = pieces.length;
    const partIndex = new Uint16Array(count);
    const colorIndex = new Uint16Array(count);
    const matrices = new Float32Array(count * INSTANCE_MATRIX_FLOATS);
    const lift = frame.yPlates * PLATE_LDU;
    pieces.forEach(({ piece, pose }, slot) => {
      const part = this.pieceByIndex(piece);
      partIndex[slot] = part.partIndex;
      colorIndex[slot] = part.color;
      const local = pieceRelativePose(pose, frame);
      writeMatrix(matrices, slot, local, part.piece.partFrame, part.yLdu - lift, 0, 0);
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
    let outline = this.crossingOutlines.get(p);
    if (!outline) {
      outline = PlacedOutline.ofTrackPiece(shape.planOutline, this.combined.pose(p));
      this.crossingOutlines.set(p, outline);
    }
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
    partRects: Float64Array,
    rectFloats: number,
    carried: ReadonlyArray<FramedTrackPiece>,
    moving: ReadonlySet<number>,
    movingOwners: ReadonlySet<number>,
  ): TrackBlockView | null {
    const field = this.cachedField();
    const skipped = this.skippedIds(field, moving, movingOwners);
    const box = this.collisionBox;
    const rect = this.rectOutline;
    for (let r = 0; r < rectFloats; r += OBSTACLE_RECT_FLOATS) {
      writeRectOutline(rect, partRects, r);
      outlineBox(rect, box, 0);
      const hit = field.clearance.blockerExcept(rect, box, 0, 0, NO_JOINS, skipped);
      if (field.isTrack(hit)) return field.describe(hit);
    }
    const [, top] = this.verticalRange();
    for (const piece of carried) {
      const pieceOutline = this.outlines.get(piece.catalogIndex);
      if (!pieceOutline || piece.yPlates * PLATE_LDU >= top) continue;
      const outline = framedOutlineInto(
        pieceOutline,
        piece.placement,
        piece.frame,
        this.framedScratchFor(pieceOutline.length),
      );
      outlineBox(outline, box, 0);
      const joined =
        piece.frame.id === WORLD_TRACK_FRAME.id
          ? this.joinedAt(
              field,
              this.layout.pieces[piece.catalogIndex]?.connectors ?? NO_POSES,
              piece.placement,
              piece.yPlates,
              moving,
            )
          : NO_JOINS;
      const hit = field.clearance.blockerExcept(outline, box, 0, 0, joined, skipped);
      if (hit !== NO_OBSTACLE) return field.describe(hit);
    }
    return null;
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
    if (this.seatsPending) return { kind: "refused", refusal: "pending", blocked: null };
    const field = this.cachedField();
    const result = solveClosure(
      this.kit,
      start,
      goal,
      { now: () => performance.now(), limitMs: CLOSURE_BUDGET_MS },
      {
        clearance: field.clearance,
        support: field.support,
        outlines: this.kitOutlines,
        startOwner: field.pieceOwner(this.endOwners[from]),
        goalOwner: field.pieceOwner(this.endOwners[to]),
      },
    );
    switch (result.kind) {
      case "exact":
        return result;
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

  crosses(from: number, move: TrackMove, joins: number | null): TrackBlockView | null {
    const start = this.ends[from];
    const placed = start ? layMoves(start, [move]).placed[0] : undefined;
    if (!placed) throw new RangeError(`no open end ${from} to lay ${move.piece.id} on`);
    const field = this.cachedField();
    const blocker = field.clearance.pieceBlocker(
      this.kitPart(move).outline,
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
    this.solveSamplesMs.push(this.lastSolveMs);
  }

  dragView(): TrackDragView | null {
    return this.drag?.view(this.lastSolveMs) ?? null;
  }

  dragTarget(): DragTargetView | null {
    return this.drag?.targetView() ?? null;
  }

  private previewRun(): PreviewRun | null {
    if (this.drag) {
      const route = this.drag.route();
      return route.start
        ? { start: route.start, moves: route.moves, refused: route.blockedMove }
        : null;
    }
    const run = this.extension.chosen();
    if (!run) return null;
    const { choice } = run;
    if (choice.blocked === null) return { start: run.start, moves: choice.moves, refused: null };
    return { start: run.start, moves: [], refused: choice.moves[0] ?? null };
  }

  ghost(): { readonly instances: ChunkInstances; readonly x: number; readonly z: number } | null {
    const route = this.previewRun();
    if (!route) return null;
    const { start } = route;
    const moves = route.refused ? [...route.moves, route.refused] : route.moves;
    if (moves.length === 0) return null;
    const { placed } = layMoves(start, moves);
    const count = placed.length;
    this.growGhostScratch(count);
    const partIndex = this.ghostParts.subarray(0, count);
    const colorIndex = this.ghostColors.subarray(0, count);
    const matrices = this.ghostMatrices.subarray(0, count * INSTANCE_MATRIX_FLOATS);
    const origin = zeta16ToStuds(start.position);
    const originX = origin.x * STUD_LDU;
    const originZ = origin.z * STUD_LDU;
    placed.forEach((piece, i) => {
      const move = moves[i];
      if (!move) return;
      const part = this.kitPart(move);
      partIndex[i] = part.partIndex;
      colorIndex[i] = i < route.moves.length ? part.color : this.refusedColor;
      writeMatrix(matrices, i, piece.placement, part.piece.partFrame, part.yLdu, originX, originZ);
    });
    const base: ChunkPartInstances = { originX, originZ, count, partIndex, colorIndex, matrices };
    return {
      instances: withStuds(base, this.parts, this.colors),
      x: originX,
      z: originZ,
    };
  }

  private growGhostScratch(count: number): void {
    if (count <= this.ghostParts.length) return;
    const capacity = Math.max(count, this.ghostParts.length * 2);
    this.ghostParts = new Uint16Array(capacity);
    this.ghostColors = new Uint16Array(capacity);
    this.ghostMatrices = new Float32Array(capacity * INSTANCE_MATRIX_FLOATS);
  }

  cancelDrag(): void {
    this.drag = null;
  }

  endDrag(): DragOutcome {
    const route = this.drag?.route();
    this.drag = null;
    if (!route) return NOTHING_LAID;
    const { closure, blocked, withheld } = route;
    if (
      withheld === null &&
      (closure === "impossible" || closure === "blocked" || closure === "limit")
    ) {
      return { ...NOTHING_LAID, refusal: closure, blocked };
    }
    if (!route.start || route.moves.length === 0) return { ...NOTHING_LAID, blocked, withheld };
    const { change, end } = this.runChange(route.start, route.moves);
    const goal = withheld === null ? route.goal : null;
    return { change, goal, end, refusal: null, blocked, withheld };
  }

  extensionPlan(): ExtensionPlan | null {
    const run = this.drag ? null : this.extension.chosen();
    if (!run) return null;
    const { change, end } = this.runChange(run.start, run.choice.moves);
    const goal = run.choice.joins === null ? null : (this.ends[run.choice.joins] ?? null);
    return { run, change, goal, end };
  }

  onExtension(xLdu: number, zLdu: number): boolean {
    const run = this.drag ? null : this.extension.chosen();
    if (!run) return false;
    const at = zeta16ToStuds(run.start.position);
    if (Math.hypot(at.x * STUD_LDU - xLdu, at.z * STUD_LDU - zLdu) <= END_PICK_RADIUS_LDU) {
      return true;
    }
    return layMoves(run.start, run.choice.moves).placed.some((piece, i) => {
      const move = run.choice.moves[i];
      if (!move) return false;
      const box = partBox({ part: this.kitPart(move), placement: piece.placement });
      return xLdu >= box.minX && xLdu <= box.maxX && zLdu >= box.minZ && zLdu <= box.maxZ;
    });
  }

  private runChange(
    start: Pose16,
    moves: ReadonlyArray<TrackMove>,
  ): { readonly change: TrackChange; readonly end: Pose16 } {
    const { placed, end } = layMoves(start, moves);
    const entries: Placed[] = [];
    placed.forEach((piece, i) => {
      const move = moves[i];
      if (move) entries.push({ part: this.kitPart(move), placement: piece.placement });
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
        yPlates: GROUND_PLATES,
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
        this.layout.yPlates(at.index) === at.yPlates &&
        pose16Equals(laid.placement, at.pose);
      if (!same) throw new Error(`laid track piece ${at.index} is not the piece the edit lifts`);
      touched.add(this.chunkOfPlaced(laid));
      this.layout.remove(at.index);
    }
    for (const at of change.lay) {
      const part = this.pieceByIndex(at.piece);
      this.layout.insert(at.index, at.piece, at.pose, at.yPlates);
      touched.add(this.chunkOfPlaced({ part, placement: at.pose }));
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
    free: Pose16,
  ): PieceSnap {
    const part = this.pieceByIndex(catalogIndex);
    const connectors = part.def.connectors;
    const held = normalizeConnector(connector, connectors.length);
    const local = connectors[held];
    if (!local) throw new RangeError(`${part.piece.id} has no connector ${connector}`);
    const end = this.endNear(hitX, hitZ, null);
    const target = end === null ? undefined : this.ends[end];
    const placement = target ? attachPose16(local, target) : freePlacement(part.def, held, free);
    let joins = 0;
    const misses: number[] = [];
    for (const own of connectors) {
      const pose = composePose16(placement, own);
      const studs = zeta16ToStuds(pose.position);
      this.ends.forEach((open, index) => {
        if (posesJoin16(open, pose)) {
          joins++;
          return;
        }
        const at = zeta16ToStuds(open.position);
        const gapLdu = Math.hypot(at.x - studs.x, at.z - studs.z) * STUD_LDU;
        if (gapLdu <= NEAR_MISS_RADIUS_LDU) misses.push(index);
      });
    }
    return { placement, end: target ? end : null, joins, misses };
  }

  pieceGhost(
    catalogIndex: number,
    placement: Pose16,
  ): { readonly instances: ChunkInstances; readonly x: number; readonly z: number } {
    const part = this.pieceByIndex(catalogIndex);
    const origin = zeta16ToStuds(placement.position);
    const originX = origin.x * STUD_LDU;
    const originZ = origin.z * STUD_LDU;
    const partIndex = this.ghostParts.subarray(0, 1);
    const colorIndex = this.ghostColors.subarray(0, 1);
    const matrices = this.ghostMatrices.subarray(0, INSTANCE_MATRIX_FLOATS);
    partIndex[0] = part.partIndex;
    colorIndex[0] = part.color;
    writeMatrix(matrices, 0, placement, part.piece.partFrame, part.yLdu, originX, originZ);
    const base: ChunkPartInstances = {
      originX,
      originZ,
      count: 1,
      partIndex,
      colorIndex,
      matrices,
    };
    return {
      instances: withStuds(base, this.parts, this.colors),
      x: originX,
      z: originZ,
    };
  }

  pieceChange(catalogIndex: number, placement: Pose16): TrackChange {
    return this.appended([{ part: this.pieceByIndex(catalogIndex), placement }]);
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
      const distance = Math.hypot(centre.x - xLdu, centre.z - zLdu);
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
      yPlates: this.layout.yPlates(placement),
    };
  }

  pieceOnRay(ray: Float64Array): TrackPieceHit | null {
    const dy = ray[RAY_DIRECTION_Y] ?? 0;
    if (dy === 0) return null;
    let best: TrackPieceHit | null = null;
    for (let p = 0; p < this.layout.count; p++) {
      const placed = this.placedAt(p);
      const top = partBox(placed).maxY + this.layout.yPlates(p) * PLATE_LDU;
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
    const levers: SwitchLeverView[] = [];
    for (let p = 0; p < this.layout.count; p++) {
      const placed = this.placedAt(p);
      const lever = this.pieceSet.lever(placed.part.catalogIndex);
      if (lever === null) continue;
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
    this.field = null;
    this.crossingOutlines.clear();
    this.graph = new TrackGraph(this.combined);
    const world: TrackEnd[] = [];
    const inRunFrames: TrackEnd[] = [];
    const owners: number[] = [];
    for (const end of this.graph.openEnds) {
      const placement = this.graph.endPlacement[end] ?? 0;
      const connector = this.graph.endConnector[end] ?? 0;
      const open: TrackEnd = {
        pose: this.combined.connectorPose(placement, connector),
        yPlates: this.combined.yPlates(placement),
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
    this.extension.endsChanged();
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
    const catalogIndex = this.layout.piece(piece);
    const edges = this.planEdges.get(catalogIndex);
    const connectors = this.pieces[catalogIndex]?.connectors;
    if (!edges || !connectors) throw new Error(`laid track piece ${piece} has no plan outline`);
    return new TrackOutline(
      edges,
      this.layout.pose(piece),
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
    const carriers = this.carriers;
    for (let c = 0; c < carriers.length; c++) {
      const carrier = carriers[c];
      if (!carrier) continue;
      this.addPartRows(rows, TRACK_UNVERIFIED, carrier.unverified, carrier.model);
      this.addPartRows(rows, TRACK_UNIDENTIFIED, carrier.unidentified, carrier.model);
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
        yPlates: this.layout.yPlates(index),
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
    });
    if (issues.length > 0) return { ok: false, issues };
    const lay = records.flatMap((record, index) => {
      const part = this.byPieceId.get(record.ref);
      if (!part) return [];
      const pose = pose16(decodeTrackPosition(record.position), record.heading);
      return [{ index, piece: part.catalogIndex, pose, yPlates: record.yPlates }];
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
        piece.part.yLdu,
        originX,
        originZ,
      );
    });
    const base: ChunkPartInstances = { originX, originZ, count, partIndex, colorIndex, matrices };
    return withStuds(base, this.parts, this.colors);
  }
}
