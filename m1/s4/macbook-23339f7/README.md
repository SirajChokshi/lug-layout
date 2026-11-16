# M1 S4 far coordinates: 250k origin vs far (MacBook Pro, M4 Max)

- **Branch:** `siraj/m1-far-coordinates-b86f`. **Fix:** `23339f72c7156cd072be98fc3243933aa8e8484d` ("Camera-relative rendering: a chunk-snapped render origin with rebasing", the branch head at fetch). **Before the fix:** `5ef44bdfba63769ccbcf26e166d4213cb469ef67` ("Place the city at a real world offset (?origin=x,z chunks) …"), its parent. Detached checkouts in `~/tmp/lug-layout-bench`; nothing was pushed.
- **Build (each commit):** `CI=true pnpm install --frozen-lockfile`, `pnpm --filter @brr/asset-pipeline restore-ldraw`, `pnpm --filter @brr/asset-pipeline build`, `pnpm --filter @brr/web build`. All exited 0. Each was served with `pnpm --filter @brr/web preview --port 4173` (stopped afterwards).
- **Runs:** 23339f7 2026-11-16 18:03:28–18:04:00 UTC, with each origin/far pair back to back (API, then camera, then origin before far). 5ef44bd far 250k WebGPU street at 18:05:13 UTC. Same setup as slice 3: one visible Chrome 157.0.8103.52 per commit with a fresh profile, **a fresh tab per run**, no GPU flags, window maximized at 1800x1130 CSS px (drawing buffer 3600x2086 at devicePixelRatio 2).
- **Far URL:** the origin URL plus `&origin=39063,39063` (chunk 39063, 39063). Base: `http://localhost:4173/?scene=city&parts=250000&api=A&camera=C&measure=1&warmup=10&frames=120`.
- **All runs:** 120 measured frames on the requested API. No failures: no crash, no `.hud .error`, no "fail" in any HUD, and every console log is empty.

## ⚠ Machine state: these numbers aren't comparable to earlier sessions

The MacBook switched to **battery power at 10:01:26 local (18:01:26 UTC)**, just before these runs (pmset log), and was under heavy background load: load average about 50, with `fseventsd` at about 131% CPU (see `macbook-info.txt`). It also idle-slept from 18:07:51 to 18:09:46 UTC, between control runs. Earlier sessions (slice 3, M1 S3) were on AC. Origin and far ran back to back under the same conditions, so **the origin vs far comparison within this folder is valid. The absolute times are not comparable to earlier folders.** The control runs below show the whole session was slower, including the unchanged S3 build.

## Origin vs far (23339f7), plus the before-fix far run

`rebases` is the result's list of render-origin moves (`frame → chunkX, chunkZ`); it doesn't exist at 5ef44bd. Draw calls and drawn triangles are medians.

