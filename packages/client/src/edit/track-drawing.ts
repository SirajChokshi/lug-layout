import type { PartAsset, TrackCatalog, TrackPartFrame, TrackPiece } from "@brr/catalog";
import {
  drawingKit,
  layMoves,
  runMoves,
  solveClosure,
  solveDrag,
  NO_END,
  TrackGraph,
  TrackLayout,
  type DrawingKit,
  packedCellKey,
  placedPlanCells,
  planTrianglesOverlap,
  type BaseCells,
  type OwnerFilter,
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
  composePose16,
  normalizeHeading16,
  pose16,
  pose16Equals,
  posesJoin16,
  zeta16,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";
import { INSTANCE_MATRIX_FLOATS, type ChunkInstances, type WorldBox } from "@brr/render";
import type { ChunkPartInstances } from "../scene/placements.ts";
import { withStuds } from "../scene/stud-stream.ts";
import type { ColorTable } from "../scene/viewer-scene.ts";
import type { PlacedOverlap } from "./placed-chunks.ts";
import {
  localBoundsTriangles,
  localPlanTriangles,
  placedPlan,
  trackPlanTransform,
  type PlacedPlan,
} from "./track-footprint.ts";

export const TRACK_SYSTEM = "lego-9v";
const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const HALF_STEP_RADIANS = HEADING_RADIANS / 2;
const END_PICK_RADIUS_LDU = 3 * STUD_LDU;
const MIN_START_DRAG_LDU = STUD_LDU;
export const LAID_TRACK_PLATES = 0;
const CLOSURE_BUDGET_MS = 30;
const GHOST_SCRATCH_PIECES = 64;
const FOOTPRINT_FLOATS = 4;
const CELL_CACHE_LIMIT = 4096;
const NO_CLIP = new Float64Array(0);

export interface KitPart {
  readonly footprints: Float64Array;
  readonly meshY: readonly [number, number];
  readonly catalogIndex: number;
  readonly piece: TrackPiece;
  readonly def: TrackPieceDef;
  readonly partIndex: number;
  readonly color: number;
  readonly yLdu: number;
  readonly heightLdu: number;
  readonly plan: Float64Array;
  readonly bounds: Float64Array;
}

export type TrackSupportProbe = (cells: BaseCells) => TrackSupport;

export interface LaidTrackPiece {
  readonly piece: number;
  readonly pieceId: string;
  readonly cells: BaseCells;
  readonly bottomLdu: number;
  readonly topLdu: number;
}

export interface HeldTrackRequest {
  readonly owner: number;
  readonly label: string;
  readonly catalogIndex: number;
  readonly placement: Pose16;
  readonly plates: number;
}

export interface HeldJoint {
  readonly laid: number;
  readonly heldCells: ReadonlySet<number>;
}

interface HeldTrackPiece extends HeldTrackRequest {
  readonly plan: PlacedPlan;
  readonly boundsKeys: ReadonlySet<number>;
  readonly ends: ReadonlyArray<Pose16>;
}

export interface TrackHost {
  support(cells: BaseCells): TrackSupport;
  overlap(
    cells: BaseCells,
    bottomLdu: number,
    topLdu: number,
    exempt: OwnerFilter,
  ): PlacedOverlap | null;
  neighbours(cells: BaseCells): ReadonlySet<number>;
  laid(piece: number, pieceId: string, cells: BaseCells, bottomLdu: number, topLdu: number): void;
  relaid(pieces: ReadonlyArray<LaidTrackPiece>): void;
}

interface RunPiece {
  readonly piece: number;
  readonly pieceId: string;
  readonly pieces: number;
}

export type RunBlock =
  | (RunPiece & {
      readonly kind: "off-baseplate";
      readonly cells: number;
      readonly missing: BaseCells;
    })
  | (RunPiece & {
      readonly kind: "overlap";
      readonly with: PlacedOverlap;
      readonly missing: BaseCells;
    })
  | (RunPiece & {
      readonly kind: "crosses-track";
      readonly other: number;
      readonly otherId: string;
      readonly inModel: string | null;
      readonly missing: BaseCells;
    });

export interface OffBaseplate {
  readonly piece: number;
  readonly pieceId: string;
  readonly pieces: number;
  readonly cells: number;
  readonly missing: BaseCells;
}

export type ClosureState = "exact" | "impossible" | "limit" | null;
export type TrackRefusal = "impossible" | "limit" | RunBlock["kind"];

export interface TrackDragView {
  readonly pieces: number;
  readonly straights: number;
  readonly curves: number;
  readonly missStuds: number;
  readonly closure: ClosureState;
  readonly fromOpenEnd: boolean;
  readonly solveMs: number;
  readonly blocked: RunBlock | null;
}

export interface TrackCommit {
  readonly laid: number;
  readonly joined: boolean;
  readonly refusal: TrackRefusal | null;
  readonly blocked: RunBlock | null;
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
  blocked: RunBlock | null;
}

interface Placed {
  readonly part: KitPart;
  readonly placement: Pose16;
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

function cellKeys(cells: BaseCells): ReadonlySet<number> {
  const keys = new Set<number>();
  for (let c = 0; c < cells.count; c++)
    keys.add(packedCellKey(cells.cellX[c] ?? 0, cells.cellZ[c] ?? 0));
  return keys;
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
  private piecePlans: PlacedPlan[] = [];
  private held: ReadonlyArray<HeldTrackPiece> = [];
  private combined: TrackLayout;
  private readonly planCache = new Map<string, PlacedPlan>();
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
    private readonly host: TrackHost,
  ) {
    this.layout = new TrackLayout(catalog.pieces.map(pieceSpec));
    this.combined = this.layout;
    this.graph = new TrackGraph(this.layout);
    catalog.pieces.forEach((piece, catalogIndex) => {
      const inKit =
        piece.system === TRACK_SYSTEM &&
        piece.status === "certified" &&
        (piece.kind === "straight" || piece.kind === "curve");
      const held = parts.some((part) => part.id === piece.part);
      if (!inKit && !held) return;
      const partIndex = partForPiece(piece, parts);
      const part = parts[partIndex];
      if (!part) throw new Error(`${piece.id}: part index ${partIndex} is out of range`);
      if (inKit && part.producedColor === undefined) {
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
        color: part.producedColor === undefined ? 0 : colors.indexOfCode(part.producedColor),
        yLdu: -part.boundsMin[1],
        heightLdu: Math.ceil(part.boundsMax[1] - part.boundsMin[1]),
        plan: localPlanTriangles(part),
        bounds: localBoundsTriangles(part),
      };
      if (inKit) this.byDef.set(piece.id, kitPart);
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
    return this.ends.map((end) => {
      const studs = zeta16ToStuds(end.position);
      return { xLdu: studs.x * STUD_LDU, zLdu: studs.z * STUD_LDU, heading: end.heading };
    });
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
      blocked: null,
    };
  }

  planOf(part: KitPart, placement: Pose16): PlacedPlan {
    const key = `${part.piece.id}|${placement.heading}|${placement.position.join(",")}`;
    const cached = this.planCache.get(key);
    if (cached) return cached;
    const plan = placedPlan(part.plan, placement, part.piece.partFrame, part.def.connectors);
    if (this.planCache.size >= CELL_CACHE_LIMIT) this.planCache.clear();
    this.planCache.set(key, plan);
    return plan;
  }

  private connectorPoses(part: KitPart, placement: Pose16): ReadonlyArray<Pose16> {
    return part.def.connectors.map((local) => composePose16(placement, local));
  }

  private laidConnectorPoses(piece: number): ReadonlyArray<Pose16> {
    const spec = this.layout.pieces[this.layout.piece(piece)];
    return (spec?.connectors ?? []).map((_, c) => this.layout.connectorPose(piece, c));
  }

  syncHeld(requests: ReadonlyArray<HeldTrackRequest>): void {
    this.held = requests.flatMap((request) => {
      const part = this.byCatalogIndex.get(request.catalogIndex);
      if (!part) return [];
      return [
        {
          ...request,
          plan: this.planOf(part, request.placement),
          boundsKeys: cellKeys(this.boundsCellsOf(part, request.placement)),
          ends: this.connectorPoses(part, request.placement),
        },
      ];
    });
    this.recomputeEnds();
  }

  heldJoints(requests: ReadonlyArray<HeldTrackRequest>): ReadonlyArray<HeldJoint> {
    const atLaidHeight = requests.flatMap((request) => {
      const part = this.byCatalogIndex.get(request.catalogIndex);
      if (!part || request.plates !== LAID_TRACK_PLATES) return [];
      return [
        { part, placement: request.placement, ends: this.connectorPoses(part, request.placement) },
      ];
    });
    const joints: HeldJoint[] = [];
    for (let p = 0; p < this.layout.count; p++) {
      const laid = this.laidConnectorPoses(p);
      const keys = new Set<number>();
      for (const held of atLaidHeight) {
        if (!laid.some((a) => held.ends.some((b) => posesJoin16(a, b)))) continue;
        for (const key of cellKeys(this.boundsCellsOf(held.part, held.placement))) keys.add(key);
      }
      if (keys.size > 0) joints.push({ laid: p, heldCells: keys });
    }
    return joints;
  }

  private boundsCellsOf(part: KitPart, placement: Pose16): BaseCells {
    return placedPlanCells(
      part.bounds,
      trackPlanTransform(placement, part.piece.partFrame),
      NO_CLIP,
    );
  }

  openEndPoses(): ReadonlyArray<Pose16> {
    return this.ends;
  }

  private crosses(
    a: PlacedPlan,
    aEnds: ReadonlyArray<Pose16>,
    b: PlacedPlan,
    bEnds: ReadonlyArray<Pose16>,
  ): BaseCells | null {
    if (aEnds.some((pa) => bEnds.some((pb) => posesJoin16(pa, pb)))) return null;
    const inB = cellKeys(b.cells);
    const sharedX: number[] = [];
    const sharedZ: number[] = [];
    for (let c = 0; c < a.cells.count; c++) {
      const x = a.cells.cellX[c] ?? 0;
      const z = a.cells.cellZ[c] ?? 0;
      if (!inB.has(packedCellKey(x, z))) continue;
      sharedX.push(x);
      sharedZ.push(z);
    }
    if (sharedX.length === 0) return null;
    const within = {
      minX: Math.min(...sharedX) * STUD_LDU,
      minZ: Math.min(...sharedZ) * STUD_LDU,
      maxX: (Math.max(...sharedX) + 1) * STUD_LDU,
      maxZ: (Math.max(...sharedZ) + 1) * STUD_LDU,
    };
    if (!planTrianglesOverlap(a.triangles, b.triangles, within)) return null;
    return {
      count: sharedX.length,
      cellX: Int32Array.from(sharedX),
      cellZ: Int32Array.from(sharedZ),
      flat: new Uint8Array(sharedX.length),
    };
  }

  private runBlock(start: Pose16, moves: ReadonlyArray<TrackMove>): RunBlock | null {
    if (moves.length === 0) return null;
    const { placed } = layMoves(start, moves);
    const plans: PlacedPlan[] = [];
    const ends: Array<ReadonlyArray<Pose16>> = [];
    for (let i = 0; i < placed.length; i++) {
      const move = moves[i];
      const piece = placed[i];
      if (!move || !piece) continue;
      const part = this.kitPart(move);
      const plan = this.planOf(part, piece.placement);
      const at: RunPiece = { piece: i, pieceId: part.piece.id, pieces: placed.length };
      const pieceEnds = this.connectorPoses(part, piece.placement);
      const atLaidHeight = this.held.filter((h) => h.plates === LAID_TRACK_PLATES);
      const joinedHeld = atLaidHeight.filter((h) =>
        h.ends.some((end) => pieceEnds.some((own) => posesJoin16(own, end))),
      );
      const interlocked: OwnerFilter = (owner, cellX, cellZ) =>
        joinedHeld.some((h) => h.owner === owner && h.boundsKeys.has(packedCellKey(cellX, cellZ)));
      for (const h of atLaidHeight) {
        if (joinedHeld.includes(h)) continue;
        const shared = this.crosses(plan, pieceEnds, h.plan, h.ends);
        if (shared) {
          const otherId = this.byCatalogIndex.get(h.catalogIndex)?.piece.id ?? "";
          return {
            ...at,
            kind: "crosses-track",
            other: -1,
            otherId,
            inModel: h.label,
            missing: shared,
          };
        }
      }
      const support = this.host.support(plan.support);
      if (support.kind === "off-baseplate") {
        return { ...at, kind: "off-baseplate", cells: support.cells, missing: support.missing };
      }
      const overlap = this.host.overlap(plan.cells, 0, part.heightLdu, interlocked);
      if (overlap) {
        return {
          ...at,
          kind: "overlap",
          with: overlap,
          missing: {
            count: 1,
            cellX: Int32Array.of(overlap.overlap.cellX),
            cellZ: Int32Array.of(overlap.overlap.cellZ),
            flat: new Uint8Array(1),
          },
        };
      }
      for (const other of this.host.neighbours(plan.cells)) {
        const otherPlan = this.piecePlans[other];
        if (!otherPlan) continue;
        const shared = this.crosses(plan, pieceEnds, otherPlan, this.laidConnectorPoses(other));
        if (shared) {
          const otherId = this.placedAt(other).part.piece.id;
          return { ...at, kind: "crosses-track", other, otherId, inModel: null, missing: shared };
        }
      }
      for (let j = 0; j < plans.length; j++) {
        const earlier = plans[j];
        const earlierEnds = ends[j];
        if (!earlier || !earlierEnds) continue;
        const shared = this.crosses(plan, pieceEnds, earlier, earlierEnds);
        if (shared) {
          const earlierId = moves[j]?.piece.id ?? "";
          return {
            ...at,
            kind: "crosses-track",
            other: -1 - j,
            otherId: earlierId,
            inModel: null,
            missing: shared,
          };
        }
      }
      plans.push(plan);
      ends.push(pieceEnds);
    }
    return null;
  }

  unsupportedPieces(probe: TrackSupportProbe): ReadonlyArray<OffBaseplate> {
    const off: OffBaseplate[] = [];
    for (let p = 0; p < this.layout.count; p++) {
      const cells = this.piecePlans[p]?.support;
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
        drag.blocked = this.runBlock(start, drag.moves);
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
    drag.blocked = this.runBlock(start, drag.moves);
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
      blocked: drag.blocked,
    };
  }

  dragTarget(): TrackEndView | null {
    const target = this.drag?.target;
    if (target === null || target === undefined) return null;
    return this.openEnds()[target] ?? null;
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
      return { laid: 0, joined: false, refusal: null, blocked: null, chunks: [] };
    }
    if (drag.closure === "impossible" || drag.closure === "limit") {
      return { laid: 0, joined: false, refusal: drag.closure, blocked: null, chunks: [] };
    }
    const blocked = this.runBlock(drag.start, drag.moves);
    if (blocked) {
      return { laid: 0, joined: false, refusal: blocked.kind, blocked, chunks: [] };
    }
    const { placed } = layMoves(drag.start, drag.moves);
    const touched = new Set<number>();
    placed.forEach((piece, i) => {
      const move = drag.moves[i];
      if (!move) return;
      const entry: Placed = { part: this.kitPart(move), placement: piece.placement };
      const index = this.layout.place(entry.part.catalogIndex, piece.placement, LAID_TRACK_PLATES);
      const plan = this.planOf(entry.part, piece.placement);
      this.piecePlans[index] = plan;
      this.host.laid(index, entry.part.piece.id, plan.cells, 0, entry.part.heightLdu);
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
      blocked: null,
      chunks: [...touched],
    };
  }

  private graphJoins(end: Pose16): boolean {
    const graph = this.graph;
    for (let e = 0; e < graph.endCount; e++) {
      if ((graph.endPartner[e] ?? NO_END) === NO_END) continue;
      const pose = this.combined.connectorPose(
        graph.endPlacement[e] ?? 0,
        graph.endConnector[e] ?? 0,
      );
      if (pose16Equals(pose, end)) return true;
    }
    return false;
  }

  private recomputeEnds(): void {
    const combined = new TrackLayout(this.layout.pieces);
    for (let p = 0; p < this.layout.count; p++) {
      combined.place(this.layout.piece(p), this.layout.pose(p), this.layout.yPlates(p));
    }
    for (const h of this.held) combined.place(h.catalogIndex, h.placement, h.plates);
    this.combined = combined;
    this.graph = new TrackGraph(combined);
    const ends: Pose16[] = [];
    for (const end of this.graph.openEnds) {
      const placement = this.graph.endPlacement[end] ?? 0;
      if (combined.yPlates(placement) !== LAID_TRACK_PLATES) continue;
      const connector = this.graph.endConnector[end] ?? 0;
      ends.push(combined.connectorPose(placement, connector));
    }
    this.ends = ends;
  }

  pieceAt(xLdu: number, zLdu: number): number | null {
    const cellX = Math.floor(xLdu / STUD_LDU);
    const cellZ = Math.floor(zLdu / STUD_LDU);
    for (let p = this.layout.count - 1; p >= 0; p--) {
      const cells = this.piecePlans[p]?.cells;
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
    for (let p = 0; p < this.layout.count; p++) {
      if (p !== piece) kept.push(this.placedAt(p));
    }
    const touched = new Set(this.chunkMembers.keys());
    this.layout = new TrackLayout(this.layout.pieces);
    this.chunkMembers.clear();
    this.piecePlans = [];
    const relaid: LaidTrackPiece[] = [];
    for (const placed of kept) {
      const index = this.layout.place(
        placed.part.catalogIndex,
        placed.placement,
        LAID_TRACK_PLATES,
      );
      const plan = this.planOf(placed.part, placed.placement);
      this.piecePlans[index] = plan;
      relaid.push({
        piece: index,
        pieceId: placed.part.piece.id,
        cells: plan.cells,
        bottomLdu: 0,
        topLdu: placed.part.heightLdu,
      });
      const centre = partCentre(placed);
      const key = trackChunkKey(chunkOf(centre.x), chunkOf(centre.z));
      const members = this.chunkMembers.get(key) ?? [];
      members.push(index);
      this.chunkMembers.set(key, members);
      touched.add(key);
    }
    this.host.relaid(relaid);
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
