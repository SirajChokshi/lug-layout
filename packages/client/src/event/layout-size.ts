import { STUD_LDU, lduFromMm } from "@brr/math";
import type { WorldBox } from "@brr/render";
import { inject, injectable } from "inversify";
import type { IPlanService } from "../plan/plan-service.ts";
import { placementsBox } from "../plan/placements-box.ts";
import { PLAN_SERVICE } from "../tokens.ts";

export const STUDS_PER_MODULE = 96;
const MM_PER_METRE = 1000;
const MM_PER_FOOT = 304.8;
const STUD_DECIMALS = 1;
const MEASURE_DECIMALS = 2;

export type LayoutSize =
  | { readonly kind: "empty" }
  | { readonly kind: "unmeasured" }
  | { readonly kind: "measured"; readonly widthLdu: number; readonly depthLdu: number };

export type SizeUnit = "studs" | "modules" | "metres" | "feet";

export interface SizeMeasure {
  readonly unit: SizeUnit;
  readonly width: string;
  readonly depth: string;
}

export interface ILayoutSize {
  subscribe(listener: () => void): () => void;
  size(): LayoutSize;
}

const EMPTY: LayoutSize = { kind: "empty" };
const UNMEASURED: LayoutSize = { kind: "unmeasured" };
const studNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: STUD_DECIMALS });
const measureNumber = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: MEASURE_DECIMALS,
  maximumFractionDigits: MEASURE_DECIMALS,
});

function measured(box: WorldBox): boolean {
  return (
    Number.isFinite(box.minX) &&
    Number.isFinite(box.maxX) &&
    Number.isFinite(box.minZ) &&
    Number.isFinite(box.maxZ)
  );
}

export function layoutSizeOf(box: WorldBox | null): LayoutSize {
  if (box === null) return EMPTY;
  if (!measured(box)) return UNMEASURED;
  return { kind: "measured", widthLdu: box.maxX - box.minX, depthLdu: box.maxZ - box.minZ };
}

function measure(
  unit: SizeUnit,
  widthLdu: number,
  depthLdu: number,
  lduPerUnit: number,
  format: Intl.NumberFormat,
): SizeMeasure {
  return {
    unit,
    width: format.format(widthLdu / lduPerUnit),
    depth: format.format(depthLdu / lduPerUnit),
  };
}

export function sizeMeasures(widthLdu: number, depthLdu: number): ReadonlyArray<SizeMeasure> {
  return [
    measure("studs", widthLdu, depthLdu, STUD_LDU, studNumber),
    measure("modules", widthLdu, depthLdu, STUD_LDU * STUDS_PER_MODULE, measureNumber),
    measure("metres", widthLdu, depthLdu, lduFromMm(MM_PER_METRE), measureNumber),
    measure("feet", widthLdu, depthLdu, lduFromMm(MM_PER_FOOT), measureNumber),
  ];
}

@injectable()
export class LayoutSizeMeter implements ILayoutSize {
  private measuredAt = Number.NaN;
  private measuredSize: LayoutSize = EMPTY;

  constructor(@inject(PLAN_SERVICE) private readonly plans: IPlanService) {}

  subscribe(listener: () => void): () => void {
    return this.plans.subscribe(listener);
  }

  size(): LayoutSize {
    const version = this.plans.version();
    if (version !== this.measuredAt) {
      this.measuredSize = layoutSizeOf(placementsBox(this.plans.placements()));
      this.measuredAt = version;
    }
    return this.measuredSize;
  }
}
