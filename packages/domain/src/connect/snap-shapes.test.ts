import { describe, expect, it } from "vitest";
import {
  CAP_FAR,
  CAP_ROOT,
  SECTION_AXLE,
  SECTION_FLARE_JOINS_NEXT,
  SECTION_ROUND,
  SnapShapes,
} from "./snap-shapes.ts";

const RECORDED_LENGTH = 0.1;
const SAME_IN_FLOAT32 = Math.fround(RECORDED_LENGTH);

interface ShapeSpec {
  readonly caps: number;
  readonly slide: boolean;
  readonly codes: ReadonlyArray<number>;
  readonly sizes: ReadonlyArray<number>;
  readonly lengths: ReadonlyArray<number>;
  readonly group: string;
}

function shapeSpecs(): ShapeSpec[] {
  const specs: ShapeSpec[] = [];
  const sections: ReadonlyArray<readonly [number, number, number]> = [
    [SECTION_ROUND, 6, 4],
    [SECTION_ROUND, 6, 20],
    [SECTION_ROUND, 8, 4],
    [SECTION_AXLE, 6, 4],
    [SECTION_FLARE_JOINS_NEXT, 6.25, 2],
  ];
  for (const caps of [0, CAP_ROOT, CAP_FAR, CAP_ROOT | CAP_FAR]) {
    for (const slide of [false, true]) {
      for (const group of ["", "clip", "bar"]) {
        sections.forEach(([code, size, length], s) => {
          specs.push({ caps, slide, codes: [code], sizes: [size], lengths: [length], group });
          const [nextCode, nextSize, nextLength] = sections[(s + 1) % sections.length] ?? [0, 0, 0];
          specs.push({
            caps,
            slide,
            codes: [code, nextCode],
            sizes: [size, nextSize],
            lengths: [length, nextLength],
            group,
          });
        });
      }
    }
  }
  return specs;
}

describe("SnapShapes", () => {
  it("interns two section lengths equal in Float32 but distinct in Float64 as two shapes, each read back exactly", () => {
    const shapes = new SnapShapes();
    const recorded = shapes.intern(CAP_ROOT, false, [SECTION_ROUND], [6], [RECORDED_LENGTH]);
    const rounded = shapes.intern(CAP_ROOT, false, [SECTION_ROUND], [6], [SAME_IN_FLOAT32]);
    expect({
      sameInFloat32: Math.fround(SAME_IN_FLOAT32) === Math.fround(RECORDED_LENGTH),
      distinct: recorded !== rounded,
      spans: [recorded, rounded].map((shape) => shapes.span(shapes.firstSection(shape))),
    }).toEqual({
      sameInFloat32: true,
      distinct: true,
      spans: [RECORDED_LENGTH, SAME_IN_FLOAT32],
    });
  });

  it("orders shapes by their content alone, as a total order that two stores interning the same shapes in opposite orders agree on", () => {
    const specs = shapeSpecs();
    const forward = new SnapShapes();
    const backward = new SnapShapes();
    const forwardIds = specs.map(({ caps, slide, codes, sizes, lengths, group }) =>
      forward.intern(caps, slide, codes, sizes, lengths, group),
    );
    const backwardIds = specs
      .toReversed()
      .map(({ caps, slide, codes, sizes, lengths, group }) =>
        backward.intern(caps, slide, codes, sizes, lengths, group),
      )
      .toReversed();
    const byContent = (shapes: SnapShapes, ids: ReadonlyArray<number>): number[] =>
      specs.map((_, k) => k).toSorted((a, b) => shapes.compare(ids[a] ?? 0, ids[b] ?? 0));
    const order = byContent(forward, forwardIds);
    let zeroOnlyForSelf = true;
    let antisymmetric = true;
    let transitive = true;
    for (let a = 0; a < specs.length; a++) {
      for (let b = 0; b < specs.length; b++) {
        const ab = forward.compare(forwardIds[a] ?? 0, forwardIds[b] ?? 0);
        const ba = forward.compare(forwardIds[b] ?? 0, forwardIds[a] ?? 0);
        if ((ab === 0) !== (a === b)) zeroOnlyForSelf = false;
        if (Math.sign(ab) !== -Math.sign(ba)) antisymmetric = false;
      }
    }
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        if (forward.compare(forwardIds[order[i] ?? 0] ?? 0, forwardIds[order[j] ?? 0] ?? 0) >= 0) {
          transitive = false;
        }
      }
    }
    expect({
      idsDiffer: forwardIds.some((id, k) => id !== backwardIds[k]),
      zeroOnlyForSelf,
      antisymmetric,
      transitive,
      sameOrderEitherWay: byContent(backward, backwardIds),
    }).toEqual({
      idsDiffer: true,
      zeroOnlyForSelf: true,
      antisymmetric: true,
      transitive: true,
      sameOrderEitherWay: order,
    });
  });
});
