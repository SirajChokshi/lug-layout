import { inject, injectable } from "inversify";
import type { IPlaceableCatalog } from "../catalog/placeable-catalog.ts";
import type { PlayModel } from "../play/play-models.ts";
import { railTopOn } from "../sim/consist.ts";
import { PLACEABLE_CATALOG } from "../tokens.ts";

export interface TallestTrain {
  readonly heightLdu: number;
  readonly model: string;
}

export function tallestTrain(models: ReadonlyArray<PlayModel>, rail: number): TallestTrain | null {
  let tallest: TallestTrain | null = null;
  for (const { name, model, vehicleTops } of models) {
    model.runningGear.vehicles.forEach((vehicle, v) => {
      const railTop = railTopOn(vehicle, rail);
      const top = vehicleTops[v] ?? Number.NEGATIVE_INFINITY;
      if (railTop === null || !Number.isFinite(top)) return;
      const heightLdu = top - railTop;
      if (!tallest || heightLdu > tallest.heightLdu) tallest = { heightLdu, model: name };
    });
  }
  return tallest;
}

export interface ITallestTrain {
  current(): TallestTrain | null;
  measure(rail: number): Promise<TallestTrain | null>;
  invalidate(): void;
}

@injectable()
export class TallestTrainMeter implements ITallestTrain {
  private measured: TallestTrain | null = null;
  private measuring: Promise<TallestTrain | null> | null = null;
  private generation = 0;

  constructor(@inject(PLACEABLE_CATALOG) private readonly catalog: IPlaceableCatalog) {}

  current(): TallestTrain | null {
    return this.measured;
  }

  measure(rail: number): Promise<TallestTrain | null> {
    this.measuring ??= this.measureAll(rail, this.generation);
    return this.measuring;
  }

  invalidate(): void {
    this.generation++;
    this.measuring = null;
  }

  private async measureAll(rail: number, generation: number): Promise<TallestTrain | null> {
    try {
      const models = await this.catalog.rollingStock();
      if (generation === this.generation) this.measured = tallestTrain(models, rail);
      return this.measured;
    } catch (error) {
      if (generation === this.generation) this.measuring = null;
      throw error;
    }
  }
}
