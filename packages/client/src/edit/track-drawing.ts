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
  LABEL_NUMBERED,
  TRACK_SEGMENT,
  type PlanDelta,
  NEAR_MISS_RADIUS_LDU,
  NO_OBSTACLE,
  TrackClearance,
  drawingKit,
  endGaps,
  FOOTPRINT_FLOATS,
  freePlacement,
  layMoves,
  runMoves,
  solveClosure,
  solveDrag,
  NO_END,
  NO_TRACK_CHANGE,
  TrackGraph,
  TrackLayout,
  footprintOutline,
  regionHolds,
  outlineContains,
  placedOutline,
  type BomCounter,
  type ClosureResult,
  type ClosureSite,
  type DrawingKit,
  type EndGap,
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
  QUARTER_TURN_16,
  zeta16,
  zeta16Direction,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";
import { INSTANCE_MATRIX_FLOATS, type ChunkInstances, type WorldBox } from "@brr/render";
import type { ChunkPartInstances } from "../scene/placements.ts";
import { withStuds } from "../scene/stud-stream.ts";
import type { ColorTable } from "../scene/viewer-scene.ts";
import type { FramedTrackPiece } from "../connect/model-track-ends.ts";
import { TrackPieceSet, type Lever } from "./track-pieces.ts";

export const TRACK_SYSTEM = "lego-9v";
const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const HALF_STEP_RADIANS = HEADING_RADIANS / 2;
const QUARTER_TURN_RADIANS = Math.PI / 2;
const END_PICK_RADIUS_LDU = 3 * STUD_LDU;
const MIN_START_DRAG_LDU = STUD_LDU;
const GROUND_PLATES = 0;
const CLOSURE_BUDGET_MS = 30;
const GHOST_SCRATCH_PIECES = 64;

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

export type ClosureState = "exact" | "impossible" | "blocked" | "limit" | "pending" | null;
export type TrackRefusal = "impossible" | "blocked" | "limit" | "pending";
const OBSTACLE_RECT_FLOATS = 4;

export interface TrackDragView {
  readonly pieces: number;
  readonly straights: number;
  readonly curves: number;
  readonly missStuds: number;
  readonly closure: ClosureState;
  readonly fromOpenEnd: boolean;
  readonly solveMs: number;
}

export interface DragOutcome {
  readonly change: TrackChange;
  readonly goal: Pose16 | null;
  readonly refusal: TrackRefusal | null;
}

