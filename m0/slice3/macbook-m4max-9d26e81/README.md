# M0 slice 3 (scale) render benchmark at 9d26e81: MacBook Pro (M4 Max)

- Repo: https://github.com/SirajChokshi/lug-layout. Tested `origin/siraj/m0-scale-b86f` at `9d26e81c1dc8a956ef1e3776ab4f4e4dbe21be6d` ("Scale the city to 1M parts: covered-stud culling, screen-size tiers, a far LOD, buffer accounting"), checked out right after `git fetch` at 2026-11-16 05:59 UTC. Nothing was run on the earlier head 6431085. Detached checkout in `~/tmp/lug-layout-bench`; nothing was pushed.
- Build: `CI=true pnpm install --frozen-lockfile`, `pnpm --filter @brr/asset-pipeline restore-ldraw`, `pnpm --filter @brr/asset-pipeline build` ("LDraw inputs match ldraw.lock.json"), and `pnpm --filter @brr/web build`. All exited 0. `pnpm --filter @brr/web preview --port 4173` was stopped after the run.
- Run: 2026-11-16 06:01:39–06:02:52 UTC, in the listed order (parts outer, camera, API inner). One visible Chrome 157.0.8103.52 with a fresh profile, driven over the DevTools protocol, no GPU flags, window maximized at 1800x1130 CSS px (drawing buffer 3600x2086 at devicePixelRatio 2), on AC power. **Each run opened a fresh tab** and the previous tab was closed. chrome://gpu reports WebGPU and WebGL as hardware accelerated.
- Machine: MacBook Pro Mac16,6, Apple M4 Max (40-core GPU), 64 GB, macOS 26.6.2 (25G83). See `macbook-info.txt`.
- URL: `http://localhost:4173/?scene=city&parts=P&api=A&camera=C&measure=1&warmup=10&frames=120`.

## Failures

None. All 16 runs reached 120 measured frames on the requested API. There was no tab crash (no `Target.targetCrashed` or `Inspector.targetCrashed` event), no `.hud .error` element, no "fail" text in any HUD, and no console errors, exceptions or log entries: every `<run>.console.txt` is empty. No `*.error.txt` files were written.

## GPU process memory

`ps -axo pid,rss,command | grep "Helper (GPU)"` matches nothing on Chrome 157, because every helper is named "Google Chrome Helper (Aperitif…)". The literal output (empty) is still recorded at the top of each `<run>.gpu-ps.txt`. Instead, I used the bench Chrome's child process with `--type=gpu-process` (pid 73480, the same process for all 16 runs). For it, each run records RSS from `ps -axww -o pid,ppid,rss,args` and the full `footprint 73480` output, taken right after the run's screenshot. Because one long-lived GPU process served every tab, its footprint is not isolated per run and may include memory left over from earlier runs. In practice it rises after each WebGPU run and falls back after the following WebGL2 run.

## Results

