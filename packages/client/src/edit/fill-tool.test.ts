import type { LduRect } from "@brr/domain";
import { CHUNK_LDU, STUD_LDU } from "@brr/math";
import type { GuideSegment, WorldBox } from "@brr/render";
import { describe, expect, it } from "vitest";
import { FillTool, MAX_FILL_TILES, nextFillGrid } from "./fill-tool.ts";
import type { LocalBox } from "./local-box.ts";
import { posedBox } from "./placed-chunks.ts";

const GUIDE_Y = -8;
const QUARTER_TURNS = [0, 1, 2, 3] as const;
const GRIDS_STUDS = [8, 16, 32] as const;
const FOOTPRINTS: ReadonlyArray<readonly [string, LocalBox]> = [
  ["a 32 × 32 baseplate", { min: [-320, -4, -320], max: [320, 0, 320] }],
  ["a 16 × 32 baseplate", { min: [-160, -4, -320], max: [160, 0, 320] }],
  ["a 2 × 4 brick", { min: [-40, -24, -20], max: [40, 0, 20] }],
  ["a 13 × 9 model centred off the stud lattice", { min: [-130, -96, -90], max: [130, 0, 90] }],
  ["an off-centre model with a fractional edge", { min: [-37.5, -40, -10], max: [52.25, 8, 71] }],
];

function boxesAt(fill: FillTool, box: LocalBox, rot: number): WorldBox[] {
  const boxes: WorldBox[] = [];
  for (let tile = 0; tile < fill.laid; tile++) {
    boxes.push(posedBox(box, fill.xAt(tile), fill.zAt(tile), 0, rot));
  }
  return boxes;
}

function overlap(a: WorldBox, b: WorldBox): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
}

function contains(outer: LduRect, inner: WorldBox): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minZ >= outer.minZ &&
    inner.maxZ <= outer.maxZ
  );
}

function pivots(fill: FillTool): Array<readonly [number, number]> {
  return Array.from({ length: fill.laid }, (_, tile) => [fill.xAt(tile), fill.zAt(tile)] as const);
}

function dragged(
  box: LocalBox,
  rot: number,
  gridStuds: number,
  from: readonly [number, number],
  to: readonly [number, number],
): FillTool {
  const fill = new FillTool(GUIDE_Y);
  fill.begin(box, rot, gridStuds * STUD_LDU, from[0], from[1]);
  fill.drag(to[0], to[1]);
  return fill;
}

describe("dragging a fill", () => {
  it.each(FOOTPRINTS)(
    "tiles %s on the stud lattice at the smallest grid multiple that keeps tiles apart, in every turn, grid and drag direction",
    (_, box) => {
      for (const rot of QUARTER_TURNS) {
        for (const gridStuds of GRIDS_STUDS) {
          const gridLdu = gridStuds * STUD_LDU;
          const turned = posedBox(box, 0, 0, 0, rot);
          for (const to of [
            [2530, 1690],
            [-2530, -1690],
            [-1900, 1400],
          ] as const) {
            const fill = dragged(box, rot, gridStuds, [130, -70], to);
            const columns = new Set(pivots(fill).map(([x]) => x)).size;
            const rows = new Set(pivots(fill).map(([, z]) => z)).size;
            const stepX = fill.xAt(1) - fill.xAt(0);
            const stepZ = fill.zAt(columns) - fill.zAt(0);
            const boxes = boxesAt(fill, box, rot);

            expect(fill.laid).toBe(columns * rows);
            expect(Math.min(columns, rows)).toBeGreaterThan(1);
            for (let tile = 0; tile < fill.laid; tile++) {
              expect(Number.isInteger(fill.xAt(tile) / STUD_LDU)).toBe(true);
              expect(Number.isInteger(fill.zAt(tile) / STUD_LDU)).toBe(true);
            }
            for (const [step, extent] of [
              [stepX, turned.maxX - turned.minX],
              [stepZ, turned.maxZ - turned.minZ],
            ] as const) {
              expect(step % gridLdu).toBe(0);
              expect(step).toBeGreaterThanOrEqual(extent);
              expect(step - gridLdu).toBeLessThan(extent + STUD_LDU);
            }
            boxes.forEach((a, i) =>
              boxes.slice(i + 1).forEach((b) => expect(overlap(a, b)).toBe(false)),
            );
          }
        }
      }
    },
  );

  it("anchors on the chosen grid line nearest the press and steps by the plate's own size", () => {
    const plate: LocalBox = { min: [-320, -4, -320], max: [320, 0, 320] };
    const strip: LocalBox = { min: [-160, -4, -320], max: [160, 0, 320] };

    expect(pivots(dragged(plate, 0, 8, [130, -70], [1530, 690]))).toEqual([
      [480, 320],
      [1120, 320],
      [1760, 320],
      [480, 960],
      [1120, 960],
      [1760, 960],
    ]);
    expect(pivots(dragged(plate, 0, 32, [130, -70], [1530, 10]))).toEqual([
      [320, 320],
      [960, 320],
      [1600, 320],
    ]);
    expect(pivots(dragged(strip, 1, 16, [-10, 10], [-700, 10]))).toEqual([
      [-960, 160],
      [-320, 160],
    ]);
  });

  it("rounds a footprint up to the chosen grid, leaving the same gap after every tile", () => {
    const brick: LocalBox = { min: [-40, -24, -20], max: [40, 0, 20] };

    expect(pivots(dragged(brick, 0, 8, [0, 0], [500, 10]))).toEqual([
      [40, 20],
      [200, 20],
      [360, 20],
      [520, 20],
    ]);
    expect(pivots(dragged(brick, 0, 32, [0, 0], [500, 10]))).toEqual([[40, 20]]);
  });

  it("lays the same drag again from its press when the grid or the turn changes mid-drag", () => {
    const brick: LocalBox = { min: [-40, -24, -20], max: [40, 0, 20] };
    const fill = dragged(brick, 0, 8, [0, 0], [500, 10]);
    const coarser = fill.reframe(brick, 0, 32 * STUD_LDU) ? pivots(fill) : [];
    const turned = fill.reframe(brick, 1, 8 * STUD_LDU) ? pivots(fill) : [];

    expect(coarser).toEqual([[40, 20]]);
    expect(turned).toEqual([
      [20, 40],
      [180, 40],
      [340, 40],
      [500, 40],
    ]);
  });

  it("lays nothing until the pointer leaves the stud it was pressed on", () => {
    const fill = new FillTool(GUIDE_Y);
    fill.begin({ min: [-320, -4, -320], max: [320, 0, 320] }, 0, CHUNK_LDU, 130, -70);
    fill.drag(135, -65);
    const before = { previewing: fill.previewing, count: fill.laid, label: fill.label() };
    fill.drag(150, -65);

    expect(before).toEqual({ previewing: false, count: 0, label: null });
    expect({ previewing: fill.previewing, count: fill.laid }).toEqual({
      previewing: true,
      count: 1,
    });
  });

  it("refuses a drag that asks for more tiles than one fill places, and places none of them", () => {
    const brick: LocalBox = { min: [-10, -24, -10], max: [10, 0, 10] };
    const side = Math.ceil(Math.sqrt(MAX_FILL_TILES + 1)) * 8 * STUD_LDU;
    const fill = dragged(brick, 0, 8, [0, 0], [side, side]);

    const guides: GuideSegment[] = [];
    fill.guides(guides);

    expect(fill.overLimit).toBe(true);
    expect(fill.wanted).toBeGreaterThan(MAX_FILL_TILES);
    expect(fill.requests(0, 0, 0)).toEqual([]);
    expect(guides.map((guide) => guide.kind)).toEqual(Array(4).fill("refused"));
  });
});

