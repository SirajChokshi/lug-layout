import { readFileSync } from "node:fs";
import { POSE16_IDENTITY, pose16, zeta16, type Pose16 } from "@brr/math";
import { expect, it } from "vitest";
import { drawingKit, type DrawingKit } from "./drawing-kit.ts";
import { solveClosure } from "./closure.ts";
import {
  ReversingSectionFinder,
  type ReversingSections,
  type ReversingTopology,
} from "./reversing-sections.ts";
import { TrackGraph } from "./track-graph.ts";
import { TrackLayout, type TrackPieceSpec } from "./track-layout.ts";
import { layMoves, type TrackPieceDef } from "./track-pose.ts";
import { runMoves } from "./track-solver.ts";

interface CatalogPiece {
  readonly id: string;
  readonly status: string;
  readonly system: string;
  readonly connectors: ReadonlyArray<{
    readonly coefficients: ReadonlyArray<string>;
    readonly heading: number;
  }>;
  readonly routes: ReadonlyArray<{ readonly from: number; readonly to: number }>;
}

const CATALOG = new URL("../../../../docs/verified-facts/track-catalog.json", import.meta.url);
const STRAIGHT_ID = "ldraw:74746";
const CURVE_ID = "ldraw:74747";
const RIGHT_SWITCH_ID = "ldraw:75541-f1";
const LEFT_SWITCH_ID = "ldraw:75542-f1";
const CROSSING_ID = "ldraw:32087";
const ENTRY = 0;
const STRAIGHT_EXIT = 1;
const DIVERGING_EXIT = 2;
const RUN_STRAIGHTS = 4;
const LINE_STRAIGHTS = 6;
const PROPERTY_TRIALS = 1000;
const MAX_LINKS = 13;

const pieces = (
  JSON.parse(readFileSync(CATALOG, "utf8")) as { readonly pieces: ReadonlyArray<CatalogPiece> }
).pieces.filter((piece) => piece.system === "lego-9v" && piece.status === "certified");

const defs: ReadonlyArray<TrackPieceDef> = pieces.map((piece) => ({
  id: piece.id,
  connectors: piece.connectors.map((c) =>
    pose16(zeta16(c.coefficients.map((value) => BigInt(value))), c.heading),
  ),
}));

const specs: ReadonlyArray<TrackPieceSpec> = pieces.map((piece, i) => ({
  connectors: defs[i]?.connectors ?? [],
  routes: piece.routes.map(({ from, to }) => ({ from, to })),
}));

function catalogIndex(id: string): number {
  const index = pieces.findIndex((piece) => piece.id === id);
  if (index < 0) throw new Error(`the certified 9V catalog has no ${id}`);
  return index;
}

function nineVoltKit(): DrawingKit {
  const result = drawingKit(defs.filter((def) => def.id === STRAIGHT_ID || def.id === CURVE_ID));
  if (result.kind !== "kit") throw new Error(result.reason);
  return result.kit;
}

const kit = nineVoltKit();
const RIGHT_SWITCH = catalogIndex(RIGHT_SWITCH_ID);
const LEFT_SWITCH = catalogIndex(LEFT_SWITCH_ID);
const CROSSING = catalogIndex(CROSSING_ID);

function laid(layout: TrackLayout, from: Pose16, moves: ReturnType<typeof runMoves>): number[] {
  return layMoves(from, moves).placed.map((piece) =>
    layout.place(catalogIndex(piece.piece.id), piece.placement, 0),
  );
}

function closed(layout: TrackLayout, from: Pose16, to: Pose16): number[] {
  const result = solveClosure(kit, from, to);
  if (result.kind !== "exact") throw new Error(`no exact closure: ${result.kind}`);
  return laid(layout, from, runMoves(kit, result.run));
}

function straights(layout: TrackLayout, from: Pose16, count: number): number[] {
  return laid(
    layout,
    from,
    runMoves(kit, { segments: [{ kind: "straight", count }], pieces: count }),
  );
}

function lastOf(placements: ReadonlyArray<number>): number {
  const last = placements.at(-1);
  if (last === undefined) throw new Error("the run laid nothing");
  return last;
}

interface Layout {
  readonly layout: TrackLayout;
  readonly sections: ReadonlyArray<ExpectedSection>;
}

interface ExpectedSection {
  readonly placements: ReadonlyArray<number>;
  readonly turning: { readonly placement: number; readonly connector: number };
}

