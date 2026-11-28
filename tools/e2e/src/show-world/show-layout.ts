import { STUD_LDU } from "@brr/math";
import { SeededRandom } from "../held-out/generator.ts";

export interface ShowSpec {
  readonly tableRows: number;
  readonly tablesPerRow: number;
  readonly tableWidthStuds: number;
  readonly tableDepthStuds: number;
  readonly aisleStuds: number;
  readonly models: number;
  readonly roadPlates: number;
  readonly trackPieces: number;
  readonly sidingsPerOval: number;
  readonly contributors: number;
}

const TABLE = { tableWidthStuds: 192, tableDepthStuds: 96, aisleStuds: 128 };

export const SHOW_SCALES: Readonly<Record<string, ShowSpec>> = {
  show: {
    ...TABLE,
    tableRows: 10,
    tablesPerRow: 12,
    models: 250,
    roadPlates: 400,
    trackPieces: 2500,
    sidingsPerOval: 3,
    contributors: 30,
  },
  smoke: {
    ...TABLE,
    tableRows: 1,
    tablesPerRow: 4,
    models: 3,
    roadPlates: 6,
    trackPieces: 90,
    sidingsPerOval: 1,
    contributors: 2,
  },
};

export interface Point {
  readonly x: number;
  readonly z: number;
}

export interface Rect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export interface Cell {
  readonly row: number;
  readonly band: number;
  readonly column: number;
}

export interface CellRun {
  readonly row: number;
  readonly band: number;
  readonly fromColumn: number;
  readonly columns: number;
}

export interface TrackKit {
  readonly straightLdu: number;
  readonly curvesPerHalfTurn: number;
  readonly halfTurnOffsetLdu: number;
  readonly halfTurnReachLdu: number;
}

export interface OvalPlan {
  readonly row: number;
  readonly westX: number;
  readonly eastX: number;
  readonly laneZ: number;
  readonly returnZ: number;
  readonly sidingStarts: ReadonlyArray<number>;
}

export interface EditSites {
  readonly freePair: CellRun;
  readonly trackRun: CellRun;
}

export interface RowPlan {
  readonly row: number;
  readonly oval: OvalPlan;
  readonly support: ReadonlyArray<CellRun>;
  readonly road: CellRun | null;
  readonly edits: EditSites | null;
  readonly modelCandidates: ReadonlyArray<Cell>;
  readonly models: number;
}

type CellUse = "support" | "interior" | "outside";

const CONTRIBUTOR_DIGITS = 2;
const SIDING_LEAD_FRACTION = 4;
const FREE_PAIR_CELLS = 2;
const TRACK_EDIT_CELLS = 3;

function share(total: number, parts: number, index: number): number {
  return Math.floor((total * (index + 1)) / parts) - Math.floor((total * index) / parts);
}

function latticeFloor(ldu: number): number {
  return Math.floor(ldu / STUD_LDU) * STUD_LDU + 0;
}

function overlaps(fromA: number, toA: number, fromB: number, toB: number): boolean {
  return fromA < toB && fromB < toA;
}

export function inRun(run: CellRun, cell: Cell): boolean {
  return (
    run.row === cell.row &&
    run.band === cell.band &&
    cell.column >= run.fromColumn &&
    cell.column < run.fromColumn + run.columns
  );
}

export class ShowLayout {
  private readonly bands: number;
  private readonly columns: number;
  private readonly rowLength: number;
  private readonly depth: number;
  private readonly pitch: number;

  constructor(
    private readonly spec: ShowSpec,
    readonly cellLdu: number,
    private readonly kit: TrackKit,
    private readonly seed: number,
  ) {
    this.rowLength = spec.tablesPerRow * spec.tableWidthStuds * STUD_LDU;
    this.depth = spec.tableDepthStuds * STUD_LDU;
    this.pitch = this.depth + spec.aisleStuds * STUD_LDU;
    this.bands = this.depth / cellLdu;
    this.columns = this.rowLength / cellLdu;
    if (!Number.isInteger(this.bands) || !Number.isInteger(this.columns)) {
      throw new Error(
        `a ${spec.tableWidthStuds} × ${spec.tableDepthStuds} stud table holds no whole number of ${cellLdu / STUD_LDU}-stud cells`,
      );
    }
  }

