import { modelTechnic, type PartInstances, type TechnicSet } from "@brr/domain";
import type { PartTechnic } from "@brr/schema/bundle";

export class FrozenTechnic implements TechnicSet {
  readonly #itemOfInstance: Int32Array;
  readonly #kind: Uint8Array;
  readonly #box: Float64Array;
  readonly #featureStart: Int32Array;
  readonly #axis: Uint8Array;
  readonly #atU: Int32Array;
  readonly #atV: Int32Array;
  readonly #from: Int32Array;
  readonly #bins: Int32Array;
  readonly #radiusStart: Int32Array;
  readonly #radii: Int32Array;

  private constructor(
    parts: ReadonlyArray<PartTechnic | null>,
    instances: PartInstances,
    boxes: ArrayLike<number>,
  ) {
    const columns = modelTechnic(parts, instances, boxes);
    this.count = columns.count;
    this.#itemOfInstance = columns.itemOfInstance;
    this.#kind = columns.kind;
    this.#box = columns.box;
    this.#featureStart = columns.featureStart;
    this.#axis = columns.axis;
    this.#atU = columns.atU;
    this.#atV = columns.atV;
    this.#from = columns.from;
    this.#bins = columns.bins;
    this.#radiusStart = columns.radiusStart;
    this.#radii = columns.radii;
  }

  readonly count: number;

  get itemOfInstance(): ArrayLike<number> {
    return this.#itemOfInstance;
  }

  get kind(): ArrayLike<number> {
    return this.#kind;
  }

  get box(): ArrayLike<number> {
    return this.#box;
  }

  get featureStart(): ArrayLike<number> {
    return this.#featureStart;
  }

  get axis(): ArrayLike<number> {
    return this.#axis;
  }

  get atU(): ArrayLike<number> {
    return this.#atU;
  }

  get atV(): ArrayLike<number> {
    return this.#atV;
  }

  get from(): ArrayLike<number> {
    return this.#from;
  }

  get bins(): ArrayLike<number> {
    return this.#bins;
  }

  get radiusStart(): ArrayLike<number> {
    return this.#radiusStart;
  }

  get radii(): ArrayLike<number> {
    return this.#radii;
  }

  static ofParts(
    parts: ReadonlyArray<PartTechnic | null>,
    instances: PartInstances,
    boxes: ArrayLike<number>,
  ): FrozenTechnic {
    return new FrozenTechnic(parts, instances, boxes);
  }
}
