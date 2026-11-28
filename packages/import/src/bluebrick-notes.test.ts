import { readFile } from "node:fs/promises";
import type {
  BlueBrickAreaLayer,
  BlueBrickLayer,
  BlueBrickMap,
  BlueBrickRuler,
  BlueBrickTextCell,
} from "@brr/schema/bluebrick";
import { BASE_LAYER, ZONE_VERTEX_MAX, type ZoneNoteV2 } from "@brr/schema/world";
import { expect, it } from "vitest";
import { blueBrickNotes } from "./bluebrick-notes.ts";
import { BrickCompiler } from "./brick-compiler.ts";

const bundleRoot = new URL("../../../tools/asset-pipeline/dist/bundle/standard/", import.meta.url);
const blueBrickFixtures = new URL("../../test-fixtures/bluebrick/", import.meta.url);
const STUD = 20;
const SEED = 0x5a0e;
const LONGER_THAN_A_LABEL = "x".repeat(201);

type Cell = readonly [number, number, number];

async function readFixture(file: string): Promise<BlueBrickMap> {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", bundleRoot), "utf8")) as {
    readonly compiler: { readonly file: string };
  };
  const compiler = new BrickCompiler(
    new WebAssembly.Module(await readFile(new URL(manifest.compiler.file, bundleRoot))),
  );
  const read = compiler.readBlueBrick(await readFile(new URL(file, blueBrickFixtures)));
  if (read.status !== "read") throw new Error(`${file}: ${read.message}`);
  return read.map;
}

function layerOf<K extends BlueBrickLayer["kind"]>(
  map: BlueBrickMap,
  kind: K,
): Extract<BlueBrickLayer, { kind: K }> {
  const layer = map.layers.find(
    (candidate): candidate is Extract<BlueBrickLayer, { kind: K }> => candidate.kind === kind,
  );
  if (!layer) throw new Error(`the map has no ${kind} layer`);
  return layer;
}

function withLayers(map: BlueBrickMap, layers: ReadonlyArray<BlueBrickLayer>): BlueBrickMap {
  return { ...map, layers, issues: [] };
}

function inside(outline: ReadonlyArray<readonly [number, number]>, x: number, z: number): boolean {
  let crossings = 0;
  outline.forEach(([ax, az], i) => {
    const [bx, bz] = outline[(i + 1) % outline.length] ?? [ax, az];
    if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) crossings++;
  });
  return crossings % 2 === 1;
}

function areaOf(outline: ReadonlyArray<readonly [number, number]>): number {
  let twice = 0;
  outline.forEach(([ax, az], i) => {
    const [bx, bz] = outline[(i + 1) % outline.length] ?? [ax, az];
    twice += ax * bz - bx * az;
  });
  return Math.abs(twice) / 2;
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state / 2 ** 32;
  };
}

function pointInStuds([x = 0, z = 0]: number[]): object {
  return { on: "point", x: x * STUD, z: z * STUD };
}

function rulerInStuds(index: number, from: number[], to: number[], color: string): object {
  return { kind: "ruler", index, layer: 3, from: pointInStuds(from), to: pointInStuds(to), color };
}

function centreMovedInStuds(item: number, dx: number, dz: number): object {
  return {
    kind: "moved",
    layer: 3,
    item,
    at: "center",
    dx: expect.closeTo(dx * STUD, 9),
    dz: expect.closeTo(dz * STUD, 9),
  };
}

function ring(): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (let x = 0; x < 3; x++)
    for (let y = 0; y < 3; y++) if (x !== 1 || y !== 1) cells.push([x, y]);
  return cells;
}

function staircase(steps: number): Array<[number, number]> {
  return Array.from({ length: steps }, (_, i): Array<[number, number]> => [
    [i, i],
    [i + 1, i],
  ]).flat();
}

it("a real show layout keeps its layers, labels, rulers and event, and reports what moved", async () => {
  const notes = blueBrickNotes(await readFixture("fordyce-2026.bbm"));
  expect(notes.layers).toEqual([
    { id: 0, name: "Tables", kind: "parts", visible: true, locked: false, opacity: 100 },
    { id: 1, name: "Tracks", kind: "parts", visible: true, locked: false, opacity: 80 },
    { id: 2, name: "labels", kind: "notes", visible: true, locked: false, opacity: 100 },
    { id: 3, name: "rulers", kind: "notes", visible: true, locked: false, opacity: 100 },
  ]);
  expect(notes.layerIds).toEqual([null, 0, 1, 2, 3]);
  expect(notes.event).toEqual({
    author: "Aaron Kimbrell",
    club: "ArkLUG",
    event: "Fordyce 2026",
    startDate: "2026-04-24",
  });
  const label = { kind: "text", layer: 2, heightStuds: 24, color: "#000000" };
  expect(notes.notes).toEqual([
    { ...label, index: 0, text: "Nikki", x: 927 * STUD, z: 112 * STUD, rot: 0 },
    { ...label, index: 1, text: "Brad", x: 1361 * STUD, z: 447 * STUD, rot: 3 },
    { ...label, index: 2, text: "Yard", x: 734 * STUD, z: 781 * STUD, rot: 0 },
    rulerInStuds(3, [1440, 64], [64, 64], "#000000"),
    rulerInStuds(4, [64, 832], [64, 60], "#000000"),
    rulerInStuds(5, [736, 80], [1120, 80], "#ff0000"),
    rulerInStuds(6, [1344, 736], [1344, 160], "#00ff40"),
    rulerInStuds(7, [1120, 768], [352, 768], "#000000"),
  ]);
  expect(notes.issues).toEqual([
    { kind: "gridLayer", layer: 0 },
    centreMovedInStuds(0, 927 - 926.8369, 112 - 112.31236),
    centreMovedInStuds(1, 1361 - 1360.749, 447 - 446.7565),
    centreMovedInStuds(2, 734 - 734.2629, 781 - 781.4315),
  ]);
});