| Run | Commit | Active API | Origin (chunks) | Median frame | p95 | Mean | CPU submit | Draw calls (median) | Drawn tris (median) | Tiers n/m/f | Rebases (count) | Rebase frames → render origin chunk | Files |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `city-250000-webgpu-aerial-origin` | `23339f7` | webgpu | 0,0 | 20.7 ms | 22.4 ms | 19.05 ms | 4.2 ms | 1,557 | 10,713,895 | 0/196/0 | 17 | f0→(11,0); f2→(3,11); f4→(-10,6); f6→(-10,-7); f8→(3,-12); f10→(11,0); f27→(7,9); f42→(-2,11); f60→(-11,5); f75→(-12,-4); f96→(-3,-12); f111→(6,-10); f129→(11,-1); f131→(8,8); f133→(-9,8); f135→(-9,-9); f137→(8,-9) | `23339f7/city-250000-webgpu-aerial-origin.json`, `.hud.txt`, `.viewport.png` |
| `city-250000-webgpu-aerial-far` | `23339f7` | webgpu | 39063,39063 | 20.5 ms | 24.0 ms | 18.99 ms | 4.1 ms | 1,557 | 10,713,895 | 0/196/0 | 17 | f0→(39074,39063); f2→(39066,39074); f4→(39053,39069); f6→(39053,39056); f8→(39066,39051); f10→(39074,39063); f27→(39070,39072); f42→(39061,39074); f60→(39052,39068); f75→(39051,39059); f96→(39060,39051); f111→(39069,39053); f129→(39074,39062); f131→(39071,39071); f133→(39054,39071); f135→(39054,39054); f137→(39071,39054) | `23339f7/city-250000-webgpu-aerial-far.json`, `.hud.txt`, `.viewport.png` |
| `city-250000-webgpu-street-origin` | `23339f7` | webgpu | 0,0 | 9.0 ms | 14.9 ms | 9.13 ms | 1.5 ms | 442 | 17,207,947 | 147/49/0 | 6 | f0→(-1,-7); f8→(-1,3); f10→(-1,-7); f96→(-1,2); f130→(-1,-7); f136→(-1,2) | `23339f7/city-250000-webgpu-street-origin.json`, `.hud.txt`, `.viewport.png` |
| `city-250000-webgpu-street-far` | `23339f7` | webgpu | 39063,39063 | 11.4 ms | 17.3 ms | 10.20 ms | 2.1 ms | 442 | 17,207,947 | 147/49/0 | 6 | f0→(39062,39056); f8→(39062,39066); f10→(39062,39056); f96→(39062,39065); f130→(39062,39056); f136→(39062,39065) | `23339f7/city-250000-webgpu-street-far.json`, `.hud.txt`, `.viewport.png` |
| `city-250000-webgpu-street-far` | `5ef44bd` | webgpu | 39063,39063 | 11.2 ms | 17.5 ms | 10.84 ms | 1.7 ms | 442 | 17,207,947 | 147/49/0 | n/a (field absent) | — | `5ef44bd/city-250000-webgpu-street-far.json`, `.hud.txt`, `.viewport.png` |
| `city-250000-webgl2-aerial-origin` | `23339f7` | webgl2 | 0,0 | 14.3 ms | 17.9 ms | 15.26 ms | 4.0 ms | 1,557 | 10,713,895 | 0/196/0 | 17 | f0→(11,0); f2→(3,11); f4→(-10,6); f6→(-10,-7); f8→(3,-12); f10→(11,0); f27→(7,9); f42→(-2,11); f60→(-11,5); f75→(-12,-4); f96→(-3,-12); f111→(6,-10); f129→(11,-1); f131→(8,8); f133→(-9,8); f135→(-9,-9); f137→(8,-9) | `23339f7/city-250000-webgl2-aerial-origin.json`, `.hud.txt`, `.viewport.png` |
| `city-250000-webgl2-aerial-far` | `23339f7` | webgl2 | 39063,39063 | 15.0 ms | 34.9 ms | 17.63 ms | 4.3 ms | 1,557 | 10,713,895 | 0/196/0 | 17 | f0→(39074,39063); f2→(39066,39074); f4→(39053,39069); f6→(39053,39056); f8→(39066,39051); f10→(39074,39063); f27→(39070,39072); f42→(39061,39074); f60→(39052,39068); f75→(39051,39059); f96→(39060,39051); f111→(39069,39053); f129→(39074,39062); f131→(39071,39071); f133→(39054,39071); f135→(39054,39054); f137→(39071,39054) | `23339f7/city-250000-webgl2-aerial-far.json`, `.hud.txt`, `.viewport.png` |
| `city-250000-webgl2-street-origin` | `23339f7` | webgl2 | 0,0 | 8.8 ms | 13.0 ms | 8.55 ms | 1.3 ms | 442 | 17,207,947 | 147/49/0 | 6 | f0→(-1,-7); f8→(-1,3); f10→(-1,-7); f96→(-1,2); f130→(-1,-7); f136→(-1,2) | `23339f7/city-250000-webgl2-street-origin.json`, `.hud.txt`, `.viewport.png` |
| `city-250000-webgl2-street-far` | `23339f7` | webgl2 | 39063,39063 | 14.4 ms | 27.4 ms | 15.96 ms | 4.5 ms | 442 | 17,207,947 | 147/49/0 | 6 | f0→(39062,39056); f8→(39062,39066); f10→(39062,39056); f96→(39062,39065); f130→(39062,39056); f136→(39062,39065) | `23339f7/city-250000-webgl2-street-far.json`, `.hud.txt`, `.viewport.png` |


