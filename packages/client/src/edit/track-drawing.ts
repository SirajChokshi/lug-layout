import type { PartBundle, PartShapeAsset } from "@brr/catalog";
import type { TrackPartFrame, TrackPiece, TrackShape } from "@brr/schema/bundle";
import type { Decoded, Issue } from "@brr/schema/decode";
import { decodeTrackPosition, encodeTrackPosition, type TrackRecordV1 } from "@brr/schema/world";
import {
  NEAR_MISS_RADIUS_LDU,
  drawingKit,
  endGaps,
  FOOTPRINT_FLOATS,
  layMoves,
  runMoves,
  solveClosure,
  solveDrag,
  NO_END,
  TrackGraph,
  TrackLayout,
  type DrawingKit,
  type EndGap,
  type TrackEnd,
  type TrackMove,
  type TrackPieceDef,
  type TrackPieceSpec,
} from "@brr/domain";
import {
  CHUNK_LDU,
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
  zeta16,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";
import { INSTANCE_MATRIX_FLOATS, type ChunkInstances, type WorldBox } from "@brr/render";
import type { ChunkPartInstances } from "../scene/placements.ts";
import { withStuds } from "../scene/stud-stream.ts";
import type { ColorTable } from "../scene/viewer-scene.ts";
import { TrackPieceSet, type Lever } from "./track-pieces.ts";

export const TRACK_SYSTEM = "lego-9v";
const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const HALF_STEP_RADIANS = HEADING_RADIANS / 2;
const END_PICK_RADIUS_LDU = 3 * STUD_LDU;
const MIN_START_DRAG_LDU = STUD_LDU;
const GROUND_PLATES = 0;
const CLOSURE_BUDGET_MS = 30;
const GHOST_SCRATCH_PIECES = 64;

export interface KitPart {
  readonly footprints: Float64Array;
  readonly meshY: readonly [number, number];
  readonly catalogIndex: number;
  readonly piece: TrackPiece;
  readonly def: TrackPieceDef;
  readonly partIndex: number;
  readonly color: number;
  readonly yLdu: number;
}

export type ClosureState = "exact" | "impossible" | "limit" | null;
export type TrackRefusal = "impossible" | "limit";

export interface TrackDragView {
  readonly pieces: number;
  readonly straights: number;
  readonly curves: number;
  readonly missStuds: number;
  readonly closure: ClosureState;
  readonly fromOpenEnd: boolean;
  readonly solveMs: number;
}

export interface TrackCommit {
  readonly laid: number;
  readonly joined: boolean;
  readonly refusal: TrackRefusal | null;
  readonly chunks: ReadonlyArray<number>;
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
  readonly chunk: number;
  readonly lever: Lever;
}

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
}

interface Placed {
  readonly part: KitPart;
  readonly placement: Pose16;
}

function normalizeConnector(connector: number, count: number): number {
  return ((connector % count) + count) % count;
}

