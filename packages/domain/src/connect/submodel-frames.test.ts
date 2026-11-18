import { describe, expect, it } from "vitest";
import { SIXTEENTHS_PER_LDU, STUD_LDU } from "@brr/math";
import { AXIS_FREE, AXIS_POS_Z } from "./connector-table.ts";
import {
  ALL_COORDINATES,
  IDENTIFICATION_RESIDUAL_LDU,
  IdentifiedPoint,
  MODEL_ROOT,
  NO_FRAME,
  SubmodelFrames,
  TRANSFORM_FLOATS,
  coordinatesAcross,
  identifyDirection,
  identifyPoint,
  type PartInstances,
} from "./submodel-frames.ts";

type Matrix = ReadonlyArray<number>;

interface Placed {
  readonly submodel: number;
  readonly local: Matrix;
}

const DUST = 0.02;
const AXIAL_DUST = 0.03;
const DUST_BEYOND_RESIDUAL_LDU = 1.8 * IDENTIFICATION_RESIDUAL_LDU;
const TREAD: readonly [number, number, number] = [0, 10, 0];

function translation(x: number, y: number, z: number): number[] {
  return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
}

function then(outer: Matrix, inner: Matrix): number[] {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let k = 0; k < 4; k++) {
      let sum = k === 3 ? (outer[r * 4 + 3] ?? 0) : 0;
      for (let j = 0; j < 3; j++) sum += (outer[r * 4 + j] ?? 0) * (inner[j * 4 + k] ?? 0);
      out.push(sum);
    }
  }
  return out;
}

function tree(
  submodels: ReadonlyArray<readonly [parent: number, local: Matrix]>,
  placed: ReadonlyArray<Placed>,
): PartInstances {
  const world: number[][] = [];
  for (const [parent, local] of submodels) {
    world.push(then(world[parent] ?? translation(0, 0, 0), local));
  }
  return {
    count: placed.length,
    partIndex: placed.map(() => 0),
    matrices: Float64Array.from(
      placed.flatMap((p) => then(world[p.submodel] ?? translation(0, 0, 0), p.local)),
    ),
    submodels: {
      count: submodels.length,
      parent: Int32Array.from(submodels, ([parent]) => parent),
      matrices: Float64Array.from(world.flat()),
      ofPart: Int32Array.from(placed, (p) => p.submodel),
    },
  };
}

