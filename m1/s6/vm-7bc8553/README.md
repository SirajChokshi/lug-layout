# M1 S6 evidence: covered-stud culling and base footprints (VM)

- **Code:** `siraj/m1-stud-culling-19ec` at `7bc8553` (one commit on `main` `1dd7132`). **Before** is `main` at `1dd7132`.
- **Bundles:** built by `pnpm --filter @brr/asset-pipeline build` on each commit. Standard bundle `201e12988ab5c1bb` (S6) and `539082a769526461` (main).
- **Machine:** this cloud VM, Chrome 157.0.8103.50 on Xvfb, WebGL2 through ANGLE on SwiftShader (a CPU rasterizer). Drawing buffer 1600×1001 for the editor and 1280×801 for `?model=`. 8 vCPU Xeon. VM frame times count for correctness and relative cost only. They are not M4 Max numbers and not Tier A.
- **Method:** every scene is built through the real UI with Playwright (`scripts/`). Clicks land on exact lattice cells using a ground-plane homography calibrated from the app's own `data-hover` readout, with each click verified before it is made. No harness pages, no scenes built in code.

## Per set (bake and `?model=`)

| Set | Parts | Studs in file | Culled at bake | Drawn | Footprint cells: anti-stud + flat | Rest plane y (LDU) | Tallest column (plates) | `?model=` drawn triangles, main → S6 | Differing px over 4 views (largest component) |
|---|---:|---:|---:|---:|---|---:|---:|---|---|
| 7936-1 | 147 | 622 | 312 | 310 | 466 = 456 + 10 | -8 | 32 | 140,604 → 124,188 | 195 (1×5) |
| 10264-1 | 2,567 | 7,489 | 5,431 | 2,058 | 1,024 = 0 + 1,024 | -4 | 100 | 1,222,337 → 939,953 | 1001 (1×7) |
| 10185-1 | 2,405 | 7,607 | 5,882 | 1,725 | 1,024 = 0 + 1,024 | -4 | 105 | 1,036,407 → 747,447 | 692 (1×5) |
| 10190-1 | 1,484 | 5,127 | 3,400 | 1,727 | 1,024 = 0 + 1,024 | -4 | 103 | 747,071 → 580,223 | 480 (1×5) |
| 10218-1 | 2,042 | 7,040 | 5,210 | 1,830 | 1,024 = 0 + 1,024 | -4 | 89 | 936,913 → 675,985 | 781 (1×5) |
| 2150-1 | 625 | 2,449 | 1,584 | 865 | 272 = 272 + 0 | -8 | 72 | 410,478 → 332,430 | 233 (1×4) |
| 4554-1 | 617 | 2,447 | 1,568 | 879 | 272 = 272 + 0 | -8 | 72 | 404,254 → 326,974 | 203 (1×4) |
| 4555-1 | 390 | 2,996 | 1,209 | 1,787 | 1,536 = 0 + 1,536 | -4 | 76 | 382,201 → 320,713 | 345 (2×4) |
| 10128-1 | 336 | 2,137 | 880 | 1,257 | 1,536 = 0 + 1,536 | -4 | 67 | 322,239 → 276,591 | 343 (1×5) |
| 10133-1 | 419 | 1,396 | 1,001 | 395 | 0 = 0 + 0 | -85.25 | 34 | 208,441 → 159,385 | 179 (1×5) |
| **All 10** | 11,032 | 39,310 | 26,477 | 12,833 | 8,178 | | | | 4452 of 41,011,200 |

