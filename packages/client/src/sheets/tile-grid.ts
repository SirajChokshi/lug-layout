import { injectable } from "inversify";
import type { Box, Point } from "./draw-list.ts";
import type { PageSize } from "./paper.ts";

export interface TileNeighbours {
  readonly left: string | null;
  readonly right: string | null;
  readonly above: string | null;
  readonly below: string | null;
}

const LETTERS = 26;
const LETTER_A = 65;
const QUARTER = 0.25;
const THREE_QUARTERS = 0.75;

export function columnName(column: number): string {
  let name = "";
  for (let rest = column + 1; rest > 0; rest = Math.floor((rest - 1) / LETTERS)) {
    name = String.fromCharCode(LETTER_A + ((rest - 1) % LETTERS)) + name;
  }
  return name;
}

export class TileGrid {
  constructor(
    readonly columns: number,
    readonly rows: number,
    readonly windowSize: PageSize,
    readonly overlapMm: number,
    readonly origin: Point,
  ) {}

  get count(): number {
    return this.columns * this.rows;
  }

  get stepX(): number {
    return this.windowSize.widthMm - this.overlapMm;
  }

  get stepY(): number {
    return this.windowSize.heightMm - this.overlapMm;
  }

  get covered(): Box {
    return {
      x: this.origin[0],
      y: this.origin[1],
      width: (this.columns - 1) * this.stepX + this.windowSize.widthMm,
      height: (this.rows - 1) * this.stepY + this.windowSize.heightMm,
    };
  }

  name(column: number, row: number): string {
    return `${columnName(column)}${row + 1}`;
  }

  window(column: number, row: number): Box {
    return {
      x: this.origin[0] + column * this.stepX,
      y: this.origin[1] + row * this.stepY,
      width: this.windowSize.widthMm,
      height: this.windowSize.heightMm,
    };
  }

  seamX(index: number): number {
    return this.origin[0] + index * this.stepX + this.overlapMm / 2;
  }

  seamY(index: number): number {
    return this.origin[1] + index * this.stepY + this.overlapMm / 2;
  }

  seamsX(): ReadonlyArray<number> {
    return Array.from({ length: this.columns - 1 }, (_, i) => this.seamX(i + 1));
  }

  seamsY(): ReadonlyArray<number> {
    return Array.from({ length: this.rows - 1 }, (_, i) => this.seamY(i + 1));
  }

  cell(column: number, row: number): Box {
    const covered = this.covered;
    const left = column === 0 ? covered.x : this.seamX(column);
    const right = column === this.columns - 1 ? covered.x + covered.width : this.seamX(column + 1);
    const top = row === 0 ? covered.y : this.seamY(row);
    const bottom = row === this.rows - 1 ? covered.y + covered.height : this.seamY(row + 1);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  neighbours(column: number, row: number): TileNeighbours {
    return {
      left: column > 0 ? this.name(column - 1, row) : null,
      right: column < this.columns - 1 ? this.name(column + 1, row) : null,
      above: row > 0 ? this.name(column, row - 1) : null,
      below: row < this.rows - 1 ? this.name(column, row + 1) : null,
    };
  }

  marks(): ReadonlyArray<Point> {
    const marks: Point[] = [];
    for (let row = 0; row < this.rows; row++) {
      for (let column = 1; column < this.columns; column++) {
        const cell = this.cell(column, row);
        const x = this.seamX(column);
        marks.push([x, cell.y + cell.height * QUARTER], [x, cell.y + cell.height * THREE_QUARTERS]);
      }
    }
    for (let column = 0; column < this.columns; column++) {
      for (let row = 1; row < this.rows; row++) {
        const cell = this.cell(column, row);
        const y = this.seamY(row);
        marks.push([cell.x + cell.width * QUARTER, y], [cell.x + cell.width * THREE_QUARTERS, y]);
      }
    }
    for (let column = 1; column < this.columns; column++) {
      for (let row = 1; row < this.rows; row++) marks.push([this.seamX(column), this.seamY(row)]);
    }
    return marks;
  }
}

export interface ISheetTiler {
  tile(extent: Box, windowSize: PageSize, overlapMm: number): TileGrid;
}

const MICROMETRES_PER_MM = 1000;

function micrometres(mm: number): number {
  return Math.round(mm * MICROMETRES_PER_MM);
}

function tilesAlong(extentMm: number, windowMm: number, overlapMm: number): number {
  const extent = micrometres(extentMm);
  const window = micrometres(windowMm);
  const overlap = micrometres(overlapMm);
  if (extent <= window) return 1;
  return Math.ceil((extent - overlap) / (window - overlap));
}

@injectable()
export class SheetTiler implements ISheetTiler {
  tile(extent: Box, windowSize: PageSize, overlapMm: number): TileGrid {
    if (!(overlapMm >= 0) || overlapMm * 2 >= Math.min(windowSize.widthMm, windowSize.heightMm)) {
      throw new RangeError(
        `a ${overlapMm} mm overlap doesn't fit a ${windowSize.widthMm} × ${windowSize.heightMm} mm window`,
      );
    }
    const columns = tilesAlong(extent.width, windowSize.widthMm, overlapMm);
    const rows = tilesAlong(extent.height, windowSize.heightMm, overlapMm);
    const coveredWidth = (columns - 1) * (windowSize.widthMm - overlapMm) + windowSize.widthMm;
    const coveredHeight = (rows - 1) * (windowSize.heightMm - overlapMm) + windowSize.heightMm;
    return new TileGrid(columns, rows, windowSize, overlapMm, [
      extent.x - (coveredWidth - extent.width) / 2,
      extent.y - (coveredHeight - extent.height) / 2,
    ]);
  }
}
