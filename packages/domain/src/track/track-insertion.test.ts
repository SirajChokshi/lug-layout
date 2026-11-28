import { POSE16_IDENTITY, ZETA16_ORDER, attachPose16 } from "@brr/math";
import { TrackCatalog, type TrackPiece } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { expect, it } from "vitest";
import catalogJson from "../../../../docs/verified-facts/track-catalog.json" with { type: "json" };
import { NO_END, TrackGraph } from "./track-graph.ts";
import { pieceArrangement } from "./track-arrangement.ts";
import { trackInsertions, type TrackInsertion } from "./track-insertion.ts";
import { TrackLayout } from "./track-layout.ts";
import { trackMove } from "./track-pose.ts";

const catalog = decodedOrThrow(decode(TrackCatalog, catalogJson), "track-catalog.json");
const pieces = catalog.pieces.filter(
  (piece) => piece.system === "lego-9v" && piece.status === "certified",
);
const specs = pieces.map((piece) => ({
  connectors: piece.connectors.map((connector) => connector.pose),
  routes: piece.routes.map(({ from, to }) => ({ from, to })),
}));

function indexOfKind(kind: TrackPiece["kind"]): number {
  const index = pieces.findIndex((piece) => piece.kind === kind);
  if (index < 0) throw new Error(`the certified 9V catalog has no ${kind}`);
  return index;
}

const STRAIGHT = indexOfKind("straight");
const CURVE = indexOfKind("curve");
const SWITCH = indexOfKind("switch");
const CROSSING = indexOfKind("crossing");
const ENTRY = 0;
const EXIT = 1;
const RUN = 7;
const RAMP_RISE = 2;
const LAID_BEFORE_THE_MODEL = 3;

function run(count: number, piece = STRAIGHT): TrackLayout {
  const layout = new TrackLayout(specs);
  let last = layout.place(piece, POSE16_IDENTITY, 0);
  for (let i = 1; i < count; i++) {
    last = layout.attach(piece, ENTRY, { placement: last, connector: EXIT });
  }
  return layout;
}

function single(piece: number) {
  return pieceArrangement(piece, specs[piece]?.connectors ?? []);
}

function inserted(layout: TrackLayout, piece: number, insertion: TrackInsertion): TrackGraph {
  const after = new TrackLayout(specs);
  for (let p = 0; p < layout.count; p++) {
    if (insertion.replaces.has(p)) continue;
    after.place(layout.piece(p), layout.pose(p), layout.yPlates(p), layout.rise(p));
  }
  after.place(piece, insertion.placement, insertion.yPlates);
  return new TrackGraph(after);
}

function joinsOfLast(graph: TrackGraph): number {
  const last = graph.placementCount - 1;
  let joins = 0;
  for (let end = graph.endStart[last] ?? 0; end < (graph.endStart[last + 1] ?? 0); end++) {
    if ((graph.endPartner[end] ?? NO_END) !== NO_END) joins++;
  }
  return joins;
}

it("drops a 9V switch into a run of straights, either way along it, in place of the two straights its route covers, keeping both outer joins", () => {
  const straights = run(RUN);
  const before = new TrackGraph(straights);

  for (let through = 0; through < RUN; through++) {
    const found = trackInsertions(before, straights, straights.count, through, single(SWITCH));
    const headings = new Set(found.map((insertion) => insertion.placement.heading));

    expect(headings.size).toBe(2);
    for (const insertion of found) {
      const after = inserted(straights, SWITCH, insertion);
      expect(insertion.replaces.size).toBe(2);
      expect(insertion.replaces.has(through)).toBe(true);
      expect(after.issues).toEqual([]);
      expect(joinsOfLast(after)).toBe(insertion.joins);
      expect(after.joinCount).toBe(before.joinCount - 1);
      expect(after.openEnds.length).toBe(before.openEnds.length + 1);
    }
  }
});

it("drops a crossing in place of one straight, joining both neighbours, and offers nothing for a straight held over a straight", () => {
  const straights = run(RUN);
  const before = new TrackGraph(straights);
  const middle = (RUN - 1) / 2;

  const crossings = trackInsertions(before, straights, straights.count, middle, single(CROSSING));

  expect(crossings.length).toBeGreaterThan(0);
  for (const insertion of crossings) {
    const after = inserted(straights, CROSSING, insertion);
    expect([...insertion.replaces]).toEqual([middle]);
    expect(after.issues).toEqual([]);
    expect(joinsOfLast(after)).toBe(2);
    expect(after.joinCount).toBe(before.joinCount);
  }
  expect(trackInsertions(before, straights, straights.count, middle, single(STRAIGHT))).toEqual([]);
});

it("lifts nothing across a circle of curves, a model's own track, or a ramp in the run", () => {
  const curveTurn = trackMove(
    { id: pieces[CURVE]?.id ?? "", connectors: specs[CURVE]?.connectors ?? [] },
    ENTRY,
    EXIT,
  ).turn;
  const circle = run(ZETA16_ORDER / curveTurn, CURVE);
  const straights = run(RUN);
  const graph = new TrackGraph(straights);
  const ramped = run(LAID_BEFORE_THE_MODEL);
  const entry = specs[STRAIGHT]?.connectors[ENTRY];
  if (!entry) throw new Error("the straight has no entry connector");
  const ramp = ramped.place(
    STRAIGHT,
    attachPose16(entry, ramped.connectorPose(LAID_BEFORE_THE_MODEL - 1, EXIT)),
    0,
    RAMP_RISE,
  );
  ramped.attach(STRAIGHT, ENTRY, { placement: ramp, connector: EXIT });

  expect(trackInsertions(new TrackGraph(circle), circle, circle.count, 0, single(SWITCH))).toEqual(
    [],
  );
  expect(trackInsertions(graph, straights, LAID_BEFORE_THE_MODEL, RUN - 1, single(SWITCH))).toEqual(
    [],
  );
  for (const insertion of trackInsertions(
    graph,
    straights,
    LAID_BEFORE_THE_MODEL,
    1,
    single(SWITCH),
  )) {
    expect([...insertion.replaces].every((p) => p < LAID_BEFORE_THE_MODEL)).toBe(true);
  }
  for (const insertion of trackInsertions(
    new TrackGraph(ramped),
    ramped,
    ramped.count,
    LAID_BEFORE_THE_MODEL - 1,
    single(SWITCH),
  )) {
    expect(insertion.replaces.has(ramp)).toBe(false);
  }
});
