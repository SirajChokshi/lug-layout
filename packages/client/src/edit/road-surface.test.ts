import type { PartShapeAsset } from "@brr/catalog";
import { NO_STUD, NO_TOP, type RoadSurface } from "@brr/domain";
import { SIXTEENTHS_PER_LDU, STUD_LDU } from "@brr/math";
import type { PartTopSurface, Vec3 } from "@brr/schema/bundle";
import { describe, expect, it } from "vitest";
import { roadCells, type SurfaceGrid } from "./road-surface.ts";

const PLATE = 8;
const TILE = 8;

interface PartSpec {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly cells: ReadonlyArray<string> | null;
  readonly studs?: ReadonlyArray<Vec3>;
}

function topSurface(min: Vec3, max: Vec3, cells: ReadonlyArray<string>): PartTopSurface {
  return {
    stepsPerLdu: SIXTEENTHS_PER_LDU,
    top: max[1] * SIXTEENTHS_PER_LDU,
    origin: [min[0] * SIXTEENTHS_PER_LDU, min[2] * SIXTEENTHS_PER_LDU],
    size: [cells[0]?.length ?? 0, cells.length],
    cells: [...cells],
  };
}

function part(id: string, spec: PartSpec, role: "ground" | "road" = "ground"): PartShapeAsset {
  const studs = spec.studs ?? [];
  const studMatrices = new Float32Array(studs.length * 12);
  studs.forEach(([x, y, z], i) => studMatrices.set([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z], i * 12));
  return {
    id,
    title: id,
    role,
    boundsMin: spec.min,
    boundsMax: spec.max,
    producedColor: undefined,
    producedColors: undefined,
    trackEnds: undefined,
    studPrimitiveIndex: new Uint8Array(studs.length),
    studColors: new Uint16Array(studs.length),
    studMatrices,
    technic: null,
    rolling: null,
    topSurface: spec.cells === null ? null : topSurface(spec.min, spec.max, spec.cells),
    outline: null,
  };
}

function turned(quarterTurns: number, [x, y, z]: Vec3): ReadonlyArray<number> {
  const angle = (quarterTurns * Math.PI) / 2;
  const c = Math.round(Math.cos(angle));
  const s = Math.round(Math.sin(angle));
  return [c, 0, s, x, 0, 1, 0, y, -s, 0, c, z];
}

interface Instance {
  readonly part: number;
  readonly transform: ReadonlyArray<number>;
}

function boxesOf(parts: ReadonlyArray<PartShapeAsset>, instances: ReadonlyArray<Instance>) {
  const boxes = new Float32Array(instances.length * 6);
  instances.forEach(({ part: index, transform: t }, i) => {
    const shape = parts[index];
    if (!shape) return;
    for (let axis = 0; axis < 3; axis++) {
      let lo = t[axis * 4 + 3] ?? 0;
      let hi = lo;
      for (let k = 0; k < 3; k++) {
        const coefficient = t[axis * 4 + k] ?? 0;
        const a = coefficient * (shape.boundsMin[k] ?? 0);
        const b = coefficient * (shape.boundsMax[k] ?? 0);
        lo += Math.min(a, b);
        hi += Math.max(a, b);
      }
      boxes[i * 6 + axis] = lo;
      boxes[i * 6 + 3 + axis] = hi;
    }
  });
  return boxes;
}

function read(
  parts: ReadonlyArray<PartShapeAsset>,
  instances: ReadonlyArray<Instance>,
  grid: SurfaceGrid,
) {
  const matrices = new Float64Array(instances.length * 12);
  instances.forEach(({ transform }, i) => matrices.set(transform, i * 12));
  return roadCells(
    {
      count: instances.length,
      partIndex: Uint16Array.from(instances.map(({ part: index }) => index)),
      matrices,
    },
    boxesOf(parts, instances),
    grid,
    parts,
  );
}