describe("SubmodelFrames", () => {
  it("identifies only the coordinates across an axle in a pair's lowest common instance, never reading the axial one", () => {
    const wheels = tree(
      [[MODEL_ROOT, translation(5 * STUD_LDU + DUST, 3 * STUD_LDU + DUST, 2 * STUD_LDU)]],
      [
        { submodel: 0, local: translation(STUD_LDU, 0, AXIAL_DUST) },
        { submodel: 0, local: translation(STUD_LDU, 0, 3 * STUD_LDU) },
        { submodel: 0, local: translation(STUD_LDU + DUST_BEYOND_RESIDUAL_LDU, 0, 6 * STUD_LDU) },
      ],
    );
    const frames = new SubmodelFrames(wheels);
    const frame = frames.lowestCommonFrame(0, 1);
    expect(frame).toBe(0);
    const transform = new Float64Array(TRANSFORM_FLOATS);
    const point = new IdentifiedPoint();
    const across = coordinatesAcross(AXIS_POS_Z);
    const tread = (instance: number, inFrame: number, coordinates: number): boolean => {
      expect(frames.relate(instance, inFrame, transform)).toBe(true);
      expect(identifyDirection(transform, 0, 0, 1)).toBe(AXIS_POS_Z);
      return identifyPoint(transform, ...TREAD, coordinates, point);
    };
    expect(tread(1, frame, ALL_COORDINATES)).toBe(true);
    expect(point.sixteenths[2]).toBe(3 * STUD_LDU * SIXTEENTHS_PER_LDU);
    expect(tread(0, frame, across)).toBe(true);
    expect(Array.from(point.sixteenths)).toEqual([
      STUD_LDU * SIXTEENTHS_PER_LDU,
      10 * SIXTEENTHS_PER_LDU,
      0,
    ]);
    expect(point.residual).toBeLessThan(1e-9);
    expect(tread(0, frame, ALL_COORDINATES)).toBe(false);
    expect(point.residual).toBeCloseTo(AXIAL_DUST, 9);
    expect(tread(0, MODEL_ROOT, across)).toBe(false);
    expect(point.residual).toBeCloseTo(DUST, 9);
    expect(tread(2, frames.lowestCommonFrame(1, 2), across)).toBe(false);
    expect(point.residual).toBeCloseTo(DUST_BEYOND_RESIDUAL_LDU, 9);
  });

  it("reads the limit per coordinate: a sixteenth printed to three decimals is within it on every coordinate, and one coordinate beyond it is not", () => {
    const identity = Float64Array.from(translation(0, 0, 0));
    const point = new IdentifiedPoint();
    const exact = STUD_LDU + 1 / SIXTEENTHS_PER_LDU;
    const printed = Number(exact.toFixed(3));
    const offByPrinting = printed - exact;
    expect(Math.abs(offByPrinting)).toBeCloseTo(IDENTIFICATION_RESIDUAL_LDU, 12);
    expect(Math.hypot(offByPrinting, offByPrinting)).toBeGreaterThan(IDENTIFICATION_RESIDUAL_LDU);
    expect(identifyPoint(identity, printed, 0, printed, ALL_COORDINATES, point)).toBe(true);
    const exactSixteenths = exact * SIXTEENTHS_PER_LDU;
    expect(Array.from(point.sixteenths)).toEqual([exactSixteenths, 0, exactSixteenths]);
    expect(point.residual).toBeCloseTo(IDENTIFICATION_RESIDUAL_LDU, 12);
    const beyond = exact + DUST_BEYOND_RESIDUAL_LDU;
    expect(identifyPoint(identity, beyond, 0, exact, ALL_COORDINATES, point)).toBe(false);
    expect(point.residual).toBeCloseTo(DUST_BEYOND_RESIDUAL_LDU, 12);
  });

  it("finds the lowest common instance in the instance tree, and relates a part only to a frame that holds it", () => {
    const nested = tree(
      [
        [MODEL_ROOT, translation(DUST, 0, 0)],
        [0, translation(STUD_LDU, 0, 0)],
        [MODEL_ROOT, translation(DUST, 0, 0)],
        [MODEL_ROOT, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
      ],
      [
        { submodel: 1, local: translation(0, 0, 0) },
        { submodel: 0, local: translation(0, 0, 0) },
        { submodel: 2, local: translation(0, 0, 0) },
        { submodel: MODEL_ROOT, local: translation(0, 0, 0) },
        { submodel: 3, local: translation(0, 0, 0) },
      ],
    );
    const frames = new SubmodelFrames(nested);
    expect([
      frames.lowestCommonFrame(0, 1),
      frames.lowestCommonFrame(1, 0),
      frames.lowestCommonFrame(0, 0),
      frames.lowestCommonFrame(0, 2),
      frames.lowestCommonFrame(3, 0),
    ]).toEqual([0, 0, 1, MODEL_ROOT, MODEL_ROOT]);
    const transform = new Float64Array(TRANSFORM_FLOATS);
    expect(frames.relate(0, 0, transform)).toBe(true);
    expect(() => frames.relate(0, 2, transform)).toThrow(RangeError);
    expect(() => frames.relate(5, MODEL_ROOT, transform)).toThrow(RangeError);
    expect(() => frames.relate(0, MODEL_ROOT, transform.subarray(1))).toThrow(RangeError);
    expect(frames.relate(4, 3, transform)).toBe(false);
    const flat = new SubmodelFrames({
      count: nested.count,
      partIndex: nested.partIndex,
      matrices: nested.matrices,
    });
    expect(flat.lowestCommonFrame(0, 2)).toBe(MODEL_ROOT);
    expect(() => flat.relate(0, 0, transform)).toThrow(RangeError);
    expect(() => coordinatesAcross(AXIS_FREE)).toThrow(RangeError);
    expect(() => identifyPoint(transform, 0, 0, 0, 0, new IdentifiedPoint())).toThrow(RangeError);
  });

  it("walks a part's frames from its innermost sub-model instance out to the model root", () => {
    const nested = tree(
      [
        [MODEL_ROOT, translation(DUST, 0, 0)],
        [0, translation(STUD_LDU, 0, 0)],
        [1, translation(0, STUD_LDU, 0)],
      ],
      [
        { submodel: 2, local: translation(0, 0, 0) },
        { submodel: MODEL_ROOT, local: translation(0, 0, 0) },
      ],
    );
    const frames = new SubmodelFrames(nested);
    const walk = (instance: number): number[] => {
      const visited: number[] = [];
      for (let f = frames.frameOf(instance); f !== NO_FRAME; f = frames.parentFrame(f)) {
        visited.push(f);
      }
      return visited;
    };
    expect(walk(0)).toEqual([2, 1, 0, MODEL_ROOT]);
    expect(walk(1)).toEqual([MODEL_ROOT]);
    const transform = new Float64Array(TRANSFORM_FLOATS);
    for (const frame of walk(0)) expect(frames.relate(0, frame, transform)).toBe(true);
    expect(() => frames.parentFrame(3)).toThrow(RangeError);
  });
});