function balloon(layout: TrackLayout, at: Pose16): { switch: number; loop: number[] } {
  const turnout = layout.place(RIGHT_SWITCH, at, 0);
  const loop = closed(
    layout,
    layout.connectorPose(turnout, STRAIGHT_EXIT),
    layout.connectorPose(turnout, DIVERGING_EXIT),
  );
  return { switch: turnout, loop };
}

const LAYOUTS: ReadonlyArray<readonly [string, () => Layout]> = [
  [
    "a balloon loop off a stem: the switch and its loop, turning at the switch's entry, and not the stem",
    () => {
      const layout = new TrackLayout(specs);
      const { switch: turnout, loop } = balloon(layout, POSE16_IDENTITY);
      straights(layout, layout.connectorPose(turnout, ENTRY), RUN_STRAIGHTS);
      return {
        layout,
        sections: [
          { placements: [turnout, ...loop], turning: { placement: turnout, connector: ENTRY } },
        ],
      };
    },
  ],
  [
    "a wye of three switches whose entries lead off it: every piece of the triangle, turning at a switch's entry",
    () => {
      const layout = new TrackLayout(specs);
      const first = layout.place(RIGHT_SWITCH, POSE16_IDENTITY, 0);
      const toSecond = straights(layout, layout.connectorPose(first, STRAIGHT_EXIT), RUN_STRAIGHTS);
      const second = layout.attach(RIGHT_SWITCH, STRAIGHT_EXIT, {
        placement: lastOf(toSecond),
        connector: 1,
      });
      const toThird = straights(layout, layout.connectorPose(first, DIVERGING_EXIT), RUN_STRAIGHTS);
      const third = layout.attach(RIGHT_SWITCH, STRAIGHT_EXIT, {
        placement: lastOf(toThird),
        connector: 1,
      });
      const leg = closed(
        layout,
        layout.connectorPose(second, DIVERGING_EXIT),
        layout.connectorPose(third, DIVERGING_EXIT),
      );
      return {
        layout,
        sections: [
          {
            placements: [first, ...toSecond, second, ...toThird, third, ...leg],
            turning: { placement: first, connector: ENTRY },
          },
        ],
      };
    },
  ],
  [
    "a line with a balloon loop at each end: two sections, and the line between them in neither",
    () => {
      const layout = new TrackLayout(specs);
      const near = balloon(layout, POSE16_IDENTITY);
      const line = straights(layout, layout.connectorPose(near.switch, ENTRY), LINE_STRAIGHTS);
      const far = layout.attach(RIGHT_SWITCH, ENTRY, { placement: lastOf(line), connector: 1 });
      const farLoop = closed(
        layout,
        layout.connectorPose(far, STRAIGHT_EXIT),
        layout.connectorPose(far, DIVERGING_EXIT),
      );
      return {
        layout,
        sections: [
          {
            placements: [near.switch, ...near.loop],
            turning: { placement: near.switch, connector: ENTRY },
          },
          { placements: [far, ...farLoop], turning: { placement: far, connector: ENTRY } },
        ],
      };
    },
  ],
  [
    "a passing siding between two switches facing apart: none",
    () => {
      const layout = new TrackLayout(specs);
      const first = layout.place(RIGHT_SWITCH, POSE16_IDENTITY, 0);
      const main = straights(layout, layout.connectorPose(first, STRAIGHT_EXIT), RUN_STRAIGHTS);
      const second = layout.attach(LEFT_SWITCH, STRAIGHT_EXIT, {
        placement: lastOf(main),
        connector: 1,
      });
      closed(
        layout,
        layout.connectorPose(first, DIVERGING_EXIT),
        layout.connectorPose(second, DIVERGING_EXIT),
      );
      return { layout, sections: [] };
    },
  ],
  [
    "a figure of eight through the 90° crossing: none",
    () => {
      const layout = new TrackLayout(specs);
      const crossing = layout.place(CROSSING, POSE16_IDENTITY, 0);
      closed(layout, layout.connectorPose(crossing, 1), layout.connectorPose(crossing, 2));
      closed(layout, layout.connectorPose(crossing, 3), layout.connectorPose(crossing, 0));
      return { layout, sections: [] };
    },
  ],
  [
    "an oval: none",
    () => {
      const layout = new TrackLayout(specs);
      const run = straights(layout, POSE16_IDENTITY, RUN_STRAIGHTS);
      closed(layout, layout.connectorPose(lastOf(run), 1), layout.connectorPose(0, 0));
      return { layout, sections: [] };
    },
  ],
];