function onePart(shape: PartShapeAsset) {
  return read(
    [shape],
    [{ part: 0, transform: turned(0, [0, 0, 0]) }],
    gridOf(shape.boundsMin, shape.boundsMax),
  );
}

function gridOf(min: Vec3, max: Vec3): SurfaceGrid {
  return {
    cellX0: min[0] / STUD_LDU,
    cellZ0: min[2] / STUD_LDU,
    width: (max[0] - min[0]) / STUD_LDU,
    depth: (max[2] - min[2]) / STUD_LDU,
  };
}

function rowsOf(surface: RoadSurface | null): ReadonlyArray<string> {
  if (!surface) return [];
  const rows: string[] = [];
  for (let row = 0; row < surface.rows; row++) {
    let text = "";
    for (let column = 0; column < surface.columns; column++) {
      const cell = row * surface.columns + column;
      text += surface.topSixteenths[cell] === NO_TOP ? " " : surface.road[cell] ? "R" : ".";
    }
    rows.push(text);
  }
  return rows;
}

describe("roadCells", () => {
  it.each(["ground", "road"] as const)(
    "makes a part's flat studless cells road and its studded cells not, whatever role it names (%s)",
    (role) => {
      const plate = part(
        "plate",
        { min: [-30, 0, -10], max: [30, PLATE, 10], cells: ["fff"], studs: [[20, PLATE, 0]] },
        role,
      );
      const { road } = onePart(plate);
      expect(rowsOf(road)).toEqual(["RR."]);
      expect([...(road?.studSixteenths ?? [])]).toEqual([
        NO_STUD,
        NO_STUD,
        PLATE * SIXTEENTHS_PER_LDU,
      ]);
    },
  );

  it("reads a recessed stud in a pocket as road at the stud's base, and a pocket without one as not road", () => {
    const pocketed = part("pocketed", {
      min: [-30, 0, -10],
      max: [30, PLATE, 10],
      cells: ["fpf"],
      studs: [[0, PLATE - 4, 0]],
    });
    const empty = part("empty pocket", {
      min: [-30, 0, -10],
      max: [30, PLATE, 10],
      cells: ["fpf"],
    });
    const { road } = onePart(pocketed);
    expect(rowsOf(road)).toEqual(["RRR"]);
    expect(road?.studSixteenths[1]).toBe((PLATE - 4) * SIXTEENTHS_PER_LDU);
    expect(rowsOf(onePart(empty).road)).toEqual(["R.R"]);
  });

  it("blocks both cells a stud stands between, so a jumper presents no road", () => {
    const jumper = part("jumper", {
      min: [-20, 0, -10],
      max: [20, PLATE, 10],
      cells: ["ff"],
      studs: [[0, PLATE, 0]],
    });
    const { road, flatTopSixteenths } = onePart(jumper);
    expect(road).toBeNull();
    expect(flatTopSixteenths).toBe(PLATE * SIXTEENTHS_PER_LDU);
  });

  it("gives a studded plate with rounded corners no road but a flat top across its plan, and a slope neither", () => {
    const studs: Vec3[] = [];
    for (const x of [-20, 0, 20]) for (const z of [-20, 0, 20]) studs.push([x, PLATE, z]);
    const rounded = part("rounded", {
      min: [-30, 0, -30],
      max: [30, PLATE, 30],
      cells: [".f.", "fff", ".f."],
      studs,
    });
    const slope = part("slope", {
      min: [-10, 0, -30],
      max: [10, 24, 30],
      cells: ["f", ".", "."],
      studs: [[0, 24, -20]],
    });
    expect(onePart(rounded)).toEqual({ road: null, flatTopSixteenths: PLATE * SIXTEENTHS_PER_LDU });
    expect(onePart(slope)).toEqual({ road: null, flatTopSixteenths: null });
  });

  it("reads each instance of a model through its own quarter turn, and a tile on a plate owns the cells it covers at its own top", () => {
    const parts = [
      part("road tile 2 x 1", { min: [-20, 0, -10], max: [20, TILE, 10], cells: ["ff"] }),
      part("plate 2 x 2", {
        min: [-20, 0, -20],
        max: [20, PLATE, 20],
        cells: ["ff", "ff"],
        studs: [
          [-10, PLATE, -10],
          [10, PLATE, -10],
          [-10, PLATE, 10],
          [10, PLATE, 10],
        ],
      }),
    ];
    const { road } = read(
      parts,
      [
        { part: 1, transform: turned(0, [0, 0, 0]) },
        { part: 0, transform: turned(1, [-10, PLATE, 0]) },
      ],
      { cellX0: -1, cellZ0: -1, width: 2, depth: 2 },
    );
    expect(rowsOf(road)).toEqual(["R.", "R."]);
    expect([...(road?.topSixteenths ?? [])].map((top) => top / SIXTEENTHS_PER_LDU)).toEqual([
      PLATE + TILE,
      PLATE,
      PLATE + TILE,
      PLATE,
    ]);
  });

  it("presents no road for an instance turned off the quarter turns or mirrored", () => {
    const tile = part("tile", { min: [-10, 0, -10], max: [10, TILE, 10], cells: ["f"] });
    const eighth = Math.SQRT1_2;
    const offLattice = [eighth, 0, eighth, 0, 0, 1, 0, 0, -eighth, 0, eighth, 0];
    const mirrored = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    const grid = { cellX0: -1, cellZ0: -1, width: 2, depth: 2 };
    expect(read([tile], [{ part: 0, transform: offLattice }], grid).road).toBeNull();
    expect(
      read([tile], [{ part: 0, transform: mirrored }], gridOf([-10, 0, -10], [10, TILE, 10])).road,
    ).toBeNull();
    expect(
      read(
        [tile],
        [{ part: 0, transform: turned(0, [0, 0, 0]) }],
        gridOf([-10, 0, -10], [10, TILE, 10]),
      ).road,
    ).not.toBeNull();
  });

  it("presents no road for a tile half a stud off the grid, whose flat cells sit on no cell of it", () => {
    const tile = part("tile", { min: [-10, 0, -10], max: [10, TILE, 10], cells: ["f"] });
    const grid = { cellX0: -1, cellZ0: -0.5, width: 2, depth: 1 };
    const { road } = read([tile], [{ part: 0, transform: turned(0, [0, 0, 0]) }], grid);
    expect(road).toBeNull();
  });

  it("presents no road for a part without a top surface record", () => {
    const unread = part("unread", { min: [-10, 0, -10], max: [10, TILE, 10], cells: null });
    expect(onePart(unread)).toEqual({ road: null, flatTopSixteenths: null });
  });

  it("gives a cell no part covers no top, so it holds no surface", () => {
    const tile = part("tile", { min: [-10, 0, -10], max: [10, TILE, 10], cells: ["f"] });
    const { road } = read([tile], [{ part: 0, transform: turned(0, [0, 0, 0]) }], {
      cellX0: -0.5,
      cellZ0: -0.5,
      width: 2,
      depth: 1,
    });
    expect(rowsOf(road)).toEqual(["R "]);
    expect(road?.topSixteenths[1]).toBe(NO_TOP);
  });

  it("marks a column a part stands in as occupied even when its top doesn't identify to a sixteenth, and a column no part covers as empty", () => {
    const tile = part("tile", { min: [-10, 0, -10], max: [10, TILE, 10], cells: ["f"] });
    const figure = part("figure", {
      min: [-10, 0, -10],
      max: [10, 5 * TILE + 0.37, 10],
      cells: null,
    });
    const { road } = read(
      [tile, figure],
      [
        { part: 0, transform: turned(0, [0, 0, 0]) },
        { part: 1, transform: turned(0, [20, 0, 0]) },
      ],
      { cellX0: -0.5, cellZ0: -0.5, width: 3, depth: 1 },
    );
    expect({
      top: [...(road?.topSixteenths ?? [])],
      occupied: [...(road?.occupied ?? [])],
    }).toEqual({ top: [TILE * SIXTEENTHS_PER_LDU, NO_TOP, NO_TOP], occupied: [1, 1, 0] });
  });

  it("keeps a top at a fractional height in sixteenths, and leaves a top that doesn't identify to a sixteenth unread", () => {
    const tile = part("tile", { min: [-10, 0, -10], max: [10, TILE, 10], cells: ["f"] });
    const grid = gridOf([-10, 0, -10], [10, TILE, 10]);
    const at = (y: number) => read([tile], [{ part: 0, transform: turned(0, [0, y, 0]) }], grid);
    expect([...(at(0.25).road?.topSixteenths ?? [])]).toEqual([(TILE + 0.25) * SIXTEENTHS_PER_LDU]);
    expect(at(0.1)).toEqual({ road: null, flatTopSixteenths: null });
  });

  it("leaves a cell unread when a part over a flat tile reaches a height that doesn't identify, rather than round it to the tile's top", () => {
    const tile = part("tile", { min: [-10, 0, -10], max: [10, TILE, 10], cells: ["f"] });
    const sliver = part("sliver", {
      min: [-10, TILE - 1, -10],
      max: [10, TILE + 0.001, 10],
      cells: ["."],
    });
    const grid = gridOf([-10, 0, -10], [10, TILE, 10]);
    const flush = turned(0, [0, 0, 0]);
    const stacked = (parts: ReadonlyArray<PartShapeAsset>) =>
      read(
        parts,
        parts.map((_, index) => ({ part: index, transform: flush })),
        grid,
      );
    expect(rowsOf(stacked([tile]).road)).toEqual(["R"]);
    expect(stacked([tile, sliver])).toEqual({ road: null, flatTopSixteenths: null });
  });
});

