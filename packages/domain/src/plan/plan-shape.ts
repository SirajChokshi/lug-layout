export const RECT_FLOATS = 4;
export const NO_PLAN_SHAPE = -1;

export interface PlanShape {
  readonly footing: Float64Array;
  readonly occupancy: Float64Array;
}

export class ShapeTable {
  private readonly ids = new Map<PlanShape, number>();
  private readonly shapes: PlanShape[] = [];

  intern(shape: PlanShape | null): number {
    if (shape === null) return NO_PLAN_SHAPE;
    const known = this.ids.get(shape);
    if (known !== undefined) return known;
    const id = this.shapes.length;
    this.shapes.push(shape);
    this.ids.set(shape, id);
    return id;
  }

  at(id: number): PlanShape | null {
    return id === NO_PLAN_SHAPE ? null : (this.shapes[id] ?? null);
  }
}
