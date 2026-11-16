import type {
  PartAsset,
  TrackCatalog,
  TrackPartFrame,
  TrackPiece,
  TrackSystem,
} from "@brr/catalog";
import {
  drawingKit,
  layMoves,
  runMoves,
  solveClosure,
  solveDrag,
  TrackGraph,
  TrackLayout,
  type DrawingKit,
  type TrackInput,
  type TrackMove,
  type TrackPieceDef,
  type TrackPieceInfo,
  type TrackPieceSpec,
} from "@brr/domain";
import {
  CHUNK_LDU,
  STUD_LDU,
  ZETA16_ORDER,
  chunkKey,
  chunkOf,
  normalizeHeading16,
  pose16,
  zeta16,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";
import { INSTANCE_MATRIX_FLOATS, type ChunkInstances } from "@brr/render";
import type { ChunkPartInstances } from "../scene/placements.ts";
import { withStuds } from "../scene/stud-stream.ts";
import type { ColorTable } from "../scene/viewer-scene.ts";

export const TRACK_SYSTEMS: ReadonlyArray<TrackSystem> = ["lego-9v", "lego-plastic"];
const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const HALF_STEP_RADIANS = HEADING_RADIANS / 2;
const END_PICK_RADIUS_LDU = 3 * STUD_LDU;
const MIN_START_DRAG_LDU = STUD_LDU;
const GROUND_PLATES = 0;

export interface KitPart {
  readonly catalogIndex: number;
  readonly piece: TrackPiece;
  readonly def: TrackPieceDef;
  readonly partIndex: number;
  readonly color: number;
  readonly yLdu: number;
}

export type ClosureState = "exact" | "refused" | null;

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
  readonly refused: boolean;
  readonly chunks: ReadonlyArray<number>;
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
  missStuds: number;
  target: number | null;
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
  const studs = zeta16ToStuds(placement.position);
  const theta = placement.heading * HEADING_RADIANS;
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  const x = studs.x * STUD_LDU + cosTheta * frame.xLdu - sinTheta * frame.zLdu;
  const z = studs.z * STUD_LDU + sinTheta * frame.xLdu + cosTheta * frame.zLdu;
  const phi = theta + frame.headingHalfSteps * HALF_STEP_RADIANS;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
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
  const studs = zeta16ToStuds(placed.placement.position);
  const theta = placed.placement.heading * HEADING_RADIANS;
  const { xLdu, zLdu } = placed.part.piece.partFrame;
  return {
    x: studs.x * STUD_LDU + Math.cos(theta) * xLdu - Math.sin(theta) * zLdu,
    z: studs.z * STUD_LDU + Math.sin(theta) * xLdu + Math.cos(theta) * zLdu,
  };
}

export function trackChunkKey(chunkX: number, chunkZ: number): number {
  return -1 - chunkKey(chunkX, chunkZ);
}

interface SystemKit {
  readonly kit: DrawingKit;
  readonly parts: ReadonlyArray<KitPart>;
}

export class TrackDrawing {
  private readonly kits = new Map<TrackSystem, SystemKit>();
  private system: TrackSystem;
  private readonly byDef = new Map<string, KitPart>();
  private readonly byCatalogIndex = new Map<number, KitPart>();
  private readonly pieceInfo: ReadonlyArray<TrackPieceInfo | null>;
  private readonly layout: TrackLayout;
  private graph: TrackGraph;
  private readonly chunkMembers = new Map<number, number[]>();
  private ends: Pose16[] = [];
  private drag: Drag | null = null;
  private lastSolveMs = 0;
  readonly solveSamplesMs: number[] = [];

