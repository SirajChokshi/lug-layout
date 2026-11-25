import type { ModelConnectors } from "./model-connectors.ts";

export const MODEL_CACHE_CONNECTORS = 2 ** 16;
export const MODEL_CACHE_MODELS = 64;

export class ModelCache<T> {
  private readonly entries = new Map<ModelConnectors, T>();
  private connectors = 0;

  constructor(
    private readonly maxConnectors: number,
    private readonly maxModels: number,
  ) {}

  get(model: ModelConnectors): T | undefined {
    const entry = this.entries.get(model);
    if (entry === undefined) return undefined;
    this.entries.delete(model);
    this.entries.set(model, entry);
    return entry;
  }

  set(model: ModelConnectors, entry: T): void {
    if (this.entries.delete(model)) this.connectors -= model.count;
    this.entries.set(model, entry);
    this.connectors += model.count;
    while (this.connectors > this.maxConnectors || this.entries.size > this.maxModels) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined || oldest === model) return;
      this.entries.delete(oldest);
      this.connectors -= oldest.count;
    }
  }
}
