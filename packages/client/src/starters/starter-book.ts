import type { PlacementPose, TrackRun, TrackSegment } from "@brr/domain";
import {
  HALF_TURN_16,
  STUD_LDU,
  ZETA16_COEFFICIENT_COUNT,
  pose16,
  rot90Cos,
  rot90Sin,
  zeta16,
  type Pose16,
  type Rot90,
} from "@brr/math";
import type { Placeable } from "../edit/placeable.ts";
import type { TrackDrawing } from "../edit/track-drawing.ts";
import type {
  StarterLayout,
  StarterPiece,
  StarterSegment,
  StarterTrackRun,
  TileArea,
} from "./starter-layouts.ts";

export interface FlatRect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export type StarterTileKind = "ground" | "road" | "module" | "set";

export interface StarterTileView {
  readonly item: string;
  readonly label: string;
  readonly kind: StarterTileKind;
  readonly rgb: string | null;
  readonly rect: FlatRect;
  readonly roadRects: ReadonlyArray<FlatRect>;
}

export interface StarterView {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly bounds: FlatRect;
  readonly tiles: ReadonlyArray<StarterTileView>;
  readonly trackPaths: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  readonly trackPieces: number;
  readonly sets: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<string>;
}

export interface StarterPlacement {
  readonly placeable: Placeable;
  readonly pose: PlacementPose;
}

export interface StarterTrack {
  readonly start: Pose16;
  readonly run: TrackRun;
}

export interface StarterPlan {
  readonly placements: ReadonlyArray<StarterPlacement>;
  readonly track: ReadonlyArray<StarterTrack>;
  readonly bounds: FlatRect;
}

interface ResolvedPiece {
  readonly placeable: Placeable;
  readonly rot: Rot90;
  readonly pose: PlacementPose;
  readonly rect: FlatRect;
}

interface Resolved {
  readonly pieces: ReadonlyArray<ResolvedPiece>;
  readonly track: ReadonlyArray<StarterTrack>;
  readonly paths: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  readonly problems: ReadonlyArray<string>;
}

const EMPTY_RECT: FlatRect = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };

function kindOf(placeable: Placeable): StarterTileKind {
  switch (placeable.kind) {
    case "baseplate":
      return "ground";
    case "road-plate":
      return "road";
    case "mils-module":
      return "module";
    case "model":
      return "set";
    default: {
      const unhandled: never = placeable.kind;
      throw new Error(`unhandled placeable kind ${String(unhandled)}`);
    }
  }
}

export function seatRect(placeable: Placeable): FlatRect {
  if (placeable.ground) return placeable.ground;
  const { min, max } = placeable.box;
  return { minX: min[0], minZ: min[2], maxX: max[0], maxZ: max[2] };
}

