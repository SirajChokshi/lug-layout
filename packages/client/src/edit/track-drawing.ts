import type { PartAsset } from "@brr/catalog";
import type { TrackCatalog, TrackPartFrame, TrackPiece } from "@brr/schema/bundle";
import {
  crossing,
  drawingKit,
  layMoves,
  rampRises,
  riserCourses,
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
  type TrackSpan,
  type TrackSupport,
} from "@brr/domain";
import {
  CHUNK_LDU,
  PLATE_LDU,
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
import type { Gauge } from "./clearance-gauge.ts";
import type { PlacedOverlap } from "./placed-chunks.ts";
import {
  localBoundsTriangles,
  localPlanTriangles,
  placedPlan,
  trackPlanTransform,
  type PlacedPlan,
} from "./track-footprint.ts";
import {
  footprintAt,
  pierAt,
  pierCourseCount,
  pierFootprint,
  writePier,
  type Pier,
  type PierFootprint,
  type PierKit,
} from "./track-piers.ts";

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
const RAY_ORIGIN_Y = 1;
const RAY_DIRECTION_Y = 4;
export const MAX_RISE_PER_PIECE = 2;

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

export interface TrackElevation {
  readonly pier: PierKit;
  readonly train: Gauge;
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
  readonly span: TrackSpan;
}

export interface TrackHost {
  support(cells: BaseCells): TrackSupport;
  overlap(
    cells: BaseCells,
    bottomLdu: number,
    topLdu: number,
    exempt: OwnerFilter,
    ownPiers: ReadonlySet<string>,
  ): PlacedOverlap | null;
  pierOverlap(cells: BaseCells, bottomLdu: number, topLdu: number): PlacedOverlap | null;
  neighbours(cells: BaseCells): ReadonlySet<number>;
  laid(piece: number, pieceId: string, cells: BaseCells, bottomLdu: number, topLdu: number): void;
  relaid(pieces: ReadonlyArray<LaidTrackPiece>): void;
  piers(piers: ReadonlyArray<Pier>): void;
}

interface RunPiece {
  readonly piece: number;
  readonly pieceId: string;
  readonly pieces: number;
}

interface CrossedTrack {
  readonly other: number;
  readonly otherId: string;
  readonly inModel: string | null;
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
  | (RunPiece &
      CrossedTrack & {
        readonly kind: "crosses-track";
        readonly missing: BaseCells;
      })
  | (RunPiece &
      CrossedTrack & {
        readonly kind: "low-clearance";
        readonly gapLdu: number;
        readonly needLdu: number;
        readonly gauge: string;
        readonly missing: BaseCells;
      })
  | (RunPiece & {
      readonly kind: "pier-off-baseplate";
      readonly plates: number;
      readonly cells: number;
      readonly missing: BaseCells;
    })
  | (RunPiece & {
      readonly kind: "pier-blocked";
      readonly plates: number;
      readonly with: PlacedOverlap | null;
      readonly runPiece: number | null;
      readonly missing: BaseCells;
    })
  | (RunPiece & {
      readonly kind: "too-steep";
      readonly fromPlates: number;
      readonly toPlates: number;
      readonly risePerPiece: number;
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
  readonly fromPlates: number;
  readonly toPlates: number;
  readonly targetPlates: number;
  readonly rampPieces: number;
  readonly rampCurves: number;
  readonly newPiers: number;
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
  readonly plates: number;
}

export interface PierView {
  readonly xLdu: number;
  readonly zLdu: number;
  readonly plates: number;
}

export interface CrossingView {
  readonly xLdu: number;
  readonly zLdu: number;
  readonly lowerPlates: number;
  readonly upperPlates: number;
  readonly gapLdu: number;
}

export interface PierPartCount {
  readonly partId: string;
  readonly title: string;
  readonly count: number;
}

interface Drag {
  readonly anchorX: number;
  readonly anchorZ: number;
  readonly fromEnd: number | null;
  readonly startPlates: number;
  start: Pose16 | null;
  previousKey: string | null;
  moves: ReadonlyArray<TrackMove>;
  rises: Int8Array;
  targetPlates: number;
  closure: ClosureState;
  goal: Pose16 | null;
  missStuds: number;
  target: number | null;
  blocked: RunBlock | null;
  newPiers: ReadonlyArray<Pier>;
}

interface Placed {
  readonly part: KitPart;
  readonly placement: Pose16;
  readonly yPlates: number;
  readonly rise: number;
}

interface PlanePoint {
  readonly x: number;
  readonly z: number;
}

interface RunCheck {
  readonly blocked: RunBlock | null;
  readonly newPiers: ReadonlyArray<Pier>;
}

const NO_CELLS: BaseCells = {
  count: 0,
  cellX: new Int32Array(0),
  cellZ: new Int32Array(0),
  flat: new Uint8Array(0),
};

function pieceSpec(piece: TrackPiece): TrackPieceSpec {
  return { connectors: piece.connectors.map((c) => c.pose), routes: piece.routes };
}

function partForPiece(piece: TrackPiece, parts: ReadonlyArray<PartAsset>): number {
  const index = parts.findIndex((part) => part.id === piece.part);
  if (index < 0) throw new Error(`${piece.id}: track part ${piece.part} is not in the bundle`);
  return index;
}

function studsLdu(position: Pose16["position"]): PlanePoint {
  const studs = zeta16ToStuds(position);
  return { x: studs.x * STUD_LDU, z: studs.z * STUD_LDU };
}

function writeMatrix(
  out: Float32Array,
  slot: number,
  placed: Placed,
  originX: number,
  originZ: number,
): void {
  const { placement, part } = placed;
  const { x, z, cos: c, sin: s } = trackPlanTransform(placement, part.piece.partFrame);
  const baseY = part.yLdu + placed.yPlates * PLATE_LDU;
  let slopeX = 0;
  let slopeZ = 0;
  let lift = 0;
  if (placed.rise !== 0) {
    const from = studsLdu(composePose16(placement, part.def.connectors[0] ?? placement).position);
    const to = studsLdu(composePose16(placement, part.def.connectors[1] ?? placement).position);
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const lengthSquared = dx * dx + dz * dz;
    const perLdu = (placed.rise * PLATE_LDU) / lengthSquared;
    slopeX = dx * perLdu;
    slopeZ = dz * perLdu;
    lift = slopeX * (x - from.x) + slopeZ * (z - from.z);
  }
  const o = slot * INSTANCE_MATRIX_FLOATS;
  out[o] = c;
  out[o + 1] = 0;
  out[o + 2] = -s;
  out[o + 3] = x - originX;
  out[o + 4] = slopeX * c + slopeZ * s;
  out[o + 5] = 1;
  out[o + 6] = -slopeX * s + slopeZ * c;
  out[o + 7] = baseY + lift;
  out[o + 8] = s;
  out[o + 9] = 0;
  out[o + 10] = c;
  out[o + 11] = z - originZ;
}

function partCentre(placed: Placed): PlanePoint {
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

function spanOf(part: KitPart, yPlates: number, rise: number): TrackSpan {
  const low = Math.min(yPlates, yPlates + rise);
  const high = Math.max(yPlates, yPlates + rise);
  return { bottomLdu: low * PLATE_LDU, railTopLdu: high * PLATE_LDU + part.heightLdu };
}

function partBox(placed: Placed): WorldBox {
  const { x, z } = trackPlanTransform(placed.placement, placed.part.piece.partFrame);
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

function cellKeys(cells: BaseCells): ReadonlySet<number> {
  const keys = new Set<number>();
  for (let c = 0; c < cells.count; c++)
    keys.add(packedCellKey(cells.cellX[c] ?? 0, cells.cellZ[c] ?? 0));
  return keys;
}

function mergeCells(parts: ReadonlyArray<BaseCells>): BaseCells {
  const xs: number[] = [];
  const zs: number[] = [];
  const seen = new Set<number>();
  for (const cells of parts) {
    for (let c = 0; c < cells.count; c++) {
      const x = cells.cellX[c] ?? 0;
      const z = cells.cellZ[c] ?? 0;
      const key = packedCellKey(x, z);
      if (seen.has(key)) continue;
      seen.add(key);
      xs.push(x);
      zs.push(z);
    }
  }
  return {
    count: xs.length,
    cellX: Int32Array.from(xs),
    cellZ: Int32Array.from(zs),
    flat: new Uint8Array(xs.length),
  };
}

function sharedCells(a: BaseCells, b: BaseCells): BaseCells | null {
  const inB = cellKeys(b);
  const xs: number[] = [];
  const zs: number[] = [];
  for (let c = 0; c < a.count; c++) {
    const x = a.cellX[c] ?? 0;
    const z = a.cellZ[c] ?? 0;
    if (!inB.has(packedCellKey(x, z))) continue;
    xs.push(x);
    zs.push(z);
  }
  if (xs.length === 0) return null;
  return {
    count: xs.length,
    cellX: Int32Array.from(xs),
    cellZ: Int32Array.from(zs),
    flat: new Uint8Array(xs.length),
  };
}

function planeHit(ray: Float64Array, yLdu: number): PlanePoint | null {
  const directionY = ray[RAY_DIRECTION_Y] ?? 0;
  if (directionY >= 0) return null;
  const t = (yLdu - (ray[RAY_ORIGIN_Y] ?? 0)) / directionY;
  if (t < 0) return null;
  return { x: (ray[0] ?? 0) + (ray[3] ?? 0) * t, z: (ray[2] ?? 0) + (ray[5] ?? 0) * t };
}

function snapToLattice(ldu: number): number {
  return Math.round(ldu / STUD_LDU) * STUD_LDU + 0;
}

export function trackChunkKey(chunkX: number, chunkZ: number): number {
  return -1 - chunkKey(chunkX, chunkZ);
}

function pierChunk(pier: Pier): { readonly key: number; readonly x: number; readonly z: number } {
  const x = chunkOf(pier.centreX);
  const z = chunkOf(pier.centreZ);
  return { key: trackChunkKey(x, z), x, z };
}

export class TrackDrawing {
  readonly kit: DrawingKit;
  private readonly byDef = new Map<string, KitPart>();
  private readonly byCatalogIndex = new Map<number, KitPart>();
  private layout: TrackLayout;
  private graph: TrackGraph;
  private readonly chunkMembers = new Map<number, number[]>();
  private readonly chunkOrigins = new Map<number, readonly [number, number]>();
  private ends: Pose16[] = [];
  private endPlates: number[] = [];
  private piecePlans: PlacedPlan[] = [];
  private pieceSupport: BaseCells[] = [];
  private held: ReadonlyArray<HeldTrackPiece> = [];
  private combined: TrackLayout;
  private readonly planCache = new Map<string, PlacedPlan>();
  private piers = new Map<string, Pier>();
  private readonly pierChunks = new Map<number, Pier[]>();
  private readonly footprint: PierFootprint;
  private drag: Drag | null = null;
  private drawAt = LAID_TRACK_PLATES;
  private risePerPiece = 1;
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
    private readonly elevation: TrackElevation,
  ) {
    this.footprint = pierFootprint(elevation.pier);
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

  get drawPlates(): number {
    return this.drawAt;
  }

  get rampRate(): number {
    return this.risePerPiece;
  }

  get trainGauge(): Gauge {
    return this.elevation.train;
  }

  get railTopLdu(): number {
    return this.kitPart(this.kit.straight).heightLdu;
  }

  get straightLdu(): number {
    return this.kitPart(this.kit.straight).piece.routes[0]?.lengthLdu ?? 0;
  }

  get curveLdu(): number {
    return this.kitPart(this.kit.left).piece.routes[0]?.lengthLdu ?? 0;
  }

  pieceHeights(piece: number): { readonly fromPlates: number; readonly toPlates: number } {
    const placed = this.placedAt(piece);
    return { fromPlates: placed.yPlates, toPlates: placed.yPlates + placed.rise };
  }

  setDrawPlates(plates: number): void {
    if (!Number.isInteger(plates) || plates < LAID_TRACK_PLATES) {
      throw new RangeError(`track can't be drawn at ${plates} plates`);
    }
    this.drawAt = plates;
  }

  setRampRate(platesPerPiece: number): void {
    if (
      !Number.isInteger(platesPerPiece) ||
      platesPerPiece < 1 ||
      platesPerPiece > MAX_RISE_PER_PIECE
    ) {
      throw new RangeError(`ramps rise 1 to ${MAX_RISE_PER_PIECE} plates per piece`);
    }
    this.risePerPiece = platesPerPiece;
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
    return {
      part,
      placement: this.layout.pose(placement),
      yPlates: this.layout.yPlates(placement),
      rise: this.layout.rise(placement),
    };
  }

  openEnds(): ReadonlyArray<TrackEndView> {
    return this.ends.map((end, i) => {
      const at = studsLdu(end.position);
      return { xLdu: at.x, zLdu: at.z, heading: end.heading, plates: this.endPlates[i] ?? 0 };
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

  endNear(ray: Float64Array, except: number | null): number | null {
    let best: number | null = null;
    let bestDistance = END_PICK_RADIUS_LDU;
    this.ends.forEach((end, index) => {
      if (index === except) return;
      const hit = planeHit(ray, (this.endPlates[index] ?? 0) * PLATE_LDU);
      if (!hit) return;
      const at = studsLdu(end.position);
      const distance = Math.hypot(at.x - hit.x, at.z - hit.z);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }

  beginDrag(ray: Float64Array): boolean {
    const fromEnd = this.endNear(ray, null);
    const end = fromEnd === null ? undefined : this.ends[fromEnd];
    const startPlates = fromEnd === null ? this.drawAt : (this.endPlates[fromEnd] ?? 0);
    const anchor = planeHit(ray, startPlates * PLATE_LDU);
    if (!anchor) return false;
    this.drag = {
      anchorX: snapToLattice(anchor.x),
      anchorZ: snapToLattice(anchor.z),
      fromEnd,
      startPlates,
      start: end ?? null,
      previousKey: null,
      moves: [],
      rises: new Int8Array(0),
      targetPlates: this.drawAt,
      closure: null,
      goal: null,
      missStuds: 0,
      target: null,
      blocked: null,
      newPiers: [],
    };
    return true;
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

  private laidEndPlates(piece: number): ReadonlyArray<number> {
    const spec = this.layout.pieces[this.layout.piece(piece)];
    return (spec?.connectors ?? []).map((_, c) => this.layout.endYPlates(piece, c));
  }

  syncHeld(requests: ReadonlyArray<HeldTrackRequest>): ReadonlyArray<number> {
    this.held = requests.flatMap((request) => {
      const part = this.byCatalogIndex.get(request.catalogIndex);
      if (!part) return [];
      return [
        {
          ...request,
          plan: this.planOf(part, request.placement),
          boundsKeys: cellKeys(this.boundsCellsOf(part, request.placement)),
          ends: this.connectorPoses(part, request.placement),
          span: spanOf(part, request.plates, 0),
        },
      ];
    });
    this.recomputeEnds();
    return this.syncPiers();
  }

  heldJoints(requests: ReadonlyArray<HeldTrackRequest>): ReadonlyArray<HeldJoint> {
    const held = requests.flatMap((request) => {
      const part = this.byCatalogIndex.get(request.catalogIndex);
      if (!part) return [];
      return [
        {
          part,
          placement: request.placement,
          plates: request.plates,
          ends: this.connectorPoses(part, request.placement),
        },
      ];
    });
    const joints: HeldJoint[] = [];
    for (let p = 0; p < this.layout.count; p++) {
      const laid = this.laidConnectorPoses(p);
      const plates = this.laidEndPlates(p);
      const keys = new Set<number>();
      for (const h of held) {
        const joins = laid.some(
          (a, c) => plates[c] === h.plates && h.ends.some((b) => posesJoin16(a, b)),
        );
        if (!joins) continue;
        for (const key of cellKeys(this.boundsCellsOf(h.part, h.placement))) keys.add(key);
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

  openEndHeights(): ReadonlyArray<number> {
    return this.endPlates;
  }

  private planCrossing(a: PlacedPlan, b: PlacedPlan): BaseCells | null {
    const shared = sharedCells(a.cells, b.cells);
    if (!shared) return null;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let c = 0; c < shared.count; c++) {
      minX = Math.min(minX, shared.cellX[c] ?? 0);
      minZ = Math.min(minZ, shared.cellZ[c] ?? 0);
      maxX = Math.max(maxX, shared.cellX[c] ?? 0);
      maxZ = Math.max(maxZ, shared.cellZ[c] ?? 0);
    }
    const within = {
      minX: minX * STUD_LDU,
      minZ: minZ * STUD_LDU,
      maxX: (maxX + 1) * STUD_LDU,
      maxZ: (maxZ + 1) * STUD_LDU,
    };
    return planTrianglesOverlap(a.triangles, b.triangles, within) ? shared : null;
  }

  private joinsAny(
    ends: ReadonlyArray<Pose16>,
    plates: ReadonlyArray<number>,
    otherEnds: ReadonlyArray<Pose16>,
    otherPlates: ReadonlyArray<number>,
  ): boolean {
    return ends.some((a, i) =>
      otherEnds.some((b, j) => plates[i] === otherPlates[j] && posesJoin16(a, b)),
    );
  }

  private crossingBlock(
    at: RunPiece,
    crossed: CrossedTrack,
    span: TrackSpan,
    otherSpan: TrackSpan,
    shared: BaseCells,
  ): RunBlock | null {
    const verdict = crossing(span, otherSpan, this.elevation.train.heightLdu);
    switch (verdict.kind) {
      case "clear":
        return null;
      case "intersects":
        return { ...at, ...crossed, kind: "crosses-track", missing: shared };
      case "low":
        return {
          ...at,
          ...crossed,
          kind: "low-clearance",
          gapLdu: verdict.gapLdu,
          needLdu: verdict.needLdu,
          gauge: this.elevation.train.model,
          missing: shared,
        };
      default: {
        const unhandled: never = verdict;
        throw new Error(`unhandled crossing ${String(unhandled)}`);
      }
    }
  }

  private heldJoinAt(end: Pose16, plates: number): boolean {
    return this.held.some(
      (h) => h.plates === plates && h.ends.some((other) => posesJoin16(end, other)),
    );
  }

  private runCheck(
    start: Pose16,
    startPlates: number,
    moves: ReadonlyArray<TrackMove>,
    rises: Int8Array,
  ): RunCheck {
    const newPiers = new Map<string, Pier>();
    const done = (blocked: RunBlock | null): RunCheck => ({
      blocked,
      newPiers: [...newPiers.values()],
    });
    if (moves.length === 0) return done(null);
    const { placed } = layMoves(start, moves);
    const plans: PlacedPlan[] = [];
    const ends: Array<ReadonlyArray<Pose16>> = [];
    const heights: Array<ReadonlyArray<number>> = [];
    const spans: TrackSpan[] = [];
    let yPlates = startPlates;
    for (let i = 0; i < placed.length; i++) {
      const move = moves[i];
      const piece = placed[i];
      if (!move || !piece) continue;
      const part = this.kitPart(move);
      const rise = rises[i] ?? 0;
      const plates = [yPlates, yPlates + rise];
      yPlates += rise;
      const plan = this.planOf(part, piece.placement);
      const span = spanOf(part, plates[0] ?? 0, rise);
      const at: RunPiece = { piece: i, pieceId: part.piece.id, pieces: placed.length };
      const pieceEnds = this.connectorPoses(part, piece.placement);
      const joinedHeld = this.held.filter((h) =>
        this.joinsAny(pieceEnds, plates, h.ends, [h.plates, h.plates]),
      );
      const interlocked: OwnerFilter = (owner, cellX, cellZ) =>
        joinedHeld.some((h) => h.owner === owner && h.boundsKeys.has(packedCellKey(cellX, cellZ)));
      for (const h of this.held) {
        if (joinedHeld.includes(h)) continue;
        const shared = this.planCrossing(plan, h.plan);
        if (!shared) continue;
        const otherId = this.byCatalogIndex.get(h.catalogIndex)?.piece.id ?? "";
        const crossed = { other: -1, otherId, inModel: h.label };
        const block = this.crossingBlock(at, crossed, span, h.span, shared);
        if (block) return done(block);
      }
      const ownPiers = new Set<string>();
      const level = plates[0] === LAID_TRACK_PLATES && plates[1] === LAID_TRACK_PLATES;
      if (level) {
        const support = this.host.support(plan.support);
        if (support.kind === "off-baseplate") {
          return done({
            ...at,
            kind: "off-baseplate",
            cells: support.cells,
            missing: support.missing,
          });
        }
      } else {
        for (let c = 0; c < pieceEnds.length; c++) {
          const end = pieceEnds[c];
          const endPlates = plates[c] ?? 0;
          if (!end || this.heldJoinAt(end, endPlates)) continue;
          const pier = pierAt(end, endPlates, this.footprint);
          ownPiers.add(pier.key);
          if (this.piers.has(pier.key) || newPiers.has(pier.key)) continue;
          const support = this.host.support(pier.cells);
          if (support.kind === "off-baseplate") {
            return done({
              ...at,
              kind: "pier-off-baseplate",
              plates: endPlates,
              cells: support.cells,
              missing: support.missing,
            });
          }
          if (endPlates === LAID_TRACK_PLATES) continue;
          const pierTop = endPlates * PLATE_LDU;
          const hit = this.host.pierOverlap(pier.cells, 0, pierTop);
          if (hit) {
            return done({
              ...at,
              kind: "pier-blocked",
              plates: endPlates,
              with: hit,
              runPiece: null,
              missing: pier.cells,
            });
          }
          for (let j = 0; j < plans.length; j++) {
            const earlier = plans[j];
            const earlierSpan = spans[j];
            if (!earlier || !earlierSpan || earlierSpan.bottomLdu >= pierTop) continue;
            const under = sharedCells(pier.cells, earlier.cells);
            if (under) {
              return done({
                ...at,
                kind: "pier-blocked",
                plates: endPlates,
                with: null,
                runPiece: j,
                missing: under,
              });
            }
          }
          newPiers.set(pier.key, pier);
        }
      }
      const overlap = this.host.overlap(
        plan.cells,
        span.bottomLdu,
        span.railTopLdu,
        interlocked,
        ownPiers,
      );
      if (overlap) {
        return done({
          ...at,
          kind: "overlap",
          with: overlap,
          missing: {
            count: 1,
            cellX: Int32Array.of(overlap.overlap.cellX),
            cellZ: Int32Array.of(overlap.overlap.cellZ),
            flat: new Uint8Array(1),
          },
        });
      }
      for (const pier of newPiers.values()) {
        if (ownPiers.has(pier.key)) continue;
        if (pier.heightPlates * PLATE_LDU <= span.bottomLdu) continue;
        const under = sharedCells(plan.cells, pier.cells);
        if (under) {
          return done({
            ...at,
            kind: "pier-blocked",
            plates: pier.heightPlates,
            with: null,
            runPiece: i,
            missing: under,
          });
        }
      }
      for (const other of this.host.neighbours(plan.cells)) {
        const otherPlan = this.piecePlans[other];
        if (!otherPlan) continue;
        if (
          this.joinsAny(
            pieceEnds,
            plates,
            this.laidConnectorPoses(other),
            this.laidEndPlates(other),
          )
        ) {
          continue;
        }
        const shared = this.planCrossing(plan, otherPlan);
        if (!shared) continue;
        const otherPlaced = this.placedAt(other);
        const crossed = { other, otherId: otherPlaced.part.piece.id, inModel: null };
        const otherSpan = spanOf(otherPlaced.part, otherPlaced.yPlates, otherPlaced.rise);
        const block = this.crossingBlock(at, crossed, span, otherSpan, shared);
        if (block) return done(block);
      }
      for (let j = 0; j < plans.length; j++) {
        const earlier = plans[j];
        const earlierEnds = ends[j];
        const earlierHeights = heights[j];
        const earlierSpan = spans[j];
        if (!earlier || !earlierEnds || !earlierHeights || !earlierSpan) continue;
        if (this.joinsAny(pieceEnds, plates, earlierEnds, earlierHeights)) continue;
        const shared = this.planCrossing(plan, earlier);
        if (!shared) continue;
        const crossed = { other: -1 - j, otherId: moves[j]?.piece.id ?? "", inModel: null };
        const block = this.crossingBlock(at, crossed, span, earlierSpan, shared);
        if (block) return done(block);
      }
      plans.push(plan);
      ends.push(pieceEnds);
      heights.push(plates);
      spans.push(span);
    }
    return done(null);
  }

  unsupportedPieces(probe: TrackSupportProbe): ReadonlyArray<OffBaseplate> {
    const off: OffBaseplate[] = [];
    for (let p = 0; p < this.layout.count; p++) {
      const cells = this.pieceSupport[p];
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

  private newRunStart(drag: Drag, hit: PlanePoint): Pose16 | null {
    const dx = hit.x - drag.anchorX;
    const dz = hit.z - drag.anchorZ;
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

  private settleHeights(drag: Drag, start: Pose16, goalPlates: number | null): void {
    const preferred = drag.moves.map((move) => move.turn === 0);
    const reach = drag.moves.length * this.risePerPiece;
    const wanted = goalPlates ?? this.drawAt;
    drag.targetPlates = wanted;
    const reachable =
      goalPlates === null
        ? Math.min(Math.max(wanted, drag.startPlates - reach), drag.startPlates + reach)
        : wanted;
    const rises = rampRises(drag.startPlates, reachable, preferred, this.risePerPiece);
    if (!rises) {
      drag.rises = new Int8Array(drag.moves.length);
      drag.newPiers = [];
      drag.blocked = {
        piece: Math.max(drag.moves.length - 1, 0),
        pieceId: drag.moves.at(-1)?.piece.id ?? "",
        pieces: drag.moves.length,
        kind: "too-steep",
        fromPlates: drag.startPlates,
        toPlates: wanted,
        risePerPiece: this.risePerPiece,
        missing: NO_CELLS,
      };
      return;
    }
    drag.rises = rises;
    const check = this.runCheck(start, drag.startPlates, drag.moves, rises);
    drag.blocked = check.blocked;
    drag.newPiers = check.newPiers;
  }

  moveDrag(ray: Float64Array): void {
    const drag = this.drag;
    if (!drag) return;
    const hit = planeHit(ray, this.drawAt * PLATE_LDU);
    if (!hit) return;
    if (drag.fromEnd === null && drag.moves.length === 0) {
      drag.start = this.newRunStart(drag, hit);
    }
    const start = drag.start;
    if (!start) return;
    const began = performance.now();
    const target = this.endNear(ray, drag.fromEnd);
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
        this.settleHeights(drag, start, this.endPlates[target ?? 0] ?? 0);
        this.recordSolve(began);
        return;
      }
    } else {
      drag.closure = null;
    }
    const plan = solveDrag(
      this.kit,
      start,
      { x: hit.x / STUD_LDU, z: hit.z / STUD_LDU },
      drag.previousKey,
    );
    drag.previousKey = plan.key;
    drag.moves = runMoves(this.kit, plan);
    drag.missStuds = plan.missStuds;
    this.settleHeights(drag, start, null);
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
    let toPlates = drag.startPlates;
    let rampPieces = 0;
    let rampCurves = 0;
    drag.rises.forEach((rise, i) => {
      toPlates += rise;
      if (rise === 0) return;
      rampPieces++;
      if (drag.moves[i]?.turn !== 0) rampCurves++;
    });
    return {
      pieces: drag.moves.length,
      straights,
      curves: drag.moves.length - straights,
      missStuds: drag.missStuds,
      closure: drag.closure,
      fromOpenEnd: drag.fromEnd !== null,
      solveMs: this.lastSolveMs,
      blocked: drag.blocked,
      fromPlates: drag.startPlates,
      toPlates,
      targetPlates: drag.targetPlates,
      rampPieces,
      rampCurves,
      newPiers: drag.newPiers.length,
    };
  }

  dragTarget(): TrackEndView | null {
    const target = this.drag?.target;
    if (target === null || target === undefined) return null;
    return this.openEnds()[target] ?? null;
  }

  ghostEnd(): TrackEndView | null {
    const drag = this.drag;
    if (!drag?.start || drag.moves.length === 0) return null;
    const { end } = layMoves(drag.start, drag.moves);
    const at = studsLdu(end.position);
    let plates = drag.startPlates;
    for (const rise of drag.rises) plates += rise;
    return { xLdu: at.x, zLdu: at.z, heading: end.heading, plates };
  }

  ghostPiers(): ReadonlyArray<PierView> {
    return (this.drag?.newPiers ?? []).map((pier) => ({
      xLdu: pier.centreX,
      zLdu: pier.centreZ,
      plates: pier.heightPlates,
    }));
  }

  private runPlaced(drag: Drag, start: Pose16): ReadonlyArray<Placed> {
    const { placed } = layMoves(start, drag.moves);
    const out: Placed[] = [];
    let yPlates = drag.startPlates;
    placed.forEach((piece, i) => {
      const move = drag.moves[i];
      if (!move) return;
      const rise = drag.rises[i] ?? 0;
      out.push({ part: this.kitPart(move), placement: piece.placement, yPlates, rise });
      yPlates += rise;
    });
    return out;
  }

  ghost(): { readonly instances: ChunkInstances; readonly x: number; readonly z: number } | null {
    const drag = this.drag;
    if (!drag?.start || drag.moves.length === 0) return null;
    const placed = this.runPlaced(drag, drag.start);
    const courses = drag.newPiers.reduce((sum, pier) => sum + pierCourseCount(pier), 0);
    const count = placed.length + courses;
    this.growGhostScratch(count);
    const partIndex = this.ghostParts.subarray(0, count);
    const colorIndex = this.ghostColors.subarray(0, count);
    const matrices = this.ghostMatrices.subarray(0, count * INSTANCE_MATRIX_FLOATS);
    const origin = studsLdu(drag.start.position);
    placed.forEach((piece, i) => {
      partIndex[i] = piece.part.partIndex;
      colorIndex[i] = piece.part.color;
      writeMatrix(matrices, i, piece, origin.x, origin.z);
    });
    let slot = placed.length;
    for (const pier of drag.newPiers) {
      slot += writePier(
        pier,
        this.elevation.pier,
        partIndex,
        colorIndex,
        matrices,
        slot,
        origin.x,
        origin.z,
      );
    }
    const base: ChunkPartInstances = {
      originX: origin.x,
      originZ: origin.z,
      count,
      partIndex,
      colorIndex,
      matrices,
    };
    return {
      instances: withStuds(base, this.parts, this.colors, undefined),
      x: origin.x,
      z: origin.z,
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
    const blocked =
      drag.blocked ?? this.runCheck(drag.start, drag.startPlates, drag.moves, drag.rises).blocked;
    if (blocked) {
      return { laid: 0, joined: false, refusal: blocked.kind, blocked, chunks: [] };
    }
    const touched = new Set<number>();
    for (const entry of this.runPlaced(drag, drag.start)) {
      const index = this.layout.place(
        entry.part.catalogIndex,
        entry.placement,
        entry.yPlates,
        entry.rise,
      );
      touched.add(this.register(index, entry));
    }
    this.recomputeEnds();
    for (const key of this.syncPiers()) touched.add(key);
    return {
      laid: drag.moves.length,
      joined: drag.goal !== null && this.graphJoins(drag.goal),
      refusal: null,
      blocked: null,
      chunks: [...touched],
    };
  }

  private register(index: number, entry: Placed): number {
    const plan = this.planOf(entry.part, entry.placement);
    this.piecePlans[index] = plan;
    this.pieceSupport[index] = this.supportCells(entry, plan);
    const span = spanOf(entry.part, entry.yPlates, entry.rise);
    this.host.laid(index, entry.part.piece.id, plan.cells, span.bottomLdu, span.railTopLdu);
    const centre = partCentre(entry);
    const chunkX = chunkOf(centre.x);
    const chunkZ = chunkOf(centre.z);
    const key = trackChunkKey(chunkX, chunkZ);
    const members = this.chunkMembers.get(key) ?? [];
    members.push(index);
    this.chunkMembers.set(key, members);
    this.chunkOrigins.set(key, [chunkX * CHUNK_LDU, chunkZ * CHUNK_LDU]);
    return key;
  }

  private supportCells(entry: Placed, plan: PlacedPlan): BaseCells {
    const top = entry.yPlates + entry.rise;
    if (entry.yPlates === LAID_TRACK_PLATES && top === LAID_TRACK_PLATES) return plan.support;
    const ends = this.connectorPoses(entry.part, entry.placement);
    const plates = [entry.yPlates, top];
    return mergeCells(
      ends.flatMap((end, c) =>
        this.heldJoinAt(end, plates[c] ?? 0) ? [] : [footprintAt(end, this.footprint)],
      ),
    );
  }

  private syncPiers(): ReadonlyArray<number> {
    const touched = new Set<number>(this.pierChunks.keys());
    const piers = new Map<string, Pier>();
    for (let p = 0; p < this.layout.count; p++) {
      const poses = this.laidConnectorPoses(p);
      const plates = this.laidEndPlates(p);
      poses.forEach((end, c) => {
        const height = plates[c] ?? 0;
        if (height === LAID_TRACK_PLATES || this.heldJoinAt(end, height)) return;
        const pier = pierAt(end, height, this.footprint);
        piers.set(pier.key, pier);
      });
    }
    this.piers = piers;
    this.pierChunks.clear();
    for (const pier of piers.values()) {
      const chunk = pierChunk(pier);
      const list = this.pierChunks.get(chunk.key) ?? [];
      list.push(pier);
      this.pierChunks.set(chunk.key, list);
      this.chunkOrigins.set(chunk.key, [chunk.x * CHUNK_LDU, chunk.z * CHUNK_LDU]);
      touched.add(chunk.key);
    }
    this.host.piers([...piers.values()]);
    return [...touched];
  }

  pierViews(): ReadonlyArray<PierView> {
    return [...this.piers.values()].map((pier) => ({
      xLdu: pier.centreX,
      zLdu: pier.centreZ,
      plates: pier.heightPlates,
    }));
  }

  pierParts(): ReadonlyArray<PierPartCount> {
    let bricks = 0;
    let plates = 0;
    for (const pier of this.piers.values()) {
      const courses = riserCourses(pier.heightPlates);
      bricks += courses.bricks;
      plates += courses.plates;
    }
    const { brick, plate } = this.elevation.pier;
    return [
      { partId: brick.part.id, title: brick.part.title, count: bricks },
      { partId: plate.part.id, title: plate.part.title, count: plates },
    ];
  }

  crossings(): ReadonlyArray<CrossingView> {
    const byUpper = new Map<number, CrossingView>();
    for (let p = 0; p < this.layout.count; p++) {
      const a = this.placedAt(p);
      const planA = this.piecePlans[p];
      if (!planA) continue;
      const spanA = spanOf(a.part, a.yPlates, a.rise);
      for (const q of this.host.neighbours(planA.cells)) {
        if (q <= p) continue;
        const planB = this.piecePlans[q];
        if (!planB) continue;
        const shared = this.planCrossing(planA, planB);
        if (!shared) continue;
        const b = this.placedAt(q);
        const verdict = crossing(spanA, spanOf(b.part, b.yPlates, b.rise), 0);
        if (verdict.kind === "intersects") continue;
        const [lower, upper, upperPiece] = verdict.upper === 0 ? [b, a, p] : [a, b, q];
        const known = byUpper.get(upperPiece);
        if (known && known.gapLdu <= verdict.gapLdu) continue;
        byUpper.set(upperPiece, {
          xLdu: ((shared.cellX[0] ?? 0) + 0.5) * STUD_LDU,
          zLdu: ((shared.cellZ[0] ?? 0) + 0.5) * STUD_LDU,
          lowerPlates: Math.max(lower.yPlates, lower.yPlates + lower.rise),
          upperPlates: Math.min(upper.yPlates, upper.yPlates + upper.rise),
          gapLdu: verdict.gapLdu,
        });
      }
    }
    return [...byUpper.values()];
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
      combined.place(
        this.layout.piece(p),
        this.layout.pose(p),
        this.layout.yPlates(p),
        this.layout.rise(p),
      );
    }
    for (const h of this.held) combined.place(h.catalogIndex, h.placement, h.plates);
    this.combined = combined;
    this.graph = new TrackGraph(combined);
    const ends: Pose16[] = [];
    const plates: number[] = [];
    for (const end of this.graph.openEnds) {
      const placement = this.graph.endPlacement[end] ?? 0;
      const connector = this.graph.endConnector[end] ?? 0;
      ends.push(combined.connectorPose(placement, connector));
      plates.push(this.graph.endYPlates[end] ?? 0);
    }
    this.ends = ends;
    this.endPlates = plates;
  }

  pieceAt(ray: Float64Array): number | null {
    for (let p = this.layout.count - 1; p >= 0; p--) {
      const cells = this.piecePlans[p]?.cells;
      if (!cells) continue;
      const placed = this.placedAt(p);
      const top = Math.max(placed.yPlates, placed.yPlates + placed.rise) * PLATE_LDU;
      const hit = planeHit(ray, top + placed.part.heightLdu);
      if (!hit) continue;
      const cellX = Math.floor(hit.x / STUD_LDU);
      const cellZ = Math.floor(hit.z / STUD_LDU);
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
    this.pieceSupport = [];
    const relaid: LaidTrackPiece[] = [];
    for (const placed of kept) {
      const index = this.layout.place(
        placed.part.catalogIndex,
        placed.placement,
        placed.yPlates,
        placed.rise,
      );
      const plan = this.planOf(placed.part, placed.placement);
      this.piecePlans[index] = plan;
      this.pieceSupport[index] = this.supportCells(placed, plan);
      const span = spanOf(placed.part, placed.yPlates, placed.rise);
      relaid.push({
        piece: index,
        pieceId: placed.part.piece.id,
        cells: plan.cells,
        bottomLdu: span.bottomLdu,
        topLdu: span.railTopLdu,
      });
      const centre = partCentre(placed);
      const chunkX = chunkOf(centre.x);
      const chunkZ = chunkOf(centre.z);
      const key = trackChunkKey(chunkX, chunkZ);
      const members = this.chunkMembers.get(key) ?? [];
      members.push(index);
      this.chunkMembers.set(key, members);
      this.chunkOrigins.set(key, [chunkX * CHUNK_LDU, chunkZ * CHUNK_LDU]);
      touched.add(key);
    }
    this.host.relaid(relaid);
    this.recomputeEnds();
    for (const key of this.syncPiers()) touched.add(key);
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
    const members = this.chunkMembers.get(key) ?? [];
    const piers = this.pierChunks.get(key) ?? [];
    const origin = this.chunkOrigins.get(key);
    if ((members.length === 0 && piers.length === 0) || !origin) return null;
    const [originX, originZ] = origin;
    const courses = piers.reduce((sum, pier) => sum + pierCourseCount(pier), 0);
    const count = members.length + courses;
    const partIndex = new Uint16Array(count);
    const colorIndex = new Uint16Array(count);
    const matrices = new Float32Array(count * INSTANCE_MATRIX_FLOATS);
    members.forEach((member, i) => {
      const piece = this.placedAt(member);
      partIndex[i] = piece.part.partIndex;
      colorIndex[i] = piece.part.color;
      writeMatrix(matrices, i, piece, originX, originZ);
    });
    let slot = members.length;
    for (const pier of piers) {
      slot += writePier(
        pier,
        this.elevation.pier,
        partIndex,
        colorIndex,
        matrices,
        slot,
        originX,
        originZ,
      );
    }
    const base: ChunkPartInstances = { originX, originZ, count, partIndex, colorIndex, matrices };
    return withStuds(base, this.parts, this.colors, undefined);
  }
}
