import type { LduRect, PlacementRequest } from "@brr/domain";
import { CHUNK_STUDS, STUD_LDU } from "@brr/math";
import { GUIDE_GRID_STUDS, type GuideKind, type GuideSegment } from "@brr/render";
import type { LocalBox } from "./local-box.ts";
import { posedBox } from "./placed-chunks.ts";
import { areaText, type LabelView } from "./size-labels.ts";

export const DEFAULT_FILL_GRID_STUDS = GUIDE_GRID_STUDS;
const FILL_GRID_STUDS: ReadonlyArray<number> = [
  DEFAULT_FILL_GRID_STUDS,
  CHUNK_STUDS / 2,
  CHUNK_STUDS,
];
export const MAX_FILL_TILES = 1024;

export function nextFillGrid(studs: number): number {
  const at = FILL_GRID_STUDS.indexOf(studs);
  return FILL_GRID_STUDS[(at + 1) % FILL_GRID_STUDS.length] ?? DEFAULT_FILL_GRID_STUDS;
}

export interface FillView {
  readonly wanted: number;
  readonly refused: number;
  readonly overLimit: boolean;
}

interface TileFrame {
  readonly pitchX: number;
  readonly pitchZ: number;
  readonly offsetX: number;
  readonly offsetZ: number;
}

interface TileGrid {
  readonly cornerX: number;
  readonly cornerZ: number;
  readonly columns: number;
  readonly rows: number;
}

const FILL_LABEL_ID = "fill";
const NO_GRIDS: ReadonlyArray<TileGrid> = [];

function latticeCeil(ldu: number): number {
  return Math.ceil(ldu / STUD_LDU) * STUD_LDU + 0;
}

function gridRound(ldu: number, gridLdu: number): number {
  return Math.round(ldu / gridLdu) * gridLdu + 0;
}

function gridCeil(ldu: number, gridLdu: number): number {
  return Math.ceil(ldu / gridLdu) * gridLdu + 0;
}

function pitchOf(reach: number, gridLdu: number): number {
  return Math.max(1, Math.ceil(reach / gridLdu)) * gridLdu;
}

function tileFrame(box: LocalBox, rot: number, gridLdu: number): TileFrame {
  const turned = posedBox(box, 0, 0, 0, rot);
  const offsetX = latticeCeil(-turned.minX);
  const offsetZ = latticeCeil(-turned.minZ);
  return {
    pitchX: pitchOf(offsetX + turned.maxX, gridLdu),
    pitchZ: pitchOf(offsetZ + turned.maxZ, gridLdu),
    offsetX,
    offsetZ,
  };
}

function span(anchor: number, end: number, pitch: number): readonly [number, number] {
  const count = Math.max(1, Math.ceil(Math.abs(end - anchor) / pitch));
  return [end < anchor ? anchor - count * pitch : anchor, count];
}

function sameGrid(a: TileGrid | undefined, b: TileGrid): boolean {
  return (
    a !== undefined &&
    a.cornerX === b.cornerX &&
    a.cornerZ === b.cornerZ &&
    a.columns === b.columns &&
    a.rows === b.rows
  );
}

function segment(
  kind: GuideKind,
  y: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): GuideSegment {
  return { kind, ax, ay: y, az, bx, by: y, bz };
}

export class FillTool {
  private readonly tileX = new Int32Array(MAX_FILL_TILES);
  private readonly tileZ = new Int32Array(MAX_FILL_TILES);
  private readonly tileY = new Int16Array(MAX_FILL_TILES);
  private readonly refusedAt = new Uint8Array(MAX_FILL_TILES);
  private frame: TileFrame | null = null;
  private grids: ReadonlyArray<TileGrid> = NO_GRIDS;
  private wantedTiles = 0;
  private laidTiles = 0;
  private refusedTiles = 0;
  private pressX = 0;
  private pressZ = 0;
  private endX = 0;
  private endZ = 0;
  private anchorX = 0;
  private anchorZ = 0;
  private dragging = false;
  private moved = false;
  private dropped = false;

