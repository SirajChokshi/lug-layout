# M0 slice 2 (city) render benchmark: MacBook Pro (M4 Max)

- Repo: https://github.com/SirajChokshi/lug-layout, branch `siraj/m0-city-b86f`. Tested commit `76f3d1f5d15d17382fbcdcf8bce378a8ca4cb8ca` ("City rail runs from measured track-end poses; credit each model per its source"), which was `origin/siraj/m0-city-b86f` after `git fetch` at 2026-11-16 04:44 UTC. The request said `76f3d1f6`, but no commit with that prefix exists; the branch head starts with `76f3d1f5`. Detached checkout in `~/tmp/lug-layout-bench`; nothing was pushed.
- Build: `CI=true pnpm install --frozen-lockfile`, `pnpm --filter @brr/asset-pipeline build` ("LDraw inputs match ldraw.lock.json"), and `pnpm --filter @brr/web build`. All exited 0. `pnpm --filter @brr/web preview --port 4173` was stopped after the run.
- Run: 2026-11-16 04:44–04:46 UTC, in the order listed below. Same setup as slice 1: visible Chrome 157.0.8103.52, a fresh profile driven over the DevTools protocol, no GPU flags, window maximized at 1800x1130 CSS px (viewport 1800x1043, drawing buffer 3600x2086 at devicePixelRatio 2), on AC power. chrome://gpu reports WebGPU and WebGL as hardware accelerated.
- Machine: MacBook Pro Mac16,6, Apple M4 Max (40-core GPU), 64 GB, macOS 26.6.2 (25G83). See `macbook-info.txt`.
- All URLs are `http://localhost:4173/?scene=city&parts=N&api=A&strategy=S&measure=1&warmup=10&frames=120`. The street runs add `&camera=street` with `parts=20000` and `strategy=instanced`.

## "Rendering failed" check

No run shows "Rendering failed": there was no `.hud .error` element, and no "fail" text in any `<run>.hud.txt`. All 14 runs completed with 120 measured frames on the requested API.

**However, both `street` runs render an empty frame.** The viewport and window screenshots show only the background colour, with no geometry. The HUD reports 4 draw calls and 19,157 drawn triangles out of 9,616,736 in the scene. The street-camera timings therefore measure an essentially empty view.

## Results

"Scene tris" is body plus stud triangles from `summary`. Frame times are quantized to about 0.1 ms (browser timer resolution).