- **Culled at bake:** `cover.coveredStuds` from the S6 bake (`checks/bake-cover-summary.json`).
- **Drawn:** `visibleStudInstances` reported by the running `?model=<set>` viewer, which matches the bake for all 10 sets.
- **Differing pixels:** `?model=<set>&api=webgl2&measure=1&warmup=1&frames=N` for N = 1, 2, 3, 4 ends on the fixed orbit pose t = (N−1)/N. The canvas is captured with the HUD hidden on both commits and diffed pixel by pixel (`scripts/compare-models.mjs`, `scripts/clusters.mjs`).
  - Rendering the same commit twice gives 0 differing pixels, so the noise floor is 0.
  - Every differing pixel (4,452 over 40 frames of 1,025,280 px) lies in a connected component at most 2 px wide. The largest is a 1×7 px line.
  - These are leaks along the seams between abutting parts (`models/seam-crop-*.png`: main, S6, diff mask). Removing a hidden stud changes what leaks through the seam.
  - A culled stud that is really visible shows as a solid blob. `models/sensitivity-earlier-rule-10128-1-windscreen.png` is such a case: a 38 px stud disc seen through the hole in a 4872 windscreen. An earlier version of this branch's rule (vertical ray only) caught it, and the shipped rule (full upper hemisphere) no longer culls that stud.

## Placement in the editor

- **Footprint, 2150-1 on a 3811 baseplate** (`footprint/`): the ghost hovers one brick above the baseplate with every stud visible under it, then is placed.
  - HUD: 166 baseplate studs culled under the footprint, 858 still drawn.
  - `checks/footprint-overlap-2150-1.txt` predicts 166 from the bake's footprint cells and the live placement.
  - `footprint-2150-1-edge-inset.png` crops the platform edge at 3×, ghost against placed.
- **Stacking, 10264-1 on 10185-1** (`stack/`; 10182-1 isn't one of the shipped sets after S1, and 10185-1 took its slot): the ghost reads "Lands at 105" and the live `World` stores `yPlates` 105.
  - `checks/stack-check.txt` predicts 105 from the two bake files alone: 10185-1's tallest column (a 4×4 block) is 105 plates, 840 LDU above its rest plane.
  - Rotating the stacked 10264-1 through all four quarter turns keeps `yPlates` at 105 (`stack.json` `rotations`).

## The 10-set scene: main against S6

Ten 3811 baseplates in a 5×2 grid at 1,600 LDU spacing, one set on each, placed through the UI. Each pose is measured as the median of 30 rAF intervals after a 3 s settle, on the same VM, one commit after the other.

| Camera | Commit | Median frame (ms) | Drawn triangles | Draw calls | Studs drawn |
|---|---|---:|---:|---:|---:|
| aerial | main 1dd7132 | 2,064.6 | 6,303,296 | 2,770 | 49,550 |
| aerial | S6 7bc8553 | 1,471.8 | 4,648,208 | 2,599 | 16,239 |
| street | main 1dd7132 | 1,718.7 | 4,758,460 | 1,991 | 49,550 |
| street | S6 7bc8553 | 1,333.5 | 3,451,967 | 1,821 | 16,239 |

- **Stud totals:** S6's HUD reports 16,239 drawn, 26,477 culled inside models and 6,834 culled under footprints. They sum to 49,550, which is every stud of the ten sets (39,310) plus ten baseplates (10,240). `main` culls none in the editor.
- **Cross-check:** `checks/footprint-overlap-10-set-scene.txt` predicts the 6,834 from the bake files and the live `World`.
- **Frame-time drop on the VM:** 29% aerial and 22% street.

## Rerun

```
cd scripts && npm install
BASE=http://127.0.0.1:5173 OUT=out/models-s6 node models.mjs
BASE=http://127.0.0.1:5173 OUT=out/scene-s6 node scene.mjs
BASE=http://127.0.0.1:5173 OUT=out/stack node stack.mjs
BASE=http://127.0.0.1:5173 OUT=out/footprint-2150-1 YAW=0 PITCH=-105 ZOOMS=6 node footprint.mjs
node compare-models.mjs <main-dir> <s6-dir> out/compare.json
node clusters.mjs <main-dir> <s6-dir> out/clusters.json
python3 stack_check.py <bundle>/standard out/stack/stack.json
python3 footprint_overlap.py <bundle>/standard out/scene-s6/scene.json
```

`CHROME=/path/to/chrome` and `API=webgpu` select the browser and API.
