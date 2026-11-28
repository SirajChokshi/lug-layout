import {
  mmRectInWorld,
  studsInside,
  type LduRect,
  type PlanRegion,
  type TableTop,
} from "@brr/domain";
import { lduFromMm, STUD_LDU } from "@brr/math";
import { Container } from "inversify";
import { describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import type { PlanSheet, SheetPlacement } from "../plan/plan-sheet.ts";
import { SHEET_COMPOSER } from "../tokens.ts";
import {
  boxesOverlap,
  composed,
  IDENTITY,
  type Box,
  type DrawItem,
  type Point,
  type Similarity,
} from "./draw-list.ts";
import {
  IMAGE_PIXELS_PER_MM,
  type SheetLayout,
  type SheetPage,
  type SheetSelection,
} from "./sheet-document.ts";
import { TABLE_PLAN_LAYERS, WHOLE_PLAN_SELECTION } from "./sheet-sets.ts";

const container = new Container();
container.load(
  ...mainThreadModules({
    bundleBaseUrl: "unused",
    disclaimer: "Not affiliated with any brick maker.",
    startSimWorker: () => new MessageChannel().port1,
  }),
);
const composer = container.get(SHEET_COMPOSER);

const REGION: PlanRegion = {
  id: "plan-1",
  name: "Club show",
  originChunkX: 0,
  originChunkZ: 0,
  footprint: {
    roomWidthMm: 3000,
    roomDepthMm: 1200,
    rooms: [],
    tables: [
      {
        id: "t1",
        name: "Front",
        number: 1,
        rect: { x: 200, z: 200, width: 1234, depth: 600 },
        heightMm: 800,
      },
      {
        id: "t2",
        name: "Back",
        number: 2,
        rect: { x: 1500, z: 200, width: 1200, depth: 600 },
        heightMm: 900,
      },
    ],
    obstacles: [],
    aisles: [],
  },
  maxOverhangMm: 0,
  maxReachMm: 700,
};

function at(x: number, z: number, width: number, depth: number): LduRect {
  return mmRectInWorld(REGION, { x, z, width, depth });
}

function tableTops(region: PlanRegion): TableTop[] {
  return region.footprint.tables.map((table) => ({
    id: table.id,
    name: table.name,
    number: table.number,
    heightMm: table.heightMm,
    surface: mmRectInWorld(region, table.rect),
    studs: studsInside(region, table.rect),
  }));
}

function square(x: number, z: number, side: number): SheetPlacement["rings"] {
  return [
    [
      [x, z],
      [x + side, z],
      [x + side, z + side],
      [x, z + side],
    ],
  ];
}

function sheetWith(placements: ReadonlyArray<SheetPlacement>): PlanSheet {
  return {
    name: REGION.name,
    originX: 0,
    originZ: 0,
    room: mmRectInWorld(REGION, { x: 0, z: 0, width: 3000, depth: 1200 }),
    tables: tableTops(REGION),
    obstacles: [],
    aisles: [],
    roadway: [],
    ramps: [],
    placements,
    partsList: { placements: placements.length, parts: placements.length, lines: 1, uncounted: 0 },
    verdict: { buildable: true, issues: 0, unmeasured: 0, notChecked: [], unchecked: null },
    disclaimer: "Not affiliated with any brick maker.",
  };
}

const COTTAGE: SheetPlacement = {
  number: 1,
  label: "my-cottage.ldr at 6800, 3400",
  parts: 13,
  segment: "model",
  rings: square(6800, 3400, 160),
  flagged: false,
};

const SHEET = sheetWith([COTTAGE]);

interface Drawn {
  readonly item: DrawItem;
  readonly transform: Similarity;
  readonly roles: ReadonlyArray<string>;
}

function walk(
  items: ReadonlyArray<DrawItem>,
  transform: Similarity = IDENTITY,
  roles: ReadonlyArray<string> = [],
): Drawn[] {
  return items.flatMap((item) =>
    item.kind === "group"
      ? walk(item.items, composed(transform, item.transform), [...roles, item.role])
      : [{ item, transform, roles }],
  );
}

function onPage(point: Point, transform: Similarity): Point {
  return [point[0] * transform.scale + transform.dx, point[1] * transform.scale + transform.dy];
}

function frameOf(page: SheetPage): Box {
  const frame = walk(page.items).find(({ item }) => item.kind === "rect" && item.role === "frame");
  if (!frame || frame.item.kind !== "rect") throw new Error(`${page.name} has no frame`);
  return frame.item.box;
}

function marksOn(page: SheetPage): Point[] {
  return walk(page.items).flatMap(({ item, transform }) =>
    item.kind === "circle" && item.role === "registration" ? [onPage(item.center, transform)] : [],
  );
}

function tablesOn(page: SheetPage): Box[] {
  return walk(page.items).flatMap(({ item, transform }) => {
    if (item.kind !== "rect" || item.role !== "table") return [];
    const [x, y] = onPage([item.box.x, item.box.y], transform);
    return [
      {
        x,
        y,
        width: item.box.width * transform.scale,
        height: item.box.height * transform.scale,
      },
    ];
  });
}

function tilePages(layout: SheetLayout, sheet: PlanSheet = SHEET): SheetPage[] {
  return composer
    .compose(sheet, layout, WHOLE_PLAN_SELECTION)
    .pages.filter((page) => /^[A-Z]+\d+$/u.test(page.name));
}

function titleLines(page: SheetPage): string[] {
  return walk(page.items).flatMap(({ item, roles }) =>
    item.kind === "text" && roles.includes("title-block") ? [item.text] : [],
  );
}

function sharedMarks(from: SheetPage, to: SheetPage, dx: number, dy: number): number {
  return marksOn(from).filter(([x, y]) =>
    marksOn(to).some(
      ([tx, ty]) => Math.abs(tx - (x - dx)) < 1e-9 && Math.abs(ty - (y - dy)) < 1e-9,
    ),
  ).length;
}

function tileGroup(page: SheetPage): { items: ReadonlyArray<DrawItem>; window: Box } {
  const group = page.items.find((item) => item.kind === "group" && item.role === "tile");
  if (!group || group.kind !== "group" || !group.clip) throw new Error(`${page.name} has no tile`);
  return { items: group.items, window: group.clip };
}

function cottageOn(page: SheetPage): Drawn | undefined {
  return walk(tileGroup(page).items).find(
    ({ item }) => item.kind === "path" && item.role === "model",
  );
}

const TILED: SheetLayout = {
  kind: "tiled",
  paper: "a4",
  orientation: "portrait",
  denominator: 1,
  overlapMm: 10,
};

describe("tiled sheets", () => {
  it("print every page on the paper chosen, with the plan at 0.4 mm per LDU, so a 1234 mm table measures 1234 mm across its pages", () => {
    const tiles = tilePages(TILED);
    expect(tiles.length).toBeGreaterThan(1);
    expect(new Set(tiles.map((page) => `${page.size.widthMm}×${page.size.heightMm}`))).toEqual(
      new Set(["210×297"]),
    );
    const front = tiles.flatMap(tablesOn).filter((table) => Math.abs(table.width - 1234) < 1e-9);
    expect(front.length).toBeGreaterThan(0);
    expect(new Set(front.map((table) => table.height.toFixed(9)))).toEqual(
      new Set(["600.000000000"]),
    );
  });

  it("put the marks a page shares with its right and lower neighbours at the same place on both, one window step apart, and never cut a mark off", () => {
    const tiles = tilePages(TILED);
    const byName = new Map(tiles.map((page) => [page.name, page]));
    const a1 = byName.get("A1");
    const b1 = byName.get("B1");
    const a2 = byName.get("A2");
    if (!a1 || !b1 || !a2) throw new Error("the tiling has at least two columns and two rows");
    const frame = frameOf(a1);
    const stepX = frame.width - TILED.overlapMm;
    const stepY = frame.height - TILED.overlapMm;
    expect(sharedMarks(a1, b1, stepX, 0)).toBeGreaterThanOrEqual(2);
    expect(sharedMarks(a1, a2, 0, stepY)).toBeGreaterThanOrEqual(2);
    const reach = TILED.overlapMm * 0.45;
    for (const page of tiles) {
      const box = frameOf(page);
      for (const [x, y] of marksOn(page)) {
        expect(x - reach).toBeGreaterThanOrEqual(box.x - 1e-9);
        expect(x + reach).toBeLessThanOrEqual(box.x + box.width + 1e-9);
        expect(y - reach).toBeGreaterThanOrEqual(box.y - 1e-9);
        expect(y + reach).toBeLessThanOrEqual(box.y + box.height + 1e-9);
      }
    }
  });

  it("carry each placement only on the pages whose window it reaches", () => {
    const tiles = tilePages(TILED);
    const carrying = tiles.filter((page) => cottageOn(page) !== undefined);
    const [first] = carrying;
    const drawn = first && cottageOn(first);
    if (!drawn || drawn.item.kind !== "path") throw new Error("some page carries the cottage");
    const corners = drawn.item.rings.flat().map((point) => onPage(point, drawn.transform));
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    const stroke = drawn.item.paint.strokeMm / 2;
    const footprint: Box = {
      x: Math.min(...xs) - stroke,
      y: Math.min(...ys) - stroke,
      width: Math.max(...xs) - Math.min(...xs) + 2 * stroke,
      height: Math.max(...ys) - Math.min(...ys) + 2 * stroke,
    };
    const reached = tiles.filter((page) => boxesOverlap(tileGroup(page).window, footprint));
    expect(carrying.length).toBeGreaterThan(0);
    expect(carrying.length).toBeLessThan(tiles.length);
    expect(carrying.map((page) => page.name)).toEqual(reached.map((page) => page.name));
  });

  it("shrink the plan by the chosen ISO 5455 scale and need fewer pages at 1:5", () => {
    const life = tilePages(TILED);
    const fifth = tilePages({ ...TILED, denominator: 5 });
    const front = fifth
      .flatMap(tablesOn)
      .filter((table) => Math.abs(table.width - 1234 / 5) < 1e-9);
    expect(front.length).toBeGreaterThan(0);
    expect(fifth.length).toBeLessThan(life.length);
  });

  it("turn the paper to the orientation that needs fewer pages when left to choose", () => {
    const auto = tilePages({ ...TILED, orientation: "auto", denominator: 5 });
    const portrait = tilePages({ ...TILED, orientation: "portrait", denominator: 5 });
    const landscape = tilePages({ ...TILED, orientation: "landscape", denominator: 5 });
    expect(auto.length).toBe(Math.min(portrait.length, landscape.length));
    expect(auto[0]?.size).toEqual(
      landscape.length < portrait.length ? landscape[0]?.size : portrait[0]?.size,
    );
  });

  it("refuse an overlap the registration marks can't fit in, and a scale off the ISO series", () => {
    expect(() => composer.compose(SHEET, { ...TILED, overlapMm: 2 }, WHOLE_PLAN_SELECTION)).toThrow(
      RangeError,
    );
    expect(() =>
      composer.compose(SHEET, { ...TILED, denominator: 3 }, WHOLE_PLAN_SELECTION),
    ).toThrow(RangeError);
  });
});

describe("a sheet fitted to one page", () => {
  it("draws at the largest ISO 5455 scale whose drawing fits the paper, says so, and stays inside the margins", () => {
    const [page] = composer.compose(
      SHEET,
      { kind: "fit", paper: "a4", orientation: "auto" },
      WHOLE_PLAN_SELECTION,
    ).pages;
    if (!page) throw new Error("a fitted sheet has a page");
    expect(page.size).toEqual({ widthMm: 297, heightMm: 210 });
    expect(titleLines(page).join(" ")).toContain("drawn at 1:20 to fit one A4 page (landscape)");
    const tables = tablesOn(page);
    expect(tables.map((table) => table.width.toFixed(9))).toEqual(
      [1234 / 20, 1200 / 20].map((width) => width.toFixed(9)),
    );
    for (const { item, transform } of walk(page.items)) {
      if (item.kind !== "rect" || item.role === "page") continue;
      const [x, y] = onPage([item.box.x, item.box.y], transform);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + item.box.width * transform.scale).toBeLessThanOrEqual(page.size.widthMm);
      expect(y + item.box.height * transform.scale).toBeLessThanOrEqual(page.size.heightMm);
    }
  });

  it("turns the page whichever way keeps the key on it when the drawing fits both ways at the same scale", () => {
    const placements = Array.from({ length: 30 }, (_, i): SheetPlacement => ({
      number: i + 1,
      label: `3811 Baseplate 32 x 32, Green at stud ${i * 32}, 0`,
      parts: 1,
      segment: "model",
      rings: square(i * 40, 0, 40),
      flagged: false,
    }));
    const squareRoom: PlanSheet = {
      ...sheetWith(placements),
      room: at(0, 0, 1200, 1200),
      tables: [],
    };
    const fitted = (["portrait", "landscape", "auto"] as const).map(
      (orientation) =>
        composer.compose(
          squareRoom,
          { kind: "fit", paper: "a3", orientation },
          WHOLE_PLAN_SELECTION,
        ).pages,
    );

    expect({
      scales: fitted.map(
        ([page]) => /drawn at (1:\d+)/u.exec(page ? titleLines(page).join(" ") : "")?.[1],
      ),
      pages: fitted.map((pages) => pages.length),
      auto: fitted[2]?.[0]?.size,
    }).toEqual({
      scales: ["1:10", "1:10", "1:10"],
      pages: [2, 1, 1],
      auto: { widthMm: 420, heightMm: 297 },
    });
  });

  it("flows a long key onto continuation pages, listing every placement once and in order", () => {
    const many = Array.from({ length: 150 }, (_, i): SheetPlacement => ({
      number: i + 1,
      label: `Train Track 9V Straight #${i + 1}`,
      parts: 1,
      segment: "track",
      rings: square(400 + (i % 30) * 160, 800 + Math.floor(i / 30) * 160, 160),
      flagged: false,
    }));
    const pages = composer.compose(
      sheetWith(many),
      { kind: "fit", paper: "a4", orientation: "portrait" },
      WHOLE_PLAN_SELECTION,
    ).pages;
    const listed = pages.flatMap((page) =>
      walk(page.items).flatMap(({ item, roles }) =>
        roles.includes("key") &&
        item.kind === "text" &&
        item.style.bold &&
        item.at[0] === 0 &&
        /^\d+$/u.test(item.text)
          ? [Number(item.text)]
          : [],
      ),
    );
    expect(pages.length).toBeGreaterThan(1);
    expect(listed).toEqual(many.map((placement) => placement.number));
  });
});

