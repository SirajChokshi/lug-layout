# M1 S5 evidence (PR #23)

- `macbook-0cf02aa/README.md`: the MacBook Pro M4 Max rotation-latency report for 10218-1 at `0cf02aa` (on battery, Low Power mode; 200 rotations per API, every sample with its breakdown). The raw `edit-state.json` files stayed on the Mac at `~/brr-s5-mac/s5-scripts/m1/s5/scripts/latency-<api>-<run>/`.
- `vm-0cf02aa/demo/`: the demo video (`s5-placement-demo.mp4`, 108 s), a GIF of the rotation and delete, the `#edit-state` dump (latency samples and `World`), the HUD text and the final frame. Driven by `scripts/s5-demo.cjs` on this VM (llvmpipe WebGL2).
- `vm-0cf02aa/world/`: every set at all four rotations plus 10185-1 on 2×2 baseplate fields (60 placements, `scripts/s5-world.cjs`), the four corner close-ups and their 2×2 grid, the inspector text, the `World` dump and `snap-check.json` from `scripts/s5-snap-check.mjs`.
- `vm-5b750dc/video/`: the ten-set video (`scripts/s5-video.cjs`, WebGPU on SwiftShader) recorded before the rebase onto S2, at `5b750dc` (main `ac8ef9a` + #19 + S5). Same S5 code; the bundle predates S2's content-addressed names.
- `vm-f57875e/rebase-1m/`: two measured runs of `?scene=city&parts=1000000&camera=aerial&api=webgl2&measure=1&warmup=10&frames=40`, with `rebases[]` (frame, chunk, chunks moved, ms) and per-frame `frameMs` and `cpuSubmitMs`.
- `scripts/`: the drivers.
