import { describe, expect, it } from "vitest";
import { decode } from "../decode/index.ts";
import { PartTopSurface } from "./index.ts";

function surface(fields: Record<string, unknown> = {}): unknown {
  return {
    stepsPerLdu: 16,
    top: 128,
    origin: [-320, -160],
    size: [3, 2],
    cells: ["fp.", "u.f"],
    ...fields,
  };
}

describe("PartTopSurface", () => {
  it("reads a grid whose rows match its size, one cell kind per character", () => {
    const decoded = decode(PartTopSurface, surface());
    if (!decoded.ok) throw new Error(JSON.stringify(decoded.issues));
    expect(decoded.value.cells).toEqual(["fp.", "u.f"]);
  });

  it.each([
    ["fewer rows than the grid has", surface({ cells: ["fp."] })],
    ["a row longer than the grid is wide", surface({ cells: ["fp.f", "u.f"] })],
    ["a cell kind it doesn't define", surface({ cells: ["fx.", "u.f"] })],
    ["a grid with no columns", surface({ size: [0, 2], cells: ["", ""] })],
    ["a top between sixteenths", surface({ top: 12.5 })],
    ["another step size", surface({ stepsPerLdu: 8 })],
  ])("refuses %s", (_case, value) => {
    expect(decode(PartTopSurface, value).ok).toBe(false);
  });
});
