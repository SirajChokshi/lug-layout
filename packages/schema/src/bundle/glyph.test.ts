import { describe, expect, it } from "vitest";
import { decodePlanGlyph } from "./glyph.ts";

class Bytes {
  private readonly bytes: number[] = [];

  text(value: string): this {
    for (const char of value) this.bytes.push(char.charCodeAt(0));
    return this;
  }

  u8(...values: ReadonlyArray<number>): this {
    this.bytes.push(...values);
    return this;
  }

  u16(value: number): this {
    return this.u8(value & 0xff, value >>> 8);
  }

  u32(value: number): this {
    return this.u8(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
  }

  i32(value: number): this {
    return this.u32(value >>> 0);
  }

  build(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

interface Parts {
  readonly scale: ReadonlyArray<number>;
  readonly size: readonly [number, number];
  readonly palette: ReadonlyArray<number>;
  readonly runs: ReadonlyArray<ReadonlyArray<number>>;
  readonly steps: ReadonlyArray<number>;
}

const VALID: Parts = {
  scale: [8, 4],
  size: [3, 2],
  palette: [4, 16],
  runs: [
    [1, 16, 1],
    [0, 0, 0],
    [0, 8, 0],
    [0, 16, 1],
    [0, 0, 0],
  ],
  steps: [16, 6, 5, 10, 9, 15],
};

function glyph(parts: Partial<Parts> = {}): Uint8Array {
  const { scale, size, palette, runs, steps } = { ...VALID, ...parts };
  const bytes = new Bytes()
    .text("BRRGLYF1")
    .u8(...scale)
    .i32(-3)
    .i32(5)
    .u32(size[0])
    .u32(size[1])
    .u32(palette.length);
  for (const color of palette) bytes.u32(color);
  bytes.u32(runs.length);
  for (const run of runs) bytes.u8(...run);
  bytes
    .u32(1)
    .u16(0)
    .u16(0)
    .u32(steps.length)
    .u8(...steps);
  return bytes.build();
}

function issue(bytes: Uint8Array): string {
  const decoded = decodePlanGlyph(bytes);
  if (decoded.ok) throw new Error("the glyph decoded");
  return decoded.issues.map((found) => found.message).join("; ");
}

describe("decodePlanGlyph", () => {
  it("reads the scale, origin, pixels and outline loops", () => {
    const decoded = decodePlanGlyph(glyph());
    if (!decoded.ok) throw new Error(decoded.issues[0]?.message);
    const value = decoded.value;
    expect([value.pixelsPerStud, value.samplesPerPixelSide]).toEqual([8, 4]);
    expect([value.originX, value.originZ, value.width, value.depth]).toEqual([-3, 5, 3, 2]);
    expect([...value.colors]).toEqual([4, 16]);
    expect([...value.coverage]).toEqual([16, 16, 0, 8, 16, 0]);
    expect([...value.colorIndex]).toEqual([1, 1, 0, 0, 1, 0]);
    expect([...value.loopStarts]).toEqual([0, 6]);
    expect([...value.vertices]).toEqual([0, 0, 8, 0, 8, 3, 5, 3, 5, 8, 0, 8]);
  });

  it("reads indices as two bytes once the palette passes 256 colours", () => {
    const palette = Array.from({ length: 257 }, (_, k) => k);
    const bytes = new Bytes()
      .text("BRRGLYF1")
      .u8(8, 4)
      .i32(0)
      .i32(0)
      .u32(1)
      .u32(1)
      .u32(palette.length);
    for (const color of palette) bytes.u32(color);
    bytes.u32(1).u8(0, 16).u16(256).u32(0);
    const decoded = decodePlanGlyph(bytes.build());
    expect(decoded.ok && [...decoded.value.colorIndex]).toEqual([256]);
  });

  it("refuses a glyph cut short or padded", () => {
    const bytes = glyph();
    for (let end = 0; end < bytes.length; end++) {
      expect(decodePlanGlyph(bytes.subarray(0, end)).ok, `${end} bytes`).toBe(false);
    }
    expect(issue(Uint8Array.from([...bytes, 0]))).toMatch(/1 bytes after its end/u);
  });

  it("refuses runs that repeat, overfill, overcover or name no colour", () => {
    const [first, second, third, fourth, fifth] = VALID.runs;
    if (!first || !second || !third || !fourth || !fifth) throw new Error("five runs");
    expect(issue(glyph({ runs: [first, second, second, fourth, fifth] }))).toMatch(/repeat/u);
    expect(issue(glyph({ runs: [[9, 16, 1], second, third, fourth, fifth] }))).toMatch(/overrun/u);
    expect(issue(glyph({ runs: [first, second, [0, 17, 0], fourth, fifth] }))).toMatch(
      /17 samples/u,
    );
    expect(issue(glyph({ runs: [[1, 16, 2], second, third, fourth, fifth] }))).toMatch(/colour 2/u);
    expect(issue(glyph({ runs: [first, [0, 0, 1], third, fourth, fifth] }))).toMatch(/colour 1/u);
    expect(issue(glyph({ runs: [first, second, third, fourth] }))).toMatch(/fill 5 of 6/u);
  });

  it("refuses a palette out of order and a glyph empty on one side", () => {
    expect(issue(glyph({ palette: [16, 4] }))).toMatch(/strictly ascending/u);
    expect(issue(glyph({ size: [3, 0] }))).toMatch(/3 × 0/u);
  });

  it("refuses an outline that leaves the glyph, repeats a vertex or doesn't close", () => {
    expect(issue(glyph({ steps: [26, 6, 5, 10, 9, 15] }))).toMatch(/leaves the glyph/u);
    expect(issue(glyph({ steps: [16, 0, 5, 10, 9, 15] }))).toMatch(/repeats a vertex/u);
    expect(issue(glyph({ steps: [16, 6, 5, 10, 9, 11] }))).toMatch(/doesn't close/u);
    expect(issue(glyph({ steps: [16, 6, 5, 10] }))).toMatch(/doesn't close/u);
    expect(issue(glyph({ steps: [16, 6, 9] }))).toMatch(/3 vertices/u);
  });

  it("refuses an overlong count and another magic", () => {
    const [, second, third, fourth, fifth] = VALID.runs;
    if (!second || !third || !fourth || !fifth) throw new Error("five runs");
    const overlong = glyph({ runs: [[0x81, 0x00, 16, 1], second, third, fourth, fifth] });
    expect(issue(overlong)).toMatch(/overlong/u);
    const other = glyph();
    other[0] = 0;
    expect(issue(other)).toMatch(/not a plan glyph/u);
  });
});
