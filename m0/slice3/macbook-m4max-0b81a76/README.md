# M0 slice 3 (scale) render benchmark at 0b81a76: MacBook Pro (M4 Max)

- Repo: https://github.com/SirajChokshi/lug-layout. Tested `0b81a76d672c64e71a968a415a5174a5fdd10020` ("Measure GPU buffers as allocated, keep imported scenes near-only, sample the far LOD densely"), which was the `origin/siraj/m0-scale-b86f` head after `git fetch` at 2026-11-16 07:25 UTC. Detached checkout in `~/tmp/lug-layout-bench`; nothing was pushed.
- Build, same steps as `../slice3-9d26e81/`: `CI=true pnpm install --frozen-lockfile`, `pnpm --filter @brr/asset-pipeline restore-ldraw`, `pnpm --filter @brr/asset-pipeline build` (wrote the standard, low and far bundles), and `pnpm --filter @brr/web build`. All exited 0 in about 33 s total. `pnpm --filter @brr/web preview --port 4173` was stopped after the run.
- Run: 2026-11-16 07:26:33–07:27:43 UTC, in the same order as 9d26e81 (parts outer, camera, API inner). One visible Chrome 157.0.8103.52 with a fresh profile, no GPU flags, a **fresh tab per run**, window maximized at 1800x1130 CSS px (drawing buffer 3600x2086 at devicePixelRatio 2), on AC power. GPU-process capture was skipped, as requested.
- Machine: MacBook Pro Mac16,6, Apple M4 Max (40-core GPU), 64 GB, macOS 26.6.2 (25G83). See `macbook-info.txt`.
- URL: `http://localhost:4173/?scene=city&parts=P&api=A&camera=C&measure=1&warmup=10&frames=120`.

## Failures

None. All 16 runs reached 120 measured frames on the requested API. There was no tab crash, no `.hud .error` element, no "fail" text in any HUD, and every `<run>.console.txt` is empty. No `*.error.txt` files were written.

## Results

Memory comes from the result JSON's `memory` object: `vertexIndexBytes`, `otherBytes` and `jsHeapBytes`. The HUD labels these "GPU buffers allocated so far, JS heap". MiB = 1,048,576 bytes. Draw calls and drawn triangles are `timings.medianDrawCalls` / `timings.medianDrawnTriangles`; tiers are `timings.medianChunkTiers`. The last timing column repeats the 9d26e81 result for the same URL from `../slice3-9d26e81/`. Frame times are quantized to about 0.1 ms, and repeat runs at 9d26e81 differed by up to about 1 ms.

