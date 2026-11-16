# M1 S7 evidence: per-model voxel far LODs

Code: branch `siraj/m1-model-lods-134d`, PR #52.
- `vm-07720a9/`: the PR head, rebased onto `main` at `cd2b742`. This is the current evidence.
  - `voxcheck.json`
  - `models/`
  - `city-vs-main/`
  - `editor-near-vs-main/`
  - `scene10/` and `scene50/`
- `macbook-07720a9/`: the M4 Max run of `s7-macbook.sh` at the PR head. Its `results.md` has the method, focus handling and tables.
- The earlier capture of the same S7 code on S5 at `0e701da` is in this branch's history at `70ee0dc` (`vm-a025cd1/`).

## VM setup
- **Server:** the real app's production build (`pnpm --filter @brr/web build`), served by `vite preview` on port 4173, with the bundle built by `pnpm --filter @brr/asset-pipeline build`.
- **Browser:** Chrome 157.0.8103.50 on Xvfb with no GPU. WebGL2 runs on ANGLE over SwiftShader, at a 1800×1000 viewport and device pixel ratio 1.
- **What the VM numbers are good for:** correctness checks (tier counts, triangle and draw-call counts, pixel diffs) and ratios. They aren't GPU timings. The M4 Max runs come from `scripts/s7-macbook.sh`.

## Scripts (`scripts/`)
- `s5-lib.cjs`: S5's UI driver library, copied unchanged from `91cb9db:m1/s5/scripts`. It places items through the catalog buttons, mouse moves read back through the editor's hover readout, clicks and keys.
- `s7-scene.cjs --scene 10|50`: builds the 10-set scene (10 baseplates and 10 sets, 5×2 at a 1,600 LDU pitch) or the 50-baseplate scene (10×5, each set five times) through the editor UI. It then:
  - takes a street view;
  - zooms out with the wheel in steps of 60 units, about ×1.06 in distance per step, saving a screenshot and the HUD stats at each step;
  - at the first step below 12 px stud pitch and the first below 3 px, cycles T through auto, near, mid and far for the same frame;
  - takes an aerial view;
  - measures frame time with M (5 warmup frames plus 60 GPU-synced frames) for each tier listed in `--measure`.

  It writes `records.json`, `zoom-series.json`, `edit-state.json` and the screenshots, plus a `.webm` when given `--video 1`.
- `s7-models.cjs`: for each set, `?model=<set>&tier=near|mid|far&measure=1` at the viewer's default framing, writing drawn triangles, draw calls and frame times per tier.
- `s7-voxcheck.py`: an independent voxelizer that shares no code with `brick-compile`. It flattens each `.mpd` from `.cache/omr` through the LDraw library in `.cache/ldraw` (standard primitives, with `stud.dat` and `stud2.dat` left out), works out the grid phase itself, and applies the occupancy and colour rules. It then compares cell by cell with the `voxelCells` and `voxelColors` arrays in the far bundle's GLBs. Run it from the repo root: `python3 s7-voxcheck.py`.
- `s7-pixel-diff.mjs a.png b.png`: counts differing pixels and reports the maximum channel delta.
- `s7-macbook.sh <sha>`: the M4 Max run. It builds the given commit, serves it, and runs `s7-models.cjs` plus `s7-scene.cjs` for both scenes on both APIs with `--channel chrome --dpr 2 --measure auto,near,mid,far`.
