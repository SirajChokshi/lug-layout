import type { PartAsset } from "@brr/catalog";
import type { TrackCatalog, TrackPartFrame, TrackPiece } from "@brr/schema/bundle";
import {
  drawingKit,
  endGaps,
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
  type BaseCells,
  type TrackMove,
  type TrackPieceDef,
  type TrackPieceSpec,
  type TrackSupport,
} from "@brr/domain";
import {
  CHUNK_LDU,
  STUD_LDU,
  ZETA16_ORDER,
  chunkKey,
  chunkOf,
  normalizeHeading16,
  POSE16_IDENTITY,
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
import { localPlanTriangles, supportCells, trackPlanTransform } from "./track-footprint.ts";

export const TRACK_SYSTEM = "lego-9v";
const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const HALF_STEP_RADIANS = HEADING_RADIANS / 2;
const END_PICK_RADIUS_LDU = 3 * STUD_LDU;
const MIN_START_DRAG_LDU = STUD_LDU;
const GROUND_PLATES = 0;
const CLOSURE_BUDGET_MS = 30;
const GHOST_SCRATCH_PIECES = 64;
const FOOTPRINT_FLOATS = 4;
const CELL_CACHE_LIMIT = 4096;

export interface KitPart {
  readonly footprints: Float64Array;
  readonly meshY: readonly [number, number];
  readonly catalogIndex: number;
  readonly piece: TrackPiece;
  readonly def: TrackPieceDef;
  readonly partIndex: number;
  readonly color: number;
  readonly yLdu: number;
  readonly plan: Float64Array;
}

export type TrackSupportProbe = (cells: BaseCells) => TrackSupport;

export interface OffBaseplate {
  readonly piece: number;
  readonly pieceId: string;
  readonly pieces: number;
  readonly cells: number;
  readonly missing: BaseCells;
}

export type ClosureState = "exact" | "impossible" | "limit" | null;
export type TrackRefusal = "impossible" | "limit" | "off-baseplate";

export interface TrackDragView {
  readonly pieces: number;
  readonly straights: number;
  readonly curves: number;
  readonly missStuds: number;
  readonly closure: ClosureState;
  readonly fromOpenEnd: boolean;
  readonly solveMs: number;
  readonly offBaseplate: OffBaseplate | null;
}

export interface TrackCommit {
  readonly laid: number;
  readonly joined: boolean;
  readonly refusal: TrackRefusal | null;
  readonly offBaseplate: OffBaseplate | null;
  readonly chunks: ReadonlyArray<number>;
}

export interface TrackFootprint {
  readonly key: { readonly chunkKey: number; readonly slot: number };
  readonly ref: string;
  readonly label: string;
  readonly box: WorldBox;
}

export interface TrackEndView {
  readonly xLdu: number;
  readonly zLdu: number;
  readonly heading: number;
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
  offBaseplate: OffBaseplate | null;
}

interface Placed {
  readonly part: KitPart;
  readonly placement: Pose16;
}

function endView(end: Pose16): TrackEndView {
  const studs = zeta16ToStuds(end.position);
  return { xLdu: studs.x * STUD_LDU, zLdu: studs.z * STUD_LDU, heading: end.heading };
}

function pieceSpec(piece: TrackPiece): TrackPieceSpec {
  return { connectors: piece.connectors.map((c) => c.pose), routes: piece.routes };
}

function partForPiece(piece: TrackPiece, parts: ReadonlyArray<PartAsset>): number {
  const index = parts.findIndex((part) => part.id === piece.part);
  if (index < 0) throw new Error(`${piece.id}: track part ${piece.part} is not in the bundle`);
  return index;
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
  const { x, z, cos: c, sin: s } = trackPlanTransform(placement, frame);
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
  const { x, z } = trackPlanTransform(placed.placement, placed.part.piece.partFrame);
  return { x, z };
}

function headingFootprints(part: PartAsset, frame: TrackPartFrame): Float64Array {
  const boxes = new Float64Array(ZETA16_ORDER * FOOTPRINT_FLOATS);
  const positions = part.mesh.positions;
  for (let heading = 0; heading < ZETA16_ORDER; heading++) {
    const phi = heading * HEADING_RADIANS + frame.headingHalfSteps * HALF_STEP_RADIANS;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    let minX = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < positions.length; i += 3) {
      const px = positions[i] ?? 0;
      const pz = positions[i + 2] ?? 0;
      const wx = c * px - s * pz;
      const wz = s * px + c * pz;
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wz < minZ) minZ = wz;
      if (wz > maxZ) maxZ = wz;
    }
    boxes.set([minX, minZ, maxX, maxZ], heading * FOOTPRINT_FLOATS);
  }
  return boxes;
}

