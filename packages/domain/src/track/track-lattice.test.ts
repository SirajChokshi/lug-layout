import { readFileSync } from "node:fs";
import {
  HALF_TURN_16,
  ZETA16_ORDER,
  addZeta16,
  attachPose16,
  composePose16,
  isLatticePose16,
  normalizeHeading16,
  pose16,
  posesJoin16,
  rotateZeta16,
  subtractZeta16,
  zeta16,
  zeta16ToStuds,
  type Pose16,
  type Zeta16,
} from "@brr/math";
import { describe, expect, it } from "vitest";
import { TrackGraph } from "./track-graph.ts";
import { TrackLayout, type TrackEndRef, type TrackPieceSpec } from "./track-layout.ts";
import {
  connectorPose,
  continuingExit,
  freePlacement,
  layMoves,
  seatsOnStuds,
  trackMove,
  type TrackPieceDef,
} from "./track-pose.ts";

interface CatalogPiece {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly system: string;
  readonly connectors: ReadonlyArray<{
    readonly coefficients: ReadonlyArray<string>;
    readonly heading: number;
  }>;
  readonly routes: ReadonlyArray<{
    readonly from: number;
    readonly to: number;
    readonly segments: ReadonlyArray<{ readonly kind: string }>;
  }>;
}

const CATALOG = new URL("../../../../docs/verified-facts/track-catalog.json", import.meta.url);
const STRAIGHT_STUDS = 16n;
const R40_STUDS = 40n;
const PARALLEL_TRACK_STUDS = 16n;
const QUARTER_TURN_CURVES = 4;
const HALF_TURN_CURVES = 8;
const PROPERTY_TIMEOUT_MS = 30_000;

const pieces = (
  JSON.parse(readFileSync(CATALOG, "utf8")) as { readonly pieces: ReadonlyArray<CatalogPiece> }
).pieces.filter((piece) => piece.system === "lego-9v" && piece.status === "certified");

function definition(piece: CatalogPiece): TrackPieceDef {
  return {
    id: piece.id,
    connectors: piece.connectors.map((c) =>
      pose16(zeta16(c.coefficients.map((value) => BigInt(value))), c.heading),
    ),
  };
}

const defs = pieces.map(definition);
const specs: ReadonlyArray<TrackPieceSpec> = pieces.map((piece, i) => ({
  connectors: defs[i]?.connectors ?? [],
  routes: piece.routes.map(({ from, to }) => ({ from, to })),
}));

function indexWhere(test: (piece: CatalogPiece) => boolean, what: string): number {
  const index = pieces.findIndex(test);
  if (index < 0) throw new Error(`the certified 9V catalog has no ${what}`);
  return index;
}

function defAt(index: number): TrackPieceDef {
  const def = defs[index];
  if (!def) throw new Error(`no piece ${index}`);
  return def;
}

const STRAIGHT = indexWhere((p) => p.kind === "straight", "straight");
const CURVE = indexWhere((p) => p.kind === "curve", "curve");

function switchTowards(turn: 1 | -1): number {
  return indexWhere(
    (p) => p.kind === "switch" && p.connectors[2]?.heading === normalizeHeading16(turn),
    `switch diverging towards ${turn}`,
  );
}

function curveEntryTurning(turn: 1 | -1): number {
  const curve = defAt(CURVE);
  const entry = [0, 1].find((c) => trackMove(curve, c, 1 - c).turn === normalizeHeading16(turn));
  if (entry === undefined) throw new Error(`the curve can't turn ${turn}`);
  return entry;
}

