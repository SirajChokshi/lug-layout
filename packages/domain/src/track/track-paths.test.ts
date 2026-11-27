import { POSE16_IDENTITY, ZETA16_ORDER, attachPose16, pose16, zeta16 } from "@brr/math";
import { TrackCatalog, type TrackPiece } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { describe, expect, it } from "vitest";
import catalogJson from "../../../../docs/verified-facts/track-catalog.json" with { type: "json" };
import { TrackGraph } from "./track-graph.ts";
import { TrackLayout } from "./track-layout.ts";
import { TrackPaths } from "./track-paths.ts";
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
const RAISED_PLATES = 3;
const FAR_STUDS = 400n;
const STRAIGHTS_TO_CLEAR_THE_CROSSING = 2;
const THREE_QUARTERS = 3 / 4;

const curveTurn = trackMove(
  { id: pieces[CURVE]?.id ?? "", connectors: specs[CURVE]?.connectors ?? [] },
  ENTRY,
  EXIT,
).turn;
const CIRCLE_CURVES = ZETA16_ORDER / curveTurn;

function onLattice(xStuds: bigint, zStuds: bigint) {
  return pose16(zeta16([xStuds, 0n, 0n, 0n, zStuds, 0n, 0n, 0n]), 0);
}

function switchEnds() {
  const routes = specs[SWITCH]?.routes ?? [];
  const points = routes.find(
    (route) => routes.filter((other) => other.from === route.from).length > 1,
  )?.from;
  const [straightExit, divergingExit] = routes.map((route) => route.to);
  if (points === undefined || straightExit === undefined || divergingExit === undefined) {
    throw new Error("the switch has no end with two routes");
  }
  return { points, straightExit, divergingExit };
}

function crossingEnds() {
  const [lineA, lineB] = specs[CROSSING]?.routes ?? [];
  if (!lineA || !lineB) throw new Error("the crossing has no two routes");
  return { lineA, lineB };
}

class Fixture {
  readonly layout = new TrackLayout(specs);
  private readonly names: string[] = [];

  place(name: string, piece: number, pose = POSE16_IDENTITY, yPlates = 0): number {
    const at = this.layout.place(piece, pose, yPlates);
    this.names[at] = name;
    return at;
  }

  attach(name: string, piece: number, connector: number, to: number, toConnector: number): number {
    const at = this.layout.attach(piece, connector, { placement: to, connector: toConnector });
    this.names[at] = name;
    return at;
  }

  chain(prefix: string, piece: number, count: number, from: number, fromConnector: number): number {
    let last = this.attach(`${prefix}0`, piece, ENTRY, from, fromConnector);
    for (let i = 1; i < count; i++) last = this.attach(`${prefix}${i}`, piece, ENTRY, last, EXIT);
    return last;
  }

  named(placements: Int32Array): ReadonlyArray<string> {
    return Array.from(placements, (p) => this.names[p] ?? `#${p}`).toSorted();
  }

  all(): ReadonlyArray<string> {
    return this.names.toSorted();
  }

  at(name: string): number {
    const placement = this.names.indexOf(name);
    if (placement < 0) throw new Error(`no piece named ${name}`);
    return placement;
  }

  graph(): TrackGraph {
    return new TrackGraph(this.layout);
  }
}

function siding(): Fixture {
  const fixture = new Fixture();
  const { points, straightExit, divergingExit } = switchEnds();
  const a = fixture.place("a", STRAIGHT);
  const b = fixture.attach("b", STRAIGHT, ENTRY, a, EXIT);
  const s = fixture.attach("switch", SWITCH, points, b, EXIT);
  const c = fixture.attach("c", STRAIGHT, ENTRY, s, straightExit);
  const e = fixture.attach("e", STRAIGHT, ENTRY, c, EXIT);
  fixture.attach("d", CURVE, ENTRY, s, divergingExit);
  fixture.place("apart", STRAIGHT, onLattice(0n, FAR_STUDS));
  const entry = specs[STRAIGHT]?.connectors[ENTRY] ?? POSE16_IDENTITY;
  const overE = attachPose16(entry, fixture.layout.connectorPose(e, EXIT));
  fixture.place("raised", STRAIGHT, overE, RAISED_PLATES);
  return fixture;
}

function crossingLines(): Fixture {
  const fixture = new Fixture();
  const { lineA, lineB } = crossingEnds();
  const x = fixture.place("crossing", CROSSING);
  fixture.attach("west", STRAIGHT, ENTRY, x, lineA.from);
  fixture.attach("east", STRAIGHT, ENTRY, x, lineA.to);
  fixture.attach("south", STRAIGHT, ENTRY, x, lineB.from);
  fixture.attach("north", STRAIGHT, ENTRY, x, lineB.to);
  return fixture;
}

function throughCrossingTwice(): Fixture {
  const fixture = new Fixture();
  const { lineA, lineB } = crossingEnds();
  const x = fixture.place("crossing", CROSSING);
  fixture.attach("tail-in", STRAIGHT, ENTRY, x, lineA.from);
  const out = fixture.chain("out", STRAIGHT, STRAIGHTS_TO_CLEAR_THE_CROSSING, x, lineA.to);
  const turned = fixture.chain("curve", CURVE, CIRCLE_CURVES * THREE_QUARTERS, out, EXIT);
  fixture.chain("back", STRAIGHT, STRAIGHTS_TO_CLEAR_THE_CROSSING, turned, EXIT);
  fixture.attach("tail-out", STRAIGHT, ENTRY, x, lineB.to);
  return fixture;
}