  contributors(): ReadonlyArray<string> {
    return Array.from(
      { length: this.spec.contributors },
      (_, index) =>
        `Show contributor ${String(index + 1).padStart(CONTRIBUTOR_DIGITS, "0")} (seed ${this.seed})`,
    );
  }

  tables(): ReadonlyArray<Rect> {
    const tables: Rect[] = [];
    const width = this.spec.tableWidthStuds * STUD_LDU;
    for (let row = 0; row < this.spec.tableRows; row++) {
      const minZ = row * this.pitch;
      for (let table = 0; table < this.spec.tablesPerRow; table++) {
        tables.push({
          minX: table * width,
          minZ,
          maxX: (table + 1) * width,
          maxZ: minZ + this.depth,
        });
      }
    }
    return tables;
  }

  rowRect(row: number): Rect {
    const minZ = row * this.pitch;
    return { minX: 0, minZ, maxX: this.rowLength, maxZ: minZ + this.depth };
  }

  cellRect(cell: Cell): Rect {
    const minX = cell.column * this.cellLdu;
    const minZ = cell.row * this.pitch + cell.band * this.cellLdu;
    return { minX, minZ, maxX: minX + this.cellLdu, maxZ: minZ + this.cellLdu };
  }

  runRect(run: CellRun): Rect {
    const first = this.cellRect({ row: run.row, band: run.band, column: run.fromColumn });
    return { ...first, maxX: first.minX + run.columns * this.cellLdu };
  }

  rows(): ReadonlyArray<RowPlan> {
    const random = new SeededRandom(this.seed);
    return Array.from({ length: this.spec.tableRows }, (_, row) => this.rowPlan(row, random));
  }

  private oval(row: number): OvalPlan {
    const { straightLdu, curvesPerHalfTurn, halfTurnOffsetLdu, halfTurnReachLdu } = this.kit;
    const piecesPerOval = share(this.spec.trackPieces, this.spec.tableRows, row);
    const straightsPerSide = Math.floor((piecesPerOval - 2 * curvesPerHalfTurn) / 2);
    const laneLength = straightsPerSide * straightLdu;
    const extent = laneLength + 2 * halfTurnReachLdu;
    const offset = Math.abs(halfTurnOffsetLdu);
    if (straightsPerSide <= 0 || extent > this.rowLength || offset > this.depth) {
      throw new Error(
        `an oval of ${piecesPerOval} pieces, ${extent} × ${offset} LDU, doesn't fit a ${this.rowLength} × ${this.depth} LDU table row`,
      );
    }
    const rect = this.rowRect(row);
    const westX = latticeFloor((this.rowLength - laneLength) / 2);
    const inset = latticeFloor((this.depth - offset) / 2);
    const laneZ = halfTurnOffsetLdu < 0 ? rect.maxZ - inset : rect.minZ + inset;
    const sidings = this.spec.sidingsPerOval;
    const spacing = laneLength / Math.max(1, sidings);
    return {
      row,
      westX,
      eastX: westX + laneLength,
      laneZ,
      returnZ: laneZ + halfTurnOffsetLdu,
      sidingStarts: Array.from({ length: sidings }, (_, index) =>
        latticeFloor(westX + index * spacing + spacing / SIDING_LEAD_FRACTION),
      ),
    };
  }

  private bandOf(row: number, z: number): number {
    return Math.floor((z - this.rowRect(row).minZ) / this.cellLdu);
  }

