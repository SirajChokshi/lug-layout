import { CHUNK_LDU, STUD_LDU } from "@brr/math";
import { describe, expect, it } from "vitest";
import {
  onSeatGrid,
  sideGrid,
  snapOutline,
  type SeatedGround,
  type WorldGround,
} from "./ground.ts";

const MODULE = CHUNK_LDU;
const HALF = MODULE / 2;

function centred(wideStuds: number, deepStuds: number): SeatedGround {
  const halfX = (wideStuds * STUD_LDU) / 2;
  const halfZ = (deepStuds * STUD_LDU) / 2;
  return {
    minX: -halfX,
    maxX: halfX,
    minZ: -halfZ,
    maxZ: halfZ,
    plates: 1,
    grid: { x: sideGrid(2 * halfX), z: sideGrid(2 * halfZ) },
  };
}

function outline(minX: number, maxX: number, minZ: number, maxZ: number): WorldGround {
  return { minX, maxX, minZ, maxZ, topY: 0 };
}

const module32 = centred(32, 32);
const halfModule = outline(0, MODULE, 0, HALF);

describe("the module grid rule", () => {
  it("gives each axis the largest step that divides both the 32-stud module and that side", () => {
    expect(centred(32, 32).grid).toEqual({ x: MODULE, z: MODULE });
    expect(centred(32, 48).grid).toEqual({ x: MODULE, z: HALF });
    expect(centred(8, 16).grid).toEqual({ x: HALF / 2, z: HALF });
  });

  it("seats a 32-stud outline only on whole modules on open ground, at every quarter turn", () => {
    for (let rot = 0; rot < 4; rot++) {
      expect(onSeatGrid(module32, HALF, HALF, rot, [])).toBe(true);
      expect(onSeatGrid(module32, HALF + HALF, HALF, rot, [])).toBe(false);
      expect(onSeatGrid(module32, HALF + STUD_LDU, HALF, rot, [])).toBe(false);
    }
  });

  it("also seats it flush against a placed baseplate edge that is off the module grid, and nowhere else off it", () => {
    expect(onSeatGrid(module32, HALF, HALF + HALF, 0, [halfModule])).toBe(true);
    expect(onSeatGrid(module32, HALF, HALF + HALF + STUD_LDU, 0, [halfModule])).toBe(false);
  });

  it("snaps the outline to whichever is nearer the cursor on each axis: the module grid or a flush neighbour edge", () => {
    const nearGrid = snapOutline(
      module32,
      HALF + 3 * STUD_LDU,
      MODULE + HALF - 3 * STUD_LDU,
      0,
      [],
    );
    expect(nearGrid).toEqual({ x: HALF, z: MODULE + HALF });
    const nearEdge = snapOutline(module32, HALF + 3 * STUD_LDU, MODULE - STUD_LDU, 0, [halfModule]);
    expect(nearEdge).toEqual({ x: HALF, z: HALF + HALF });
    expect(onSeatGrid(module32, nearEdge.x, nearEdge.z, 0, [halfModule])).toBe(true);
  });
});