function closedLoop(): Fixture {
  const fixture = new Fixture();
  const first = fixture.place("curve", CURVE);
  fixture.chain("curve-", CURVE, CIRCLE_CURVES - 1, first, EXIT);
  return fixture;
}

const FIXTURES = { siding, crossingLines, throughCrossingTwice, closedLoop };

describe("track paths", () => {
  it("lays every fixture from real 9V pieces with exactly the joins it means", () => {
    const joins = Object.entries(FIXTURES).map(([name, build]) => {
      const graph = build().graph();
      return { name, open: graph.openEnds.length, issues: graph.issues.length };
    });

    expect(joins).toEqual([
      { name: "siding", open: 7, issues: 0 },
      { name: "crossingLines", open: 4, issues: 0 },
      { name: "throughCrossingTwice", open: 2, issues: 0 },
      { name: "closedLoop", open: 0, issues: 0 },
    ]);
  });

  it("selects a run up to the next switch or open end, and a switch's run takes in the track off each of its ends", () => {
    const fixture = siding();
    const paths = new TrackPaths(fixture.graph());
    const run = (name: string) => fixture.named(paths.run(fixture.at(name)));

    expect({
      a: run("a"),
      b: run("b"),
      c: run("c"),
      e: run("e"),
      d: run("d"),
      switch: run("switch"),
      apart: run("apart"),
      raised: run("raised"),
    }).toEqual({
      a: ["a", "b"],
      b: ["a", "b"],
      c: ["c", "e"],
      e: ["c", "e"],
      d: ["d"],
      switch: ["a", "b", "c", "d", "e", "switch"],
      apart: ["apart"],
      raised: ["raised"],
    });
  });

  it("selects the whole network joined to a piece, and never track that only lies over or apart from it", () => {
    const fixture = siding();
    const paths = new TrackPaths(fixture.graph());
    const network = (name: string) => fixture.named(paths.network(fixture.at(name)));

    expect({ d: network("d"), apart: network("apart"), raised: network("raised") }).toEqual({
      d: ["a", "b", "c", "d", "e", "switch"],
      apart: ["apart"],
      raised: ["raised"],
    });
  });

  it("follows a run straight through a crossing along the route it entered on, and a crossing's own run takes both lines", () => {
    const fixture = crossingLines();
    const paths = new TrackPaths(fixture.graph());
    const run = (name: string) => fixture.named(paths.run(fixture.at(name)));

    expect({
      west: run("west"),
      south: run("south"),
      crossing: run("crossing"),
      network: fixture.named(paths.network(fixture.at("west"))),
    }).toEqual({
      west: ["crossing", "east", "west"],
      south: ["crossing", "north", "south"],
      crossing: fixture.all(),
      network: fixture.all(),
    });
  });

  it("follows a run that loops back through the same crossing on its other route out to the open end beyond it", () => {
    const fixture = throughCrossingTwice();
    const paths = new TrackPaths(fixture.graph());

    expect(fixture.named(paths.run(fixture.at("tail-in")))).toEqual(fixture.all());
    expect(fixture.named(paths.run(fixture.at("tail-out")))).toEqual(fixture.all());
  });

  it("selects a closed loop with no switch whole from any of its pieces", () => {
    const fixture = closedLoop();
    const graph = fixture.graph();
    const paths = new TrackPaths(graph);

    for (let p = 0; p < graph.placementCount; p++) {
      expect(fixture.named(paths.run(p))).toEqual(fixture.all());
    }
  });

  it("gives every single-route piece of a run the same run, keeps switches out of other pieces' runs, and gives every piece of a network the same network", () => {
    const broken: string[] = [];
    for (const [name, build] of Object.entries(FIXTURES)) {
      const fixture = build();
      const graph = fixture.graph();
      const paths = new TrackPaths(graph);
      const isSwitch = (p: number) => pieces[fixture.layout.piece(p)]?.kind === "switch";
      const singleRoute = (p: number) => specs[fixture.layout.piece(p)]?.routes.length === 1;
      for (let p = 0; p < graph.placementCount; p++) {
        const run = paths.run(p);
        const network = paths.network(p);
        const where = `${name}: piece ${p}`;
        if (!run.includes(p)) broken.push(`${where} is not in its own run`);
        for (const q of run) {
          if (!network.includes(q)) broken.push(`${where} runs to ${q} outside its network`);
          if (q !== p && isSwitch(q)) broken.push(`${where} runs into switch ${q}`);
          const sameRun = paths.run(q).join() === run.join();
          if (singleRoute(p) && singleRoute(q) && !sameRun) broken.push(`${where} and ${q} differ`);
        }
        for (const q of network) {
          if (paths.network(q).join() !== network.join()) broken.push(`${where} and ${q} split`);
        }
      }
    }

    expect(broken).toEqual([]);
  });

  it("refuses a placement that isn't in the graph", () => {
    const graph = siding().graph();
    const paths = new TrackPaths(graph);

    expect(() => paths.run(graph.placementCount)).toThrow(RangeError);
    expect(() => paths.network(-1)).toThrow(RangeError);
  });
});
