import { rectsOverlap, type LduRect } from "@brr/domain";
import { CHUNK_LDU, STUD_LDU } from "@brr/math";
import type { GuideSegment } from "@brr/render";
import { areaText, placedBox, type LabelView } from "./layout-guides.ts";
import type { LocalBox } from "./local-box.ts";

export const MAX_FILL_TILES = 256;

export interface FillTile {
  readonly x: number;
  readonly z: number;
  readonly rect: LduRect;
  readonly taken: boolean;
}

export interface FillPlan {
  readonly rect: LduRect;
  readonly columns: number;
  readonly rows: number;
  readonly tiles: ReadonlyArray<FillTile>;
}

export interface FillOptions {
  readonly box: LocalBox;
  readonly rot: number;
  readonly taken: (rect: LduRect, x: number, z: number) => boolean;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? Math.abs(a) : greatestCommonDivisor(b, a % b);
}

export function fillAnchorLdu(tileWidth: number, tileDepth: number): number {
  return Math.max(
    STUD_LDU,
    greatestCommonDivisor(greatestCommonDivisor(tileWidth, tileDepth), CHUNK_LDU),
  );
}

function snapUp(ldu: number, step: number): number {
  return Math.ceil(ldu / step) * step + 0;
}

interface TileFrame {
  readonly width: number;
  readonly depth: number;
  readonly pivotX: number;
  readonly pivotZ: number;
  readonly anchor: number;
}

function tileFrame(box: LocalBox, rot: number): TileFrame {
  const turned = placedBox(box, 0, 0, 0, rot);
  const width = turned.maxX - turned.minX;
  const depth = turned.maxZ - turned.minZ;
  return {
    width,
    depth,
    pivotX: -turned.minX,
    pivotZ: -turned.minZ,
    anchor: fillAnchorLdu(width, depth),
  };
}

function tiled(
  frame: TileFrame,
  minX: number,
  minZ: number,
  columns: number,
  rows: number,
  taken: FillOptions["taken"],
): FillPlan {
  const tiles: FillTile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const rect = {
        minX: minX + column * frame.width,
        minZ: minZ + row * frame.depth,
        maxX: minX + (column + 1) * frame.width,
        maxZ: minZ + (row + 1) * frame.depth,
      };
      const x = rect.minX + frame.pivotX;
      const z = rect.minZ + frame.pivotZ;
      tiles.push({ x, z, rect, taken: taken(rect, x, z) });
    }
  }
  return {
    rect: {
      minX,
      minZ,
      maxX: minX + columns * frame.width,
      maxZ: minZ + rows * frame.depth,
    },
    columns,
    rows,
    tiles,
  };
}

function span(start: number, end: number, size: number): readonly [number, number] {
  const count = Math.max(1, Math.ceil(Math.abs(end - start) / size));
  return [end < start ? start - count * size : start, count];
}

export function dragFill(
  options: FillOptions,
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
): FillPlan {
  const frame = tileFrame(options.box, options.rot);
  const anchorX = Math.round(startX / frame.anchor) * frame.anchor + 0;
  const anchorZ = Math.round(startZ / frame.anchor) * frame.anchor + 0;
  const [minX, columns] = span(anchorX, endX, frame.width);
  const [minZ, rows] = span(anchorZ, endZ, frame.depth);
  return tiled(frame, minX, minZ, columns, rows, options.taken);
}

export function packedFill(options: FillOptions, area: LduRect): ReadonlyArray<FillTile> {
  const frame = tileFrame(options.box, options.rot);
  const chosen: FillTile[] = [];
  for (let z = snapUp(area.minZ, frame.anchor); z + frame.depth <= area.maxZ; z += frame.anchor) {
    for (let x = snapUp(area.minX, frame.anchor); x + frame.width <= area.maxX; x += frame.anchor) {
      const rect = { minX: x, minZ: z, maxX: x + frame.width, maxZ: z + frame.depth };
      if (chosen.some((tile) => rectsOverlap(tile.rect, rect))) continue;
      const tileX = x + frame.pivotX;
      const tileZ = z + frame.pivotZ;
      if (options.taken(rect, tileX, tileZ)) continue;
      chosen.push({ x: tileX, z: tileZ, rect, taken: false });
    }
  }
  return chosen;
}

export function takenByFirstLayer(footprints: ReadonlyArray<LduRect>): (rect: LduRect) => boolean {
  return (rect) => footprints.some((footprint) => rectsOverlap(rect, footprint));
}

export function fillCounts(tiles: ReadonlyArray<FillTile>): {
  readonly free: number;
  readonly taken: number;
} {
  let taken = 0;
  for (const tile of tiles) if (tile.taken) taken++;
  return { free: tiles.length - taken, taken };
}

function outline(rect: LduRect, y: number, kind: GuideSegment["kind"]): GuideSegment[] {
  const { minX, minZ, maxX, maxZ } = rect;
  return [
    { kind, ax: minX, ay: y, az: minZ, bx: maxX, by: y, bz: minZ },
    { kind, ax: maxX, ay: y, az: minZ, bx: maxX, by: y, bz: maxZ },
    { kind, ax: maxX, ay: y, az: maxZ, bx: minX, by: y, bz: maxZ },
    { kind, ax: minX, ay: y, az: maxZ, bx: minX, by: y, bz: minZ },
  ];
}

function crossed(rect: LduRect, y: number): GuideSegment[] {
  const { minX, minZ, maxX, maxZ } = rect;
  return [
    ...outline(rect, y, "blocked"),
    { kind: "blocked", ax: minX, ay: y, az: minZ, bx: maxX, by: y, bz: maxZ },
    { kind: "blocked", ax: maxX, ay: y, az: minZ, bx: minX, by: y, bz: maxZ },
  ];
}

export function fillGuides(plan: FillPlan, y: number): GuideSegment[] {
  return plan.tiles.flatMap((tile) =>
    tile.taken ? crossed(tile.rect, y) : outline(tile.rect, y, "draft"),
  );
}

export function fillLabel(plan: FillPlan, y: number): LabelView {
  const { free, taken } = fillCounts(plan.tiles);
  const { rect } = plan;
  const plates = `${plan.columns} × ${plan.rows} plates`;
  const counts = taken > 0 ? `${free} new, ${taken} occupied` : `${free} new`;
  return {
    id: "fill",
    kind: "draft",
    text: `${plates} · ${areaText(rect.maxX - rect.minX, rect.maxZ - rect.minZ)} · ${counts}`,
    x: (rect.minX + rect.maxX) / 2,
    y,
    z: rect.minZ,
  };
}
