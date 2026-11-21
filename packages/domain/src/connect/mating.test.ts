import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SnapMating } from "./mating.ts";
import { SnapShapes } from "./snap-shapes.ts";

type Section = readonly [code: number, size: number, length: number];

interface VectorShape {
  readonly caps: number;
  readonly slide: boolean;
  readonly group: string;
  readonly sections: ReadonlyArray<Section>;
}

interface VectorPair {
  readonly name: string;
  readonly male: VectorShape;
  readonly female: VectorShape;
  readonly engaged: ReadonlyArray<readonly [number, number]>;
}

const VECTORS = new URL("../../../test-fixtures/snap-mating-vectors.json", import.meta.url);
const { pairs } = JSON.parse(readFileSync(VECTORS, "utf8")) as {
  readonly pairs: ReadonlyArray<VectorPair>;
};

function interned(shapes: SnapShapes, shape: VectorShape): number {
  return shapes.intern(
    shape.caps,
    shape.slide,
    shape.sections.map(([code]) => code),
    shape.sections.map(([, size]) => size),
    shape.sections.map(([, , length]) => length),
    shape.group,
  );
}

describe("the shared mating vectors the bake's port is held to", () => {
  it.each(pairs.map((pair) => [pair.name, pair] as const))("%s", (_, pair) => {
    const shapes = new SnapShapes();
    const male = interned(shapes, pair.male);
    const female = interned(shapes, pair.female);
    expect(Array.from(new SnapMating(shapes).ranges(male, female))).toEqual(pair.engaged.flat());
  });
});