  constructor(private readonly y: number) {}

  get drafting(): boolean {
    return this.dragging;
  }

  get previewing(): boolean {
    return this.dragging && this.moved && !this.dropped;
  }

  get cancelled(): boolean {
    return this.dropped;
  }

  get laid(): number {
    return this.laidTiles;
  }

  get wanted(): number {
    return this.wantedTiles;
  }

  get refused(): number {
    return this.refusedTiles;
  }

  get overLimit(): boolean {
    return this.wantedTiles > MAX_FILL_TILES;
  }

  xAt(tile: number): number {
    return this.tileX[tile] ?? 0;
  }

  zAt(tile: number): number {
    return this.tileZ[tile] ?? 0;
  }

  begin(box: LocalBox, rot: number, gridLdu: number, x: number, z: number): void {
    this.pressX = x;
    this.pressZ = z;
    this.endX = x;
    this.endZ = z;
    this.dragging = true;
    this.moved = false;
    this.dropped = false;
    this.reframe(box, rot, gridLdu);
  }

  reframe(box: LocalBox, rot: number, gridLdu: number): boolean {
    this.frame = tileFrame(box, rot, gridLdu);
    this.anchorX = gridRound(this.pressX, gridLdu);
    this.anchorZ = gridRound(this.pressZ, gridLdu);
    this.clear();
    return this.relayout();
  }

  drag(x: number, z: number): boolean {
    if (!this.dragging || this.dropped) return false;
    this.endX = x;
    this.endZ = z;
    if (!this.moved) {
      const sameStud =
        Math.round(x / STUD_LDU) === Math.round(this.pressX / STUD_LDU) &&
        Math.round(z / STUD_LDU) === Math.round(this.pressZ / STUD_LDU);
      if (sameStud) return false;
      this.moved = true;
    }
    return this.relayout();
  }

  end(): void {
    this.dragging = false;
  }

  cancel(): void {
    this.dropped = this.dragging;
    this.moved = false;
    this.clear();
  }

  layTables(box: LocalBox, rot: number, gridLdu: number, tables: ReadonlyArray<LduRect>): void {
    const frame = tileFrame(box, rot, gridLdu);
    this.frame = frame;
    this.dragging = false;
    this.moved = false;
    this.dropped = false;
    this.clear();
    const grids: TileGrid[] = [];
    for (const table of tables) {
      const cornerX = gridCeil(table.minX, gridLdu);
      const cornerZ = gridCeil(table.minZ, gridLdu);
      const columns = Math.floor((table.maxX - cornerX) / frame.pitchX);
      const rows = Math.floor((table.maxZ - cornerZ) / frame.pitchZ);
      if (columns <= 0 || rows <= 0) continue;
      const grid = { cornerX, cornerZ, columns, rows };
      grids.push(grid);
      this.lay(frame, grid);
    }
    this.grids = grids;
  }

  settle(tile: number, yPlates: number, refused: boolean): void {
    this.tileY[tile] = yPlates;
    const was = this.refusedAt[tile] === 1;
    this.refusedAt[tile] = refused ? 1 : 0;
    this.refusedTiles += (refused ? 1 : 0) - (was ? 1 : 0);
  }

  requests(refId: number, colorId: number, rot: number): PlacementRequest[] {
    const requests: PlacementRequest[] = [];
    if (this.overLimit) return requests;
    for (let tile = 0; tile < this.laidTiles; tile++) {
      if (this.refusedAt[tile] === 1) continue;
      requests.push({
        placement: null,
        to: {
          refId,
          colorId,
          x: this.tileX[tile] ?? 0,
          z: this.tileZ[tile] ?? 0,
          yPlates: this.tileY[tile] ?? 0,
          rot,
        },
      });
    }
    return requests;
  }

