import { POSE16_IDENTITY, composePose16, zeta16ToStuds, type Pose16 } from "@brr/math";
import { TrackCatalog, type TrackPiece } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { expect, it } from "vitest";
import catalogJson from "../../../../docs/verified-facts/track-catalog.json" with { type: "json" };
import { CLOSURE_BUDGET } from "./closure.ts";
import { drawingKit } from "./drawing-kit.ts";
import { arranged, type TrackArrangement } from "./track-arrangement.ts";
import {
  ovalBlueprint,
  passingSidingBlueprint,
  reversingLoopBlueprint,
  turnoutOf,
  type Turnout,
} from "./track-blueprints.ts";
import { TrackGraph } from "./track-graph.ts";
import { trackInsertions } from "./track-insertion.ts";
import { TrackLayout } from "./track-layout.ts";
import type { TrackPieceDef } from "./track-pose.ts";

const catalog = decodedOrThrow(decode(TrackCatalog, catalogJson), "track-catalog.json");
const pieces = catalog.pieces.filter(
  (piece) => piece.system === "lego-9v" && piece.status === "certified",
);
const defs: ReadonlyArray<TrackPieceDef> = pieces.map((piece) => ({
  id: piece.id,
  connectors: piece.connectors.map((connector) => connector.pose),
}));
const specs = pieces.map((piece, index) => ({
  connectors: defs[index]?.connectors ?? [],
  routes: piece.routes.map(({ from, to }) => ({ from, to })),
}));
const built = drawingKit(defs);
if (built.kind !== "kit") throw new Error(built.reason);
const kit = built.kit;
const ENTRY = 0;
const EXIT = 1;
const RUN = 24;
const SIZES = 4;

function indexOf(piece: TrackPieceDef): number {
  return defs.findIndex((def) => def.id === piece.id);
}

function turnout(id: string): Turnout {
  const index = pieces.findIndex((piece) => piece.id === id);
  const found = defs[index] && turnoutOf(defs[index], specs[index]?.routes ?? []);
  if (!found) throw new Error(`${id} is not a turnout`);
  return found;
}

function indexOfKind(kind: TrackPiece["kind"]): number {
  const index = pieces.findIndex((piece) => piece.kind === kind);
  if (index < 0) throw new Error(`the certified 9V catalog has no ${kind}`);
  return index;
}

const RIGHT = turnout("ldraw:75541-f1");
const LEFT = turnout("ldraw:75542-f1");
const STRAIGHT = indexOfKind("straight");

function straightRun(count: number): TrackLayout {
  const layout = new TrackLayout(specs);
  let last = layout.place(STRAIGHT, POSE16_IDENTITY, 0);
  for (let i = 1; i < count; i++) {
    last = layout.attach(STRAIGHT, ENTRY, { placement: last, connector: EXIT });
  }
  return layout;
}

function laid(arrangement: TrackArrangement, frame: Pose16, layout = new TrackLayout(specs)) {
  for (const { piece, placement } of arrangement.pieces) {
    layout.place(piece, composePose16(frame, placement), 0);
  }
  return new TrackGraph(layout);
}

function insertedInRun(arrangement: TrackArrangement) {
  const run = straightRun(RUN);
  const graph = new TrackGraph(run);
  const [insertion] = trackInsertions(graph, run, run.count, RUN / 2, arrangement);
  if (!insertion) return null;
  const after = new TrackLayout(specs);
  for (let p = 0; p < run.count; p++) {
    if (!insertion.replaces.has(p)) after.place(run.piece(p), run.pose(p), 0);
  }
  return {
    replaced: insertion.replaces.size,
    graph: laid(arrangement, insertion.placement, after),
  };
}

function sideOf(arrangement: TrackArrangement): number {
  return Math.sign(
    arrangement.pieces.reduce((sum, { placement }) => sum + zeta16ToStuds(placement.position).z, 0),
  );
}

it("reads a switch's points, straight and branch from its routes, and finds no turnout in a straight, curve or crossing", () => {
  expect(RIGHT).toMatchObject({ points: 0, straight: 1, branch: 2 });
  for (const kind of ["straight", "curve", "crossing"] as const) {
    const index = indexOfKind(kind);
    const def = defs[index];
    if (!def) throw new Error(`no ${kind}`);
    expect(turnoutOf(def, specs[index]?.routes ?? [])).toBeNull();
  }
});

it("closes an oval of the kit's straights and curves on itself at every size, every end joined", () => {
  for (let size = 0; size < SIZES; size++) {
    const oval = arranged(ovalBlueprint(kit, size), indexOf);
    const graph = laid(oval, POSE16_IDENTITY);

    expect(oval.ends).toEqual([]);
    expect(graph.openEnds.length).toBe(0);
    expect(graph.issues).toEqual([]);
    expect(oval.pieces.filter((p) => p.piece === STRAIGHT)).toHaveLength(2 * size);
  }
});

it("drops a passing siding of either hand into a straight run in place of the stretch between its points, joining both switches and leaving only the run's own ends open, longer at each size", () => {
  for (const [hand, mirror] of [
    [RIGHT, LEFT],
    [LEFT, RIGHT],
  ] as const) {
    let previous = 0;
    for (let size = 0; size < SIZES; size++) {
      const siding = arranged(
        passingSidingBlueprint(kit, hand, mirror, size, CLOSURE_BUDGET),
        indexOf,
      );
      const dropped = insertedInRun(siding);

      expect(siding.ends).toHaveLength(2);
      expect(dropped?.graph.issues).toEqual([]);
      expect(dropped?.graph.openEnds.length).toBe(2);
      expect(dropped?.replaced).toBeGreaterThan(previous);
      previous = dropped?.replaced ?? Infinity;
    }
  }
  const right = arranged(passingSidingBlueprint(kit, RIGHT, LEFT, 0, CLOSURE_BUDGET), indexOf);
  const left = arranged(passingSidingBlueprint(kit, LEFT, RIGHT, 0, CLOSURE_BUDGET), indexOf);
  expect(sideOf(right)).toBe(-sideOf(left));
});

it("closes a reversing loop from a switch's straight exit back into its branch, leaving one open end at its points", () => {
  for (const hand of [RIGHT, LEFT]) {
    const loop = arranged(reversingLoopBlueprint(kit, hand, CLOSURE_BUDGET), indexOf);
    const graph = laid(loop, POSE16_IDENTITY);

    expect(loop.ends).toHaveLength(1);
    expect(graph.openEnds.length).toBe(1);
    expect(graph.issues).toEqual([]);
  }
});