export interface TrackFootprint {
  readonly key: { readonly chunkKey: number; readonly slot: number };
  readonly ref: string;
  readonly label: string;
  readonly box: WorldBox;
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

export interface LaidPieceView {
  readonly piece: string;
  readonly xLdu: number;
  readonly zLdu: number;
  readonly yPlates: number;
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

export interface DragTargetView {
  readonly end: number;
  readonly joins: boolean;
}

interface Drag {
  readonly anchorX: number;
  readonly anchorZ: number;
  readonly fromEnd: number | null;
  start: Pose16 | null;
  previousKey: string | null;
  moves: ReadonlyArray<TrackMove>;
  closure: ClosureState;
  goal: Pose16 | null;
  missStuds: number;
  target: number | null;
  clearance: DragClearance | null;
  readonly closures: Map<string, ClosureResult>;
}

interface DragClearance {
  readonly field: TrackClearance;
  readonly pieceIds: Int32Array;
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

export function trackChunkKey(chunkX: number, chunkZ: number): number {
  return -1 - chunkKey(chunkX, chunkZ);
}

export class TrackDrawing {
  readonly kit: DrawingKit;
  private readonly byDef = new Map<string, KitPart>();
  private readonly byCatalogIndex = new Map<number, KitPart>();
  private readonly byPieceId = new Map<string, KitPart>();
  readonly pieceSet: TrackPieceSet;
  private readonly layout: TrackLayout;
  private readonly pieces: ReadonlyArray<TrackPiece>;
  private held: ReadonlyArray<FramedTrackPiece> = [];
  private combined: TrackLayout;
  private graph: TrackGraph;
  private readonly chunkMembers = new Map<number, number[]>();
  private ends: Pose16[] = [];
  private endOwners: number[] = [];
  private openList: TrackEnd[] = [];
  private obstacleRects: Float64Array = new Float64Array(0);
  private seatsPending = false;
  private gapList: ReadonlyArray<EndGap> = [];
  private drag: Drag | null = null;
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
      if (piece.system !== TRACK_SYSTEM || piece.status !== "certified") return;
      const inKit = piece.kind === "straight" || piece.kind === "curve";
      const partIndex = partForPiece(piece, parts);
      const part = parts[partIndex];
      if (!part) throw new Error(`${piece.id}: part index ${partIndex} is out of range`);
      if (part.producedColor === undefined) {
        throw new Error(`${piece.id}: track part has no sourced produced colour`);
      }
      const def: TrackPieceDef = { id: piece.id, connectors: piece.connectors.map((c) => c.pose) };
      const shape = kitFootprints(piece, shapes);
      const kitPart: KitPart = {
        footprints: Float64Array.from(shape.footprints),
        outline: footprintOutline(shape, piece.partFrame),
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

  countPiece(counter: BomCounter, placement: number): void {
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

  syncHeld(held: ReadonlyArray<FramedTrackPiece>): void {
    this.held = held;
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
    const fromEnd = this.endNear(hitX, hitZ, null);
    const end = fromEnd === null ? undefined : this.ends[fromEnd];
    this.drag = {
      anchorX: latticeX,
      anchorZ: latticeZ,
      fromEnd,
      start: end ?? null,
      previousKey: null,
      moves: [],
      closure: null,
      goal: null,
      missStuds: 0,
      target: null,
      clearance: null,
      closures: new Map(),
    };
  }

  setObstacles(rects: Float64Array, seatsPending: boolean): void {
    if (rects.length % OBSTACLE_RECT_FLOATS !== 0) {
      throw new RangeError(`obstacle rects come in ${OBSTACLE_RECT_FLOATS} floats each`);
    }
    this.obstacleRects = rects;
    this.seatsPending = seatsPending;
    const drag = this.drag;
    if (drag) {
      drag.clearance = null;
      drag.closures.clear();
    }
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

  private clearanceOf(drag: Drag): DragClearance {
    if (drag.clearance) return drag.clearance;
    const field = new TrackClearance();
    const pieceIds = new Int32Array(this.layout.count).fill(NO_OBSTACLE);
    const [, top] = this.verticalRange();
    for (let p = 0; p < this.layout.count; p++) {
      if (this.layout.yPlates(p) * PLATE_LDU >= top) continue;
      const placed = this.placedAt(p);
      pieceIds[p] = field.addPiece(placed.part.outline, placed.placement);
    }
    const rects = this.obstacleRects;
    for (let r = 0; r < rects.length; r += OBSTACLE_RECT_FLOATS) {
      field.addRect(rects[r] ?? 0, rects[r + 1] ?? 0, rects[r + 2] ?? 0, rects[r + 3] ?? 0);
    }
    drag.clearance = { field, pieceIds };
    return drag.clearance;
  }

  private closureSite(drag: Drag, target: number): ClosureSite {
    const { field, pieceIds } = this.clearanceOf(drag);
    const owner = (end: number | null): number => {
      const placement = end === null ? undefined : this.endOwners[end];
      return placement === undefined ? NO_OBSTACLE : (pieceIds[placement] ?? NO_OBSTACLE);
    };
    return {
      clearance: field,
      outlineOf: (piece) => {
        const part = this.byPieceId.get(piece.id);
        if (!part) throw new Error(`${piece.id} is not a placeable track piece`);
        return part.outline;
      },
      startOwner: owner(drag.fromEnd),
      goalOwner: owner(target),
    };
  }

  private closure(drag: Drag, start: Pose16, target: number, goal: Pose16): ClosureResult {
    const key = `${target}|${start.heading}|${start.position.join(",")}`;
    const cached = drag.closures.get(key);
    if (cached) return cached;
    const result = solveClosure(
      this.kit,
      start,
      goal,
      { now: () => performance.now(), limitMs: CLOSURE_BUDGET_MS },
      this.closureSite(drag, target),
    );
    drag.closures.set(key, result);
    return result;
  }

  private newRunStart(drag: Drag, hitX: number, hitZ: number): Pose16 | null {
    const dx = hitX - drag.anchorX;
    const dz = hitZ - drag.anchorZ;
    if (Math.hypot(dx, dz) < MIN_START_DRAG_LDU) return null;
    const quarterTurns = Math.round(Math.atan2(dz, dx) / QUARTER_TURN_RADIANS);
    const heading = normalizeHeading16(quarterTurns * QUARTER_TURN_16);
    const position = zeta16([
      BigInt(drag.anchorX / STUD_LDU),
      0n,
      0n,
      0n,
      BigInt(drag.anchorZ / STUD_LDU),
      0n,
      0n,
      0n,
    ]);
    return pose16(position, heading);
  }

  moveDrag(hitX: number, hitZ: number): void {
    const drag = this.drag;
    if (!drag) return;
    if (drag.fromEnd === null && drag.moves.length === 0) {
      drag.start = this.newRunStart(drag, hitX, hitZ);
    }
    const start = drag.start;
    if (!start) return;
    const began = performance.now();
    const target = this.endNear(hitX, hitZ, drag.fromEnd);
    const goal = target === null ? undefined : this.ends[target];
    drag.target = target;
    drag.goal = goal ?? null;
    if (target !== null && goal && this.seatsPending) {
      drag.closure = "pending";
      drag.moves = [];
      drag.missStuds = 0;
      this.recordSolve(began);
      return;
    }
    if (target !== null && goal) {
      const result = this.closure(drag, start, target, goal);
      drag.closure = result.kind;
      drag.moves = result.kind === "exact" ? runMoves(this.kit, result.run) : [];
      drag.missStuds = 0;
      this.recordSolve(began);
      return;
    } else {
      drag.closure = null;
    }
    const plan = solveDrag(
      this.kit,
      start,
      { x: hitX / STUD_LDU, z: hitZ / STUD_LDU },
      drag.previousKey,
    );
    drag.previousKey = plan.key;
    drag.moves = runMoves(this.kit, plan);
    drag.missStuds = plan.missStuds;
    this.recordSolve(began);
  }

  private recordSolve(began: number): void {
    this.lastSolveMs = performance.now() - began;
    this.solveSamplesMs.push(this.lastSolveMs);
  }

  dragView(): TrackDragView | null {
    const drag = this.drag;
    if (!drag) return null;
    const straights = drag.moves.filter((m) => m.turn === 0).length;
    return {
      pieces: drag.moves.length,
      straights,
      curves: drag.moves.length - straights,
      missStuds: drag.missStuds,
      closure: drag.closure,
      fromOpenEnd: drag.fromEnd !== null,
      solveMs: this.lastSolveMs,
    };
  }

  dragTarget(): DragTargetView | null {
    const drag = this.drag;
    if (!drag || drag.target === null) return null;
    return { end: drag.target, joins: drag.closure === "exact" };
  }

  ghost(): { readonly instances: ChunkInstances; readonly x: number; readonly z: number } | null {
    const drag = this.drag;
    if (!drag?.start || drag.moves.length === 0) return null;
    const { placed } = layMoves(drag.start, drag.moves);
    const count = placed.length;
    this.growGhostScratch(count);
    const partIndex = this.ghostParts.subarray(0, count);
    const colorIndex = this.ghostColors.subarray(0, count);
    const matrices = this.ghostMatrices.subarray(0, count * INSTANCE_MATRIX_FLOATS);
    const origin = zeta16ToStuds(drag.start.position);
    const originX = origin.x * STUD_LDU;
    const originZ = origin.z * STUD_LDU;
    placed.forEach((piece, i) => {
      const move = drag.moves[i];
      if (!move) return;
      const part = this.kitPart(move);
      partIndex[i] = part.partIndex;
      colorIndex[i] = part.color;
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
    const drag = this.drag;
    this.drag = null;
    if (
      drag?.closure === "impossible" ||
      drag?.closure === "blocked" ||
      drag?.closure === "limit" ||
      drag?.closure === "pending"
    ) {
      return { change: NO_TRACK_CHANGE, goal: null, refusal: drag.closure };
    }
    if (!drag?.start || drag.moves.length === 0) {
      return { change: NO_TRACK_CHANGE, goal: null, refusal: null };
    }
    const { placed } = layMoves(drag.start, drag.moves);
    const entries: Placed[] = [];
    placed.forEach((piece, i) => {
      const move = drag.moves[i];
      if (move) entries.push({ part: this.kitPart(move), placement: piece.placement });
    });
    return { change: this.appended(entries), goal: drag.goal, refusal: null };
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
    for (let p = 0; p < this.layout.count; p++) {
      const key = this.chunkOfPlaced(this.placedAt(p));
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

  private laidPiece(placement: number): TrackPieceAt {
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
    this.endOwners = owners;
    this.openList = [...world, ...inRunFrames];
    this.gapList = endGaps(this.openList);
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
    const { box } = footprint;
    const at = entry * BOX_STRIDE;
    delta.box[at + BOX_MIN_X] = box.minX;
    delta.box[at + BOX_MIN_Y] = box.minY;
    delta.box[at + BOX_MIN_Z] = box.minZ;
    delta.box[at + BOX_MAX_X] = box.maxX;
    delta.box[at + BOX_MAX_Y] = box.maxY;
    delta.box[at + BOX_MAX_Z] = box.maxZ;
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
    const issues: Issue[] = [];
    if (this.layout.count > 0) {
      issues.push({ path: "track", message: "can only be restored into an empty drawing" });
    }
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
    return { ok: true, value: this.applyTrack({ lift: [], lay }) };
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
