import { PerformanceObserver, performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { boxesCross, solidsCross, type PartSolid, type StudSolid } from "../src/solid-contact.ts";

type Vec = readonly [number, number, number];

const BOX_CALLS = 2_000_000;
const SOLID_CALLS = 2_000;
const WARMUP = 2_000;
const STUD_SEGMENTS = 16;
const STUD_RADIUS = 6;
const STUD_HEIGHT = 4;
const STUDS_ACROSS = 4;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function shell(lo: Vec, hi: Vec): number[] {
  const corner = (i: number): Vec => [
    i & 1 ? hi[0] : lo[0],
    i & 2 ? hi[1] : lo[1],
    i & 4 ? hi[2] : lo[2],
  ];
  return [
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
    [0, 2, 3, 1],
    [4, 5, 7, 6],
  ].flatMap(([a = 0, b = 0, c = 0, d = 0]) => [a, b, c, a, c, d].flatMap((i) => [...corner(i)]));
}

function cylinderStud(): StudSolid {
  const triangles: number[] = [];
  for (let k = 0; k < STUD_SEGMENTS; k++) {
    const a = (2 * Math.PI * k) / STUD_SEGMENTS;
    const b = (2 * Math.PI * (k + 1)) / STUD_SEGMENTS;
    const ax = STUD_RADIUS * Math.cos(a);
    const az = STUD_RADIUS * Math.sin(a);
    const bx = STUD_RADIUS * Math.cos(b);
    const bz = STUD_RADIUS * Math.sin(b);
    triangles.push(ax, 0, az, bx, 0, bz, bx, STUD_HEIGHT, bz);
    triangles.push(ax, 0, az, bx, STUD_HEIGHT, bz, ax, STUD_HEIGHT, az);
    triangles.push(0, STUD_HEIGHT, 0, ax, STUD_HEIGHT, az, bx, STUD_HEIGHT, bz);
  }
  return {
    box: Float64Array.of(-STUD_RADIUS, 0, -STUD_RADIUS, STUD_RADIUS, STUD_HEIGHT, STUD_RADIUS),
    triangles: Float64Array.from(triangles),
  };
}

function hollowBrick(stud: StudSolid): PartSolid {
  const half = (STUDS_ACROSS * 20) / 2;
  const body = [
    ...shell([-half, -24, -half], [half, 0, half]),
    ...shell([-half + 4, -20, -half + 4], [half - 4, -4, half - 4]),
  ];
  const frames: number[] = [];
  const posed: number[] = [];
  for (let i = 0; i < STUDS_ACROSS; i++) {
    for (let j = 0; j < STUDS_ACROSS; j++) {
      const x = -half + 10 + 20 * i;
      const z = -half + 10 + 20 * j;
      frames.push(1, 0, 0, -x, 0, 1, 0, 0, 0, 0, 1, -z);
      for (let t = 0; t < stud.triangles.length; t += 3) {
        posed.push(
          (stud.triangles[t] ?? 0) + x,
          stud.triangles[t + 1] ?? 0,
          (stud.triangles[t + 2] ?? 0) + z,
        );
      }
    }
  }
  return {
    box: Float64Array.of(-half, -24, -half, half, STUD_HEIGHT, half),
    triangles: Float64Array.from([...body, ...posed]),
    bodyTriangles: body.length / 9,
    studFrames: Float64Array.from(frames),
    studPrimitive: new Uint8Array(STUDS_ACROSS * STUDS_ACROSS),
    primitives: [stud],
  };
}

function at(x: number, y: number, z: number): Float64Array {
  const m = Float64Array.from(IDENTITY);
  m[3] = x;
  m[7] = y;
  m[11] = z;
  return m;
}

const brick = hollowBrick(cylinderStud());
const origin = at(0, 0, 0);
const onTop = at(0, 24 + STUD_HEIGHT, 0);
const beside = at(STUDS_ACROSS * 20, 0, 0);
const sunk = at(10, 20, 10);
const box = brick.box;

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });
const collectGarbage = (globalThis as { gc?: () => void }).gc;

function settle(): Promise<void> {
  collectGarbage?.();
  return new Promise((resolve) => setTimeout(resolve, 50));
}

interface Measured {
  readonly ms: number;
  readonly gcs: number;
  readonly heapGrowthBytes: number;
  readonly result: number;
}

async function measured(run: () => number): Promise<Measured> {
  run();
  await settle();
  const gcBefore = collections;
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  const result = run();
  const ms = performance.now() - start;
  const heapAfter = process.memoryUsage().heapUsed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { ms, gcs: collections - gcBefore, heapGrowthBytes: heapAfter - heapBefore, result };
}

function boxes(calls: number): number {
  let crossing = 0;
  for (let k = 0; k < calls; k++) {
    if (boxesCross(origin, 0, box, 0, k & 1 ? onTop : sunk, 0, box, 0)) crossing++;
  }
  return crossing;
}

function solids(calls: number, other: Float64Array): number {
  let crossing = 0;
  for (let k = 0; k < calls; k++) if (solidsCross(brick, origin, 0, brick, other, 0)) crossing++;
  return crossing;
}

boxes(WARMUP);
solids(WARMUP, sunk);
const boxed = await measured(() => boxes(BOX_CALLS));
const resting = await measured(() => solids(SOLID_CALLS, onTop));
const touching = await measured(() => solids(SOLID_CALLS, beside));
const crossing = await measured(() => solids(SOLID_CALLS, sunk));
observer.disconnect();

const ns = (m: Measured, count: number): string => ((m.ms * 1e6) / count).toFixed(1);
const row = (work: string, m: Measured, count: number): string =>
  `| ${work} | ${count.toLocaleString("en-US")} | ${m.ms.toFixed(1)} | ${ns(m, count)} | ${m.result.toLocaleString("en-US")} | ${m.gcs} | ${m.heapGrowthBytes} |`;
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"} (${cpus().length} threads)`,
    `a ${STUDS_ACROSS}x${STUDS_ACROSS} brick with a sealed hollow and ${STUD_SEGMENTS}-segment studs, ${brick.triangles.length / 9} triangles, against itself`,
    "",
    "| Work | Count | ms | ns each | Crossing | GCs | Heap growth (bytes) |",
    "|---|---|---|---|---|---|---|",
    row("posed boxes, alternately resting and sunk", boxed, BOX_CALLS),
    row("solids, one resting on the other's studs", resting, SOLID_CALLS),
    row("solids, side faces touching", touching, SOLID_CALLS),
    row("solids, one sunk into the other", crossing, SOLID_CALLS),
    "",
  ].join("\n"),
);
