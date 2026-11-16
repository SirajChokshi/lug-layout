import type { PartAsset, PartModel } from "@brr/catalog";

export class MergedParts {
  private readonly assets: PartAsset[] = [];
  private readonly byId = new Map<string, number>();

  constructor(initial: ReadonlyArray<PartAsset>) {
    for (const part of initial) this.add(part);
  }

  get parts(): ReadonlyArray<PartAsset> {
    return this.assets;
  }

  indexOf(id: string): number {
    return this.byId.get(id) ?? -1;
  }

  private add(part: PartAsset): number {
    const existing = this.byId.get(part.id);
    if (existing !== undefined) return existing;
    this.assets.push(part);
    this.byId.set(part.id, this.assets.length - 1);
    return this.assets.length - 1;
  }

  remap(model: PartModel, modelParts: ReadonlyArray<PartAsset>): PartModel {
    const global = modelParts.map((part) => this.add(part));
    const partIndex = new Uint16Array(model.instanceCount);
    for (let i = 0; i < model.instanceCount; i++) {
      const merged = global[model.partIndex[i] ?? 0];
      if (merged === undefined)
        throw new Error(`model instance ${i} names a part outside its bundle`);
      partIndex[i] = merged;
    }
    return { ...model, partIndex };
  }
}
