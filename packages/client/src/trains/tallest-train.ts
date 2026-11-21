import { inject, injectable } from "inversify";
import type { IPlaceableCatalog } from "../catalog/placeable-catalog.ts";
import type { PlayModel } from "../play/play-models.ts";
import { PLACEABLE_CATALOG } from "../tokens.ts";

export interface TallestTrain {
  readonly heightLdu: number;
  readonly model: string;
}

export function tallestTrain(
  models: ReadonlyArray<PlayModel>,
  railPart: string,
): TallestTrain | null {
  let tallest: TallestTrain | null = null;
  for (const { name, model, vehicleTops } of models) {
    model.vehicles.forEach((vehicle, v) => {
      const contact = vehicle.railContacts.find((c) => c.railPart === railPart);
      const top = vehicleTops[v] ?? Number.NEGATIVE_INFINITY;
      if (!contact || !Number.isFinite(top)) return;
      const heightLdu = top - contact.railTopY;
      if (!tallest || heightLdu > tallest.heightLdu) tallest = { heightLdu, model: name };
    });
  }
  return tallest;
}

export interface ITallestTrain {
  current(): TallestTrain | null;
  measure(railPart: string): Promise<TallestTrain | null>;
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

  measure(railPart: string): Promise<TallestTrain | null> {
    this.measuring ??= this.measureAll(railPart, this.generation);
    return this.measuring;
  }

  invalidate(): void {
    this.generation++;
    this.measuring = null;
  }

  private async measureAll(railPart: string, generation: number): Promise<TallestTrain | null> {
    try {
      const models = await this.catalog.rollingStock();
      if (generation === this.generation) this.measured = tallestTrain(models, railPart);
      return this.measured;
    } catch (error) {
      if (generation === this.generation) this.measuring = null;
      throw error;
    }
  }
}
