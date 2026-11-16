# M1 S1 evidence, VM run at d697e5d

Same setup as `../vm-e9f3b11/README.md`: real app production build served by `vite preview`, Chrome for Testing 159.0.8154.6 on Xvfb, no GPU (WebGPU on SwiftShader, WebGL2 on llvmpipe), 1280×800.

- `inline-geometry.md` / `.json`: every inline-part resolution from the e9f3b11 set list, flattened independently by `scripts/compare.py` (MPD sections first, then the pinned library) and compared vertex by vertex with the official part.
- `guard/build-failures.txt`: the build refusing 10251-1 and 10278-1 with the compiler's own check.
- `flatten-check.md`: `scripts/flatten_check.py` against the baked model JSON, comparing part, colour, order and all 12 matrix entries per instance.
- `runs/rebrickable-comparison.md`, `runs/city-compare.txt`, `runs/<set>-<api>.json`, `screens/`.
