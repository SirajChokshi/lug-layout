import type { BundleColor, PartAsset } from "@brr/catalog";
import { STUD_LDU } from "@brr/math";
import type { ColorTable } from "../scene/viewer-scene.ts";
import { brickPlaceable, type Placeable } from "./placeable.ts";

export type BrickShape = "brick" | "plate" | "tile" | "jumper";

export const BRICK_SHAPES: ReadonlyArray<BrickShape> = ["brick", "plate", "tile", "jumper"];

const BRICK_ROLES: ReadonlySet<string> = new Set(["wall", "roof", "detail", "brick"]);
const MATRIX_FLOATS = 12;
const PLATES_PER_BRICK = 3;

export function isBrickPart(part: { readonly role: string }): boolean {
  return BRICK_ROLES.has(part.role);
}

export interface BrickPart {
  readonly part: PartAsset;
  readonly partIndex: number;
  readonly shape: BrickShape;
  readonly heightPlates: number;
  readonly studsWide: number;
  readonly studsDeep: number;
  readonly colors: ReadonlyArray<BundleColor>;
}

function studsOffSeat(part: PartAsset, phaseX: number, phaseZ: number): boolean {
  for (let o = 0; o < part.studMatrices.length; o += MATRIX_FLOATS) {
    const x = part.studMatrices[o + 3] ?? 0;
    const z = part.studMatrices[o + 11] ?? 0;
    const offX = (((x - phaseX) % STUD_LDU) + STUD_LDU) % STUD_LDU;
    const offZ = (((z - phaseZ) % STUD_LDU) + STUD_LDU) % STUD_LDU;
    if (offX !== 0 || offZ !== 0) return true;
  }
  return false;
}

function shapeOf(part: PartAsset, heightPlates: number): BrickShape {
  const seat = part.seat;
  if (seat && studsOffSeat(part, seat.phaseX, seat.phaseZ)) return "jumper";
  if (part.studMatrices.length === 0) return "tile";
  return heightPlates >= PLATES_PER_BRICK ? "brick" : "plate";
}

function heightOf(part: PartAsset): number {
  let top = 0;
  for (const plates of part.seat?.cells.columnTop ?? []) top = Math.max(top, plates);
  return top;
}

export interface UnseatedPart {
  readonly id: string;
  readonly title: string;
}

export class BrickCatalog {
  readonly parts: ReadonlyArray<BrickPart>;
  readonly unseated: ReadonlyArray<UnseatedPart>;
  private readonly placeables = new Map<string, Placeable>();

  constructor(
    candidates: ReadonlyArray<{ readonly part: PartAsset; readonly partIndex: number }>,
    bundleColors: ReadonlyArray<BundleColor>,
    private readonly allParts: ReadonlyArray<PartAsset>,
    private readonly colors: ColorTable,
    private readonly tableY: number,
  ) {
    const parts: BrickPart[] = [];
    const unseated: UnseatedPart[] = [];
    for (const { part, partIndex } of candidates) {
      const seat = part.seat;
      if (!seat || part.producedColors.length === 0) {
        unseated.push({ id: part.id.replace("ldraw:", ""), title: part.title });
        continue;
      }
      const heightPlates = heightOf(part);
      parts.push({
        part,
        partIndex,
        shape: shapeOf(part, heightPlates),
        heightPlates,
        studsWide: seat.cells.width,
        studsDeep: seat.cells.depth,
        colors: part.producedColors.map((code) => {
          const color = bundleColors.find((c) => c.code === code);
          if (!color)
            throw new Error(`${part.id} is produced in colour ${code}, which LDConfig lacks`);
          colors.indexOfCode(code);
          return color;
        }),
      });
    }
    this.parts = parts.toSorted(
      (a, b) =>
        BRICK_SHAPES.indexOf(a.shape) - BRICK_SHAPES.indexOf(b.shape) ||
        a.studsWide * a.studsDeep - b.studsWide * b.studsDeep ||
        a.studsWide - b.studsWide,
    );
    this.unseated = unseated;
  }

  find(partId: string): BrickPart | null {
    return this.parts.find((brick) => brick.part.id === partId) ?? null;
  }

  colorFor(brick: BrickPart, wanted: number | null): BundleColor {
    const color = brick.colors.find((c) => c.code === wanted) ?? brick.colors[0];
    if (!color) throw new Error(`${brick.part.id} has no produced colour`);
    return color;
  }

  placeable(brick: BrickPart, color: BundleColor): Placeable {
    const key = `${brick.part.id}@${color.code}`;
    const known = this.placeables.get(key);
    if (known) return known;
    const made = brickPlaceable(
      brick.part,
      brick.partIndex,
      color.code,
      color.name.replaceAll("_", " "),
      this.allParts,
      this.colors,
      this.tableY,
    );
    this.placeables.set(key, made);
    return made;
  }
}
