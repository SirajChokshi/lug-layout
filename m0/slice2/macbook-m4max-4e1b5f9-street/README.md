# M0 slice 2 street-camera check at 4e1b5f9: MacBook Pro (M4 Max)

- Repo: https://github.com/SirajChokshi/lug-layout. Tested commit `4e1b5f9143728699546812533b7229ec4f8235ab` ("Keep the street camera inside the city, reject essentially empty frames, settle on instancing"), which is on `origin/siraj/m0-city-b86f`. The branch head at fetch time was `ed6ddcd603855a5f50fd527c1515a84ea5d7a309`, which was not tested. Detached checkout in `~/tmp/lug-layout-bench`; nothing was pushed.
- Build: `CI=true pnpm install --frozen-lockfile`, `pnpm --filter @brr/asset-pipeline build`, and `pnpm --filter @brr/web build`. All exited 0. `pnpm --filter @brr/web preview --port 4173` was stopped after the run.
- Run: 2026-11-16 05:35 UTC, WebGPU first. Same setup as before: visible Chrome 157.0.8103.52, a fresh profile, no GPU flags, window maximized at 1800x1130 CSS px, on AC power. MacBook Pro Mac16,6, M4 Max, macOS 26.6.2.
- URL: `http://localhost:4173/?scene=city&parts=20000&api=<A>&camera=street&measure=1&warmup=10&frames=120`.
- Both runs produced a `#result`; there is no error element and no "fail" text in either HUD. Both screenshots show the street view: road with lane markings, sidewalks and buildings on the left. This fixes the empty street frame seen at `76f3d1f` (`../slice2-76f3d1f/`).

| Run | Active API | drawingBuffer | Median draw calls | Median drawn tris | Load | Median frame | p95 | Mean | CPU submit | Frames | sceneCoverage (sampled frames) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `street-20000-webgpu` | webgpu, apple / metal-3 | 3600×2086 @2 | 99 | 2,890,449 | 168 ms | 5.4 ms | 9.5 ms | 5.95 ms | 1.7 ms | 120 | 0.6502, 0.6480, 0.6458, 0.6406, 0.6285, 0.6185, 0.5959, 0.5629, 0.5009 |
| `street-20000-webgl2` | webgl2, ANGLE Metal, M4 Max | 3600×2086 @2 | 99 | 2,890,449 | 88 ms | 3.3 ms | 4.4 ms | 3.39 ms | 0.4 ms | 120 | same 9 values as WebGPU |

Exact sceneCoverage values are in the JSON. Scene: 20,090 parts, 25 modules, 9,616,736 triangles, 120,037 stud instances.

## Files

| File | What |
| --- | --- |
| `street-20000-webgpu.json`, `street-20000-webgl2.json` | Exact `#result` text, including `timings.sceneCoverage` |
| `street-20000-<api>.png` | Full Chrome window screenshot |
| `street-20000-<api>.viewport.png` | Viewport screenshot via DevTools |
| `street-20000-<api>.hud.txt` | HUD text |
| `chrome-gpu.txt`, `chrome-systeminfo.json`, `browser-window.json`, `macbook-info.txt` | Environment |

No `*.error.txt` files were written, because neither run failed.
