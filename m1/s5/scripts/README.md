# M1 S5 drivers

Playwright drives the real editor at `/` (with `?state=1`, which adds a hidden `#edit-state` element holding the latency samples and the `World` dump). The scripts only use the UI: catalog buttons, mouse moves and clicks, the R, Delete, Escape and C keys, right-drag and the wheel. To reach a lattice point they move the mouse and read the editor's own hover readout (`.editor[data-hover]`), refining by Newton steps until the snapped point matches.

Setup: build the branch (`pnpm install`, `pnpm --filter @brr/asset-pipeline restore-ldraw`, `pnpm --filter @brr/asset-pipeline build`, `pnpm --filter @brr/web build`), serve it with `pnpm --filter @brr/web preview --port 4173`, and make `playwright-core` resolvable (or set `PLAYWRIGHT_CORE` to its path). `CHROME_PATH` selects the browser binary.

Common options: `--api webgpu|webgl2`, `--base http://localhost:4173`, `--width`, `--height`, `--dpr`, `--out <dir>`.

- `s5-latency.cjs [--trials 50] [--sets omr:10264-1,...]`: places one baseplate at (0, 0); then for every set and each of the four rotations runs N trials of place, select, rotate (R) and delete. Each action's latency is the time from the input event to the end of the GPU work for the first frame that contains it. Writes `edit-state.json`, `hud.txt`, `console.txt` and `final.png`.
- `s5-video.cjs [--pause 600]`: records a video (Playwright `recordVideo`) of placing ten baseplates and the ten sets, rotating three sets through all four orientations, deleting one, and orbiting. Writes the `.webm` plus `edit-state.json`, `steps.txt`, `hud.txt` and `final.png`.
- `s5-world.cjs [--settle 2500]`: places every set at all four rotations, then 10185-1 on a 2×2 baseplate field at each rotation with a close-up of its corner. Writes `closeup-10185-1-rot<r>.png`, the inspector text, and `edit-state.json`.
- `node s5-snap-check.mjs <edit-state.json> <bundle/standard>`: recomputes every stud's world position in float64 from the dumped `World`, the model files and the part GLBs. Reports pose violations, frame shifts that differ from the bake rule, and per placement the studs on the baseplate phase (x, z ≡ 10 mod 20) and the maximum deviation of the studs on the model's own lattice.
