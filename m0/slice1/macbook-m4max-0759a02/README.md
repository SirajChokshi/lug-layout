# M0 slice 1 render benchmark at PR #10 head 0759a02: MacBook Pro (M4 Max)

- Repo: https://github.com/SirajChokshi/lug-layout. Tested commit `0759a025690510e816a867152cb1c57e8cedc0ba` ("Report render failures honestly, render at devicePixelRatio, drop unread fields"), detached checkout in `~/tmp/lug-layout-bench`. Nothing was pushed.
- Build: `CI=true pnpm install --frozen-lockfile`, `pnpm --filter @brr/asset-pipeline build` ("LDraw inputs match ldraw.lock.json"), and `pnpm --filter @brr/web build`. All exited 0. `pnpm --filter @brr/web preview --port 4173` was stopped after the run.
- Run: 2026-11-16 04:14 UTC. Same procedure as `../slice1-d22c3b3/`: visible Chrome 157.0.8103.52, a fresh profile driven over the DevTools protocol, no GPU flags, window maximized at 1800x1130 CSS px (viewport 1800x1043), on AC power. chrome://gpu reports WebGPU and WebGL as hardware accelerated.
- Machine: MacBook Pro Mac16,6, Apple M4 Max (40-core GPU), 64 GB, macOS 26.6.2 (25G83). See `macbook-info.txt`.
- HUD check: none of the five HUDs shows "Rendering failed" (no `.hud .error` element, and no "fail" text in any `<run>.hud.txt`).

| Run | URL params | Active API | drawingBuffer | Parts | Scene tris | Draw calls | Load | Median frame | p95 | Mean | Median CPU submit | Frames |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `webgpu-default` | `api=webgpu` (lod standard) | webgpu, apple / metal-3 | 3600×2086, devicePixelRatio 2 | 35 | 110,174 | 31 | 79 ms | 1.1 ms | 2.2 ms | 1.24 ms | 0.1 ms | 120 |
| `webgl2-default` | `api=webgl2` (lod standard) | webgl2, ANGLE Metal, M4 Max | 3600×2086, devicePixelRatio 2 | 35 | 110,174 | 31 | 77 ms | 2.2 ms | 3.7 ms | 2.40 ms | 0.2 ms | 120 |
| `webgpu-low` | `api=webgpu&lod=low` | webgpu, apple / metal-3 | 3600×2086, devicePixelRatio 2 | 35 | 58,446 | 31 | 65 ms | 0.9 ms | 1.4 ms | 0.97 ms | 0.1 ms | 120 |
| `webgpu-7936-1` | `api=webgpu&model=7936-1` | webgpu, apple / metal-3 | 3600×2086, devicePixelRatio 2 | 147 | 140,603 | 105 | 77 ms | 1.2 ms | 2.3 ms | 1.39 ms | 0.2 ms | 120 |
| `webgl2-7936-1` | `api=webgl2&model=7936-1` | webgl2, ANGLE Metal, M4 Max | 3600×2086, devicePixelRatio 2 | 147 | 140,603 | 105 | 53 ms | 2.1 ms | 2.3 ms | 2.15 ms | 0.2 ms | 120 |

**Not directly comparable with `../slice1-d22c3b3/` or `../slice1/`.** This commit renders at native devicePixelRatio, so the drawing buffer is 3600×2086 (about 7.5 million pixels). According to the change description, earlier commits rendered the same 1800×1043 viewport at devicePixelRatio 1, about 1.9 million pixels, roughly 4× fewer. Their result JSONs have no `drawingBuffer` field, so the earlier size isn't recorded there. Frame times are also quantized to about 0.1 ms (browser timer resolution).

## Files

| File | What |
| --- | --- |
| `<run>.json` | Exact `document.querySelector('#result').textContent` |
| `<run>.png` | Full Chrome window screenshot (macOS `screencapture` of the window bounds) |
| `<run>.viewport.png` | Viewport screenshot via DevTools `Page.captureScreenshot` |
| `<run>.hud.txt` | HUD text at capture time |
| `chrome-gpu.txt` | chrome://gpu text |
| `chrome-systeminfo.json` | DevTools `SystemInfo.getInfo` |
| `browser-window.json` | Window bounds, viewport, screen size and devicePixelRatio for each run |
| `macbook-info.txt` | `sw_vers`, hardware overview (serial and UUIDs removed), displays, power |
