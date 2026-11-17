# M1 S6 evidence after the critic's review: from below, translucent parts, rest planes (VM)

- **Code:** `siraj/m1-stud-culling-19ec` at `a6ed56e`, on `main` `ecd8f23`. **Before** is `main` at `ecd8f23`. **Old S6** is `7bc8553`, the head the critic reviewed.
- **Local patch for the comparison builds only:** both comparison builds carry `checks/local-view-below-patch-for-before-runs.diff`, the same `view=below` viewer parameter this PR adds. Nothing else is changed.
- **Bundles:** standard `89dc6cfcb854a520` (S6), `main` built at `ecd8f23`, and `201e12988ab5c1bb` (old S6).
- **Machine:** this VM, Chrome 157.0.8103.50, WebGL2 on SwiftShader. Correctness and relative cost only; not M4 Max and not Tier A.

## What changed since `7bc8553` (review items)
1. **Closed below:** every downward line of sight from just outside the stud must hit opaque model geometry within 3 studs (60 LDU). The rays start at 8 heights, every 2.5° from −2.5° to −90°, along 64 azimuths in the stud frame and 64 in the model's lattice frame.
2. **Translucent colours:** triangles whose resolved LDConfig colour has `ALPHA` < 255 neither cover nor block.
3. **Rest plane:** the lowest transformed vertex of any part. The upright-only bounding-box rule is gone, and every model's rest plane is unchanged.
4. **Azimuths:** enclosure rays use 16 azimuths from 0°, so they include the lattice axes and diagonals. The ray-triangle test is inclusive by 1e-9 at edges, so axis rays don't slip between a quad's two triangles; that had dropped 29 cells under 44336p01.
5. **Placement:** a baseplate or roof stud under a hollow (anti-stud) footprint cell is dropped only when all 8 neighbouring cells are closed at its base height by another placement's column. Under a flat cell it is dropped as before.
6. **Model viewer:** `?model=<set>&view=below` orbits under the model.

## Per set

| Set | Studs | Culled at bake (old → new) | Kept: open below | Kept: translucent | Footprint = anti-stud + flat | Rest y | `?model=` triangles main → S6 | Diff px from above / below (2-D blobs, old S6 below) |
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

- **Footprints** match the critic's independent flattener cell for cell: 7936-1 456 + 10, 1,024 flat for each modular, 264 for 2150-1 and 4554-1, 1,536 flat for 4555-1 and 10128-1, 0 for 10133-1.
- **Kept: translucent** counts studs that would be culled again if translucent colours could cover (`bake/witness-and-audit-output.txt`).
- **The critic's own `below_witnesses`** (60 LDU free path; their code applied unchanged in a scratch copy, `bake/critic-witness-and-dense-audit.patch`) finds **0** visible culled studs in all 17 models. On `7bc8553` it found 2,868.
- **Residual from a denser audit:** an independent test denser than the shipped one in every dimension (16 heights, 128 azimuths offset half a step, 1.25° elevation steps, 60 LDU) ran on every 10th culled stud, 1,982 in all.
  - It finds 10 with an escape window narrower than the shipped sampling (`AUDITSAMPLE` lines), about 0.5%, so roughly 100 of the 19,865 culled studs.
  - These are pinhole and grazing gaps only a few degrees wide. One such case is a 7 px sliver in 10218-1 from below, which I traced and which the shipped sampling now keeps.

## From below in the real app (`?model=<set>&view=below&measure=1&warmup=1&frames=N`, N = 1–4)
- **S6 against main:** 2,007 differing pixels over 40 frames, every one in a component at most 2 px wide (seam leaks, largest 1×8). No 2-D blob.
- **Old S6 against main:** 10,202 differing pixels, including 87 two-dimensional blobs, the largest 10×6 px.
  - `models/below-10218-blob.png` (main, old S6, new S6 at 8×): the row of stud bumps along an overhang edge is gone in the old S6 and back in the new.
  - `models/below-10133-blob.png` shows the same for 10133-1.
- **From above, S6 against main:** 3,450 px, all in components at most 2 px wide.
- **Noise floor:** rendering the same commit twice gives 0 differing pixels.

## Editor (through the UI with Playwright)
- **Footprint, 2150-1 on a 3811:** 150 baseplate studs culled; the edge studs whose neighbours are off the baseplate stay. The 150 is predicted from the bake (`checks/footprint-overlap-2150-1.txt`).
- **Stack:** 10264-1 on 10185-1 lands at `yPlates` 105, the same as the bake prediction (`checks/stack-check.txt`), and stays at 105 through four rotations.
- **10-set scene:** five 3811 baseplates in each of two rows at 1,600 LDU, one set on each.

| Camera | Commit | Median frame (ms) | Drawn triangles | Draw calls | Studs drawn |
|---|---|---:|---:|---:|---:|
| aerial | main ecd8f23 | 1,968.7 | 6,303,296 | 2,770 | 49,550 |
| aerial | S6 a6ed56e | 1,482.4 | 4,987,664 | 2,600 | 22,907 |
| street | main ecd8f23 | 1,600.3 | 4,758,460 | 1,991 | 49,550 |
| street | S6 a6ed56e | 1,317.6 | 3,726,383 | 1,822 | 22,907 |

- **Stud totals:** 22,907 drawn + 19,865 culled inside models + 6,778 culled under footprints = 49,550, every stud of the ten sets plus ten baseplates.
- **Cross-check:** 6,778 is predicted from the bake files with the neighbour rule (`checks/footprint-overlap-10-set-scene.txt`).
- **Bake time:** 38 s per bundle on 8 cores, about 7 s before the dense downward test; three bundles are built.

## Rerun
Same as `m1/s6/vm-7bc8553`. `VIEW=below node models.mjs` adds the from-below views. The bake audit is `bake/critic-witness-and-dense-audit.patch` applied to a copy of `crates/`, then `AUDIT=1` on the CLI.
