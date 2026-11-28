import { Container } from "inversify";
import { expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { SHEET_SETS } from "../tokens.ts";

function sheetSets() {
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: "unused",
      disclaimer: "unused",
      startSimWorker: () => new MessageChannel().port1,
    }),
  );
  return container.get(SHEET_SETS);
}

it("starts every plan with a main plan tiled at true scale and a table plan fitted to A3, as named layer sets", () => {
  const sets = sheetSets();
  expect(sets.sets("plan-1")).toEqual([
    {
      id: expect.any(String),
      name: "Main plan",
      content: "placements",
      layers: [
        "room",
        "aisles",
        "tables",
        "obstacles",
        "roadway",
        "models",
        "track",
        "ramps",
        "dimensions",
        "numbers",
      ],
      layout: { kind: "tiled", paper: "a4", orientation: "auto", denominator: 1, overlapMm: 10 },
      format: "pdf",
    },
    {
      id: expect.any(String),
      name: "Table plan",
      content: "tables",
      layers: ["room", "aisles", "tables", "obstacles", "dimensions", "table-numbers"],
      layout: { kind: "fit", paper: "a3", orientation: "auto" },
      format: "pdf",
    },
  ]);
});

it("adds, renames, re-layers and removes a plan's sheets without touching another plan's, telling subscribers each time", () => {
  const sets = sheetSets();
  const other = sets.sets("plan-2");
  let told = 0;
  const unsubscribe = sets.subscribe(() => told++);
  const yard = sets.add("plan-1");
  sets.update("plan-1", yard.id, {
    name: "Yard plan",
    layers: ["numbers", "track", "room", "track"],
    layout: { kind: "fit", paper: "letter", orientation: "landscape" },
  });
  const [main, tables] = sets.sets("plan-1");
  if (!main || !tables) throw new Error("the defaults are there");
  sets.remove("plan-1", tables.id);
  unsubscribe();
  sets.update("plan-1", main.id, { format: "svg" });

  expect(
    sets
      .sets("plan-1")
      .map(({ name, layers, layout, format }) => ({ name, layers, layout, format })),
  ).toEqual([
    { name: "Main plan", layers: main.layers, layout: main.layout, format: "svg" },
    {
      name: "Yard plan",
      layers: ["room", "track", "numbers"],
      layout: { kind: "fit", paper: "letter", orientation: "landscape" },
      format: "pdf",
    },
  ]);
  expect(yard.name).toBe("Sheet 3");
  expect(sets.sets("plan-2")).toEqual(other);
  expect({ told, version: sets.version() }).toEqual({ told: 3, version: 4 });
  expect(() => sets.update("plan-1", "no-such-sheet", { name: "x" })).toThrow(
    "no sheet set no-such-sheet",
  );
});