function endView(end: Pose16): TrackEndView {
  const studs = zeta16ToStuds(end.position);
  return {
    xLdu: studs.x * STUD_LDU,
    zLdu: studs.z * STUD_LDU,
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

function partTransform(placement: Pose16, frame: TrackPartFrame): PartTransform {
  const studs = zeta16ToStuds(placement.position);
  const theta = placement.heading * HEADING_RADIANS;
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  const phi = theta + frame.headingHalfSteps * HALF_STEP_RADIANS;
  return {
    x: studs.x * STUD_LDU + cosTheta * frame.xLdu - sinTheta * frame.zLdu,
    z: studs.z * STUD_LDU + sinTheta * frame.xLdu + cosTheta * frame.zLdu,
    c: Math.cos(phi),
    s: Math.sin(phi),
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
  private graph: TrackGraph;
  private readonly chunkMembers = new Map<number, number[]>();
  private ends: Pose16[] = [];
  private gapList: ReadonlyArray<EndGap> = [];
  private footprints: ReadonlyArray<TrackFootprint> | null = null;
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
    return {
      layout: this.layout,
      pieces: this.pieces,
      railPart: straight.piece.part,
      railTopY: straight.yLdu + part.boundsMax[1],
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

  coincidentEndIssues(): number {
    return this.graph.issues.length;
  }

  private placedAt(placement: number): Placed {
    const part = this.byCatalogIndex.get(this.layout.piece(placement));
    if (!part) throw new Error(`placement ${placement} is not a placeable track piece`);
    return { part, placement: this.layout.pose(placement) };
  }

  openEnds(): ReadonlyArray<TrackEndView> {
    return this.ends.map(endView);
  }

  gaps(): ReadonlyArray<TrackGapView> {
    return this.gapList.map((gap) => {
      const a = this.ends[gap.a] ?? POSE16_IDENTITY;
      const b = this.ends[gap.b] ?? POSE16_IDENTITY;
      const from = zeta16ToStuds(a.position);
      const to = zeta16ToStuds(b.position);
      const theta = a.heading * HEADING_RADIANS;
      const dx = to.x - from.x;
      const dz = to.z - from.z;
      return {
        a: endView(a),
        b: endView(b),
        xStuds: from.x,
        zStuds: from.z,
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
    for (let p = 0; p < this.layout.count; p++) {
      for (const route of this.placedAt(p).part.piece.routes) {
        routes.push({
          from: endView(this.layout.connectorPose(p, route.from)),
          to: endView(this.layout.connectorPose(p, route.to)),
        });
      }
    }
    return routes;
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
    };
  }

  private newRunStart(drag: Drag, hitX: number, hitZ: number): Pose16 | null {
    const dx = hitX - drag.anchorX;
    const dz = hitZ - drag.anchorZ;
    if (Math.hypot(dx, dz) < MIN_START_DRAG_LDU) return null;
    const heading = normalizeHeading16(Math.round(Math.atan2(dz, dx) / HEADING_RADIANS));
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
    if (goal) {
      const result = solveClosure(this.kit, start, goal, {
        now: () => performance.now(),
        limitMs: CLOSURE_BUDGET_MS,
      });
      drag.closure = result.kind;
      if (result.kind === "exact") {
        drag.moves = runMoves(this.kit, result.run);
        drag.missStuds = 0;
        this.recordSolve(began);
        return;
      }
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
      instances: withStuds(base, this.parts, this.colors, undefined),
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

  endDrag(): TrackCommit {
    const drag = this.drag;
    this.drag = null;
    if (!drag?.start || drag.moves.length === 0) {
      return { laid: 0, joined: false, refusal: null, chunks: [] };
    }
    if (drag.closure === "impossible" || drag.closure === "limit") {
      return { laid: 0, joined: false, refusal: drag.closure, chunks: [] };
    }
    const { placed } = layMoves(drag.start, drag.moves);
    const entries: Placed[] = [];
    placed.forEach((piece, i) => {
      const move = drag.moves[i];
      if (move) entries.push({ part: this.kitPart(move), placement: piece.placement });
    });
    const chunks = this.commitPlaced(entries);
    return {
      laid: entries.length,
      joined: drag.goal !== null && this.graphJoins(drag.goal),
      refusal: null,
      chunks,
    };
  }

  private commitPlaced(entries: ReadonlyArray<Placed>): ReadonlyArray<number> {
    const touched = new Set<number>();
    for (const entry of entries) {
      const index = this.layout.place(entry.part.catalogIndex, entry.placement, GROUND_PLATES);
      const key = this.chunkOfPlaced(entry);
      const members = this.chunkMembers.get(key) ?? [];
      members.push(index);
      this.chunkMembers.set(key, members);
      touched.add(key);
    }
    this.recomputeEnds();
    return [...touched];
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
    const local = connectors[normalizeConnector(connector, connectors.length)];
    if (!local) throw new RangeError(`${part.piece.id} has no connector ${connector}`);
    const end = this.endNear(hitX, hitZ, null);
    const target = end === null ? undefined : this.ends[end];
    const placement = attachPose16(local, target ?? free);
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
      instances: withStuds(base, this.parts, this.colors, undefined),
      x: originX,
      z: originZ,
    };
  }

  placePiece(catalogIndex: number, placement: Pose16): TrackCommit {
    const part = this.pieceByIndex(catalogIndex);
    const before = this.graph.joinCount;
    const chunks = this.commitPlaced([{ part, placement }]);
    return { laid: 1, joined: this.graph.joinCount > before, refusal: null, chunks };
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

  throwSwitch(placement: number): SwitchThrow | null {
    const placed = this.placedAt(placement);
    const thrown = this.pieceSet.thrown(placed.part.catalogIndex);
    if (thrown === null) return null;
    this.layout.replace(placement, thrown);
    this.footprints = null;
    const lever = this.pieceSet.lever(thrown);
    if (lever === null) throw new Error(`catalog piece ${thrown} has no lever position`);
    return { chunk: this.chunkOfPlaced(placed), lever };
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

  private graphJoins(end: Pose16): boolean {
    const graph = this.graph;
    for (let e = 0; e < graph.endCount; e++) {
      if ((graph.endPartner[e] ?? NO_END) === NO_END) continue;
      const pose = this.layout.connectorPose(
        graph.endPlacement[e] ?? 0,
        graph.endConnector[e] ?? 0,
      );
      if (pose16Equals(pose, end)) return true;
    }
    return false;
  }

  private recomputeEnds(): void {
    this.footprints = null;
    this.graph = new TrackGraph(this.layout);
    const ends: TrackEnd[] = [];
    for (const end of this.graph.openEnds) {
      const placement = this.graph.endPlacement[end] ?? 0;
      const connector = this.graph.endConnector[end] ?? 0;
      ends.push({
        pose: this.layout.connectorPose(placement, connector),
        yPlates: this.layout.yPlates(placement),
      });
    }
    this.ends = ends.map((end) => end.pose);
    this.gapList = endGaps(ends);
  }

  planFootprints(): ReadonlyArray<TrackFootprint> {
    this.footprints ??= this.measureFootprints();
    return this.footprints;
  }

  private measureFootprints(): ReadonlyArray<TrackFootprint> {
    const footprints: TrackFootprint[] = [];
    for (let p = 0; p < this.layout.count; p++) {
      const placed = this.placedAt(p);
      const centre = partCentre(placed);
      footprints.push({
        key: { chunkKey: trackChunkKey(chunkOf(centre.x), chunkOf(centre.z)), slot: p },
        ref: placed.part.piece.id,
        label: `${placed.part.piece.title} #${p + 1}`,
        box: partBox(placed),
      });
    }
    return footprints;
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
    const touched = new Set<number>();
    for (const record of records) {
      const part = this.byPieceId.get(record.ref);
      if (!part) continue;
      const placement = pose16(decodeTrackPosition(record.position), record.heading);
      const index = this.layout.place(part.catalogIndex, placement, record.yPlates);
      const centre = partCentre({ part, placement });
      const key = trackChunkKey(chunkOf(centre.x), chunkOf(centre.z));
      const members = this.chunkMembers.get(key) ?? [];
      members.push(index);
      this.chunkMembers.set(key, members);
      touched.add(key);
    }
    this.recomputeEnds();
    return { ok: true, value: [...touched] };
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
    return withStuds(base, this.parts, this.colors, undefined);
  }
}