describe("roadCells at equal tops", () => {
  const cornerTile = part("corner tile 2 x 2", {
    min: [-20, 0, -20],
    max: [20, TILE, 20],
    cells: ["f.", "ff"],
  });
  const tile = part("tile 1 x 1", { min: [-10, 0, -10], max: [10, TILE, 10], cells: ["f"] });
  const grid = { cellX0: -1, cellZ0: -1, width: 2, depth: 2 };

  function bothOrders(parts: ReadonlyArray<PartShapeAsset>, instances: ReadonlyArray<Instance>) {
    return [read(parts, instances, grid), read(parts, instances.toReversed(), grid)];
  }

  it("reads a tile set in a corner tile's notch as road whatever order the file lists them in", () => {
    const [first, reversed] = bothOrders(
      [cornerTile, tile],
      [
        { part: 0, transform: turned(0, [0, 0, 0]) },
        { part: 1, transform: turned(0, [10, 0, -10]) },
      ],
    );
    expect(rowsOf(first?.road ?? null)).toEqual(["RR", "RR"]);
    expect(reversed).toEqual(first);
  });

  it("reads a tile flush over a pocket's recessed stud as flat road with no stud, whatever the order", () => {
    const pocketed = part("pocketed", {
      min: [-30, 0, -10],
      max: [30, 2 * PLATE, 10],
      cells: ["fpf"],
      studs: [[0, PLATE, 0]],
    });
    const inlay = part("inlay tile", { min: [-10, 0, -10], max: [10, TILE, 10], cells: ["f"] });
    const parts = [pocketed, inlay];
    const instances = [
      { part: 0, transform: turned(0, [0, 0, 0]) },
      { part: 1, transform: turned(0, [0, PLATE, 0]) },
    ];
    const line = { cellX0: -1.5, cellZ0: -0.5, width: 3, depth: 1 };
    const first = read(parts, instances, line);
    const reversed = read(parts, instances.toReversed(), line);
    expect(rowsOf(first.road)).toEqual(["RRR"]);
    expect(first.road?.studSixteenths[1]).toBe(NO_STUD);
    expect(reversed).toEqual(first);
  });

  it("reads a pocket as no road when a part that isn't flat stands flush at the top over its recessed stud, whatever the order", () => {
    const pocketed = part("pocketed", {
      min: [-30, 0, -10],
      max: [30, 2 * PLATE, 10],
      cells: ["fpf"],
      studs: [[0, PLATE, 0]],
    });
    const grille = part("grille tile", { min: [-10, 0, -10], max: [10, TILE, 10], cells: ["."] });
    const instances = [
      { part: 0, transform: turned(0, [0, 0, 0]) },
      { part: 1, transform: turned(0, [0, PLATE, 0]) },
    ];
    const line = { cellX0: -1.5, cellZ0: -0.5, width: 3, depth: 1 };
    const first = read([pocketed, grille], instances, line);
    expect(rowsOf(first.road)).toEqual(["R.R"]);
    expect(read([pocketed, grille], instances.toReversed(), line)).toEqual(first);
  });

  it("reads a pocket as no road when a part sunk in it covers its recessed stud below the top", () => {
    const pocketed = part("pocketed", {
      min: [-30, 0, -10],
      max: [30, 2 * PLATE, 10],
      cells: ["fpf"],
      studs: [[0, 0, 0]],
    });
    const sunk = part("sunk tile", { min: [-10, 0, -10], max: [10, TILE, 10], cells: ["f"] });
    const { road } = read(
      [pocketed, sunk],
      [
        { part: 0, transform: turned(0, [0, 0, 0]) },
        { part: 1, transform: turned(0, [0, 0, 0]) },
      ],
      { cellX0: -1.5, cellZ0: -0.5, width: 3, depth: 1 },
    );
    expect(rowsOf(road)).toEqual(["R.R"]);
  });
});

