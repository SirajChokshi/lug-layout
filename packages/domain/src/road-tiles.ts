import { STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import { NO_TOP, type RoadSide, type RoadSurface } from "./road-joins.ts";

export type RoadShape = "dead-end" | "straight" | "curve" | "t-junction" | "crossroads";
export type RoadTileRefusal = "no-piece" | "other-family";

export interface RoadKitCandidate {
  readonly ref: number;
  readonly family: string;
  readonly surface: RoadSurface;
}

export interface RoadKitPiece {
  readonly ref: number;
  readonly arms: number;
  readonly shape: RoadShape;
}

export interface RoadEdgeRun {
  readonly road: boolean;
  readonly cells: number;
}

export interface RoadKit {
  readonly family: string;
  readonly profile: string;
  readonly tileLdu: number;
  readonly edgeTopSixteenths: number;
  readonly edgeRuns: ReadonlyArray<RoadEdgeRun>;
  readonly pieces: ReadonlyArray<RoadKitPiece>;
  readonly shapes: ReadonlyArray<RoadShape>;
}

export interface RoadPieceChoice {
  readonly ref: number;
  readonly rot: number;
  readonly arms: number;
}

export interface RoadTile {
  readonly ix: number;
  readonly iz: number;
}

export interface ExistingRoadTile {
  readonly arms: number;
  readonly sameKit: boolean;
}

export type PlannedRoadTile =
  | { readonly kind: "keep"; readonly ix: number; readonly iz: number; readonly arms: number }
  | {
      readonly kind: "lay";
      readonly ix: number;
      readonly iz: number;
      readonly arms: number;
      readonly replaces: boolean;
      readonly choices: ReadonlyArray<RoadPieceChoice>;
    }
  | { readonly kind: "remove"; readonly ix: number; readonly iz: number; readonly arms: number }
  | {
      readonly kind: "stranded";
      readonly ix: number;
      readonly iz: number;
      readonly arms: number;
      readonly junction: number;
    }
  | {
      readonly kind: "refuse";
      readonly ix: number;
      readonly iz: number;
      readonly arms: number;
      readonly reason: RoadTileRefusal;
    };

const QUARTER_TURNS = 4;
const ROAD_SHAPES: ReadonlyArray<RoadShape> = [
  "dead-end",
  "straight",
  "curve",
  "t-junction",
  "crossroads",
];
const SIDES: ReadonlyArray<readonly [RoadSide, number, number]> = [
  ["minX", -1, 0],
  ["maxX", 1, 0],
  ["minZ", 0, -1],
  ["maxZ", 0, 1],
];

export const ARM_BITS: Readonly<Record<RoadSide, number>> = {
  minX: 0b0001,
  maxX: 0b0010,
  minZ: 0b0100,
  maxZ: 0b1000,
};

export function armToward(dx: number, dz: number): number {
  for (const [side, sx, sz] of SIDES) {
    if (sx === dx && sz === dz) return ARM_BITS[side];
  }
  throw new Error(`(${dx}, ${dz}) is not a unit step along x or z`);
}

function armCount(arms: number): number {
  let count = 0;
  for (let bits = arms; bits !== 0; bits &= bits - 1) count++;
  return count;
}

export function rotateArms(arms: number, rot: number): number {
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  let rotated = 0;
  for (const [side, dx, dz] of SIDES) {
    if ((arms & ARM_BITS[side]) === 0) continue;
    rotated |= armToward(cos * dx + sin * dz, -sin * dx + cos * dz);
  }
  return rotated;
}

export function roadShape(arms: number): RoadShape {
  switch (armCount(arms)) {
    case 1:
      return "dead-end";
    case 2:
      return arms === (ARM_BITS.minX | ARM_BITS.maxX) || arms === (ARM_BITS.minZ | ARM_BITS.maxZ)
        ? "straight"
        : "curve";
    case 3:
      return "t-junction";
    case 4:
      return "crossroads";
    default:
      throw new Error(`arm mask ${arms} has no road arm`);
  }
}

function edgeCells(surface: RoadSurface, side: RoadSide): ReadonlyArray<number> {
  const { columns, rows } = surface;
  switch (side) {
    case "minX":
      return Array.from({ length: rows }, (_, row) => row * columns);
    case "maxX":
      return Array.from({ length: rows }, (_, row) => row * columns + columns - 1);
    case "minZ":
      return Array.from({ length: columns }, (_, column) => column);
    case "maxZ":
      return Array.from({ length: columns }, (_, column) => (rows - 1) * columns + column);
    default: {
      const unhandled: never = side;
      throw new Error(`unhandled side ${String(unhandled)}`);
    }
  }
}

function edgeProfile(surface: RoadSurface, side: RoadSide): ReadonlyArray<number> | null {
  const cells = edgeCells(surface, side);
  if (!cells.some((cell) => (surface.road[cell] ?? 0) !== 0)) return null;
  return cells;
}

function roadTopOf(surface: RoadSurface, cells: ReadonlyArray<number>): number {
  for (const cell of cells) {
    if ((surface.road[cell] ?? 0) !== 0) return surface.topSixteenths[cell] ?? NO_TOP;
  }
  return NO_TOP;
}

function profileKey(surface: RoadSurface, cells: ReadonlyArray<number>): string {
  const keys = cells.map(
    (cell) =>
      `${surface.topSixteenths[cell] ?? 0}:${surface.studSixteenths[cell] ?? 0}:${surface.road[cell] ?? 0}`,
  );
  const forward = keys.join(",");
  const backward = keys.map((_, index) => keys[keys.length - 1 - index] ?? "").join(",");
  return forward < backward ? forward : backward;
}

function edgeRuns(surface: RoadSurface, cells: ReadonlyArray<number>): ReadonlyArray<RoadEdgeRun> {
  const runs: RoadEdgeRun[] = [];
  for (const cell of cells) {
    const road = (surface.road[cell] ?? 0) !== 0;
    const last = runs.at(-1);
    if (last?.road === road) runs[runs.length - 1] = { road, cells: last.cells + 1 };
    else runs.push({ road, cells: 1 });
  }
  return runs;
}

function isCentredSquare(surface: RoadSurface): boolean {
  return (
    surface.columns === surface.rows &&
    surface.minX * 2 === -surface.columns * STUD_LDU &&
    surface.minZ * 2 === -surface.rows * STUD_LDU
  );
}

interface KitDraft {
  readonly family: string;
  readonly profile: string;
  readonly tileLdu: number;
  readonly edgeTopSixteenths: number;
  readonly edgeRuns: ReadonlyArray<RoadEdgeRun>;
  readonly pieces: RoadKitPiece[];
}

export function roadKits(candidates: ReadonlyArray<RoadKitCandidate>): ReadonlyArray<RoadKit> {
  const drafts = new Map<string, KitDraft>();
  for (const { ref, family, surface } of candidates) {
    if (!isCentredSquare(surface)) continue;
    let arms = 0;
    let profile: string | null = null;
    let runs: ReadonlyArray<RoadEdgeRun> = [];
    let edgeTop = NO_TOP;
    let uniform = true;
    for (const [side] of SIDES) {
      const cells = edgeProfile(surface, side);
      if (!cells) continue;
      arms |= ARM_BITS[side];
      const key = profileKey(surface, cells);
      if (profile !== null && key !== profile) uniform = false;
      profile = key;
      runs = edgeRuns(surface, cells);
      edgeTop = roadTopOf(surface, cells);
    }
    if (profile === null || !uniform) continue;
    const tileLdu = surface.columns * STUD_LDU;
    const key = `${family}|${tileLdu}|${profile}`;
    let draft = drafts.get(key);
    if (!draft) {
      draft = { family, profile, tileLdu, edgeTopSixteenths: edgeTop, edgeRuns: runs, pieces: [] };
      drafts.set(key, draft);
    }
    draft.pieces.push({ ref, arms, shape: roadShape(arms) });
  }
  return [...drafts.values()].map((draft) => ({
    ...draft,
    shapes: ROAD_SHAPES.filter((shape) => draft.pieces.some((piece) => piece.shape === shape)),
  }));
}

export function roadPieceChoices(
  kit: RoadKit,
  needed: number,
  preferredRot: number,
): ReadonlyArray<RoadPieceChoice> {
  const ranked: Array<RoadPieceChoice & { readonly extra: number; readonly order: number }> = [];
  kit.pieces.forEach((piece, pieceIndex) => {
    for (let turn = 0; turn < QUARTER_TURNS; turn++) {
      const rot = (preferredRot + turn) % QUARTER_TURNS;
      const arms = rotateArms(piece.arms, rot);
      if ((arms & needed) !== needed) continue;
      ranked.push({
        ref: piece.ref,
        rot,
        arms,
        extra: armCount(arms) - armCount(needed),
        order: pieceIndex * QUARTER_TURNS + turn,
      });
    }
  });
  ranked.sort((a, b) => a.extra - b.extra || a.order - b.order);
  return ranked.map(({ ref, rot, arms }) => ({ ref, rot, arms }));
}

function tileKey(ix: number, iz: number): string {
  return `${ix},${iz}`;
}

export function extendRoadPath(
  path: ReadonlyArray<RoadTile>,
  ix: number,
  iz: number,
): ReadonlyArray<RoadTile> {
  const last = path.at(-1);
  if (!last) return [{ ix, iz }];
  if (last.ix === ix && last.iz === iz) return path;
  const previous = path.at(-2);
  if (previous?.ix === ix && previous.iz === iz) return path.slice(0, -1);
  const extended = [...path];
  let x = last.ix;
  let z = last.iz;
  while (x !== ix || z !== iz) {
    if (Math.abs(ix - x) >= Math.abs(iz - z)) x += Math.sign(ix - x);
    else z += Math.sign(iz - z);
    extended.push({ ix: x, iz: z });
  }
  return extended;
}

export function planRoadTiles(
  kit: RoadKit,
  path: ReadonlyArray<RoadTile>,
  existingAt: (ix: number, iz: number) => ExistingRoadTile | null,
  preferredRot: number,
): ReadonlyArray<PlannedRoadTile> {
  const needed = new Map<string, RoadTile & { arms: number }>();
  const need = (ix: number, iz: number, arms: number): void => {
    const key = tileKey(ix, iz);
    const tile = needed.get(key);
    if (tile) tile.arms |= arms;
    else needed.set(key, { ix, iz, arms });
  };
  path.forEach((tile, index) => {
    need(tile.ix, tile.iz, 0);
    const next = path[index + 1];
    if (!next) return;
    need(tile.ix, tile.iz, armToward(next.ix - tile.ix, next.iz - tile.iz));
    need(next.ix, next.iz, armToward(tile.ix - next.ix, tile.iz - next.iz));
  });
  for (const tile of needed.values()) {
    const existing = existingAt(tile.ix, tile.iz);
    if (existing) tile.arms |= existing.arms;
    for (const [side, dx, dz] of SIDES) {
      const neighbour = existingAt(tile.ix + dx, tile.iz + dz);
      if (neighbour && (neighbour.arms & armToward(-dx, -dz)) !== 0) tile.arms |= ARM_BITS[side];
    }
  }
  return [...needed.values()].map(({ ix, iz, arms }): PlannedRoadTile => {
    const existing = existingAt(ix, iz);
    if (existing && existing.arms === arms) return { kind: "keep", ix, iz, arms };
    if (existing && !existing.sameKit)
      return { kind: "refuse", ix, iz, arms, reason: "other-family" };
    const choices = roadPieceChoices(kit, arms, preferredRot);
    if (choices.length === 0) return { kind: "refuse", ix, iz, arms, reason: "no-piece" };
    return { kind: "lay", ix, iz, arms, replaces: existing !== null, choices };
  });
}

const JUNCTION_ARMS = 3;

export function planRoadErase(
  kit: RoadKit,
  path: ReadonlyArray<RoadTile>,
  existingAt: (ix: number, iz: number) => ExistingRoadTile | null,
): ReadonlyArray<PlannedRoadTile> {
  const removed = new Map<string, RoadTile & { readonly arms: number }>();
  for (const { ix, iz } of path) {
    const existing = existingAt(ix, iz);
    if (existing?.sameKit) removed.set(tileKey(ix, iz), { ix, iz, arms: existing.arms });
  }
  const remaining = new Map<string, RoadTile & { readonly original: number; arms: number }>();
  for (const tile of removed.values()) {
    for (const [, dx, dz] of SIDES) {
      const ix = tile.ix + dx;
      const iz = tile.iz + dz;
      const key = tileKey(ix, iz);
      if (removed.has(key)) continue;
      const neighbour = existingAt(ix, iz);
      const facing = armToward(-dx, -dz);
      if (!neighbour?.sameKit || (neighbour.arms & facing) === 0) continue;
      if (armCount(neighbour.arms) < JUNCTION_ARMS) continue;
      const left = remaining.get(key) ?? { ix, iz, original: neighbour.arms, arms: neighbour.arms };
      left.arms &= ~facing;
      remaining.set(key, left);
    }
  }
  const planned: PlannedRoadTile[] = [...removed.values()].map(({ ix, iz, arms }) => ({
    kind: "remove",
    ix,
    iz,
    arms,
  }));
  for (const { ix, iz, original, arms } of remaining.values()) {
    const choices =
      arms === 0
        ? []
        : roadPieceChoices(kit, arms, 0).filter(
            (choice) => armCount(choice.arms) < armCount(original),
          );
    if (choices.length > 0) planned.push({ kind: "lay", ix, iz, arms, replaces: true, choices });
    else planned.push({ kind: "stranded", ix, iz, arms, junction: original });
  }
  return planned;
}