function lattice(x: bigint, z: bigint): Zeta16 {
  return zeta16([x, 0n, 0n, 0n, z, 0n, 0n, 0n]);
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function seatedStart(random: () => number): Pose16 {
  const coordinate = () => BigInt(Math.floor((random() - 0.5) * 2_000_000));
  return pose16(lattice(coordinate(), coordinate()), 4 * Math.floor(random() * 4));
}

function inFrameOf(frame: Pose16, value: Zeta16): Zeta16 {
  return rotateZeta16(subtractZeta16(value, frame.position), -frame.heading);
}

describe("stud seating", () => {
  it("seats the straight, switch and crossing bodies on studs, but not a lone curve", () => {
    expect(new Set(pieces.map((p) => p.kind))).toEqual(
      new Set(["straight", "curve", "switch", "crossing"]),
    );
    expect(Object.fromEntries(pieces.map((p, i) => [p.id, seatsOnStuds(defAt(i))]))).toEqual(
      Object.fromEntries(pieces.map((p) => [p.id, p.kind !== "curve"])),
    );
  });

  it("lays a held piece on open ground on the studs, held end at the cursor where it can be", () => {
    const cursors = [lattice(0n, 0n), lattice(37n, -12n), lattice(-1_000_003n, 999_999n)];
    const wrong: string[] = [];
    for (const [index, def] of defs.entries()) {
      const seats = seatsOnStuds(def);
      def.connectors.forEach((end, held) => {
        for (const position of cursors) {
          for (const heading of [0, 4, 8, 12]) {
            const free = pose16(position, heading);
            const placement = freePlacement(def, held, free);
            const heldEnd = composePose16(placement, end);
            const gap = zeta16ToStuds(subtractZeta16(heldEnd.position, free.position));
            const facing = normalizeHeading16(heldEnd.heading - free.heading - HALF_TURN_16);
            const problems = [
              (!seats || isLatticePose16(end)) &&
                !posesJoin16(heldEnd, free) &&
                "not at the cursor",
              seats && !isLatticePose16(placement) && "off the studs",
              seats && Math.hypot(gap.x, gap.z) > Math.SQRT1_2 && "too far from the cursor",
              seats && ![ZETA16_ORDER - 1, 0, 1].includes(facing) && "facing away",
            ].filter((problem) => problem !== false);
            if (problems.length > 0) {
              wrong.push(`${pieces[index]?.id} end ${held} heading ${heading}: ${problems}`);
            }
          }
        }
      });
    }
    expect(wrong).toEqual([]);
  });
});

describe("continuing exits", () => {
  const CONTINUED_FROM_EACH_END: Readonly<Record<string, ReadonlyArray<number>>> = {
    straight: [1, 0],
    curve: [1, 0],
    switch: [1, 0, 0],
    crossing: [1, 0, 3, 2],
  };

  it("carries on through each certified 9V piece: a switch from its points along its straight route, and into its points from either route", () => {
    const continued = defs.map((def, i) => [
      pieces[i]?.id,
      def.connectors.map((_end, entry) => continuingExit(def, entry)),
    ]);
    const switchRoutes = pieces
      .filter((piece) => piece.kind === "switch")
      .map((piece) =>
        piece.routes
          .find((route) => route.from === 0 && route.to === 1)
          ?.segments.map((segment) => segment.kind),
      );

    expect(continued).toEqual(pieces.map((p) => [p.id, CONTINUED_FROM_EACH_END[p.kind]]));
    expect(switchRoutes.length).toBeGreaterThan(0);
    for (const kinds of switchRoutes) expect(kinds).toEqual(["straight"]);
  });

  it("continues a custom wye by its lowest-numbered exit and a custom buffer stop by none", () => {
    const wye: TrackPieceDef = {
      id: "custom:wye",
      connectors: [
        pose16(lattice(0n, 0n), HALF_TURN_16),
        pose16(lattice(32n, 8n), 1),
        pose16(lattice(32n, -8n), ZETA16_ORDER - 1),
      ],
    };
    const bufferStop: TrackPieceDef = {
      id: "custom:buffer-stop",
      connectors: [pose16(lattice(0n, 0n), HALF_TURN_16)],
    };

    expect(wye.connectors.map((_end, entry) => continuingExit(wye, entry))).toEqual([1, 0, 0]);
    expect(continuingExit(bufferStop, 0)).toBeNull();
  });
});

describe("closed loops", () => {
  it(
    "closes a rounded rectangle of any size exactly, every straight and corner end on the studs",
    () => {
      const random = seeded(2026);
      const sizes: Array<readonly [number, number]> = [
        [0, 0],
        [1, 0],
        [0, 1],
        [20_000, 3],
      ];
      for (let trial = 0; trial < 40; trial++) {
        sizes.push([Math.floor(random() * 200), Math.floor(random() * 200)]);
      }
      for (const [index, [wide, deep]] of sizes.entries()) {
        const turn = index % 2 === 0 ? 1 : -1;
        const start = seatedStart(random);
        const straight = trackMove(defAt(STRAIGHT), 0, 1);
        const entry = curveEntryTurning(turn);
        const curve = trackMove(defAt(CURVE), entry, 1 - entry);
        const side = (count: number) => [
          ...Array.from({ length: count }, () => straight),
          ...Array.from({ length: QUARTER_TURN_CURVES }, () => curve),
        ];
        const moves = [...side(wide), ...side(deep), ...side(wide), ...side(deep)];
        const { placed, end } = layMoves(start, moves);

        expect(posesJoin16(end, pose16(start.position, start.heading + HALF_TURN_16))).toBe(true);
        const firstCorner = placed[wide + QUARTER_TURN_CURVES - 1];
        if (!firstCorner) throw new Error("the loop has no first corner");
        const cornerEnd = connectorPose(firstCorner, 1 - entry);
        const along = STRAIGHT_STUDS * BigInt(wide) + R40_STUDS;
        expect(inFrameOf(start, cornerEnd.position)).toEqual(
          lattice(along, BigInt(turn) * R40_STUDS),
        );
        expect(isLatticePose16(cornerEnd)).toBe(true);
        const unseated = placed.filter(
          (piece, i) => moves[i] === straight && !isLatticePose16(piece.placement),
        );
        expect(unseated).toEqual([]);
      }
    },
    PROPERTY_TIMEOUT_MS,
  );
});

interface Ladder {
  readonly placements: ReadonlyArray<number>;
  readonly trackEnds: ReadonlyArray<TrackEndRef>;
  readonly entry: TrackEndRef;
}

function layLadder(layout: TrackLayout, start: Pose16, turn: 1 | -1, switches: number): Ladder {
  const switchIndex = switchTowards(turn);
  const switchDef = defAt(switchIndex);
  const curveEntry = curveEntryTurning(turn === 1 ? -1 : 1);
  const first = layout.place(switchIndex, attachPose16(switchDef.connectors[0] ?? start, start), 0);
  const placements = [first];
  const trackEnds: TrackEndRef[] = [];
  let current = first;
  for (let k = 1; k <= switches; k++) {
    trackEnds.push({ placement: current, connector: 1 });
    const curve = layout.attach(CURVE, curveEntry, { placement: current, connector: 2 });
    placements.push(curve);
    const curveExit = { placement: curve, connector: 1 - curveEntry };
    if (k === switches) {
      trackEnds.push(curveExit);
      break;
    }
    current = layout.attach(switchIndex, 0, curveExit);
    placements.push(current);
  }
  return { placements, trackEnds, entry: { placement: first, connector: 0 } };
}

function extendTo(layout: TrackLayout, from: TrackEndRef, straights: bigint): TrackEndRef {
  let end = from;
  for (let i = 0n; i < straights; i++) {
    end = { placement: layout.attach(STRAIGHT, 0, end), connector: 1 };
  }
  return end;
}

describe("switch ladders", () => {
  it("fans parallel tracks out exactly 16 studs apart, every switch seated on the studs", () => {
    const random = seeded(16);
    for (const turn of [1, -1] as const) {
      for (let switches = 1; switches <= 12; switches++) {
        const layout = new TrackLayout(specs);
        const start = seatedStart(random);
        const ladder = layLadder(layout, start, turn, switches);
        ladder.trackEnds.forEach((ref, track) => {
          const end = layout.connectorPose(ref.placement, ref.connector);
          expect(isLatticePose16(end)).toBe(true);
          expect(normalizeHeading16(end.heading - start.heading)).toBe(0);
          const offset = inFrameOf(start, end.position);
          expect(offset[4]).toBe(BigInt(turn) * PARALLEL_TRACK_STUDS * BigInt(track));
        });
        for (const placement of ladder.placements) {
          if (layout.piece(placement) === CURVE) continue;
          expect(isLatticePose16(layout.pose(placement))).toBe(true);
        }
      }
    }
  });

  it(
    "closes a yard between two facing ladders and a return loop with every end joined exactly",
    () => {
      const random = seeded(48);
      for (const turn of [1, -1] as const) {
        for (let switches = 1; switches <= 8; switches++) {
          const layout = new TrackLayout(specs);
          const start = seatedStart(random);
          const span = 2n * (48n * BigInt(switches) + 32n) + 4n * STRAIGHT_STUDS;
          const across = addZeta16(start.position, rotateZeta16(lattice(span, 0n), start.heading));
          const near = layLadder(layout, start, turn, switches);
          const far = layLadder(
            layout,
            pose16(across, start.heading + HALF_TURN_16),
            turn === 1 ? -1 : 1,
            switches,
          );
          near.trackEnds.forEach((nearEnd, track) => {
            const farEnd = far.trackEnds[track];
            if (!farEnd) throw new Error(`the far ladder has no track ${track}`);
            const from = layout.connectorPose(nearEnd.placement, nearEnd.connector);
            const to = layout.connectorPose(farEnd.placement, farEnd.connector);
            const gap = inFrameOf(from, to.position);
            expect(gap).toEqual(lattice(gap[0], 0n));
            expect(gap[0] % STRAIGHT_STUDS).toBe(0n);
            extendTo(layout, nearEnd, gap[0] / STRAIGHT_STUDS);
          });

          const awayEntry = curveEntryTurning(turn === 1 ? -1 : 1);
          const turnAround = (from: TrackEndRef): TrackEndRef => {
            let end = from;
            for (let c = 0; c < HALF_TURN_CURVES; c++) {
              end = { placement: layout.attach(CURVE, awayEntry, end), connector: 1 - awayEntry };
            }
            return end;
          };
          turnAround(extendTo(layout, turnAround(far.entry), span / STRAIGHT_STUDS));

          const graph = new TrackGraph(layout);
          expect(graph.issues).toEqual([]);
          expect(graph.openEnds.length).toBe(0);
          expect(graph.joinCount * 2).toBe(graph.endCount);
          expect(graph.switchCount).toBe(2 * switches);
          for (let p = 0; p < layout.count; p++) {
            if (layout.piece(p) === CURVE) continue;
            expect(isLatticePose16(layout.pose(p))).toBe(true);
          }
        }
      }
    },
    PROPERTY_TIMEOUT_MS,
  );
});
