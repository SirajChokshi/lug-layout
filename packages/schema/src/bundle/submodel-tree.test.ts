import { describe, expect, it } from "vitest";
import { MODEL_ROOT, submodelTreeFits } from "./index.ts";

const MATRIX_FLOATS = 12;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function tree(parent: ReadonlyArray<number>, ofPart: ReadonlyArray<number>) {
  return { parent, matrices: parent.flatMap(() => IDENTITY), ofPart };
}

describe("submodelTreeFits", () => {
  it("accepts a tree whose parents come first and whose parts name an instance or the root", () => {
    expect(submodelTreeFits(tree([MODEL_ROOT, 0, MODEL_ROOT], [MODEL_ROOT, 1, 2]), 3)).toBe(true);
  });

  it("refuses a parent after its child, an ofPart of the wrong length, missing matrix floats and an unknown instance", () => {
    expect(submodelTreeFits(tree([1, MODEL_ROOT], [MODEL_ROOT]), 1)).toBe(false);
    expect(submodelTreeFits(tree([MODEL_ROOT], [0]), 2)).toBe(false);
    expect(
      submodelTreeFits(
        { ...tree([MODEL_ROOT], [0]), matrices: IDENTITY.slice(0, MATRIX_FLOATS - 1) },
        1,
      ),
    ).toBe(false);
    expect(submodelTreeFits(tree([MODEL_ROOT], [1]), 1)).toBe(false);
  });
});