function union(a: FlatRect | null, b: FlatRect): FlatRect {
  if (!a) return b;
  return {
    minX: Math.min(a.minX, b.minX),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

export function rotateRect(rect: FlatRect, rot: Rot90): FlatRect {
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  const xs = [rect.minX, rect.maxX];
  const zs = [rect.minZ, rect.maxZ];
  const worldX = xs.flatMap((x) => zs.map((z) => cos * x + sin * z));
  const worldZ = xs.flatMap((x) => zs.map((z) => -sin * x + cos * z));
  return {
    minX: Math.min(...worldX) + 0,
    minZ: Math.min(...worldZ) + 0,
    maxX: Math.max(...worldX) + 0,
    maxZ: Math.max(...worldZ) + 0,
  };
}

function offset(rect: FlatRect, x: number, z: number): FlatRect {
  return { minX: rect.minX + x, minZ: rect.minZ + z, maxX: rect.maxX + x, maxZ: rect.maxZ + z };
}

function onStuds(ldu: number): boolean {
  return Number.isInteger(ldu / STUD_LDU);
}

function latticeStart(xLdu: number, zLdu: number, heading: number): Pose16 {
  const position = Array.from({ length: ZETA16_COEFFICIENT_COUNT }, () => 0n);
  position[0] = BigInt(xLdu / STUD_LDU);
  position[ZETA16_COEFFICIENT_COUNT / 2] = BigInt(zLdu / STUD_LDU);
  return pose16(zeta16(position), heading);
}

function roadRuns(placeable: Placeable): ReadonlyArray<FlatRect> {
  const surface = placeable.road;
  if (!surface || placeable.kind !== "mils-module") return [];
  const runs: FlatRect[] = [];
  for (let row = 0; row < surface.rows; row++) {
    let start = -1;
    for (let column = 0; column <= surface.columns; column++) {
      const isRoad = column < surface.columns && surface.road[row * surface.columns + column] === 1;
      if (isRoad && start < 0) start = column;
      if (isRoad || start < 0) continue;
      runs.push({
        minX: surface.minX + start * STUD_LDU,
        minZ: surface.minZ + row * STUD_LDU,
        maxX: surface.minX + column * STUD_LDU,
        maxZ: surface.minZ + (row + 1) * STUD_LDU,
      });
      start = -1;
    }
  }
  return runs;
}

function piecesIn(segments: ReadonlyArray<TrackSegment>): number {
  return segments.reduce(
    (sum, segment) => sum + (segment.kind === "straight" ? segment.count : segment.curves),
    0,
  );
}

export class StarterBook {
  private readonly byId = new Map<string, Placeable>();
  private readonly refIds = new Map<Placeable, number>();

  constructor(
    private readonly layouts: ReadonlyArray<StarterLayout>,
    placeables: ReadonlyArray<Placeable>,
    private readonly track: TrackDrawing,
    private readonly setNames: ReadonlyMap<string, string>,
    private readonly rgbOf: (ldrawColor: number) => string,
  ) {
    placeables.forEach((placeable, refId) => {
      this.byId.set(placeable.id, placeable);
      this.refIds.set(placeable, refId);
    });
  }

  views(): ReadonlyArray<StarterView> {
    return this.layouts.map((layout) => this.view(layout));
  }

  plan(id: string): StarterPlan | null {
    const layout = this.layouts.find((candidate) => candidate.id === id);
    if (!layout) return null;
    const resolved = this.resolve(layout);
    if (resolved.problems.length > 0) return null;
    return {
      placements: resolved.pieces.map(({ placeable, pose }) => ({ placeable, pose })),
      track: resolved.track,
      bounds: this.bounds(resolved),
    };
  }

  private resolve(layout: StarterLayout): Resolved {
    const problems: string[] = [];
    const missing = [...new Set(layout.pieces.map((piece) => piece.item))].filter(
      (item) => !this.byId.has(item),
    );
    if (missing.length > 0) problems.push(`not in this bundle: ${missing.join(", ")}`);
    const pitch = this.tilePitch(layout.tile, problems);
    if (pitch === null) return { pieces: [], track: [], paths: [], problems };
    const pieces: ResolvedPiece[] = [];
    for (const piece of layout.pieces) {
      const resolved = this.resolvePiece(piece, pitch, problems);
      if (resolved) pieces.push(resolved);
    }
    const track: StarterTrack[] = [];
    const paths: Array<ReadonlyArray<readonly [number, number]>> = [];
    for (const run of layout.track) {
      const laid = this.resolveRun(run, pitch, problems);
      if (!laid) continue;
      track.push(laid);
      paths.push(this.path(laid));
    }
    return { pieces, track, paths, problems };
  }

  private tilePitch(item: string, problems: string[]): number | null {
    const tile = this.byId.get(item);
    if (!tile) {
      problems.push(`tile ${item} is not in this bundle`);
      return null;
    }
    const seat = seatRect(tile);
    const width = seat.maxX - seat.minX;
    if (width !== seat.maxZ - seat.minZ || !onStuds(width)) {
      problems.push(`tile ${item} is not a square of whole studs`);
      return null;
    }
    return width;
  }

  private resolvePiece(
    piece: StarterPiece,
    pitch: number,
    problems: string[],
  ): ResolvedPiece | null {
    const placeable = this.byId.get(piece.item);
    const refId = placeable ? this.refIds.get(placeable) : undefined;
    if (!placeable || refId === undefined) return null;
    const local = rotateRect(seatRect(placeable), piece.rot);
    const x = piece.col * pitch + piece.xStuds * STUD_LDU - local.minX;
    const z = piece.row * pitch + piece.zStuds * STUD_LDU - local.minZ;
    if (!onStuds(x) || !onStuds(z)) {
      problems.push(`${piece.item} would sit off the stud lattice at (${x}, ${z}) LDU`);
      return null;
    }
    return {
      placeable,
      rot: piece.rot,
      pose: { refId, colorId: placeable.worldColor, x, z, yPlates: 0, rot: piece.rot },
      rect: offset(local, x, z),
    };
  }

  private segment(segment: StarterSegment, problems: string[]): TrackSegment | null {
    switch (segment.kind) {
      case "straight":
        return segment;
      case "half-turn": {
        const curves = HALF_TURN_16 / this.track.kit.left.turn;
        if (!Number.isInteger(curves)) {
          problems.push(`a half turn is not a whole number of ${this.track.kit.left.piece.id}`);
          return null;
        }
        return { kind: "turn", sign: segment.sign, curves };
      }
      default: {
        const unhandled: never = segment;
        throw new Error(`unhandled segment ${String(unhandled)}`);
      }
    }
  }

  private resolveRun(run: StarterTrackRun, pitch: number, problems: string[]): StarterTrack | null {
    const segments: TrackSegment[] = [];
    for (const segment of run.segments) {
      const resolved = this.segment(segment, problems);
      if (!resolved) return null;
      segments.push(resolved);
    }
    const trackRun: TrackRun = { segments, pieces: piecesIn(segments) };
    const fromOrigin = this.path({ start: latticeStart(0, 0, run.heading), run: trackRun });
    const extent = fromOrigin.reduce<FlatRect | null>(
      (rect, [x, z]) => union(rect, { minX: x, minZ: z, maxX: x, maxZ: z }),
      null,
    );
    if (!extent) return null;
    const area = this.areaRect(run.centredOn, pitch);
    const x = (area.minX + area.maxX - extent.minX - extent.maxX) / 2;
    const z = (area.minZ + area.maxZ - extent.minZ - extent.maxZ) / 2;
    if (!onStuds(x) || !onStuds(z)) {
      problems.push(`the track run can't be centred on its tiles at whole studs (${x}, ${z}) LDU`);
      return null;
    }
    return { start: latticeStart(x, z, run.heading), run: trackRun };
  }

  private areaRect(area: TileArea, pitch: number): FlatRect {
    return {
      minX: area.col * pitch,
      minZ: area.row * pitch,
      maxX: (area.col + area.cols) * pitch,
      maxZ: (area.row + area.rows) * pitch,
    };
  }

  private path(track: StarterTrack): ReadonlyArray<readonly [number, number]> {
    return this.track.runPath(track.start, track.run).map((end) => [end.xLdu, end.zLdu] as const);
  }

  private bounds(resolved: Resolved): FlatRect {
    let bounds: FlatRect | null = null;
    for (const piece of resolved.pieces) bounds = union(bounds, piece.rect);
    for (const path of resolved.paths) {
      for (const [x, z] of path) bounds = union(bounds, { minX: x, minZ: z, maxX: x, maxZ: z });
    }
    return bounds ?? EMPTY_RECT;
  }

  private labelOf(placeable: Placeable): string {
    const name = this.setNames.get(placeable.id);
    return name === undefined ? placeable.label : `${name} (${placeable.label})`;
  }

  private view(layout: StarterLayout): StarterView {
    const resolved = this.resolve(layout);
    const tiles = resolved.pieces.map((piece): StarterTileView => {
      const colored = piece.placeable.kind === "baseplate" || piece.placeable.kind === "road-plate";
      return {
        item: piece.placeable.id,
        label: this.labelOf(piece.placeable),
        kind: kindOf(piece.placeable),
        rgb: colored ? this.rgbOf(piece.placeable.worldColor) : null,
        rect: piece.rect,
        roadRects: roadRuns(piece.placeable).map((run) =>
          offset(rotateRect(run, piece.rot), piece.pose.x, piece.pose.z),
        ),
      };
    });
    return {
      id: layout.id,
      title: layout.title,
      blurb: layout.blurb,
      bounds: this.bounds(resolved),
      tiles,
      trackPaths: resolved.paths,
      trackPieces: resolved.track.reduce((sum, track) => sum + track.run.pieces, 0),
      sets: [
        ...new Set(
          resolved.pieces.flatMap((piece) =>
            piece.placeable.kind === "model" ? [this.labelOf(piece.placeable)] : [],
          ),
        ),
      ],
      problems: resolved.problems,
    };
  }
}