| Run | Active API | Median frame | p95 | CPU submit | Draw calls (median) | Drawn tris (median) | Chunk tiers near/mid/far | vertexIndexBytes | otherBytes | JS heap | Load | 9d26e81 median / p95 | Files |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `city-100000-aerial-webgpu` | webgpu | 5.9 ms | 6.6 ms | 1.4 ms | 671 | 8,290,265 | 15 / 66 / 0 | 17.3 MiB (18,121,096 B) | 0.19 MiB (196,752 B) | 43.5 MiB | 276 ms | 6.2 / 6.8 ms | `city-100000-aerial-webgpu.json`, `.hud.txt`, `.viewport.png` |
| `city-100000-aerial-webgl2` | webgl2 | 7.7 ms | 8.4 ms | 1.4 ms | 671 | 8,290,265 | 15 / 66 / 0 | 17.3 MiB (18,121,096 B) | 0.21 MiB (216,400 B) | 40.8 MiB | 164 ms | 8.0 / 8.7 ms | `city-100000-aerial-webgl2.json`, `.hud.txt`, `.viewport.png` |
| `city-100000-street-webgpu` | webgpu | 3.5 ms | 6.7 ms | 0.6 ms | 218 | 8,627,341 | 79 / 2 / 0 | 12.9 MiB (13,561,188 B) | 0.09 MiB (92,112 B) | 41.1 MiB | 163 ms | 3.5 / 6.4 ms | `city-100000-street-webgpu.json`, `.hud.txt`, `.viewport.png` |
| `city-100000-street-webgl2` | webgl2 | 5.0 ms | 7.9 ms | 0.6 ms | 218 | 8,627,341 | 79 / 2 / 0 | 12.9 MiB (13,561,188 B) | 0.10 MiB (101,296 B) | 36.1 MiB | 161 ms | 5.6 / 7.9 ms | `city-100000-street-webgl2.json`, `.hud.txt`, `.viewport.png` |
| `city-250000-aerial-webgpu` | webgpu | 12.1 ms | 14.0 ms | 3.3 ms | 1,557 | 10,713,895 | 0 / 196 / 0 | 41.9 MiB (43,972,544 B) | 0.24 MiB (255,792 B) | 75.7 MiB | 278 ms | 11.5 / 12.3 ms | `city-250000-aerial-webgpu.json`, `.hud.txt`, `.viewport.png` |
| `city-250000-aerial-webgl2` | webgl2 | 13.3 ms | 14.6 ms | 3.3 ms | 1,557 | 10,713,895 | 0 / 196 / 0 | 41.9 MiB (43,972,544 B) | 0.27 MiB (281,344 B) | 72.0 MiB | 279 ms | 13.2 / 13.9 ms | `city-250000-aerial-webgl2.json`, `.hud.txt`, `.viewport.png` |
| `city-250000-street-webgpu` | webgpu | 7.2 ms | 11.4 ms | 1.6 ms | 442 | 17,207,947 | 147 / 49 / 0 | 31.5 MiB (33,024,712 B) | 0.26 MiB (274,352 B) | 80.9 MiB | 281 ms | 7.6 / 11.0 ms | `city-250000-street-webgpu.json`, `.hud.txt`, `.viewport.png` |
| `city-250000-street-webgl2` | webgl2 | 8.6 ms | 12.0 ms | 1.2 ms | 442 | 17,207,947 | 147 / 49 / 0 | 31.5 MiB (33,024,712 B) | 0.29 MiB (301,760 B) | 69.8 MiB | 282 ms | 8.4 / 12.1 ms | `city-250000-street-webgl2.json`, `.hud.txt`, `.viewport.png` |
| `city-500000-aerial-webgpu` | webgpu | 23.8 ms | 25.0 ms | 6.9 ms | 3,144 | 21,042,349 | 0 / 390 / 10 | 84.3 MiB (88,415,976 B) | 0.50 MiB (524,912 B) | 135.8 MiB | 474 ms | 24.2 / 25.5 ms | `city-500000-aerial-webgpu.json`, `.hud.txt`, `.viewport.png` |
| `city-500000-aerial-webgl2` | webgl2 | 24.1 ms | 26.1 ms | 7.0 ms | 3,144 | 21,042,349 | 0 / 390 / 10 | 84.3 MiB (88,415,976 B) | 0.55 MiB (577,376 B) | 132.0 MiB | 468 ms | 23.9 / 25.2 ms | `city-500000-aerial-webgl2.json`, `.hud.txt`, `.viewport.png` |
| `city-500000-street-webgpu` | webgpu | 9.1 ms | 18.0 ms | 2.5 ms | 771 | 19,066,243 | 171 / 227 / 0 | 57.8 MiB (60,576,360 B) | 0.49 MiB (517,392 B) | 147.3 MiB | 486 ms | 9.3 / 17.6 ms | `city-500000-street-webgpu.json`, `.hud.txt`, `.viewport.png` |
| `city-500000-street-webgl2` | webgl2 | 10.8 ms | 18.4 ms | 2.5 ms | 771 | 19,066,243 | 171 / 227 / 0 | 57.8 MiB (60,576,360 B) | 0.54 MiB (569,104 B) | 202.7 MiB | 483 ms | 11.1 / 18.5 ms | `city-500000-street-webgl2.json`, `.hud.txt`, `.viewport.png` |
| `city-1000000-aerial-webgpu` | webgpu | 40.6 ms | 45.7 ms | 13.9 ms | 5,670 | 26,079,987 | 0 / 376 / 405 | 168.8 MiB (176,990,708 B) | 0.97 MiB (1,019,472 B) | 246.9 MiB | 864 ms | 39.7 / 44.0 ms | `city-1000000-aerial-webgpu.json`, `.hud.txt`, `.viewport.png` |
| `city-1000000-aerial-webgl2` | webgl2 | 38.9 ms | 41.3 ms | 15.2 ms | 5,670 | 26,079,987 | 0 / 376 / 405 | 168.8 MiB (176,990,708 B) | 1.07 MiB (1,121,392 B) | 247.9 MiB | 875 ms | 38.0 / 40.1 ms | `city-1000000-aerial-webgl2.json`, `.hud.txt`, `.viewport.png` |
| `city-1000000-street-webgpu` | webgpu | 15.3 ms | 33.4 ms | 5.3 ms | 1,373 | 23,960,837 | 189 / 595 / 0 | 114.2 MiB (119,745,628 B) | 0.91 MiB (950,352 B) | 238.6 MiB | 857 ms | 15.7 / 33.4 ms | `city-1000000-street-webgpu.json`, `.hud.txt`, `.viewport.png` |
| `city-1000000-street-webgl2` | webgl2 | 16.1 ms | 32.7 ms | 4.6 ms | 1,373 | 23,960,837 | 189 / 595 / 0 | 114.2 MiB (119,745,628 B) | 1.00 MiB (1,045,360 B) | 368.4 MiB | 884 ms | 15.4 / 32.8 ms | `city-1000000-street-webgl2.json`, `.hud.txt`, `.viewport.png` |

## Files (per run `<run>` = `city-<parts>-<camera>-<api>`)

| File | What |
| --- | --- |
| `<run>.json` | Exact `#result` text (includes `memory`, `timings.medianChunkTiers`, `drawingBuffer`) |
| `<run>.hud.txt` | HUD text |
| `<run>.viewport.png` | Viewport screenshot via DevTools `Page.captureScreenshot` |
| `<run>.console.txt` | Console, exception and log entries for the tab (all empty) |
| `chrome-gpu.txt`, `chrome-systeminfo.json` | chrome://gpu text and DevTools `SystemInfo.getInfo` |
| `browser-window.json` | Window bounds and per-run completion and wait time |
| `macbook-info.txt`, `run.log` | Machine info and driver log |
