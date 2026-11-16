# M0 slice 1 render benchmark at PR #10 head d22c3b3: MacBook Pro (M4 Max)

- Repo: https://github.com/SirajChokshi/lug-layout. Tested commit `d22c3b311f430e21e039c21dde8e7d115cc588af` ("Colour road plates from Rebrickable's produced elements"), detached checkout in `~/tmp/lug-layout-bench`. Nothing was pushed.
- Build: `pnpm install --frozen-lockfile` (run with `CI=true` because pnpm refused to purge `node_modules` without a terminal), `pnpm --filter @brr/asset-pipeline build` ("LDraw inputs match ldraw.lock.json"), and `pnpm --filter @brr/web build`. All exited 0. `pnpm --filter @brr/web preview --port 4173` was stopped after the run.
- Run: 2026-11-16 03:54 UTC. Same setup as `../slice1/`: visible Chrome 157.0.8103.52, a fresh profile driven over the DevTools protocol, no GPU flags, window maximized at 1800x1130 CSS px (viewport 1800x1043, devicePixelRatio 2), on AC power. chrome://gpu reports WebGPU and WebGL as hardware accelerated.
- Machine: MacBook Pro Mac16,6, Apple M4 Max (16-core CPU, 40-core GPU), 64 GB, macOS 26.6.2 (25G83). See `macbook-info.txt`.

| Run | URL params | Active API | Parts | Scene tris | Studs | Draw calls | Load | Median frame | p95 | Mean | Median CPU submit | Frames |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `webgpu-default` | `api=webgpu` (lod standard) | webgpu, apple / metal-3 | 35 | 110,174 | 1,999 | 31 | 71 ms | 0.6 ms | 1.2 ms | 0.73 ms | 0.1 ms | 120 |
| `webgl2-default` | `api=webgl2` (lod standard) | webgl2, ANGLE Metal, M4 Max | 35 | 110,174 | 1,999 | 31 | 73 ms | 0.8 ms | 0.9 ms | 0.83 ms | 0.1 ms | 120 |
| `webgpu-low` | `api=webgpu&lod=low` | webgpu, apple / metal-3 | 35 | 58,446 | 1,999 | 31 | 67 ms | 0.7 ms | 1.4 ms | 0.76 ms | 0.1 ms | 120 |
| `webgpu-7936-1` | `api=webgpu&model=7936-1` | webgpu, apple / metal-3 | 147 | 140,603 | 622 | 105 | 100 ms | 0.9 ms | 1.5 ms | 0.88 ms | 0.2 ms | 120 |
| `webgl2-7936-1` | `api=webgl2&model=7936-1` | webgl2, ANGLE Metal, M4 Max | 147 | 140,603 | 622 | 105 | 78 ms | 1.1 ms | 1.3 ms | 1.12 ms | 0.2 ms | 120 |

Values are copied from each `#result` JSON. Frame times are quantized to about 0.1 ms (browser timer resolution), so differences under 1 ms are close to that resolution. Every run completed in about 1 s of wall time.

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
