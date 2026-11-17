import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { FOOTPRINT_FLOATS, ViewCamera, type CameraTarget } from "../src/camera/view-camera.ts";

const FOV_Y_DEGREES = 40;
const FRAMES = 1_000_000;
const WARMUP_FRAMES = 300_000;
const FRAME_MS = 16;
const WIDTH_PX = 1600;
const HEIGHT_PX = 900;
const FRAMED_BOX = { minX: -2_400, minY: 0, minZ: -640, maxX: 1_280, maxY: 960, maxZ: 1_920 };
const REFRAME_EVERY_FRAMES = 60;

interface Scenario {
  readonly name: string;
  readonly input: (camera: ViewCamera, frame: number) => void;
}

const SCENARIOS: ReadonlyArray<Scenario> = [
  { name: "idle", input: () => {} },
  { name: "orbit drag", input: (camera) => camera.orbit(1, 0) },
  {
    name: "grab pan",
    input: (camera, frame) => camera.grabPan(0, 0, frame % 2 === 0 ? 0.01 : -0.01, 0),
  },
  {
    name: "wheel zoom glide",
    input: (camera, frame) => camera.glideZoomAt(0.3, -0.2, frame % 2 === 0 ? 0.1 : -0.1),
  },
  {
    name: "Fit all tween",
    input: (camera, frame) => {
      if (frame % REFRAME_EVERY_FRAMES === 0) camera.frame(FRAMED_BOX);
    },
  },
];

const viewSum = new Float64Array(1);
const target: CameraTarget = {
  setView(eyeX, eyeY, eyeZ, atX, atY, atZ, orthoHalfHeightLdu) {
    viewSum[0] =
      (viewSum[0] ?? 0) + eyeX + eyeY + eyeZ + atX + atY + atZ + (orthoHalfHeightLdu ?? 0);
  },
};

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

function runFrames(
  camera: ViewCamera,
  scenario: Scenario,
  frames: number,
  footprint: Float64Array,
) {
  for (let frame = 0; frame < frames; frame++) {
    scenario.input(camera, frame);
    camera.step(frame * FRAME_MS);
    camera.apply(target);
    camera.footprint(footprint);
  }
}

const rows: string[] = [];
for (const scenario of SCENARIOS) {
  const camera = new ViewCamera(FOV_Y_DEGREES);
  camera.resize(WIDTH_PX, HEIGHT_PX);
  camera.setSafeArea(468, 57, 380, 153);
  const footprint = new Float64Array(FOOTPRINT_FLOATS);
  runFrames(camera, scenario, WARMUP_FRAMES, footprint);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gcBefore = collections;
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  runFrames(camera, scenario, FRAMES, footprint);
  const elapsedMs = performance.now() - start;
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
  await new Promise((resolve) => setTimeout(resolve, 50));
  rows.push(
    `| ${scenario.name} | ${FRAMES.toLocaleString("en-US")} | ${((elapsedMs * 1000) / FRAMES).toFixed(3)} | ${collections - gcBefore} | ${(heapGrowth / FRAMES).toFixed(3)} |`,
  );
}
observer.disconnect();
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}, ViewCamera input + step + apply + footprint per frame (checksum ${(viewSum[0] ?? 0).toExponential(3)})`,
    "| scenario | frames | µs/frame | GCs during run | heap growth B/frame |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"),
);
