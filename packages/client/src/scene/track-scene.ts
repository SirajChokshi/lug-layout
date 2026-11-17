import { PART_BUNDLE_LOADER, type IPartBundleLoader, type PartBundle } from "@brr/catalog";
import type { BundleLod, TrackPiece } from "@brr/schema/bundle";
import { TrackGraph, type TrackLayout } from "@brr/domain";
import { CHUNK_LDU, chunkKey, chunkOf, PLATE_LDU, STUD_LDU, zeta16ToStuds } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS, SCENE_BACKEND, type ISceneBackend } from "@brr/render";
import { inject, injectable } from "inversify";
import { plateDepthBelowOrigin } from "./part-footprint.ts";
import type { ChunkPartInstances } from "./placements.ts";
import { withStuds } from "./stud-stream.ts";
import { buildTrackPlan } from "./track-plan.ts";
import {
  ColorTable,
  showChunks,
  type IViewerScene,
  type KeyedChunk,
  type SceneSummary,
  type TrackSummary,
} from "./viewer-scene.ts";

export interface ITrackScene extends IViewerScene {
  selectPlan(plan: string): void;
}

export const TRACK_PARTS = (part: { readonly role: string }): boolean => part.role === "track";
const STEP_RADIANS = Math.PI / 8;
const HALF_STEP_RADIANS = Math.PI / 16;
const ORBIT_DISTANCE_FACTOR = 0.3;
const ORBIT_ELEVATION_FACTOR = 2.6;
const MIN_ORBIT_RADIUS_LDU = 400;

interface PlacedPart {
  readonly part: number;
  readonly color: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly angle: number;
}

function partPlacement(
  layout: TrackLayout,
  placement: number,
  piece: TrackPiece,
  bundle: PartBundle,
  colors: ColorTable,
): PlacedPart {
  const part = bundle.parts.findIndex((asset) => asset.id === piece.part);
  const asset = bundle.parts[part];
  if (!asset) throw new Error(`track part ${piece.part} is not in the bundle`);
  if (asset.producedColor === undefined) {
    throw new Error(`${asset.id}: track parts need a sourced produced colour in palette.json`);
  }
  const pose = layout.pose(placement);
  const origin = zeta16ToStuds(pose.position);
  const heading = pose.heading * STEP_RADIANS;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const { xLdu, zLdu, headingHalfSteps } = piece.partFrame;
  return {
    part,
    color: colors.indexOfCode(asset.producedColor),
    x: origin.x * STUD_LDU + xLdu * cos - zLdu * sin,
    y: (layout.yPlates(placement) + plateDepthBelowOrigin(asset)) * PLATE_LDU,
    z: origin.z * STUD_LDU + xLdu * sin + zLdu * cos,
    angle: heading + headingHalfSteps * HALF_STEP_RADIANS,
  };
}

function chunkedInstances(placed: ReadonlyArray<PlacedPart>): Map<number, ChunkPartInstances> {
  const byChunk = new Map<number, PlacedPart[]>();
  for (const part of placed) {
    const key = chunkKey(chunkOf(part.x), chunkOf(part.z));
    const list = byChunk.get(key);
    if (list) list.push(part);
    else byChunk.set(key, [part]);
  }
  const chunks = new Map<number, ChunkPartInstances>();
  for (const [key, list] of byChunk) {
    const first = list[0];
    if (!first) continue;
    const originX = chunkOf(first.x) * CHUNK_LDU;
    const originZ = chunkOf(first.z) * CHUNK_LDU;
    const partIndex = new Uint16Array(list.length);
    const colorIndex = new Uint16Array(list.length);
    const matrices = new Float32Array(list.length * INSTANCE_MATRIX_FLOATS);
    list.forEach((part, i) => {
      const cos = Math.cos(part.angle);
      const sin = Math.sin(part.angle);
      const o = i * INSTANCE_MATRIX_FLOATS;
      partIndex[i] = part.part;
      colorIndex[i] = part.color;
      matrices.set(
        [cos, 0, -sin, part.x - originX, 0, 1, 0, part.y, sin, 0, cos, part.z - originZ],
        o,
      );
    });
    chunks.set(key, { originX, originZ, count: list.length, partIndex, colorIndex, matrices });
  }
  return chunks;
}

export function trackChunks(
  layout: TrackLayout,
  catalogPieces: ReadonlyArray<TrackPiece>,
  bundle: PartBundle,
  colors: ColorTable,
): KeyedChunk[] {
  const placed: PlacedPart[] = [];
  for (let p = 0; p < layout.count; p++) {
    const piece = catalogPieces[layout.piece(p)];
    if (!piece) throw new Error(`placement ${p} has no catalog piece`);
    placed.push(partPlacement(layout, p, piece, bundle, colors));
  }
  const chunks: KeyedChunk[] = [];
  for (const [key, instances] of chunkedInstances(placed)) {
    chunks.push({ key, instances: withStuds(instances, bundle.parts, colors, undefined) });
  }
  return chunks;
}

export function summarizeTrack(
  plan: string,
  graph: TrackGraph,
  layout: TrackLayout,
  pieces: ReadonlyArray<TrackPiece>,
): TrackSummary {
  let unverifiedPlacements = 0;
  for (let p = 0; p < layout.count; p++) {
    if (pieces[layout.piece(p)]?.status !== "certified") unverifiedPlacements++;
  }
  return {
    plan,
    placements: layout.count,
    ends: graph.endCount,
    joins: graph.joinCount,
    openEnds: graph.openEnds.length,
    coincidentNotJoined: graph.issues.length,
    switches: graph.switchCount,
    directedEdges: graph.edgeCount,
    reachableFromFirstEdge: graph.edgeCount === 0 ? 0 : graph.reachableEdgeCount(0),
    unverifiedPlacements,
  };
}

@injectable()
export class TrackScene implements ITrackScene {
  private plan = "";
  private centreX = 0;
  private centreZ = 0;
  private radius = MIN_ORBIT_RADIUS_LDU;

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) readonly backend: ISceneBackend,
  ) {}

  selectPlan(plan: string): void {
    this.plan = plan;
  }

  async load(lod: BundleLod): Promise<SceneSummary> {
    const bundle = await this.loader.load(lod, TRACK_PARTS);
    const { layout, catalogPieces } = buildTrackPlan(this.plan, bundle.trackCatalog);
    const graph = new TrackGraph(layout);
    this.frame(graph);
    const colors = new ColorTable(bundle);
    const chunks = trackChunks(layout, catalogPieces, bundle, colors);
    const summary = showChunks(this.backend, bundle, undefined, colors, chunks, null);
    return { ...summary, track: summarizeTrack(this.plan, graph, layout, catalogPieces) };
  }

  private frame(graph: TrackGraph): void {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let end = 0; end < graph.endCount; end++) {
      const x = graph.endXLdu[end] ?? 0;
      const z = graph.endZLdu[end] ?? 0;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    if (graph.endCount === 0) return;
    this.centreX = (minX + maxX) / 2;
    this.centreZ = (minZ + maxZ) / 2;
    this.radius = Math.max(Math.hypot(maxX - minX, maxZ - minZ) / 2, MIN_ORBIT_RADIUS_LDU);
  }

  setCamera(t: number): void {
    const angle = t * 2 * Math.PI;
    const distance = this.radius * ORBIT_DISTANCE_FACTOR;
    this.backend.setView(
      this.centreX + distance * Math.cos(angle),
      this.radius * ORBIT_ELEVATION_FACTOR,
      this.centreZ + distance * Math.sin(angle),
      this.centreX,
      0,
      this.centreZ,
    );
  }
}