it("a synthetic yard of official parts brings its zones, hidden layer, turned label and ruler ends", async () => {
  const notes = blueBrickNotes(await readFixture("synthetic-yard.bbm"));
  expect(
    notes.layers.map(({ id, name, kind, visible, opacity }) => [id, name, kind, visible, opacity]),
  ).toEqual([
    [0, "Baseplates", "parts", true, 80],
    [1, "Track", "parts", true, 100],
    [2, "Zones", "notes", false, 30],
    [3, "Labels", "notes", true, 100],
    [4, "Measures", "notes", true, 100],
  ]);
  expect(notes.event).toEqual({
    author: "Brick Railroad",
    club: "Synthetic LUG",
    event: "Yard & siding test",
    startDate: "2024-02-29",
    comment:
      "Built by hand from official LDraw parts:\n3811 baseplates, 53401 straights and a 53400 curve.",
  });
  const cell = 8 * STUD;
  expect(notes.notes).toEqual([
    {
      kind: "zone",
      index: 0,
      layer: 2,
      name: "Zones",
      color: "#228b22",
      outline: [
        [-cell, 3 * cell],
        [cell, 3 * cell],
        [cell, 4 * cell],
        [-cell, 4 * cell],
      ],
    },
    {
      kind: "zone",
      index: 1,
      layer: 2,
      name: "Zones",
      color: "#ffa500",
      outline: [
        [0, 4 * cell],
        [cell, 4 * cell],
        [cell, 5 * cell],
        [0, 5 * cell],
      ],
    },
    {
      kind: "text",
      index: 2,
      layer: 3,
      text: "Yard lead\n<siding>",
      x: 16 * STUD,
      z: 28 * STUD,
      rot: 1,
      heightStuds: 14,
      color: "#123456",
    },
    {
      kind: "ruler",
      index: 3,
      layer: 4,
      from: { on: "point", x: 8 * STUD, z: 16 * STUD },
      to: { on: "point", x: 56 * STUD, z: 16 * STUD },
      color: "#000000",
    },
  ]);
  expect(notes.issues).toEqual([
    { kind: "gridLayer", layer: 0 },
    {
      kind: "moved",
      layer: 4,
      item: 0,
      at: "center",
      dx: (16 - 16.25) * STUD,
      dz: (28 - 27.625) * STUD,
    },
    { kind: "detached", layer: 5, item: 0, end: "from", brick: { layer: 2, brick: 0 } },
    { kind: "circularRuler", layer: 5, item: 1 },
  ]);
});

it("area cells become hole-free zones that cover exactly the painted cells", async () => {
  const yard = await readFixture("synthetic-yard.bbm");
  const template = layerOf(yard, "area");
  const random = seeded(SEED);
  const randomFill = (colors: number, density: number): Cell[] => {
    const cells: Cell[] = [];
    for (let x = -8; x < 8; x++) {
      for (let y = -8; y < 8; y++) {
        if (random() < density) cells.push([x, y, Math.floor(random() * colors)]);
      }
    }
    return cells;
  };
  const shapes: ReadonlyArray<{ cellSize: number; cells: ReadonlyArray<Cell> }> = [
    { cellSize: 1, cells: ring().map(([x, y]) => [x, y, 0]) },
    {
      cellSize: 4,
      cells: [
        [1, 0, 0],
        [2, 0, 0],
        [0, 1, 0],
        [2, 1, 0],
        [0, 2, 0],
        [1, 2, 0],
        [2, 2, 0],
        [1, 1, 1],
      ],
    },
    { cellSize: 2, cells: staircase(1100).map(([x, y]) => [x, y, 0]) },
    ...Array.from({ length: 12 }, (_, i) => ({
      cellSize: 1 + (i % 3) * 15,
      cells: randomFill(1 + (i % 3), 0.55 + (i % 4) * 0.1),
    })),
  ];
  for (const { cellSize, cells } of shapes) {
    const area: BlueBrickAreaLayer = {
      ...template,
      cellSize,
      cells: cells.map(([x, y, color]) => ({ x, y, rgb: 0x10_2030 * (color + 1) })),
    };
    const notes = blueBrickNotes(withLayers(yard, [area]));
    const zones = notes.notes.filter((note): note is ZoneNoteV2 => note.kind === "zone");
    expect(zones.length).toBe(notes.notes.length);
    expect(notes.issues).toEqual([]);
    const size = cellSize * STUD;
    const wrong: string[] = [];
    const paintedArea = new Map<string, number>();
    for (const { x, y, rgb } of area.cells) {
      const color = `#${rgb.toString(16).padStart(6, "0")}`;
      paintedArea.set(color, (paintedArea.get(color) ?? 0) + size * size);
      const covering = zones.filter((zone) =>
        inside(zone.outline, (x + 0.5) * size, (y + 0.5) * size),
      );
      if (covering.length !== 1 || covering[0]?.color !== color) wrong.push(`${x},${y}`);
    }
    const zoneArea = new Map<string, number>();
    for (const { color, outline } of zones) {
      expect(outline.length).toBeLessThanOrEqual(ZONE_VERTEX_MAX);
      expect(new Set(outline.map(String)).size).toBe(outline.length);
      zoneArea.set(color, (zoneArea.get(color) ?? 0) + areaOf(outline));
    }
    expect(wrong).toEqual([]);
    expect(zoneArea).toEqual(paintedArea);
  }
  const lShape = blueBrickNotes(
    withLayers(yard, [
      {
        ...template,
        cells: [0, 1, 2].map((y) => ({ x: 0, y, rgb: 1 })).concat({ x: 1, y: 2, rgb: 1 }),
      },
    ]),
  );
  expect(lShape.notes.map((note) => note.kind === "zone" && note.outline.length)).toEqual([6]);
});