  constructor(
    catalog: TrackCatalog,
    private readonly parts: ReadonlyArray<PartAsset>,
    private readonly colors: ColorTable,
  ) {
    this.layout = new TrackLayout(catalog.pieces.map(pieceSpec));
    this.graph = new TrackGraph(this.layout);
    this.pieceInfo = catalog.pieces.map((piece) => {
      const index = parts.findIndex((part) => part.id === piece.part);
      const part = parts[index];
      if (!part || part.producedColor === undefined) return null;
      return {
        id: piece.id,
        title: piece.title,
        part: piece.part,
        ldrawColor: part.producedColor,
        status: piece.status,
        frameXLdu: piece.partFrame.xLdu,
        frameZLdu: piece.partFrame.zLdu,
        frameHalfSteps: piece.partFrame.headingHalfSteps,
        boundsMinX: part.boundsMin[0],
        boundsMaxX: part.boundsMax[0],
        boundsMinZ: part.boundsMin[2],
        boundsMaxZ: part.boundsMax[2],
      };
    });
    for (const system of TRACK_SYSTEMS) {
      const kitParts: KitPart[] = [];
      catalog.pieces.forEach((piece, catalogIndex) => {
        const inKit =
          piece.system === system && (piece.kind === "straight" || piece.kind === "curve");
        if (!inKit) return;
        const partIndex = partForPiece(piece, parts);
        const part = parts[partIndex];
        if (!part) throw new Error(`${piece.id}: part index ${partIndex} is out of range`);
        if (part.producedColor === undefined) {
          throw new Error(`${piece.id}: track part has no sourced produced colour`);
        }
        const def: TrackPieceDef = {
          id: piece.id,
          connectors: piece.connectors.map((c) => c.pose),
        };
        const kitPart: KitPart = {
          catalogIndex,
          piece,
          def,
          partIndex,
          color: colors.indexOfCode(part.producedColor),
          yLdu: -part.boundsMin[1],
        };
        kitParts.push(kitPart);
        this.byDef.set(piece.id, kitPart);
        this.byCatalogIndex.set(catalogIndex, kitPart);
      });
      const result = drawingKit(kitParts.map((k) => k.def));
      if (result.kind !== "kit") throw new Error(`no ${system} drawing kit: ${result.reason}`);
      this.kits.set(system, { kit: result.kit, parts: kitParts });
    }
    this.system = TRACK_SYSTEMS[0] ?? "lego-9v";
  }

  get kit(): DrawingKit {
    const active = this.kits.get(this.system);
    if (!active) throw new Error(`no ${this.system} drawing kit`);
    return active.kit;
  }

  get activeSystem(): TrackSystem {
    return this.system;
  }

  useSystem(system: TrackSystem): void {
    if (!this.kits.has(system)) throw new Error(`no ${system} drawing kit`);
    this.cancelDrag();
    this.system = system;
  }

  kitParts(system: TrackSystem = this.system): ReadonlyArray<KitPart> {
    return this.kits.get(system)?.parts ?? [];
  }

  trackInput(): TrackInput {
    return { layout: this.layout, graph: this.graph, pieces: this.pieceInfo };
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
    if (goal) {
      const run = solveClosure(this.kit, start, goal);
      drag.closure = run ? "exact" : "refused";
      if (run) {
        drag.moves = runMoves(this.kit, run);
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
    const partIndex = new Uint16Array(count);
    const colorIndex = new Uint16Array(count);
    const matrices = new Float32Array(count * INSTANCE_MATRIX_FLOATS);
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

  cancelDrag(): void {
    this.drag = null;
  }

  endDrag(): TrackCommit {
    const drag = this.drag;
    this.drag = null;
    if (!drag?.start || drag.moves.length === 0) {
      return { laid: 0, joined: false, refused: false, chunks: [] };
    }
    if (drag.closure === "refused") return { laid: 0, joined: false, refused: true, chunks: [] };
    const { placed } = layMoves(drag.start, drag.moves);
    const touched = new Set<number>();
    placed.forEach((piece, i) => {
      const move = drag.moves[i];
      if (!move) return;
      const entry: Placed = { part: this.kitPart(move), placement: piece.placement };
      const index = this.layout.place(entry.part.catalogIndex, piece.placement, GROUND_PLATES);
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
      joined: drag.closure === "exact",
      refused: false,
      chunks: [...touched],
    };
  }

  private recomputeEnds(): void {
    this.graph = new TrackGraph(this.layout);
    const ends: Pose16[] = [];
    for (const end of this.graph.openEnds) {
      const placement = this.graph.endPlacement[end] ?? 0;
      const connector = this.graph.endConnector[end] ?? 0;
      ends.push(this.layout.connectorPose(placement, connector));
    }
    this.ends = ends;
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