describe("an image", () => {
  it("draws the plan so a stud is the chosen whole pixels at the PNG's density, and states its check bar in pixels", () => {
    const counts = [1, 3, 8, 32];
    const drawn = counts.map((pixelsPerStud) => {
      const { pages } = composer.compose(
        SHEET,
        { kind: "image", pixelsPerStud },
        WHOLE_PLAN_SELECTION,
      );
      const [page] = pages;
      if (!page || pages.length !== 1) throw new Error("an image is one page");
      const title = titleLines(page).join(" ");
      return {
        tablesPx: tablesOn(page).map((table) =>
          [table.width, table.height].map((mm) => (mm * IMAGE_PIXELS_PER_MM).toFixed(9)),
        ),
        scale: title.includes(`drawn at ${pixelsPerStud} px per stud`),
        printAdvice: title.includes("100%"),
      };
    });
    const [eight] = composer.compose(
      SHEET,
      { kind: "image", pixelsPerStud: 8 },
      WHOLE_PLAN_SELECTION,
    ).pages;
    expect(drawn).toEqual(
      counts.map((pixelsPerStud) => ({
        tablesPx: REGION.footprint.tables.map((table) =>
          [table.rect.width, table.rect.depth].map((mm) =>
            ((lduFromMm(mm) / STUD_LDU) * pixelsPerStud).toFixed(9),
          ),
        ),
        scale: true,
        printAdvice: false,
      })),
    );
    expect(eight && titleLines(eight)).toContain(
      "this bar is 256 px at 4 px per mm: 32 studs · 25.6 cm",
    );
  });

  it("refuses a pixel count that isn't whole, or is past the one that draws at 1:1", () => {
    for (const pixelsPerStud of [0, 2.5, 33]) {
      expect(() =>
        composer.compose(SHEET, { kind: "image", pixelsPerStud }, WHOLE_PLAN_SELECTION),
      ).toThrow(RangeError);
    }
  });
});