describe("filling tables", () => {
  const tables: ReadonlyArray<LduRect> = [
    { minX: -170, minZ: 330, maxX: 2850, maxZ: 1830 },
    { minX: 3200, minZ: 0, maxX: 3360, maxZ: 3200 },
  ];

  it.each(FOOTPRINTS)(
    "packs %s whole inside each table from its first grid line, in every turn and grid",
    (_, box) => {
      for (const rot of QUARTER_TURNS) {
        for (const gridStuds of GRIDS_STUDS) {
          const fill = new FillTool(GUIDE_Y);
          fill.layTables(box, rot, gridStuds * STUD_LDU, tables);
          const boxes = boxesAt(fill, box, rot);

          expect(fill.laid).toBe(fill.wanted);
          for (const placed of boxes) {
            expect(tables.some((table) => contains(table, placed))).toBe(true);
          }
          boxes.forEach((a, i) =>
            boxes.slice(i + 1).forEach((b) => expect(overlap(a, b)).toBe(false)),
          );
        }
      }
    },
  );

  it("fits a 32 × 32 plate only where a whole one lands on the grid inside the table", () => {
    const plate: LocalBox = { min: [-320, -4, -320], max: [320, 0, 320] };
    const fill = new FillTool(GUIDE_Y);
    fill.layTables(plate, 0, 8 * STUD_LDU, tables);

    expect(pivots(fill)).toEqual([
      [160, 800],
      [800, 800],
      [1440, 800],
      [2080, 800],
      [160, 1440],
      [800, 1440],
      [1440, 1440],
      [2080, 1440],
    ]);
  });
});

describe("a settled fill", () => {
  it("asks to place every tile that wasn't refused, at the height each one settled at", () => {
    const plate: LocalBox = { min: [-320, -4, -320], max: [320, 0, 320] };
    const fill = dragged(plate, 1, 32, [0, 0], [1900, 10]);
    fill.settle(0, 3, false);
    fill.settle(1, 0, true);
    fill.settle(2, 1, false);

    const guides: GuideSegment[] = [];
    fill.guides(guides);

    expect(guides.filter((guide) => guide.kind === "refused")).toEqual([
      { kind: "refused", ax: 640, ay: GUIDE_Y, az: 0, bx: 1280, by: GUIDE_Y, bz: 640 },
      { kind: "refused", ax: 1280, ay: GUIDE_Y, az: 0, bx: 640, by: GUIDE_Y, bz: 640 },
    ]);
    expect(fill.refused).toBe(1);
    expect(fill.requests(7, 15, 1).map((request) => request.to)).toEqual([
      { refId: 7, colorId: 15, x: 320, z: 320, yPlates: 3, rot: 1 },
      { refId: 7, colorId: 15, x: 1600, z: 320, yPlates: 1, rot: 1 },
    ]);
  });
});

it("cycles the fill grid through 8, 16 and 32 studs", () => {
  expect([8, 16, 32].map(nextFillGrid)).toEqual([16, 32, 8]);
});