function meshYRange(part: PartAsset): readonly [number, number] {
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const positions = part.mesh.positions;
  for (let i = 1; i < positions.length; i += 3) {
    const y = positions[i] ?? 0;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minY, maxY];
}

function partBox(placed: Placed): WorldBox {
  const { x, z } = trackPlanTransform(placed.placement, placed.part.piece.partFrame);
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
  private layout: TrackLayout;
  private graph: TrackGraph;
  private readonly chunkMembers = new Map<number, number[]>();
  private ends: Pose16[] = [];
  private gapList: ReadonlyArray<EndGap> = [];
  private pieceCells: BaseCells[] = [];
  private readonly cellCache = new Map<string, BaseCells>();
  private drag: Drag | null = null;
  private lastSolveMs = 0;
  private ghostParts = new Uint16Array(GHOST_SCRATCH_PIECES);
  private ghostColors = new Uint16Array(GHOST_SCRATCH_PIECES);
  private ghostMatrices = new Float32Array(GHOST_SCRATCH_PIECES * INSTANCE_MATRIX_FLOATS);
  readonly solveSamplesMs: number[] = [];

  constructor(
    catalog: TrackCatalog,
    private readonly parts: ReadonlyArray<PartAsset>,
    private readonly colors: ColorTable,
    private readonly probe: TrackSupportProbe,
  ) {
    this.layout = new TrackLayout(catalog.pieces.map(pieceSpec));
    this.graph = new TrackGraph(this.layout);
    catalog.pieces.forEach((piece, catalogIndex) => {
      const inKit =
        piece.system === TRACK_SYSTEM &&
        piece.status === "certified" &&
        (piece.kind === "straight" || piece.kind === "curve");
      if (!inKit) return;
      const partIndex = partForPiece(piece, parts);
      const part = parts[partIndex];
      if (!part) throw new Error(`${piece.id}: part index ${partIndex} is out of range`);
      if (part.producedColor === undefined) {
        throw new Error(`${piece.id}: track part has no sourced produced colour`);
      }
      const def: TrackPieceDef = { id: piece.id, connectors: piece.connectors.map((c) => c.pose) };
      const kitPart: KitPart = {
        footprints: headingFootprints(part, piece.partFrame),
        meshY: meshYRange(part),
        catalogIndex,
        piece,
        def,
        partIndex,
        color: colors.indexOfCode(part.producedColor),
        yLdu: -part.boundsMin[1],
        plan: localPlanTriangles(part),
      };
      this.byDef.set(piece.id, kitPart);
      this.byCatalogIndex.set(catalogIndex, kitPart);
    });
    const result = drawingKit([...this.byDef.values()].map((k) => k.def));
    if (result.kind !== "kit") throw new Error(`no ${TRACK_SYSTEM} drawing kit: ${result.reason}`);
    this.kit = result.kit;
  }

  kitParts(): ReadonlyArray<KitPart> {
    return [...this.byDef.values()];
  }

  get pieceCount(): number {
    return this.layout.count;
  }

  countOf(pieceId: string): number {
    const part = this.byDef.get(pieceId);
    let count = 0;
    for (let p = 0; p < this.layout.count; p++) {
      if (part && this.layout.piece(p) === part.catalogIndex) count++;
    }
    return count;
  }

  coincidentEndIssues(): number {
    return this.graph.issues.length;
  }

  private placedAt(placement: number): Placed {
    const part = this.byCatalogIndex.get(this.layout.piece(placement));
    if (!part) throw new Error(`placement ${placement} is not a drawing-kit piece`);
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
      offBaseplate: null,
    };
  }

  cellsOf(part: KitPart, placement: Pose16): BaseCells {
    const key = `${part.piece.id}|${placement.heading}|${placement.position.join(",")}`;
    const cached = this.cellCache.get(key);
    if (cached) return cached;
    const cells = supportCells(part.plan, placement, part.piece.partFrame, part.def.connectors);
    if (this.cellCache.size >= CELL_CACHE_LIMIT) this.cellCache.clear();
    this.cellCache.set(key, cells);
    return cells;
  }

  private offBaseplate(start: Pose16, moves: ReadonlyArray<TrackMove>): OffBaseplate | null {
    if (moves.length === 0) return null;
    const { placed } = layMoves(start, moves);
    for (let i = 0; i < placed.length; i++) {
      const move = moves[i];
      const piece = placed[i];
      if (!move || !piece) continue;
      const part = this.kitPart(move);
      const support = this.probe(this.cellsOf(part, piece.placement));
      if (support.kind === "off-baseplate") {
        return {
          piece: i,
          pieceId: part.piece.id,
          pieces: placed.length,
          cells: support.cells,
          missing: support.missing,
        };
      }
    }
    return null;
  }

  unsupportedPieces(probe: TrackSupportProbe): ReadonlyArray<OffBaseplate> {
    const off: OffBaseplate[] = [];
    for (let p = 0; p < this.layout.count; p++) {
      const cells = this.pieceCells[p];
      if (!cells) continue;
      const support = probe(cells);
      if (support.kind === "on-baseplate") continue;
      off.push({
        piece: p,
        pieceId: this.placedAt(p).part.piece.id,
        pieces: this.layout.count,
        cells: support.cells,
        missing: support.missing,
      });
    }
    return off;
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
        drag.offBaseplate = this.offBaseplate(start, drag.moves);
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
    drag.offBaseplate = this.offBaseplate(start, drag.moves);
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
      offBaseplate: drag.offBaseplate,
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
      return { laid: 0, joined: false, refusal: null, offBaseplate: null, chunks: [] };
    }
    if (drag.closure === "impossible" || drag.closure === "limit") {
      return { laid: 0, joined: false, refusal: drag.closure, offBaseplate: null, chunks: [] };
    }
    const offBaseplate = this.offBaseplate(drag.start, drag.moves);
    if (offBaseplate) {
      return { laid: 0, joined: false, refusal: "off-baseplate", offBaseplate, chunks: [] };
    }
    const { placed } = layMoves(drag.start, drag.moves);
    const touched = new Set<number>();
    placed.forEach((piece, i) => {
      const move = drag.moves[i];
      if (!move) return;
      const entry: Placed = { part: this.kitPart(move), placement: piece.placement };
      const index = this.layout.place(entry.part.catalogIndex, piece.placement, GROUND_PLATES);
      this.pieceCells[index] = this.cellsOf(entry.part, piece.placement);
      const centre = partCentre(entry);
      const key = trackChunkKey(chunkOf(centre.x), chunkOf(centre.z));
      const members = this.chunkMembers.get(key) ?? [];
      members.push(index);
      this.chunkMembers.set(key, members);
      touched.add(key);
    });
    this.recomputeEnds();
    return {
      laid: placed.length,
      joined: drag.goal !== null && this.graphJoins(drag.goal),
      refusal: null,
      offBaseplate: null,
      chunks: [...touched],
    };
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

  pieceAt(xLdu: number, zLdu: number): number | null {
    const cellX = Math.floor(xLdu / STUD_LDU);
    const cellZ = Math.floor(zLdu / STUD_LDU);
    for (let p = this.layout.count - 1; p >= 0; p--) {
      const cells = this.pieceCells[p];
      if (!cells) continue;
      for (let c = 0; c < cells.count; c++) {
        if (cells.cellX[c] === cellX && cells.cellZ[c] === cellZ) return p;
      }
    }
    return null;
  }

  pieceBox(piece: number): WorldBox {
    return partBox(this.placedAt(piece));
  }

  pieceId(piece: number): string {
    return this.placedAt(piece).part.piece.id;
  }

  removePiece(piece: number): ReadonlyArray<number> {
    const kept: Placed[] = [];
    const keptCells: BaseCells[] = [];
    for (let p = 0; p < this.layout.count; p++) {
      if (p === piece) continue;
      kept.push(this.placedAt(p));
      keptCells.push(
        this.pieceCells[p] ?? this.cellsOf(this.placedAt(p).part, this.layout.pose(p)),
      );
    }
    const touched = new Set(this.chunkMembers.keys());
    this.layout = new TrackLayout(this.layout.pieces);
    this.chunkMembers.clear();
    this.pieceCells = keptCells;
    for (const placed of kept) {
      const index = this.layout.place(placed.part.catalogIndex, placed.placement, GROUND_PLATES);
      const centre = partCentre(placed);
      const key = trackChunkKey(chunkOf(centre.x), chunkOf(centre.z));
      const members = this.chunkMembers.get(key) ?? [];
      members.push(index);
      this.chunkMembers.set(key, members);
      touched.add(key);
    }
    this.recomputeEnds();
    return [...touched];
  }

  planFootprints(): ReadonlyArray<TrackFootprint> {
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