function sectionsOf(graph: TrackGraph, found: ReversingSections): ReadonlyArray<ExpectedSection> {
  return Array.from({ length: found.count }, (_, s) => {
    const turning = found.turningEnd[s] ?? -1;
    return {
      placements: Array.from(
        found.placements.subarray(found.placementStart[s], found.placementStart[s + 1]),
      ),
      turning: {
        placement: graph.endPlacement[turning] ?? -1,
        connector: graph.endConnector[turning] ?? -1,
      },
    };
  });
}

function sorted(placements: ReadonlyArray<number>): ReadonlyArray<number> {
  return placements.toSorted((a, b) => a - b);
}

it.each(LAYOUTS)("finds the reversing sections of %s", (_name, build) => {
  const { layout, sections } = build();
  const graph = new TrackGraph(layout);

  expect(graph.issues).toEqual([]);
  expect(sectionsOf(graph, new ReversingSectionFinder().find(graph))).toEqual(
    sections.map((section) => ({ ...section, placements: sorted(section.placements) })),
  );
});

it("clears a balloon loop once any one piece of it is lifted, and keeps it when only the stem is", () => {
  const layout = new TrackLayout(specs);
  const { switch: turnout, loop } = balloon(layout, POSE16_IDENTITY);
  const [stem] = straights(layout, layout.connectorPose(turnout, ENTRY), 1);
  if (stem === undefined) throw new Error("no stem");
  const finder = new ReversingSectionFinder();
  const countWithout = (placement: number): number => {
    const piece = layout.piece(placement);
    const pose = layout.pose(placement);
    layout.remove(placement);
    const count = finder.find(new TrackGraph(layout)).count;
    layout.insert(placement, piece, pose, 0);
    return count;
  };

  expect([turnout, ...loop].map(countWithout)).toEqual([turnout, ...loop].map(() => 0));
  expect(countWithout(stem)).toBe(1);
  expect(finder.find(new TrackGraph(layout)).count).toBe(1);
});

interface Link {
  readonly a: number;
  readonly b: number;
  readonly placement: number;
}

interface Topology extends ReversingTopology {
  readonly links: ReadonlyArray<Link>;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

const PIECE_ROUTES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[0, 1]],
  [
    [0, 1],
    [0, 2],
  ],
  [
    [0, 1],
    [2, 3],
  ],
];
const ANY_ROUTES = PIECE_ROUTES.length;

function pieceRoutes(next: () => number): ReadonlyArray<readonly [number, number]> {
  const kind = next() % (PIECE_ROUTES.length + 1);
  if (kind !== ANY_ROUTES) return PIECE_ROUTES[kind] ?? [];
  const ends = 1 + (next() % 4);
  const routes: Array<readonly [number, number]> = [];
  for (let a = 0; a < ends; a++) {
    for (let b = a + 1; b < ends; b++) if (next() % 2 === 0) routes.push([a, b]);
  }
  return routes.length > 0 ? routes : [[0, 0]];
}

function randomTopology(next: () => number): Topology {
  const placementCount = 1 + (next() % 6);
  const endPlacement: number[] = [];
  const links: Link[] = [];
  for (let p = 0; p < placementCount; p++) {
    const first = endPlacement.length;
    const routes = pieceRoutes(next);
    const ends = 1 + Math.max(...routes.flat());
    for (let e = 0; e < ends; e++) endPlacement.push(p);
    for (const [a, b] of routes) {
      if (a !== b) links.push({ a: first + a, b: first + b, placement: p });
    }
  }
  const routes = links.length;
  const endPartner = new Int32Array(endPlacement.length).fill(-1);
  const order = endPlacement.map((_, end) => end);
  for (let i = order.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [order[i], order[j]] = [order[j] ?? 0, order[i] ?? 0];
  }
  for (let i = 0; i + 1 < order.length; i += 2) {
    const a = order[i] ?? 0;
    const b = order[i + 1] ?? 0;
    if (next() % 3 === 0) continue;
    endPartner[a] = b;
    endPartner[b] = a;
    links.push({ a: Math.min(a, b), b: Math.max(a, b), placement: -1 });
  }
  const from: number[] = [];
  const to: number[] = [];
  const placementOfEdge: number[] = [];
  for (const { a, b, placement } of links.slice(0, routes)) {
    from.push(a, b);
    to.push(b, a);
    placementOfEdge.push(placement, placement);
  }
  return {
    links,
    placementCount,
    endPlacement: Int32Array.from(endPlacement),
    endPartner,
    edgeFromEnd: Int32Array.from(from),
    edgeToEnd: Int32Array.from(to),
    edgePlacement: Int32Array.from(placementOfEdge),
  };
}

