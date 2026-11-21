import { describe, expect, it } from "vitest";
import { lduFromMm } from "@brr/math";
import { ExactFrame, exactCoveredWithin, exactGrown, exactUncovered } from "./exact-rect.ts";
import type { LduRect, PlanRegion } from "./plan-region.ts";
import {
  BOX_STRIDE,
  CoverageScratch,
  coverageContext,
  placementIssueCount,
  placementIssues,
  regionContext,
  uncoveredPieces,
  UNDECIDED,
  type PlanIssue,
} from "./plan-rules.ts";

const CLASS_FLOOR = 500;
const WITNESS_FAMILY = 50;
const CERTIFIED_MAGNITUDE = 2 ** 1021;
const TWO_53 = 2 ** 53;
const CHUNK = 640;
const SWEEP_TIMEOUT_MS = 60_000;

type Rect = readonly [number, number, number, number];
type Expectation = "certified" | "uncertified" | "either";

interface FitCase {
  readonly surfaces: ReadonlyArray<Rect>;
  readonly reach: number;
  readonly box: Rect;
  readonly expect: Expectation;
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function rect([minX, minZ, maxX, maxZ]: Rect): LduRect {
  return { minX, minZ, maxX, maxZ };
}

function boxRow([minX, minZ, maxX, maxZ]: Rect): Float64Array {
  return Float64Array.of(minX, 0, minZ, maxX, 0, maxZ);
}

function representableSum(t: number, q: number): boolean {
  if (!(Math.abs(t) <= CERTIFIED_MAGNITUDE) || !(Math.abs(q) <= CERTIFIED_MAGNITUDE)) return false;
  const s = t + q;
  if (!Number.isFinite(s)) return false;
  const frame = new ExactFrame([t, q, s]);
  return frame.of(s) === frame.of(t) + frame.of(q);
}

function certifies(fit: FitCase): boolean {
  return fit.surfaces.every(([minX, minZ, maxX, maxZ]) =>
    [
      [minX, -fit.reach],
      [minZ, -fit.reach],
      [maxX, fit.reach],
      [maxZ, fit.reach],
    ].every(([t, q]) => representableSum(t ?? Number.NaN, q ?? Number.NaN)),
  );
}

function exactPieces(fit: FitCase, frame: ExactFrame): string[] {
  const grown = fit.surfaces.map((s) => exactGrown(frame.rect(rect(s)), frame.of(fit.reach)));
  return exactUncovered(frame.rect(rect(fit.box)), grown)
    .map((p) => `${p.minX},${p.minZ},${p.maxX},${p.maxZ}`)
    .toSorted();
}

function floatPieces(pieces: Float64Array, count: number, frame: ExactFrame): string[] {
  const keys: string[] = [];
  for (let p = 0; p < count; p++) {
    const at = p * 4;
    const edges = [pieces[at], pieces[at + 1], pieces[at + 2], pieces[at + 3]];
    keys.push(edges.map((v) => frame.of(v ?? Number.NaN)).join(","));
  }
  return keys.toSorted();
}

function frameOf(fit: FitCase): ExactFrame {
  return new ExactFrame([...fit.box, ...fit.surfaces.flat(), fit.reach]);
}

function decide(fit: FitCase, scratch: CoverageScratch): number {
  return uncoveredPieces(
    coverageContext(fit.surfaces.map(rect), fit.reach),
    boxRow(fit.box),
    0,
    scratch,
  );
}

function scaled(fit: FitCase, by: number): FitCase {
  const scale = (r: Rect): Rect => [r[0] * by, r[1] * by, r[2] * by, r[3] * by];
  return {
    surfaces: fit.surfaces.map(scale),
    reach: fit.reach * by,
    box: scale(fit.box),
    expect: fit.expect,
  };
}

function family(witness: FitCase, from: number): FitCase[] {
  return Array.from({ length: WITNESS_FAMILY }, (_, k) => scaled(witness, 2 ** (from + k)));
}

function bigintCovered(fit: FitCase): boolean {
  const frame = frameOf(fit);
  return exactCoveredWithin(
    frame.rect(rect(fit.box)),
    fit.surfaces.map((s) => frame.rect(rect(s))),
    frame.of(fit.reach),
  );
}

function many(make: () => FitCase): FitCase[] {
  return Array.from({ length: CLASS_FLOOR }, () => make());
}

function problemsWith(name: string, fit: FitCase, scratch: CoverageScratch): string[] {
  const certified = certifies(fit);
  const problems: string[] = [];
  const label = `${name} ${JSON.stringify(fit)}`;
  if (fit.expect === "certified" && !certified) problems.push(`${label}: expected to certify`);
  if (fit.expect === "uncertified" && certified) problems.push(`${label}: expected not to certify`);
  const count = decide(fit, scratch);
  if (!certified) {
    if (count !== UNDECIDED) problems.push(`${label}: decided ${count} without certifying`);
    return problems;
  }
  if (count === UNDECIDED) return [...problems, `${label}: undecided though certified`];
  const frame = frameOf(fit);
  const mine = floatPieces(scratch.pieces, count, frame).join("|");
  const exact = exactPieces(fit, frame).join("|");
  if (mine !== exact) problems.push(`${label}: pieces ${mine} against ${exact}`);
  if ((count === 0) !== bigintCovered(fit)) problems.push(`${label}: covered disagrees`);
  return problems;
}

function generators(next: () => number): Record<string, () => FitCase[]> {
  const int = (n: number): number => Math.floor(next() * n);
  const pick = <T>(values: ReadonlyArray<T>): T => values[int(values.length)] as T;
  const lattice = (): number => int(9) * CHUNK - 4 * CHUNK + lduFromMm(int(4000) - 2000);
  const latticeRect = (): Rect => {
    const x = lattice();
    const z = lattice();
    return [x, z, x + lduFromMm(1 + int(3000)), z + lduFromMm(1 + int(3000))];
  };
  const latticeBox = (): Rect => {
    const x = lattice() + int(4) * 0.25;
    const z = lattice() + int(4) * 0.25;
    return [x, z, x + int(64) * 20, z + int(64) * 20];
  };
  const mantissa = (): number => (1 + next()) * 2 ** (int(120) - 60) * (next() < 0.5 ? -1 : 1);
  const nearTwo53 = (): number => pick([2 ** 52, TWO_53 - 1, TWO_53, TWO_53 + 2, 2 ** 54]) + int(5);
  return {
    certifiedLattice: () =>
      many(() => ({
        surfaces: Array.from({ length: 1 + int(4) }, latticeRect),
        reach: lduFromMm(int(11)),
        box: latticeBox(),
        expect: "certified",
      })),
    uncertifiedSums: () => [
      ...family(
        { surfaces: [[0, 0, 0.1, 100]], reach: 2.5, box: [0, 10, 0.1, 20], expect: "uncertified" },
        -20,
      ),
      ...many(() => {
        const t = nearTwo53() * pick([1, -1]);
        return {
          surfaces: [[t - 1000, 0, t, 100]],
          reach: pick([2.5, 0.5, 1.5]),
          box: [t - 10, 10, t + 1, 20],
          expect: "either",
        };
      }),
      ...many(() => {
        const t = 1e300 * (1 + next());
        return {
          surfaces: [[t, 0, t * 1.5, 100]],
          reach: 1 + int(9),
          box: [t, 10, t * 1.2, 20],
          expect: "uncertified",
        };
      }),
    ],
    boundaries: () =>
      many(() => {
        const edge = pick([
          CERTIFIED_MAGNITUDE,
          CERTIFIED_MAGNITUDE * (1 + Number.EPSILON),
          CERTIFIED_MAGNITUDE * (1 - Number.EPSILON / 2),
          Number.MAX_VALUE,
        ]);
        const reach = pick([0, 1, lduFromMm(4e307), edge]);
        return {
          surfaces: [[-edge, -1, edge, 1]],
          reach,
          box: [-1, -0.5, 1, 0.5],
          expect: "either",
        };
      }),
    largeLattice: () =>
      many(() => {
        const t = (2 ** 46 + int(2 ** 20)) * CHUNK + lduFromMm(int(4000));
        return {
          surfaces: [[t, 0, t + lduFromMm(1 + int(3000)), 2000]],
          reach: lduFromMm(int(11)),
          box: [t + int(100), 10, t + int(100) + 20, 30],
          expect: "either",
        };
      }),
    nonFiniteAndTiny: () =>
      many(() => {
        const special = pick([Number.NaN, Infinity, -Infinity, 5e-324, 2.2e-308, 0, -0]);
        const slot = int(5);
        const surface: [number, number, number, number] = [0, 0, 100, 100];
        if (slot < 4) surface[slot] = special;
        return {
          surfaces: [surface],
          reach: slot === 4 ? special : pick([0, 5e-324, 2.5]),
          box: [10, 10, 20, 20],
          expect: "either",
        };
      }),
    cancellations: () =>
      many(() => {
        const t = (1 + int(1 << 20)) * 2 ** int(40);
        const q = -(t - (1 + int(64)) * 2 ** -int(30));
        return { surfaces: [[t, t, t * 2, t * 2]], reach: -q, box: [0, 0, t, t], expect: "either" };
      }),
    lopsided: () =>
      many(() => {
        const big = 2 ** (40 + int(20));
        const small = 2 ** -int(40);
        const [t, r] = next() < 0.5 ? [big, small] : [small, big];
        return { surfaces: [[-t, -t, t, t]], reach: r, box: [-1, -1, 1, 1], expect: "either" };
      }),
    mixedEdges: () => [
      ...many(() => ({
        surfaces: [latticeRect(), [TWO_53 - 1 - 1000, 0, TWO_53 - 1, 100]],
        reach: 2.5,
        box: latticeBox(),
        expect: "uncertified",
      })),
      ...many(() => ({
        surfaces: [
          [0, 0, 640, 640],
          [TWO_53 - 1001, 0, TWO_53 - 1, 100],
        ],
        reach: pick([2, 2.5, 0.5]),
        box: [10, 10, 20, 20],
        expect: "uncertified",
      })),
    ],
    underCover: () => [
      ...family(
        {
          surfaces: [[0, 0, TWO_53 - 1, 100]],
          reach: 2,
          box: [TWO_53, 10, TWO_53, 10],
          expect: "uncertified",
        },
        0,
      ),
      ...family(
        {
          surfaces: [[-10, 0, 1, 10]],
          reach: Number.MIN_VALUE,
          box: [1, 5, 1, 5],
          expect: "uncertified",
        },
        0,
      ),
      ...many(() => {
        const k = int(8);
        const t = 2 ** (53 + k) - 2 ** k;
        return {
          surfaces: [[0, 0, t, 100]],
          reach: 2 ** (k + 1),
          box: [2 ** (53 + k), 10, 2 ** (53 + k), 10],
          expect: "uncertified",
        };
      }),
    ],
    overCover: () => [
      ...family(
        {
          surfaces: [[0, 0, TWO_53 - 1, 100]],
          reach: 2.5,
          box: [10, 10, TWO_53 + 2, 20],
          expect: "uncertified",
        },
        0,
      ),
      ...many(() => {
        const k = int(8);
        const t = 2 ** (53 + k) - 2 ** k;
        return {
          surfaces: [[0, 0, t, 100]],
          reach: 2.5 * 2 ** k,
          box: [10, 10, 2 ** (53 + k) + 2 ** (k + 1), 20],
          expect: "uncertified",
        };
      }),
    ],
    randomMantissas: () =>
      many(() => {
        const t = mantissa();
        return {
          surfaces: [[t, -Math.abs(t), t + Math.abs(mantissa()), Math.abs(t)]],
          reach: Math.abs(mantissa()),
          box: [t, 0, t + Math.abs(mantissa()), Math.abs(mantissa())],
          expect: "either",
        };
      }),
    negativeReach: () =>
      many(() => ({
        surfaces: Array.from({ length: 1 + int(3) }, latticeRect),
        reach: -lduFromMm(int(2000)),
        box: latticeBox(),
        expect: "certified",
      })),
    touchingEdges: () =>
      many(() => {
        const s = latticeRect();
        const r = lduFromMm(int(5));
        const side = int(4);
        const box: [number, number, number, number] = [s[0] - r, s[1] - r, s[2] + r, s[3] + r];
        if (side === 0) box[2] = s[0] - r;
        if (side === 1) box[0] = s[2] + r;
        if (side === 2) box[3] = s[1] - r;
        return {
          surfaces: [s, [s[2], s[1], s[2] + 640, s[3]]],
          reach: r,
          box,
          expect: "certified",
        };
      }),
    zeroArea: () =>
      many(() => {
        const s = latticeRect();
        const x = pick([s[0], (s[0] + s[2]) / 2, s[2], s[0] - 20]);
        const z = pick([s[1], (s[1] + s[3]) / 2, s[3]]);
        return {
          surfaces: [s],
          reach: 0,
          box: next() < 0.5 ? [x, z, x, z] : [x, s[1], x, s[3]],
          expect: "certified",
        };
      }),
    invertedBoxes: () => [
      ...family(
        { surfaces: [[0, 0, 10, 10]], reach: 0, box: [8, 8, 2, 2], expect: "certified" },
        -20,
      ),
      ...family(
        { surfaces: [[1, 5, 11, 15]], reach: 0, box: [10, 0, 2, 20], expect: "certified" },
        -20,
      ),
      ...many(() => {
        const s = latticeRect();
        return {
          surfaces: [s],
          reach: 0,
          box: [s[2] - 20, s[1], s[0] + 20, s[3] + 40],
          expect: "certified",
        };
      }),
    ],
    certifiedDegenerate: () => [
      ...family(
        { surfaces: [[0, 0, 640, 320]], reach: 0, box: [320, -100, 320, 400], expect: "certified" },
        -20,
      ),
      ...many(() => {
        const s = latticeRect();
        const x = (s[0] + s[2]) / 2;
        return { surfaces: [s], reach: 0, box: [x, s[1] - 40, x, s[3] + 40], expect: "certified" };
      }),
    ],
    successiveSubtraction: () => [
      ...family(
        {
          surfaces: [
            [0, 0, 60, 100],
            [40, 0, 100, 100],
          ],
          reach: 0,
          box: [0, 0, 100, 100],
          expect: "certified",
        },
        -20,
      ),
      ...many(() => {
        const s = latticeRect();
        const cut = (s[0] + s[2]) / 2;
        return {
          surfaces: [[s[0], s[1], cut + 20, s[3]], [cut - 20, s[1], s[2], s[3]], latticeRect()],
          reach: 0,
          box: s,
          expect: "certified",
        };
      }),
    ],
    positiveRemainders: () => [
      ...family(
        { surfaces: [[0, 0, 60, 100]], reach: 0, box: [0, 0, 100, 100], expect: "certified" },
        -20,
      ),
      ...many(() => {
        const s = latticeRect();
        return {
          surfaces: [s],
          reach: 0,
          box: [s[0] - 40, s[1] - 40, s[2] + 40, s[3]],
          expect: "certified",
        };
      }),
    ],
    flatTablesAndRepeats: () =>
      many(() => {
        const s = latticeRect();
        return {
          surfaces: [[s[0], s[1], s[0], s[3]], s, s],
          reach: lduFromMm(int(3)),
          box: latticeBox(),
          expect: "certified",
        };
      }),
  };
}

describe("uncoveredPieces against the bigint path", () => {
  it(
    "decides every generated class exactly as exactCoveredWithin, or reports UNDECIDED",
    () => {
      const scratch = new CoverageScratch();
      const classes = Object.entries(generators(lcg(20261119)));
      const problems = classes.flatMap(([name, make]) =>
        make().flatMap((fit) => problemsWith(name, fit, scratch)),
      );
      const sizes = classes.map(([name, make]) => [name, make().length] as const);
      expect(problems.slice(0, 5)).toEqual([]);
      expect(sizes.filter(([, size]) => size < CLASS_FLOOR)).toEqual([]);
    },
    SWEEP_TIMEOUT_MS,
  );

  it("shows each gap witness is a real disagreement between rounding and the exact edge", () => {
    const under: FitCase = {
      surfaces: [[0, 0, TWO_53 - 1, 100]],
      reach: 2,
      box: [TWO_53, 10, TWO_53, 10],
      expect: "uncertified",
    };
    const over: FitCase = {
      surfaces: [[0, 0, TWO_53 - 1, 100]],
      reach: 2.5,
      box: [10, 10, TWO_53 + 2, 20],
      expect: "uncertified",
    };
    expect([bigintCovered(under), bigintCovered(over)]).toEqual([true, false]);
    expect([TWO_53 - 1 + 2, TWO_53 - 1 + 2.5]).toEqual([TWO_53, TWO_53 + 2]);
  });
});

function region(next: () => number): PlanRegion {
  const int = (n: number): number => Math.floor(next() * n);
  const mm = (): number => {
    const roll = next();
    if (roll < 0.03) return Number.NaN;
    if (roll < 0.08) return int(4000) + 0.5;
    if (roll < 0.1) return -int(200);
    return int(4000);
  };
  return {
    id: "p",
    name: `room ${int(9)}`,
    originChunkX: int(5) - 2,
    originChunkZ: int(5) - 2,
    footprint: {
      roomWidthMm: 500 + int(4000),
      roomDepthMm: 500 + int(4000),
      tables: Array.from({ length: int(4) }, (_, i) => ({
        id: `t${i}`,
        name: `t${i}`,
        rect: { x: mm(), z: mm(), width: 100 + int(2000), depth: 100 + int(2000) },
        heightMm: 750,
      })),
      obstacles: Array.from({ length: int(3) }, (_, i) => ({
        id: `o${i}`,
        name: `o${i}`,
        rect: { x: mm(), z: mm(), width: 100 + int(500), depth: 100 + int(500) },
      })),
    },
    maxOverhangMm: next() < 0.1 ? -int(50) : int(200),
  };
}

function placementBox(next: () => number, plan: PlanRegion): Rect {
  const int = (n: number): number => Math.floor(next() * n);
  const roll = next();
  if (roll < 0.03) return [Number.NaN, 0, 10, 10];
  if (roll < 0.05) return [0, 0, Infinity, 10];
  const x = plan.originChunkX * CHUNK + int(12000) - 1000 + (next() < 0.2 ? next() : 0);
  const z = plan.originChunkZ * CHUNK + int(12000) - 1000;
  const width = next() < 0.05 ? -int(100) : int(800);
  return [x, z, x + width, z + int(800)];
}

describe("placementIssueCount", () => {
  it(
    "counts exactly the issues placementIssues emits, for random regions and boxes",
    () => {
      const next = lcg(77);
      const scratch = new CoverageScratch();
      let flagged = 0;
      for (let r = 0; r < 300; r++) {
        const plan = region(next);
        const ctx = regionContext(plan);
        for (let b = 0; b < 40; b++) {
          const box = placementBox(next, plan);
          const row = new Float64Array(BOX_STRIDE * 2);
          row.set(boxRow(box), BOX_STRIDE);
          const issues: PlanIssue[] = [];
          placementIssues(
            ctx,
            { key: { chunkKey: 0, slot: b }, ref: "ref", label: "box", box: rect(box) },
            issues,
          );
          expect(placementIssueCount(ctx, row, BOX_STRIDE, scratch)).toBe(issues.length);
          if (issues.length > 0) flagged++;
        }
      }
      expect(flagged).toBeGreaterThan(1000);
    },
    SWEEP_TIMEOUT_MS,
  );
});