const SHOW: PlanRegion = {
  ...REGION,
  footprint: {
    ...REGION.footprint,
    tables: [
      ...REGION.footprint.tables,
      {
        id: "t3",
        name: "Side",
        number: 3,
        rect: { x: 200, z: 900, width: 600, depth: 200 },
        heightMm: 800,
      },
    ],
  },
};

const TRACK_PIECE: SheetPlacement = {
  number: 2,
  label: "Train Track 9V Straight #1",
  parts: 1,
  segment: "track",
  rings: square(4000, 2000, 160),
  flagged: false,
};

const TABLE_PLAN: SheetSelection = {
  name: "Table plan",
  content: "tables",
  layers: TABLE_PLAN_LAYERS,
};

function legendLabels(page: SheetPage): string[] {
  return walk(page.items).flatMap(({ item }) =>
    item.kind === "text" && item.role === "legend" ? [item.text] : [],
  );
}

function textsIn(page: SheetPage, role: string): string[] {
  return walk(page.items).flatMap(({ item, roles }) =>
    item.kind === "text" && roles.includes(role) ? [item.text] : [],
  );
}

describe("sheet sets", () => {
  it("draw a table plan: tables coloured by height and numbered at their centres, a schedule of each table, and a legend of heights", () => {
    const sheet = { ...sheetWith([COTTAGE, TRACK_PIECE]), tables: tableTops(SHOW) };
    const [page] = composer.compose(
      sheet,
      { kind: "fit", paper: "a3", orientation: "auto" },
      TABLE_PLAN,
    ).pages;
    if (!page) throw new Error("a fitted sheet has a page");
    const drawn = walk(page.items);
    const fills = drawn.flatMap(({ item }) =>
      item.kind === "rect" && item.role === "table" ? [JSON.stringify(item.paint.fill)] : [],
    );
    const tables = tablesOn(page);
    const badges = drawn.flatMap(({ item, transform }) =>
      item.kind === "circle" && item.role === "table-number"
        ? [onPage(item.center, transform)]
        : [],
    );
    const schedule = textsIn(page, "key");
    const studs = SHOW.footprint.tables.map((table) => studsInside(SHOW, table.rect));
    expect(fills).toHaveLength(3);
    expect(fills[0]).toBe(fills[2]);
    expect(fills[1]).not.toBe(fills[0]);
    expect(badges.map(([x, y]) => [x.toFixed(6), y.toFixed(6)])).toEqual(
      tables.map((table) => [
        (table.x + table.width / 2).toFixed(6),
        (table.y + table.height / 2).toFixed(6),
      ]),
    );
    expect(textsIn(page, "drawing").filter((t) => /^\d+$/u.test(t))).toEqual(["1", "2", "3"]);
    expect(schedule.slice(0, 7)).toEqual([
      "Tables: numbers on the plan",
      "No.",
      "Height",
      "Size",
      "Studs on the lattice",
      "From left, back wall",
      "Table",
    ]);
    expect(schedule.slice(7, 13)).toEqual([
      "1",
      "80 cm",
      "123.4 × 60 cm",
      `${studs[0]?.studsWide} × ${studs[0]?.studsDeep}`,
      "20, 20 cm",
      "Front",
    ]);
    expect(schedule).toContain("3 tables at 2 heights");
    expect(legendLabels(page)).toEqual([
      "Room walls",
      "Dimension in studs and cm",
      "Table number (see schedule)",
      "Table, 80 cm high",
      "Table, 90 cm high",
    ]);
    expect(titleLines(page)[0]).toBe("Table plan · Club show");
    expect(drawn.some(({ item }) => item.role === "model" || item.role === "number")).toBe(false);
  });

  it("draw each obstacle by its kind and each aisle by its side: only obstacles that block are hatched, a power point is a filled marker, the public aisle is dashed, every aisle is labelled with its side, and the legend lists the kinds and sides shown", () => {
    const sheet: PlanSheet = {
      ...sheetWith([]),
      obstacles: [
        { name: "Pillar A", rect: at(0, 0, 200, 200), kind: "pillar" },
        { name: "Fire door", rect: at(2800, 1100, 200, 100), kind: "door" },
        { name: "Socket", rect: at(300, 300, 100, 100), kind: "power" },
      ],
      aisles: [
        { name: "Visitors", rect: at(200, 800, 2500, 400), side: "public" },
        { name: "Pit", rect: at(200, 0, 2500, 200), side: "crew" },
      ],
    };
    const [page] = composer.compose(
      sheet,
      { kind: "fit", paper: "a3", orientation: "auto" },
      TABLE_PLAN,
    ).pages;
    if (!page) throw new Error("a fitted sheet has a page");
    const drawn = walk(page.items);
    const inLayer = (layer: string) =>
      drawn.filter(({ roles }) => roles.includes(`layer-${layer}`)).map(({ item }) => item);
    const areas = [...inLayer("aisles"), ...inLayer("obstacles")].flatMap((item) =>
      item.kind === "rect"
        ? [
            {
              role: item.role,
              filled: item.paint.fill !== null,
              dashed: item.paint.dashMm.length > 0,
            },
          ]
        : [],
    );

    expect(inLayer("obstacles").map((item) => item.role)).toEqual([
      "obstacle pillar",
      "hatch",
      "obstacle door",
      "hatch",
      "obstacle power",
    ]);
    expect(areas).toEqual([
      { role: "aisle public", filled: true, dashed: true },
      { role: "aisle crew", filled: true, dashed: false },
      { role: "obstacle pillar", filled: false, dashed: false },
      { role: "obstacle door", filled: false, dashed: false },
      { role: "obstacle power", filled: true, dashed: false },
    ]);
    expect(textsIn(page, "layer-dimensions")).toEqual(
      expect.arrayContaining([
        "Pillar A",
        "Fire door",
        "Socket",
        "Visitors · public",
        "Pit · crew",
      ]),
    );
    expect(legendLabels(page)).toEqual([
      "Room walls",
      "Public aisle",
      "Crew aisle (reach)",
      "Pillar (keep clear)",
      "Door (keep clear)",
      "Power point (marker)",
      "Dimension in studs and cm",
      "Table number (see schedule)",
      "Table, 80 cm high",
      "Table, 90 cm high",
    ]);
  });

  it("draw only the layers a sheet set names, and list only the placements those layers show, under their plan numbers", () => {
    const [page] = composer.compose(
      sheetWith([COTTAGE, TRACK_PIECE]),
      { kind: "whole" },
      { name: "Track only", content: "placements", layers: ["room", "track", "numbers"] },
    ).pages;
    if (!page) throw new Error("a whole sheet has a page");
    const roles = new Set(walk(page.items).map(({ item }) => item.role));
    const key = textsIn(page, "key");
    expect({
      table: roles.has("table"),
      model: roles.has("model"),
      track: roles.has("track"),
      room: roles.has("room"),
    }).toEqual({ table: false, model: false, track: true, room: true });
    expect(legendLabels(page)).toEqual([
      "Room walls",
      "Track piece outline",
      "Placement number (see key)",
    ]);
    const badges = walk(page.items).flatMap(({ item, roles: groups }) =>
      item.kind === "text" && item.role === "number" && groups.includes("layer-numbers")
        ? [item.text]
        : [],
    );
    expect(badges).toEqual(["2"]);
    expect(key.slice(4, 7)).toEqual(["2", "1", "Train Track 9V Straight #1"]);
    expect(key).not.toContain(COTTAGE.label);
  });
});