| Run | parts param | API (active) | Strategy | Camera | drawingBuffer | Parts | Modules | Studs | Scene tris | Draw calls | Drawn tris | Load | Median | p95 | Mean | CPU submit | Frames |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `city-2000-webgpu-instanced` | 2,000 | webgpu | instanced | aerial | 3600×2086 @2 | 2,035 | 16 | 23,242 | 1,542,652 | 181 | 1,542,653 | 115 ms | 2.1 ms | 3.0 ms | 2.36 ms | 0.4 ms | 120 |
| `city-2000-webgpu-batched` | 2,000 | webgpu | batched | aerial | 3600×2086 @2 | 2,035 | 16 | 23,242 | 1,542,652 | 2,784 | 1,542,653 | 85 ms | 2.6 ms | 3.3 ms | 2.70 ms | 0.4 ms | 120 |
| `city-2000-webgl2-instanced` | 2,000 | webgl2 | instanced | aerial | 3600×2086 @2 | 2,035 | 16 | 23,242 | 1,542,652 | 181 | 1,542,653 | 131 ms | 4.3 ms | 5.5 ms | 4.40 ms | 0.5 ms | 120 |
| `city-2000-webgl2-batched` | 2,000 | webgl2 | batched | aerial | 3600×2086 @2 | 2,035 | 16 | 23,242 | 1,542,652 | 11 | 1,542,653 | 73 ms | 4.7 ms | 5.1 ms | 4.59 ms | 0.3 ms | 120 |
| `city-20000-webgpu-instanced` | 20,000 | webgpu | instanced | aerial | 3600×2086 @2 | 20,090 | 25 | 120,037 | 9,616,736 | 321 | 9,616,737 | 91 ms | 4.1 ms | 4.3 ms | 4.12 ms | 0.7 ms | 120 |
| `city-20000-webgpu-batched` | 20,000 | webgpu | batched | aerial | 3600×2086 @2 | 20,090 | 25 | 120,037 | 9,616,736 | 26,601 | 9,156,881 | 76 ms | 10.3 ms | 10.8 ms | 10.25 ms | 2.7 ms | 120 |
| `city-20000-webgl2-instanced` | 20,000 | webgl2 | instanced | aerial | 3600×2086 @2 | 20,090 | 25 | 120,037 | 9,616,736 | 321 | 9,616,737 | 94 ms | 6.3 ms | 7.1 ms | 6.37 ms | 0.6 ms | 120 |
| `city-20000-webgl2-batched` | 20,000 | webgl2 | batched | aerial | 3600×2086 @2 | 20,090 | 25 | 120,037 | 9,616,736 | 11 | 9,156,881 | 72 ms | 24.2 ms | 25.1 ms | 24.27 ms | 2.1 ms | 120 |
| `city-100000-webgpu-instanced` | 100,000 | webgpu | instanced | aerial | 3600×2086 @2 | 100,228 | 81 | 552,956 | 45,516,348 | 1,117 | 45,516,349 | 110 ms | 13.9 ms | 14.8 ms | 13.98 ms | 1.8 ms | 120 |
| `city-100000-webgpu-batched` | 100,000 | webgpu | batched | aerial | 3600×2086 @2 | 100,228 | 81 | 552,956 | 45,516,348 | 133,947 | 42,917,725 | 89 ms | 42.7 ms | 44.6 ms | 42.81 ms | 12.1 ms | 120 |
| `city-100000-webgl2-instanced` | 100,000 | webgl2 | instanced | aerial | 3600×2086 @2 | 100,228 | 81 | 552,956 | 45,516,348 | 1,117 | 45,516,349 | 113 ms | 17.5 ms | 18.1 ms | 17.62 ms | 2.1 ms | 120 |
| `city-100000-webgl2-batched` | 100,000 | webgl2 | batched | aerial | 3600×2086 @2 | 100,228 | 81 | 552,956 | 45,516,348 | 13 | 42,917,725 | 90 ms | 117.6 ms | 126.0 ms | 119.09 ms | 8.6 ms | 120 |
| `street-20000-webgpu-instanced` | 20,000 | webgpu | instanced | street | 3600×2086 @2 | 20,090 | 25 | 120,037 | 9,616,736 | 4 | 19,157 | 94 ms | 1.2 ms | 4.1 ms | 1.73 ms | 0.2 ms | 120 |
| `street-20000-webgl2-instanced` | 20,000 | webgl2 | instanced | street | 3600×2086 @2 | 20,090 | 25 | 120,037 | 9,616,736 | 4 | 19,157 | 93 ms | 2.5 ms | 4.1 ms | 2.76 ms | 0.2 ms | 120 |

## Files

| File | What |
| --- | --- |
| `<run>.json` | Exact `document.querySelector('#result').textContent` (includes `drawingBuffer`) |
| `<run>.viewport.png` | Viewport screenshot via DevTools `Page.captureScreenshot` |
| `<run>.png` | Full Chrome window screenshot (macOS `screencapture`), an extra |
| `<run>.hud.txt` | HUD text at capture time |
| `chrome-gpu.txt` | chrome://gpu text |
| `chrome-systeminfo.json` | DevTools `SystemInfo.getInfo` |
| `browser-window.json` | Window bounds, viewport, screen size and devicePixelRatio for each run |
| `macbook-info.txt` | `sw_vers`, hardware overview (serial and UUIDs removed), displays, power |