describe("roadCells beside studs", () => {
  const tile = part("tile 1 x 1", { min: [-10, 0, -10], max: [10, TILE, 10], cells: ["f"] });
  const studded = part("plate 1 x 1", {
    min: [-10, 0, -10],
    max: [10, PLATE, 10],
    cells: ["f"],
    studs: [[0, PLATE, 0]],
  });
  const beside = (plateX: number) =>
    read(
      [tile, studded],
      [
        { part: 0, transform: turned(0, [0, 0, 0]) },
        { part: 1, transform: turned(0, [plateX, 0, 0]) },
      ],
      { cellX0: -0.5, cellZ0: -0.5, width: 2, depth: 1 },
    );

  it("keeps a tile's road beside a studded plate a stud away, however far within the identification residual the plate's position sits", () => {
    for (const plateX of [20, 19.9996, 20.0004, 19.9999]) {
      expect(rowsOf(beside(plateX).road), `${plateX}`).toEqual(["R."]);
    }
  });

  it("blocks the cells at its own height around a stud whose position doesn't identify to a sixteenth, rather than guess", () => {
    expect(beside(19.99).road).toBeNull();
  });

  it("leaves road at another height alone around a stud turned off the lattice", () => {
    const offCentre = part("plate 1 x 1, stud off its centre", {
      min: [-10, 0, -10],
      max: [10, PLATE, 10],
      cells: ["f"],
      studs: [[-10, PLATE, 0]],
    });
    const eighth = Math.SQRT1_2;
    const at = (plateY: number) =>
      read(
        [tile, offCentre],
        [
          { part: 0, transform: turned(0, [0, 0, 0]) },
          { part: 1, transform: [eighth, 0, eighth, 18, 0, 1, 0, plateY, -eighth, 0, eighth, 0] },
        ],
        { cellX0: -0.5, cellZ0: -0.5, width: 2, depth: 1 },
      );
    expect(rowsOf(at(3 * PLATE).road)).toEqual(["R."]);
    expect(rowsOf(at(-2 * PLATE).road)).toEqual(["R."]);
    expect(at(TILE - PLATE).road).toBeNull();
  });
});
