import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import {
  Group,
  InstancedBufferGeometry,
  InterleavedBufferAttribute,
  Mesh,
  PerspectiveCamera,
  Scene,
} from "three/webgpu";
import type { TrackEndKind, TrackEndMarker } from "../src/scene-backend.ts";
import { TrackEndArrows } from "../src/three/track-end-arrows.ts";

const ARROW_COUNTS: ReadonlyArray<number> = [1_000, 10_000];
const SPREAD_LDU = 20_000;
const CALLS = 1_000;
const WARMUP_CALLS = 6_000;
const CAMERAS = 256;
const ORBIT_STEP_RADIANS = 0.01;
const EYE_DISTANCE_LDU = 30_000;
const EYE_HEIGHT_LDU = 18_000;
const CHUNK_LDU = 640;
const CLOSE_EYE_HEIGHT_LDU = 1_500;
const KINDS: ReadonlyArray<TrackEndKind> = ["open", "gap", "target"];
const SEED = 0x2545f491;

function markers(count: number): TrackEndMarker[] {
  let state = SEED;
  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  return Array.from({ length: count }, (_, index) => ({
    xLdu: Math.round((next() - 0.5) * SPREAD_LDU),
    yLdu: 0,
    zLdu: Math.round((next() - 0.5) * SPREAD_LDU),
    headingRadians: next() * 2 * Math.PI,
    kind: KINDS[index % KINDS.length] ?? "open",
  }));
}

function orbitingCameras(): PerspectiveCamera[] {
  return Array.from({ length: CAMERAS }, (_, step) => {
    const camera = new PerspectiveCamera(40, 16 / 9, 20, 200_000);
    const angle = step * ORBIT_STEP_RADIANS;
    camera.position.set(
      Math.cos(angle) * EYE_DISTANCE_LDU,
      EYE_HEIGHT_LDU,
      Math.sin(angle) * EYE_DISTANCE_LDU,
    );
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    return camera;
  });
}

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

async function probe(name: string, call: (index: number) => void): Promise<string> {
  for (let i = 0; i < WARMUP_CALLS; i++) call(i);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gcBefore = collections;
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  for (let i = 0; i < CALLS; i++) call(i);
  const elapsedMs = performance.now() - start;
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
  await new Promise((resolve) => setTimeout(resolve, 50));
  return `| ${name} | ${((elapsedMs * 1000) / CALLS).toFixed(0)} | ${collections - gcBefore} | ${(heapGrowth / CALLS).toFixed(1)} |`;
}

function closeCamera(lookAtX: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(40, 16 / 9, 20, 200_000);
  camera.position.set(lookAtX, CLOSE_EYE_HEIGHT_LDU, CLOSE_EYE_HEIGHT_LDU);
  camera.lookAt(lookAtX, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

const cameras = orbitingCameras();
const views: ReadonlyArray<readonly [string, ReadonlyArray<PerspectiveCamera>]> = [
  ["the camera orbiting the whole spread", cameras],
  ["a close camera seeing a few", [closeCamera(0)]],
  ["a camera seeing none", [closeCamera(SPREAD_LDU * 4)]],
];
const scene = new Scene();
const rows: string[] = [];
for (const count of ARROW_COUNTS) {
  const spread = markers(count);
  const arrows = new TrackEndArrows();
  arrows.set(spread);
  arrows.place(0, 0);
  const mesh = arrows.group.children[0];
  if (
    !(mesh instanceof Mesh) ||
    !(mesh.geometry instanceof InstancedBufferGeometry) ||
    Array.isArray(mesh.material)
  ) {
    throw new Error("the arrow mesh draws one instanced geometry with one material");
  }
  const { geometry, material } = mesh;
  const slotPart = geometry.getAttribute("slotPart");
  if (!(slotPart instanceof InterleavedBufferAttribute)) {
    throw new Error("the arrow slots are one interleaved buffer");
  }
  const slots = slotPart.data;
  const group = new Group();
  const label = `${count.toLocaleString("en-US")} arrows`;
  for (const [view, viewCameras] of views) {
    rows.push(
      await probe(`${label}: draw, ${view}`, (index) => {
        const camera = viewCameras[index % viewCameras.length];
        if (camera) {
          mesh.onBeforeRender(
            null as unknown as Parameters<Mesh["onBeforeRender"]>[0],
            scene,
            camera,
            geometry,
            material,
            group,
          );
          slots.clearUpdateRanges();
        }
      }),
    );
  }
  rows.push(
    await probe(`${label}: place after a rebase`, (index) => {
      arrows.place((index % 2) * CHUNK_LDU, 0);
    }),
    await probe(`${label}: set the same markers again`, () => {
      arrows.set(spread);
    }),
  );
}
observer.disconnect();
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}, ${CALLS.toLocaleString("en-US")} calls after ${WARMUP_CALLS.toLocaleString("en-US")} warm-up calls; two items (head and post) per arrow`,
    "| step | µs/call | GCs during run | heap growth B/call |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"),
);
