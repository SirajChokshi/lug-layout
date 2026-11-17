# M1 S6 evidence after the critic's review, rebased on main 334cfe6 (VM)

- **Code:** `siraj/m1-stud-culling-19ec` at `8e41152`, on `main` `334cfe6`. **Before** is `main` at `334cfe6`. **Old S6** is `7bc8553`, the head the critic reviewed; it is compared against `main` `ecd8f23`, its own base at the time.
- **Local patches, for the evidence builds only:**
  - Every comparison build (main, old S6) carries `checks/local-view-below-patch-for-before-runs.diff`, the same `view=below` viewer parameter this PR adds.
  - For the editor runs, both main and S6 also carry `checks/local-pr66-skip-latticeless-patch.diff`. That's commit `17b32a2` of open PR #66: since #39, `main`'s edit mode stops at "model 10020-1 has no stud lattice", and the patch skips lattice-less sets.
- **Bundles:** standard `7106b705ee6e2397` (S6) and `6462e3f858d42279` (main). **Machine:** this VM, Chrome 157.0.8103.50, WebGL2 on SwiftShader. Correctness and relative cost only.

## Review items
1. **Closed below:** every downward line of sight from just outside a stud must hit opaque model geometry within 3 studs (60 LDU). Rays start at 8 heights, every 2.5° from −2.5° to −90°, along 64 stud-frame and 64 lattice-frame azimuths.
2. **Translucent colours:** `ALPHA` < 255 neither covers nor blocks.
3. **Rest plane:** the lowest transformed vertex of any part.
4. **Azimuths:** 16 enclosure azimuths from 0°, including the axes and diagonals.
5. **Placement:** a stud under a hollow footprint cell is dropped only when all 8 neighbours are closed at its base height. `?model=<set>&view=below` orbits under the model.
6. **Cover cache:** the cover is computed once per bundle build, from the standard LOD, and reused for low and far. The bundle hashes are the same with and without the cache.

## Bake, all 30 models (`bake/witness-and-audit-output-all-30-models.txt`)
- **Culled:** 25,678 studs — 19,865 in the ten sets, 3,157 in the eight train models from #39, and 2,656 in the five MILS road modules.
- **The critic's `below_witnesses`**, applied unchanged in a scratch copy (`bake/critic-witness-and-dense-audit.patch`), finds **0** visible culled studs in every model. On `7bc8553` it found 2,868 in the ten sets.
- **Measured residual:** an independent test denser than the shipped one in every dimension (16 heights, 128 azimuths offset half a step, 1.25° steps), run on every 10th culled stud (2,557 studs), finds **9** with an escape window narrower than the shipped sampling. That is 0.35%, so roughly 90 studs, all behind pinhole or grazing gaps a few degrees wide.

## Ten sets
| Set | Studs | Culled at bake (old → new) | Kept: open below | Kept: translucent (a6ed56e run) | Footprint = anti-stud + flat | Rest y | `?model=` triangles main → S6 | Diff px from above / below (2-D blobs, old S6 below) |
|---|---:|---|---:|---:|---|---:|---|---|
| 7936-1 | 622 | 312 → 156 | 138 | 10 | 466 = 456 + 10 | -8 | 140,604 → 132,444 | 144 / 100 (0, 5) |
| 10264-1 | 7,489 | 5,431 → 4,404 | 879 | 93 | 1,024 = 0 + 1,024 | -4 | 1,222,337 → 994,865 | 838 / 515 (0, 3) |
| 10185-1 | 7,607 | 5,882 → 4,726 | 1,071 | 26 | 1,024 = 0 + 1,024 | -4 | 1,036,407 → 805,959 | 596 / 386 (0, 7) |
| 10190-1 | 5,127 | 3,400 → 2,527 | 849 | 4 | 1,024 = 0 + 1,024 | -4 | 747,071 → 623,087 | 451 / 307 (0, 12) |
| 10218-1 | 7,040 | 5,210 → 4,311 | 809 | 101 | 1,024 = 0 + 1,024 | -4 | 936,913 → 723,937 | 641 / 323 (0, 8) |
| 2150-1 | 2,449 | 1,584 → 927 | 651 | 4 | 264 = 264 + 0 | -8 | 410,478 → 364,062 | 140 / 82 (0, 11) |
| 4554-1 | 2,447 | 1,568 → 913 | 649 | 4 | 264 = 264 + 0 | -8 | 404,254 → 358,510 | 87 / 64 (0, 11) |
| 4555-1 | 2,996 | 1,209 → 713 | 455 | 5 | 1,536 = 0 + 1,536 | -4 | 382,201 → 346,057 | 201 / 79 (0, 12) |
| 10128-1 | 2,137 | 880 → 451 | 380 | 24 | 1,536 = 0 + 1,536 | -4 | 322,239 → 299,295 | 195 / 67 (0, 12) |
| 10133-1 | 1,396 | 1,001 → 737 | 250 | 2 | 0 = 0 + 0 | -85.25 | 208,441 → 172,441 | 157 / 84 (0, 6) |
| **All 10** | 39,310 | 26,477 → 19,865 | 6,131 | 273 | 8,162 | | | 3450 / 2007 (0, 87) |

The ten sets' cover is identical to the `a6ed56e` run. Footprints match the critic's independent flattener cell for cell.

## From below in the real app
- **S6 against main:** 2,007 differing pixels over 40 frames, all in components at most 2 px wide (seam leaks, largest 1×8). No 2-D blob.
- **Old S6 against main `ecd8f23`:** 10,202 differing pixels, including 87 two-dimensional blobs (largest 10×6).
- **Crops:** `models/below-10218-blob.png` and `models/below-10133-blob.png` (main, old S6, new S6, 8×) show overhang edge studs missing in the old S6 and back in the new.
- **From above, S6 against main:** 3,450 px, all thin.

## Editor
- **Footprint:** 2150-1 on a 3811 culls 150 baseplate studs (prediction 150). Edge studs whose neighbours are off the baseplate stay.
- **Stack:** 10264-1 on 10185-1 rests at `yPlates` 105 (prediction 105) through four rotations.
- **Roads (`roads/`):** a MILS road module and a 3811 placed side by side get the same poses and road report as main (module at `yPlates` 0, 32 open cells). S6 also culls 608 studs inside the module.

| Camera | Commit | Median frame (ms) | Drawn triangles | Draw calls | Studs drawn |
|---|---|---:|---:|---:|---:|
| aerial | main 334cfe6 | 2,051.7 | 6,303,296 | 2,770 | 49,550 |
| aerial | S6 8e41152 | 1,605.0 | 4,987,664 | 2,600 | 22,907 |
| street | main 334cfe6 | 1,661.6 | 4,758,460 | 1,991 | 49,550 |
| street | S6 8e41152 | 1,274.0 | 3,726,383 | 1,822 | 22,907 |

- **Stud totals:** 22,907 drawn + 19,865 culled inside models + 6,778 culled under footprints = 49,550. The 6,778 is predicted from the bake (`checks/footprint-overlap-10-set-scene.txt`).
- **Bundle build:** 5 min 30 s for three bundles, against about 4 min 50 s on main. The standard bake alone takes 61 s.