"Accounted buffers" is `memory.geometryBytes + memory.instanceBytes` from the result JSON (the HUD's "Buffers (accounted)"). The JS heap is `memory.jsHeapBytes`. MiB = 1,048,576 bytes; footprint values are as printed by `footprint`. Draw calls and drawn triangles are `timings.medianDrawCalls` / `timings.medianDrawnTriangles`. Chunk tiers are `timings.medianChunkTiers`. Frame times are quantized to about 0.1 ms.

| Run | Active API | Parts | Median frame | p95 | CPU submit | Draw calls (median) | Drawn tris (median) | Scene tris | Studs drawn / total | Chunk tiers near/mid/far | Accounted buffers (geometry + instances) | JS heap | GPU process RSS | GPU process footprint | Load | Files |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `city-100000-aerial-webgpu` | webgpu | 100,228 | 6.2 ms | 6.8 ms | 1.5 ms | 671 | 8,242,675 | 25,317,372 | 132,144 / 552,956 | 15 / 66 / 0 | 22.9 MiB (6.1 + 16.8) | 42.9 MiB | 166 MiB | 1968 MB | 196 ms | `city-100000-aerial-webgpu.json`, `.hud.txt`, `.viewport.png`, `.gpu-ps.txt`, `.gpu-footprint-73480.txt`, `.console.txt` |
| `city-100000-aerial-webgl2` | webgl2 | 100,228 | 8.0 ms | 8.7 ms | 1.4 ms | 671 | 8,242,675 | 25,317,372 | 132,144 / 552,956 | 15 / 66 / 0 | 22.9 MiB (6.1 + 16.8) | 39.6 MiB | 190 MiB | 1914 MB | 149 ms | `city-100000-aerial-webgl2.json`, `.hud.txt`, `.viewport.png`, `.gpu-ps.txt`, `.gpu-footprint-73480.txt`, `.console.txt` |
| `city-100000-street-webgpu` | webgpu | 100,228 | 3.5 ms | 6.4 ms | 0.6 ms | 218 | 8,627,341 | 25,317,372 | 132,144 / 552,956 | 79 / 2 / 0 | 22.9 MiB (6.1 + 16.8) | 38.4 MiB | 179 MiB | 2766 MB | 244 ms | `city-100000-street-webgpu.json`, `.hud.txt`, `.viewport.png`, `.gpu-ps.txt`, `.gpu-footprint-73480.txt`, `.console.txt` |
| `city-100000-street-webgl2` | webgl2 | 100,228 | 5.6 ms | 7.9 ms | 0.7 ms | 218 | 8,627,341 | 25,317,372 | 132,144 / 552,956 | 79 / 2 / 0 | 22.9 MiB (6.1 + 16.8) | 35.8 MiB | 186 MiB | 2016 MB | 145 ms | `city-100000-street-webgl2.json`, `.hud.txt`, `.viewport.png`, `.gpu-ps.txt`, `.gpu-footprint-73480.txt`, `.console.txt` |
| `city-250000-aerial-webgpu` | webgpu | 250,665 | 11.5 ms | 12.3 ms | 3.0 ms | 1,557 | 10,573,003 | 63,398,368 | 325,871 / 1,391,563 | 0 / 196 / 0 | 47.9 MiB (6.1 + 41.8) | 74.8 MiB | 218 MiB | 3112 MB | 265 ms | `city-250000-aerial-webgpu.json`, `.hud.txt`, `.viewport.png`, `.gpu-ps.txt`, `.gpu-footprint-73480.txt`, `.console.txt` |
| `city-250000-aerial-webgl2` | webgl2 | 250,665 | 13.2 ms | 13.9 ms | 3.2 ms | 1,557 | 10,573,003 | 63,398,368 | 325,871 / 1,391,563 | 0 / 196 / 0 | 47.9 MiB (6.1 + 41.8) | 71.6 MiB | 233 MiB | 2262 MB | 262 ms | `city-250000-aerial-webgl2.json`, `.hud.txt`, `.viewport.png`, `.gpu-ps.txt`, `.gpu-footprint-73480.txt`, `.console.txt` |
| `city-250000-street-webgpu` | webgpu | 250,665 | 7.6 ms | 11.0 ms | 1.7 ms | 442 | 17,206,927 | 63,398,368 | 325,871 / 1,391,563 | 147 / 49 / 0 | 47.9 MiB (6.1 + 41.8) | 80.2 MiB | 214 MiB | 3358 MB | 253 ms | `city-250000-street-webgpu.json`, `.hud.txt`, `.viewport.png`, `.gpu-ps.txt`, `.gpu-footprint-73480.txt`, `.console.txt` |
| `city-250000-street-webgl2` | webgl2 | 250,665 | 8.4 ms | 12.1 ms | 1.0 ms | 442 | 17,206,927 | 63,398,368 | 325,871 / 1,391,563 | 147 / 49 / 0 | 47.9 MiB (6.1 + 41.8) | 69.5 MiB | 220 MiB | 2366 MB | 285 ms | `city-250000-street-webgl2.json`, `.hud.txt`, `.viewport.png`, `.gpu-ps.txt`, `.gpu-footprint-73480.txt`, `.console.txt` |
| `city-500000-aerial-webgpu` | webgpu | 501,462 | 24.2 ms | 25.5 ms | 6.8 ms | 3,144 | 20,754,649 | 127,389,256 | 659,856 / 2,797,132 | 0 / 390 / 10 | 90.3 MiB (6.1 + 84.2) | 134.3 MiB | 220 MiB | 3478 MB | 453 ms | `city-500000-aerial-webgpu.json`, `.hud.txt`, `.viewport.png`, `.gpu-ps.txt`, `.gpu-footprint-73480.txt`, `.console.txt` |
| `city-500000-aerial-webgl2` | webgl2 | 501,462 | 23.9 ms | 25.2 ms | 6.7 ms | 3,144 | 20,754,649 | 127,389,256 | 659,856 / 2,797,132 | 0 / 390 / 10 | 90.3 MiB (6.1 + 84.2) | 197.6 MiB | 316 MiB | 2491 MB | 467 ms | `city-500000-aerial-webgl2.json`, `.hud.txt`, `.viewport.png`, `.gpu-ps.txt`, `.gpu-footprint-73480.txt`, `.console.txt` |
| `city-500000-street-webgpu` | webgpu | 501,462 | 9.3 ms | 17.6 ms | 2.7 ms | 771 | 19,026,807 | 127,389,256 | 659,856 / 2,797,132 | 171 / 227 / 0 | 90.3 MiB (6.1 + 84.2) | 134.3 MiB | 214 MiB | 3542 MB | 464 ms | `city-500000-street-webgpu.json`, `.hud.txt`, `.viewport.png`, `.gpu-ps.txt`, `.gpu-footprint-73480.txt`, `.console.txt` |
| `city-500000-street-webgl2` | webgl2 | 501,462 | 11.1 ms | 18.5 ms | 2.6 ms | 771 | 19,026,807 | 127,389,256 | 659,856 / 2,797,132 | 171 / 227 / 0 | 90.3 MiB (6.1 + 84.2) | 200.2 MiB | 271 MiB | 2454 MB | 453 ms | `city-500000-street-webgl2.json`, `.hud.txt`, `.viewport.png`, `.gpu-ps.txt`, `.gpu-footprint-73480.txt`, `.console.txt` |
| `city-1000000-aerial-webgpu` | webgpu | 1,002,729 | 39.7 ms | 44.0 ms | 13.5 ms | 5,670 | 25,522,497 | 255,056,164 | 1,330,062 / 5,580,666 | 0 / 376 / 405 | 175.2 MiB (6.1 + 169.1) | 385.4 MiB | 281 MiB | 3677 MB | 847 ms | `city-1000000-aerial-webgpu.json`, `.hud.txt`, `.viewport.png`, `.gpu-ps.txt`, `.gpu-footprint-73480.txt`, `.console.txt` |
| `city-1000000-aerial-webgl2` | webgl2 | 1,002,729 | 38.0 ms | 40.1 ms | 13.6 ms | 5,670 | 25,522,497 | 255,056,164 | 1,330,062 / 5,580,666 | 0 / 376 / 405 | 175.2 MiB (6.1 + 169.1) | 261.5 MiB | 425 MiB | 2537 MB | 832 ms | `city-1000000-aerial-webgl2.json`, `.hud.txt`, `.viewport.png`, `.gpu-ps.txt`, `.gpu-footprint-73480.txt`, `.console.txt` |
| `city-1000000-street-webgpu` | webgpu | 1,002,729 | 15.7 ms | 33.4 ms | 5.5 ms | 1,373 | 23,875,577 | 255,056,164 | 1,330,062 / 5,580,666 | 189 / 595 / 0 | 175.2 MiB (6.1 + 169.1) | 238.2 MiB | 311 MiB | 3666 MB | 822 ms | `city-1000000-street-webgpu.json`, `.hud.txt`, `.viewport.png`, `.gpu-ps.txt`, `.gpu-footprint-73480.txt`, `.console.txt` |
| `city-1000000-street-webgl2` | webgl2 | 1,002,729 | 15.4 ms | 32.8 ms | 4.4 ms | 1,373 | 23,875,577 | 255,056,164 | 1,330,062 / 5,580,666 | 189 / 595 / 0 | 175.2 MiB (6.1 + 169.1) | 396.1 MiB | 395 MiB | 2503 MB | 828 ms | `city-1000000-street-webgl2.json`, `.hud.txt`, `.viewport.png`, `.gpu-ps.txt`, `.gpu-footprint-73480.txt`, `.console.txt` |

## Reproducibility

An earlier full pass (06:00:07–06:01:19 UTC), identical except that its GPU memory capture found no process, is kept in `pass1-no-gpu-memory/` (`#result` JSON, HUD and viewport screenshot per run, plus its log). Its median frame times are within 1 ms of this pass on every run; for example, 1M aerial webgpu was 40.1 ms in pass 1 and 39.7 ms here.

## Files (per run `<run>` = `city-<parts>-<camera>-<api>`)

| File | What |
| --- | --- |
| `<run>.json` | Exact `#result` text, including `memory`, `timings.medianChunkTiers` and `drawingBuffer` |
| `<run>.hud.txt` | HUD text |
| `<run>.viewport.png` | Viewport screenshot via DevTools `Page.captureScreenshot` |
| `<run>.gpu-ps.txt` | Literal `grep "Helper (GPU)"` output (empty), then the GPU process `ps` row (pid, ppid, RSS KiB, args) |
| `<run>.gpu-footprint-73480.txt` | Full `footprint` output for the GPU process after the run |
| `<run>.console.txt` | Console, exception and log entries for the tab (all empty) |
| `chrome-gpu.txt`, `chrome-systeminfo.json` | chrome://gpu text and DevTools `SystemInfo.getInfo` |
| `browser-window.json` | Window bounds and per-run completion, wait time and GPU memory summary |
| `macbook-info.txt` | `sw_vers`, hardware overview (serial and UUIDs removed), displays, power |
| `run.log` | Driver log |