**Reading.**
- At 23339f7, WebGPU far vs origin is within noise: aerial 20.5 vs 20.7 ms, street 11.4 vs 9.0 ms (CPU submit 2.1 vs 1.5 ms).
- WebGL2 far runs were slower and spikier than origin: aerial p95 34.9 vs 17.9 ms, street 14.4 vs 8.8 ms median and 27.4 vs 13.0 ms p95. That's one sample each under a loaded, battery-powered machine, so re-run on AC before drawing conclusions.
- Draw calls, drawn triangles and tiers are identical between origin and far.
- The rebase sequences are identical between origin and far, apart from the 39063-chunk offset: 17 rebases in aerial, 6 in street.
- In street, the origin alternates between two chunks (z −7 ↔ +3/+2 at the origin; 39056 ↔ 39066/39065 when far) at frames 0, 8, 10, 96, 130 and 136. Frames 0–10 are warm-up.
- The before-fix far street run (5ef44bd) measured 11.2 / 17.5 ms, CPU 1.7 ms, the same as 23339f7 far (11.4 / 17.3 ms). Precision artefacts at the far origin would show visually, not in frame time; see the recordings.

## Controls (same session, origin URLs only)

Added to separate the code from the machine state.

| URL (origin 0,0) | 23339f7, 18:03 UTC, battery | 5ef44bd control, 18:07 UTC, battery | 1a53a93 control, 18:10 UTC, battery | 1a53a93 in M1 S3, 17:12 UTC, AC |
|---|---|---|---|---|
| `webgpu aerial` | 20.7 / 22.4 ms, CPU 4.2 | 21.3 / 22.2 ms, CPU 4.2 | 21.0 / 22.4 ms, CPU 4.1 | 11.7 / 12.4 ms, CPU 3.2 |
| `webgpu street` | 9.0 / 14.9 ms, CPU 1.5 | 10.5 / 15.3 ms, CPU 1.9 | 11.5 / 16.6 ms, CPU 1.9 | 6.6 / 10.9 ms, CPU 1.2 |
| `webgl2 aerial` | 14.3 / 17.9 ms, CPU 4.0 | not run | 19.3 / 41.5 ms, CPU 5.8 | 13.3 / 14.3 ms, CPU 3.3 |
| `webgl2 street` | 8.8 / 13.0 ms, CPU 1.3 | not run | 11.8 / 23.8 ms, CPU 2.9 | 8.3 / 12.5 ms, CPU 1.2 |

At 250k WebGPU aerial, the unchanged S3 build (1a53a93) gives 21.0 ms in this session against 11.7 ms an hour earlier on AC. So the slowdown is the machine's state, not the S4 code.

## Live recordings (no measure)

URL: `http://localhost:4173/?scene=city&parts=20000&api=webgpu&camera=street&origin=39063,39063`. Each was recorded with macOS `screencapture -v -V10` of the maximized Chrome window, 3 s after the HUD appeared. The files are H.264 `.mov`, 3600×2260, about 10.0 s, about 57 fps. The camera moves during both. `*.frame5s.png` is a frame at 5 s, and `*.meta.json` holds the URL, start time, window bounds and the HUD before and after.

| Commit | Recording | Size |
|---|---|---|
| 5ef44bd (before the fix) | `recordings/live-20000-webgpu-street-far-5ef44bd.mov` | 55 MB |
| 23339f7 (fix) | `recordings/live-20000-webgpu-street-far-23339f7.mov` | 65 MB |

The 23339f7 HUD shows `Render origin (chunks) (39061, 39060); 1 rebases`, and 5ef44bd has no render-origin row. Both report 120 fps (rAF). Frame-to-frame differences exist in both (the camera moves), so any precision jitter has to be judged by watching.

## Files

- `23339f7/`, `5ef44bd/`, `controls/5ef44bd/`, `controls/1a53a93/`: for each run, `<run>.json` (exact `#result`, including `rebases` at 23339f7), `.hud.txt`, `.viewport.png` and `.console.txt`, plus `run.log`. `chrome-gpu.txt` and `chrome-systeminfo.json` are present in `23339f7/` and `5ef44bd/`. The `controls/5ef44bd` driver timed out on the final chrome://gpu read after both runs had completed, so that folder has no GPU text.
- `recordings/`: the two `.mov` files, frames and metadata.
- `macbook-info.txt`: hardware, power (battery), load and top CPU processes, captured at 18:11 UTC.
