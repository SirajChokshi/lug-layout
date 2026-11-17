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
