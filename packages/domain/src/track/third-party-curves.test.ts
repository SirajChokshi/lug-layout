import { POSE16_IDENTITY } from "@brr/math";
import { TrackCatalog } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { expect, it } from "vitest";
import catalogJson from "../../../../docs/verified-facts/track-catalog.json" with { type: "json" };
import { TrackGraph } from "./track-graph.ts";
import { TrackLayout } from "./track-layout.ts";

const catalog = decodedOrThrow(decode(TrackCatalog, catalogJson), "track-catalog.json");
const specs = catalog.pieces.map((piece) => ({
  connectors: piece.connectors.map((connector) => connector.pose),
  routes: piece.routes.map(({ from, to }) => ({ from, to })),
}));
const STRAIGHT_9V = catalog.pieces.findIndex((piece) => piece.id === "ldraw:74746");
const CURVE_9V = catalog.pieces.findIndex((piece) => piece.id === "ldraw:74747");
const wideCurves = catalog.pieces.flatMap((piece, index) =>
  piece.thirdParty !== undefined && piece.kind === "curve" ? [index] : [],
);
const HALF_CIRCLE = 8;
const ENTRY = 0;
const EXIT = 1;
const STRAIGHT_COUNTS = [1, 4, 9];

function oval(firstHalf: number, secondHalf: number, straights: number): TrackGraph {
  const layout = new TrackLayout(specs);
  let last = layout.place(STRAIGHT_9V, POSE16_IDENTITY, 0);
  const lay = (piece: number, count: number): void => {
    for (let i = 0; i < count; i++) {
      last = layout.attach(piece, ENTRY, { placement: last, connector: EXIT });
    }
  };
  lay(STRAIGHT_9V, straights - 1);
  lay(firstHalf, HALF_CIRCLE);
  lay(STRAIGHT_9V, straights);
  lay(secondHalf, HALF_CIRCLE);
  return new TrackGraph(layout);
}

it("a wide third-party curve closes an oval with LEGO 9V straights on itself at any length, every end joined exactly", () => {
  expect(wideCurves.length).toBeGreaterThan(0);
  for (const curve of wideCurves) {
    for (const straights of STRAIGHT_COUNTS) {
      const graph = oval(curve, curve, straights);

      expect(graph.openEnds.length).toBe(0);
      expect(graph.issues).toEqual([]);
    }
  }
});

it("half circles of two different radii leave an oval open: its two ends miss each other and nothing joins them", () => {
  for (const curve of wideCurves) {
    const graph = oval(curve, CURVE_9V, STRAIGHT_COUNTS[1] ?? 1);

    expect(graph.openEnds.length).toBe(2);
    expect(graph.issues).toEqual([]);
  }
});