function simpleCycles(links: ReadonlyArray<Link>, ends: number): ReadonlyArray<number> {
  const cycles: number[] = [];
  const degree = new Int32Array(ends);
  for (let mask = 1; mask < 1 << links.length; mask++) {
    degree.fill(0);
    links.forEach((link, k) => {
      if ((mask & (1 << k)) === 0) return;
      degree[link.a] = (degree[link.a] ?? 0) + 1;
      degree[link.b] = (degree[link.b] ?? 0) + 1;
    });
    if (degree.some((d) => d !== 0 && d !== 2)) continue;
    const start = links.findIndex((_, k) => (mask & (1 << k)) !== 0);
    let reached = 1 << start;
    for (let grew = true; grew;) {
      grew = false;
      links.forEach((link, k) => {
        if ((mask & (1 << k)) === 0 || (reached & (1 << k)) !== 0) return;
        const touches = links.some(
          (other, j) =>
            (reached & (1 << j)) !== 0 &&
            [other.a, other.b].some((end) => end === link.a || end === link.b),
        );
        if (touches) {
          reached |= 1 << k;
          grew = true;
        }
      });
    }
    if (reached === mask) cycles.push(mask);
  }
  return cycles;
}

function bitCount(mask: number): number {
  let count = 0;
  for (let rest = mask; rest !== 0; rest &= rest - 1) count++;
  return count;
}

interface OracleSection {
  readonly placements: ReadonlyArray<number>;
  readonly oddCycles: ReadonlyArray<number>;
}

function oracleSections(topology: Topology): ReadonlyArray<OracleSection> {
  const { links } = topology;
  const cycles = simpleCycles(links, topology.endPlacement.length);
  const blockOf = links.map((_, k) => k);
  const root = (k: number): number => {
    let at = k;
    while (blockOf[at] !== at) at = blockOf[at] ?? at;
    return at;
  };
  for (const cycle of cycles) {
    const members = links.map((_, k) => k).filter((k) => (cycle & (1 << k)) !== 0);
    for (const k of members) blockOf[root(k)] = root(members[0] ?? k);
  }
  const blocks = new Map<number, number[]>();
  for (const cycle of cycles) {
    if (bitCount(cycle) % 2 === 0) continue;
    const first = links.findIndex((_, k) => (cycle & (1 << k)) !== 0);
    const block = root(first);
    blocks.set(block, [...(blocks.get(block) ?? []), cycle]);
  }
  return [...blocks].map(([block, oddCycles]) => ({
    placements: [
      ...new Set(
        links.flatMap((link, k) =>
          link.placement >= 0 && root(k) === block ? [link.placement] : [],
        ),
      ),
    ].toSorted((a, b) => a - b),
    oddCycles,
  }));
}

function turnsOn(topology: Topology, end: number, cycle: number): boolean {
  const routesAtEnd = topology.links.filter(
    (link, k) =>
      (cycle & (1 << k)) !== 0 && link.placement >= 0 && (link.a === end || link.b === end),
  );
  return routesAtEnd.length === 2;
}

it("reports exactly the blocks of track that hold an odd cycle of routes and joins, on any topology, turning where one of their odd cycles passes from route to route", () => {
  const next = seeded(20261127);
  const finder = new ReversingSectionFinder();
  let reversing = 0;
  let trials = 0;
  while (trials < PROPERTY_TRIALS) {
    const topology = randomTopology(next);
    if (topology.links.length > MAX_LINKS) continue;
    trials++;
    const found = finder.find(topology);
    const expected = oracleSections(topology);
    const actual = Array.from({ length: found.count }, (_, s) => ({
      placements: Array.from(
        found.placements.subarray(found.placementStart[s], found.placementStart[s + 1]),
      ),
      turning: found.turningEnd[s] ?? -1,
    }));
    reversing += actual.length;

    expect(actual.map((section) => section.placements).toSorted()).toEqual(
      expected.map((section) => section.placements).toSorted(),
    );
    for (const { placements, turning } of actual) {
      const section = expected.find((candidate) =>
        candidate.placements.every((p, k) => placements[k] === p),
      );
      expect(section?.oddCycles.some((cycle) => turnsOn(topology, turning, cycle))).toBe(true);
    }
  }
  expect(reversing).toBeGreaterThan(PROPERTY_TRIALS / 20);
});
