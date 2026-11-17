# M6 super-chunk far LOD evidence (PR #56)

`scripts/build-world.mjs` builds a world of real modules through the editor UI only (catalog clicks, cursor moves checked against the HUD's "Cursor on lattice" readout, real clicks, R to rotate, C to centre, M to measure). Each module is one 3811 baseplate plus one of the ten OMR sets, on a 45 × 45 grid with a two-chunk (1,280 LDU) pitch: 2,025 modules, 4,050 placements. At each checkpoint it measures a street pose (corner of the world, pitch 0.35, distance 3,200 LDU) and an aerial pose (world centre, pitch 0.9, distance 60,000 LDU) with the M key, which settles the LOD and then times `frames` GPU-synced frames. Results go to `<out>/results.json` with a screenshot per pose.

## Run it (MacBook M4 Max)
```bash
git fetch origin siraj/m6-super-chunk-lod-c470 && git checkout <PR head>
pnpm install && pnpm --filter @brr/asset-pipeline build && pnpm --filter @brr/web build
pnpm --filter @brr/web exec vite preview --port 4180 --strictPort &
npm i --prefix /tmp/pw playwright-core@1 && cp m6/superchunk/scripts/build-world.mjs /tmp/pw/
cd /tmp/pw
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node build-world.mjs \
  --url=http://127.0.0.1:4180/ --api=webgpu --side=45 --checkpoints=125,500,1000,2025 \
  --frames=60 --width=1600 --height=1000 --buildDistance=40000 --out=/tmp/pw/m4-after
CHROME=... node build-world.mjs --url=http://127.0.0.1:4180/ --api=webgpu --side=45 \
  --modules=500 --checkpoints=16,64,125,250,500 --frames=60 --superchunks=0 \
  --width=1600 --height=1000 --buildDistance=40000 --out=/tmp/pw/m4-before
```
`--hopTest=1` first centres on targets 102 and 160 LDU away and across the world at the build distance and checks each is aimable. `--integerMouse=1` rounds cursor positions to whole CSS pixels, which forces the case where a 20 LDU cell can't be hit at 40,000 LDU; the script then zooms in by halves (not below 2,500 LDU), aims, and zooms back out. Tested on the VM at 1280×800 and 1600×1000.

`--superchunks=0` makes every super-chunk resident, which is the behaviour before the PR. Stop the before run when a frame passes ~2 s.

## VM heap runs (vm-heap/)

Same driver, 45-wide grid, 500 modules (1,000 placements), checkpoints at 125/250/500, 10 measured frames, 1600×1000, WebGL2 on SwiftShader (correctness and memory only; frame times are not GPU numbers). `heapAfterGcBytes` is `Runtime.getHeapUsage` after `HeapProfiler.collectGarbage`; `backingStorageSize` is ArrayBuffer backing stores. `old-6788866` is the first #56 head; `fixed-846d78d` has the render-object release (same LOD code as later restacks).

| Head | Modules | Pose | Frame median / p95 ms | Live chunks | Super-chunks drawn | performance.memory MiB | V8 heap after GC MiB | ArrayBuffer backing MiB | Settle ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old-6788866 | 125 | street | 1518 / 1549 | 164 | 17 | 230 | 69 | 155 | 36044 |
| old-6788866 | 125 | aerial | 142 / 147 | 0 | 25 | 159 | 20 | 139 | 1046 |
| old-6788866 | 250 | street | 2747 / 2884 | 264 | 25 | 439 | 101 | 335 | 60946 |
| old-6788866 | 250 | aerial | 186 / 205 | 0 | 38 | 333 | 23 | 310 | 3273 |
| old-6788866 | 500 | street | 3081 / 3181 | 242 | 43 | 685 | 106 | 563 | 61614 |
| old-6788866 | 500 | aerial | 239 / 245 | 0 | 51 | 568 | 30 | 537 | 4167 |
| fixed-846d78d | 125 | street | 1570 / 1878 | 164 | 17 | 188 | 68 | 111 | 43411 |
| fixed-846d78d | 125 | aerial | 143 / 147 | 0 | 25 | 199 | 19 | 80 | 1164 |
| fixed-846d78d | 250 | street | 2791 / 2839 | 264 | 25 | 279 | 98 | 149 | 61657 |
| fixed-846d78d | 250 | aerial | 177 / 184 | 0 | 38 | 113 | 20 | 93 | 3762 |
| fixed-846d78d | 500 | street | 2642 / 2869 | 299 | 42 | 319 | 115 | 192 | 60246 |
| fixed-846d78d | 500 | aerial | 244 / 257 | 0 | 51 | 142 | 23 | 118 | 8457 |

Street settle hits the 60 s cap on SwiftShader (each frame takes ~3 s, and resident chunks load within a per-frame budget).

## Seam and translucency review captures (seam-review-6462c9b/)

`scripts/seam-replay.mjs` replays one fixed sequence of mouse and wheel input against a build, so different builds see the same camera poses. It places items by reading the editor's `data-hover` cursor readout and correcting with a locally measured screen-to-lattice Jacobian, so it needs no camera model. It logs the HUD each step and saves frames at `--shots` steps (20 s after the last input) or at the first mixed-residency step (`--stopOnMixed=1`).

Builds were served with `vite preview` from `apps/web`: before (`bc866de`) on 4183, fixed (`6462c9b`) on 4182.

    node scripts/seam-replay.mjs --url=http://127.0.0.1:4182/ --out=seam-fixed --orbitDx=-300 --orbitDy=-60 --startWheel=1800 --stepWheel=-60 --steps=14 --shots=14
    node scripts/seam-replay.mjs --url=http://127.0.0.1:4183/ --out=seam-prefix --orbitDx=-300 --orbitDy=-60 --startWheel=1800 --stepWheel=-60 --steps=14 --shots=14
    node scripts/seam-replay.mjs --url=http://127.0.0.1:4182/ --superchunks=0 --out=seam-off --orbitDx=-300 --orbitDy=-60 --startWheel=1800 --stepWheel=-60 --steps=14 --shots=14
    node scripts/seam-replay.mjs --url=http://127.0.0.1:4182/ --out=pop-fixed --item=omr:10264-1 --plates=320:320 --orbitDx=0 --orbitDy=-30 --startWheel=1500 --stepWheel=-40 --steps=8 --shots=8

Pixel counts: `node scripts/crop.mjs <frame> <out> 600 400 340 180 2` (seam) or `745 440 140 120 4` (10264-1), and `node scripts/diff.mjs <crop> <reference crop>`.

`build-world.mjs` now centres the camera with the editor's "Go to x, z" form when it exists. Main's `C` shortcut animates the camera, which broke the hover-then-hop centring.
