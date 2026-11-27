import type { TableTop } from "@brr/domain";
import { rgb, type Paint, type Rgb } from "./draw-list.ts";
import { PAINTS } from "./sheet-paints.ts";

const OKABE_ITO: ReadonlyArray<Rgb> = [
  rgb("#e69f00"),
  rgb("#56b4e9"),
  rgb("#009e73"),
  rgb("#f0e442"),
  rgb("#0072b2"),
  rgb("#d55e00"),
  rgb("#cc79a7"),
  rgb("#999999"),
];

const TINT_OPACITY = 0.55;

export class TableHeights {
  readonly heightsMm: ReadonlyArray<number>;

  constructor(tables: ReadonlyArray<TableTop>) {
    this.heightsMm = [...new Set(tables.map((table) => table.heightMm))].toSorted((a, b) => a - b);
  }

  colorOf(heightMm: number): Rgb {
    const index = this.heightsMm.indexOf(heightMm);
    if (index < 0) throw new Error(`no table is ${heightMm} mm high`);
    const color = OKABE_ITO[index % OKABE_ITO.length];
    if (!color) throw new Error("the height palette is empty");
    return color;
  }

  paintOf(heightMm: number): Paint {
    return { ...PAINTS.table, fill: this.colorOf(heightMm), fillOpacity: TINT_OPACITY };
  }
}