it("what can't come over is reported: unknown colours, empty labels, rulers measuring nothing, odd turns", async () => {
  const yard = await readFixture("synthetic-yard.bbm");
  const texts = layerOf(yard, "text");
  const rulers = layerOf(yard, "ruler");
  const [text] = texts.texts;
  const [linear] = rulers.rulers;
  if (!text || linear?.shape !== "linear") throw new Error("the yard lost its label or ruler");
  const labels: ReadonlyArray<BlueBrickTextCell> = [
    { ...text, color: { kind: "named", name: "WindowText" } },
    { ...text, text: "  " },
    { ...text, orientation: "45" },
  ];
  const measures: ReadonlyArray<BlueBrickRuler> = [
    { ...linear, fromAttachment: null, to: { x: "8.01", y: "16.01" } },
    { ...linear, fromAttachment: null, color: { kind: "named", name: "cornflowerblue" } },
  ];
  const notes = blueBrickNotes(
    withLayers(yard, [
      { ...texts, texts: labels },
      { ...rulers, rulers: measures, groups: [] },
    ]),
  );
  expect(notes.layers).toEqual([
    BASE_LAYER,
    { id: 1, name: "Labels", kind: "notes", visible: true, locked: false, opacity: 100 },
    { id: 2, name: "Measures", kind: "notes", visible: true, locked: false, opacity: 100 },
  ]);
  expect(notes.notes).toEqual([
    expect.objectContaining({ kind: "text", index: 0, layer: 1, rot: 3 }),
    expect.objectContaining({ kind: "ruler", index: 1, layer: 2, color: "#6495ed" }),
  ]);
  expect(notes.issues).toEqual([
    { kind: "unknownColor", layer: 0, item: 0, name: "WindowText" },
    {
      kind: "refused",
      layer: 0,
      item: 1,
      reason: expect.stringContaining("layers[0][1].text: must be 1 to 4000 characters"),
    },
    expect.objectContaining({ kind: "moved", layer: 0, item: 2 }),
    { kind: "turned", layer: 0, item: 2, degrees: "45" },
    {
      kind: "refused",
      layer: 1,
      item: 0,
      reason: expect.stringContaining("the ruler measures nothing"),
    },
  ]);
});

it("map properties and layer names the world can't hold are reported and the rest kept", async () => {
  const yard = await readFixture("synthetic-yard.bbm");
  const notes = blueBrickNotes({
    ...yard,
    properties: {
      ...yard.properties,
      author: LONGER_THAN_A_LABEL,
      date: { year: 2026, month: 13, day: 1 },
    },
    layers: yard.layers.map((layer, position) =>
      position === 1
        ? { ...layer, name: "" }
        : position === 3
          ? { ...layer, name: LONGER_THAN_A_LABEL }
          : layer,
    ),
  });
  expect(notes.event).toEqual({
    club: "Synthetic LUG",
    event: "Yard & siding test",
    comment: yard.properties.comment,
  });
  expect(notes.layers.map((layer) => layer.name)).toEqual([
    "Layer 2",
    "Track",
    "Layer 4",
    "Labels",
    "Measures",
  ]);
  expect(
    notes.issues.filter((issue) => issue.kind === "renamedLayer" || issue.kind === "eventField"),
  ).toEqual([
    { kind: "renamedLayer", layer: 3, name: "Layer 4" },
    {
      kind: "eventField",
      field: "author",
      reason: expect.stringContaining("event.author: must be 1 to 200 characters"),
    },
    { kind: "eventField", field: "startDate", reason: "event.startDate: is not a calendar date" },
  ]);
});