  view(): FillView {
    return { wanted: this.wantedTiles, refused: this.refusedTiles, overLimit: this.overLimit };
  }

  guides(out: GuideSegment[]): void {
    const frame = this.frame;
    const { y } = this;
    if (!this.previewing || !frame) return;
    const over = this.overLimit;
    for (const grid of this.grids) {
      const minX = grid.cornerX;
      const minZ = grid.cornerZ;
      const maxX = minX + grid.columns * frame.pitchX;
      const maxZ = minZ + grid.rows * frame.pitchZ;
      const kind: GuideKind = over ? "refused" : "draft";
      const columnLines = over ? 1 : grid.columns;
      const rowLines = over ? 1 : grid.rows;
      for (let c = 0; c <= columnLines; c++) {
        const x = c === columnLines ? maxX : minX + c * frame.pitchX;
        out.push(segment(kind, y, x, minZ, x, maxZ));
      }
      for (let r = 0; r <= rowLines; r++) {
        const z = r === rowLines ? maxZ : minZ + r * frame.pitchZ;
        out.push(segment(kind, y, minX, z, maxX, z));
      }
    }
    if (over) return;
    for (let tile = 0; tile < this.laidTiles; tile++) {
      if (this.refusedAt[tile] !== 1) continue;
      const minX = (this.tileX[tile] ?? 0) - frame.offsetX;
      const minZ = (this.tileZ[tile] ?? 0) - frame.offsetZ;
      const maxX = minX + frame.pitchX;
      const maxZ = minZ + frame.pitchZ;
      out.push(
        segment("refused", y, minX, minZ, maxX, maxZ),
        segment("refused", y, maxX, minZ, minX, maxZ),
      );
    }
  }

  label(): LabelView | null {
    const frame = this.frame;
    const grid = this.grids[0];
    if (!this.previewing || !frame || !grid) return null;
    const width = grid.columns * frame.pitchX;
    const depth = grid.rows * frame.pitchZ;
    const counts = this.overLimit
      ? `${this.wantedTiles} tiles, at most ${MAX_FILL_TILES} in one fill`
      : `${this.laidTiles - this.refusedTiles} to place${this.refusedTiles > 0 ? `, ${this.refusedTiles} refused` : ""}`;
    return {
      id: FILL_LABEL_ID,
      kind: "draft",
      text: `${grid.columns} × ${grid.rows} · ${areaText(width, depth)} · ${counts}`,
      x: grid.cornerX + width / 2,
      y: this.y,
      z: grid.cornerZ + depth / 2,
    };
  }

  private relayout(): boolean {
    const frame = this.frame;
    if (!this.moved || !frame) return false;
    const [cornerX, columns] = span(this.anchorX, this.endX, frame.pitchX);
    const [cornerZ, rows] = span(this.anchorZ, this.endZ, frame.pitchZ);
    const grid = { cornerX, cornerZ, columns, rows };
    if (sameGrid(this.grids[0], grid)) return false;
    this.clear();
    this.grids = [grid];
    this.lay(frame, grid);
    return true;
  }

  private clear(): void {
    this.grids = NO_GRIDS;
    this.wantedTiles = 0;
    this.laidTiles = 0;
    this.refusedTiles = 0;
  }

  private lay(frame: TileFrame, grid: TileGrid): void {
    this.wantedTiles += grid.columns * grid.rows;
    for (let row = 0; row < grid.rows; row++) {
      for (let column = 0; column < grid.columns; column++) {
        const tile = this.laidTiles;
        if (tile >= MAX_FILL_TILES) return;
        this.tileX[tile] = grid.cornerX + column * frame.pitchX + frame.offsetX;
        this.tileZ[tile] = grid.cornerZ + row * frame.pitchZ + frame.offsetZ;
        this.tileY[tile] = 0;
        this.refusedAt[tile] = 0;
        this.laidTiles = tile + 1;
      }
    }
  }
}
