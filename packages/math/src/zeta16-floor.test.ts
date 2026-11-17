import { describe, expect, it } from "vitest";
import { rotateZeta16, zeta16, zeta16ToStuds, type Zeta16 } from "./zeta16.ts";
import { zeta16FloorStuds } from "./zeta16-floor.ts";

const QUARTER_TURN_STEPS = 4;

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function coefficient(next: () => number, span: number): bigint {
  return BigInt((next() % (2 * span + 1)) - span);
}

function rootTwo(whole: bigint, times: bigint): Zeta16 {
  return zeta16([whole, 0n, times, 0n, 0n, 0n, -times, 0n]);
}

function pellConvergents(count: number): ReadonlyArray<readonly [bigint, bigint]> {
  const pairs: Array<readonly [bigint, bigint]> = [];
  let p = 1n;
  let q = 1n;
  for (let i = 0; i < count; i++) {
    pairs.push([p, q]);
    [p, q] = [p + 2n * q, p + q];
  }
  return pairs;
}

describe("zeta16FloorStuds", () => {
  it("files symmetric poses on super-chunk lines exactly on the integer they equal", () => {
    const next = lcg(11);
    for (let i = 0; i < 2000; i++) {
      const line = BigInt((next() % 17) - 8) * 256n;
      const a = coefficient(next, 2000);
      const b = coefficient(next, 2000);
      const c = coefficient(next, 2000);
      const onX = zeta16([line, a, b, c, coefficient(next, 3000), c, b, a]);
      expect(zeta16FloorStuds(onX).x).toBe(line);
      const onZ = zeta16([coefficient(next, 3000), a, b, c, line, -c, -b, -a]);
      expect(zeta16FloorStuds(onZ).z).toBe(line);
    }
    expect(zeta16FloorStuds(zeta16([1024n, 40n, 0n, 0n, 0n, 0n, 0n, 40n])).x).toBe(1024n);
  });

  it("agrees with the plane position wherever that is far from a whole stud", () => {
    const next = lcg(5);
    let compared = 0;
    for (let i = 0; i < 4000; i++) {
      const value = zeta16(Array.from({ length: 8 }, () => coefficient(next, 5000)));
      const studs = zeta16ToStuds(value);
      const floors = zeta16FloorStuds(value);
      for (const [exact, plane] of [
        [floors.x, studs.x],
        [floors.z, studs.z],
      ] as const) {
        const fraction = plane - Math.floor(plane);
        if (fraction < 1e-6 || fraction > 1 - 1e-6) continue;
        expect(exact).toBe(BigInt(Math.floor(plane)));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(7900);
  });

  it("turns a quarter turn into (x, z) → (−z, x), including on and next to whole studs", () => {
    const next = lcg(23);
    for (let i = 0; i < 2000; i++) {
      const symmetric = next() % 2 === 0;
      const a = coefficient(next, 1_000_000);
      const value = zeta16([
        coefficient(next, 1_000_000),
        a,
        coefficient(next, 1_000_000),
        coefficient(next, 1_000_000),
        coefficient(next, 1_000_000),
        coefficient(next, 1_000_000),
        coefficient(next, 1_000_000),
        symmetric ? -a : coefficient(next, 1_000_000),
      ]);
      const [, c1, c2, c3, , c5, c6, c7] = value;
      const zIsWhole = c1 + c7 === 0n && c2 + c6 === 0n && c3 + c5 === 0n;
      const turned = zeta16FloorStuds(rotateZeta16(value, QUARTER_TURN_STEPS));
      const floors = zeta16FloorStuds(value);
      expect(turned.z).toBe(floors.x);
      expect(turned.x).toBe(zIsWhole ? -floors.z : -floors.z - 1n);
    }
  });

  it("settles a + b√2 within 10⁻²⁰ of zero, where float can't, on the side the Pell sign says", () => {
    for (const [p, q] of pellConvergents(60)) {
      const below = 2n * q * q - p * p < 0n;
      expect(zeta16FloorStuds(rootTwo(-p, q)).x).toBe(below ? -1n : 0n);
      expect(zeta16FloorStuds(rootTwo(p, -q)).x).toBe(below ? 0n : -1n);
    }
  });
});