  private use(oval: OvalPlan, cell: Cell): CellUse {
    const { straightLdu, halfTurnReachLdu } = this.kit;
    const rect = this.cellRect(cell);
    const laneBand = this.bandOf(oval.row, oval.laneZ);
    const returnBand = this.bandOf(oval.row, oval.returnZ);
    const lowBand = Math.min(laneBand, returnBand);
    const highBand = Math.max(laneBand, returnBand);
    const westEdge = oval.westX - halfTurnReachLdu - straightLdu;
    const eastEdge = oval.eastX + halfTurnReachLdu + straightLdu;
    if (cell.band < lowBand || cell.band > highBand) return "outside";
    if (!overlaps(rect.minX, rect.maxX, westEdge, eastEdge)) return "outside";
    const between = cell.band > lowBand && cell.band < highBand;
    const inside = rect.minX >= oval.westX + straightLdu && rect.maxX <= oval.eastX - straightLdu;
    return between && inside ? "interior" : "support";
  }

  cellsOf(row: number): ReadonlyArray<Cell> {
    const cells: Cell[] = [];
    for (let band = 0; band < this.bands; band++) {
      for (let column = 0; column < this.columns; column++) cells.push({ row, band, column });
    }
    return cells;
  }

  private rowPlan(row: number, random: SeededRandom): RowPlan {
    const oval = this.oval(row);
    const cells = this.cellsOf(row);
    const of = (use: CellUse): Cell[] => cells.filter((cell) => this.use(oval, cell) === use);
    const interior = of("interior");
    const roadPlates = share(this.spec.roadPlates, this.spec.tableRows, row);
    const road = this.roadRun(row, interior, roadPlates);
    const edits =
      row === Math.floor(this.spec.tableRows / 2) ? this.editSites(row, interior, road) : null;
    const reserved = [road, edits?.freePair ?? null, edits?.trackRun ?? null];
    const free = (cell: Cell): boolean => !reserved.some((run) => run !== null && inRun(run, cell));
    return {
      row,
      oval,
      support: this.runsOf(of("support")),
      road,
      edits,
      modelCandidates: [
        ...random.shuffled(interior.filter(free)),
        ...random.shuffled(of("outside")),
      ],
      models: share(this.spec.models, this.spec.tableRows, row),
    };
  }

  private editSites(row: number, interior: ReadonlyArray<Cell>, road: CellRun | null): EditSites {
    const band = road?.band ?? interior[0]?.band ?? 0;
    const columns = new Set(
      interior.filter((cell) => cell.band === band).map((cell) => cell.column),
    );
    const from = road === null ? Math.min(...columns) : road.fromColumn + road.columns;
    const wanted = FREE_PAIR_CELLS + TRACK_EDIT_CELLS;
    for (let column = from; column < from + wanted; column++) {
      if (!columns.has(column)) {
        throw new Error(
          `table row ${row + 1} has no ${wanted} free cells inside its oval for the edit sites`,
        );
      }
    }
    return {
      freePair: { row, band, fromColumn: from, columns: FREE_PAIR_CELLS },
      trackRun: { row, band, fromColumn: from + FREE_PAIR_CELLS, columns: TRACK_EDIT_CELLS },
    };
  }

  private roadRun(row: number, interior: ReadonlyArray<Cell>, plates: number): CellRun | null {
    if (plates === 0) return null;
    const band = interior[0]?.band;
    const columns = interior.filter((cell) => cell.band === band).map((cell) => cell.column);
    const first = columns[0];
    if (band === undefined || first === undefined || columns.length < plates) {
      throw new Error(
        `table row ${row + 1} has ${columns.length} cells inside its oval for ${plates} road plates`,
      );
    }
    return {
      row,
      band,
      fromColumn: first + Math.floor((columns.length - plates) / 2),
      columns: plates,
    };
  }

  runsOf(cells: ReadonlyArray<Cell>): ReadonlyArray<CellRun> {
    const runs: CellRun[] = [];
    for (const cell of cells) {
      const last = runs.at(-1);
      if (
        last &&
        last.band === cell.band &&
        last.row === cell.row &&
        last.fromColumn + last.columns === cell.column
      ) {
        runs[runs.length - 1] = { ...last, columns: last.columns + 1 };
      } else {
        runs.push({ row: cell.row, band: cell.band, fromColumn: cell.column, columns: 1 });
      }
    }
    return runs;
  }
}
