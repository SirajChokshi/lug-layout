# M1 S3 "unchanged" check: main eda49e7 vs slice 1a53a93 on the MacBook Pro (M4 Max)

- **Main:** `eda49e75dbabe51d1abcc9249dea6a413c75174c` (`origin/main` after fetch). **Slice:** `1a53a93d0dafe21426bcab3203cff2da9ac6eb59` on `siraj/m1-world-core-b86f` ("M1 S3: world core packages (math, domain) and dependency-cruiser boundaries"; the branch head at fetch). Detached checkouts in `~/tmp/lug-layout-bench`; nothing was pushed.
- **Build (each commit):** `CI=true pnpm install --frozen-lockfile`, `pnpm --filter @brr/asset-pipeline restore-ldraw`, `pnpm --filter @brr/asset-pipeline build`, `pnpm --filter @brr/web build`. All exited 0. Each commit was served with `pnpm --filter @brr/web preview --port 4173`, and the server was stopped afterwards.
- **Run:** main 2026-11-16 17:10:35–17:11:25 UTC, then the slice 17:11:56–17:12:47 UTC, with the same 12 URLs in the same order (parts, then API, then camera). Same setup as slice 3: one visible Chrome 157.0.8103.52 per commit with a fresh profile, **a fresh tab per run**, no GPU flags, window maximized at 1800x1130 CSS px (drawing buffer 3600x2086 at devicePixelRatio 2), on AC power. chrome://gpu reports WebGPU and WebGL as hardware accelerated.
- **Machine:** MacBook Pro Mac16,6, Apple M4 Max (40-core GPU), 64 GB, macOS 26.6.2 (25G83). See `macbook-info.txt`.
- **URL:** `http://localhost:4173/?scene=city&parts=P&api=A&camera=C&measure=1&warmup=10&frames=120`.

## Verdict

**Unchanged.** On all 12 URLs, every deterministic field is identical between main and the slice: parts, modules, stud instances, studs drawn, scene triangles, median drawn triangles, median draw calls, chunk tiers and GPU buffer bytes. Median frame times differ by −0.6 to +0.5 ms, the same as run-to-run noise in earlier repeats (up to about 1 ms). JS heap varies with garbage-collection timing; at 1M parts on WebGL2, aerial and street swap between about 249 and 393 MiB across the two builds. All 24 runs reached 120 measured frames on the requested API. There were no failures: no crash, no `.hud .error`, no "fail" in any HUD, and every console log is empty.

## Main vs slice

"GPU buffers" is `memory.vertexIndexBytes + memory.otherBytes`; both builds report the same two fields. Values show once when equal and as `main → slice` when they differ (none do). Frame times are quantized to about 0.1 ms.

| Run | Active API | Parts | Modules | Stud instances | Studs drawn | Scene tris | Drawn tris (median) | Draw calls (median) | Tiers n/m/f | GPU buffers | Median ms main / slice (Δ) | p95 ms main / slice | JS heap MiB main / slice | Deterministic fields |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `city-20000-webgpu-aerial` | webgpu | 20,090 | 25 | 120,037 | 34,145 | 5,493,920 | 5,493,921 | 196 | 25/0/0 | 4.2 MiB | 2.7 / 2.9 (+0.2) | 3.3 / 3.3 | 25.2 / 22.8 | identical |
| `city-20000-webgpu-street` | webgpu | 20,090 | 25 | 120,037 | 34,145 | 5,493,920 | 1,858,353 | 65 | 25/0/0 | 2.6 MiB | 1.2 / 1.4 (+0.2) | 2.1 / 2.4 | 19.5 / 20.8 | identical |
| `city-20000-webgl2-aerial` | webgl2 | 20,090 | 25 | 120,037 | 34,145 | 5,493,920 | 5,493,921 | 196 | 25/0/0 | 4.2 MiB | 4.4 / 4.3 (-0.1) | 5.1 / 4.9 | 19.6 / 19.5 | identical |
| `city-20000-webgl2-street` | webgl2 | 20,090 | 25 | 120,037 | 34,145 | 5,493,920 | 1,858,353 | 65 | 25/0/0 | 2.6 MiB | 2.5 / 2.6 (+0.1) | 3.2 / 3.4 | 29.7 / 32.4 | identical |
| `city-250000-webgpu-aerial` | webgpu | 250,665 | 196 | 1,391,563 | 325,871 | 63,398,368 | 10,713,895 | 1,557 | 0/196/0 | 42.2 MiB | 11.7 / 11.7 (+0.0) | 12.6 / 12.4 | 75.6 / 75.6 | identical |
| `city-250000-webgpu-street` | webgpu | 250,665 | 196 | 1,391,563 | 325,871 | 63,398,368 | 17,207,947 | 442 | 147/49/0 | 31.8 MiB | 6.7 / 6.6 (-0.1) | 10.8 / 10.9 | 80.9 / 80.9 | identical |
| `city-250000-webgl2-aerial` | webgl2 | 250,665 | 196 | 1,391,563 | 325,871 | 63,398,368 | 10,713,895 | 1,557 | 0/196/0 | 42.2 MiB | 13.0 / 13.3 (+0.3) | 13.7 / 14.3 | 72.0 / 72.0 | identical |
| `city-250000-webgl2-street` | webgl2 | 250,665 | 196 | 1,391,563 | 325,871 | 63,398,368 | 17,207,947 | 442 | 147/49/0 | 31.8 MiB | 8.2 / 8.3 (+0.1) | 12.1 / 12.5 | 69.8 / 69.9 | identical |
| `city-1000000-webgpu-aerial` | webgpu | 1,002,729 | 784 | 5,580,666 | 1,330,062 | 255,056,164 | 26,079,987 | 5,670 | 0/376/405 | 169.8 MiB | 39.5 / 38.9 (-0.6) | 42.4 / 41.1 | 249.9 / 248.5 | identical |
| `city-1000000-webgpu-street` | webgpu | 1,002,729 | 784 | 5,580,666 | 1,330,062 | 255,056,164 | 23,960,837 | 1,373 | 189/595/0 | 115.1 MiB | 15.3 / 15.4 (+0.1) | 33.3 / 33.2 | 256.9 / 243.0 | identical |
| `city-1000000-webgl2-aerial` | webgl2 | 1,002,729 | 784 | 5,580,666 | 1,330,062 | 255,056,164 | 26,079,987 | 5,670 | 0/376/405 | 169.9 MiB | 37.7 / 38.2 (+0.5) | 40.2 / 40.1 | 389.9 / 249.1 | identical |
| `city-1000000-webgl2-street` | webgl2 | 1,002,729 | 784 | 5,580,666 | 1,330,062 | 255,056,164 | 23,960,837 | 1,373 | 189/595/0 | 115.2 MiB | 15.8 / 15.5 (-0.3) | 32.3 / 32.2 | 236.0 / 393.4 | identical |

## Files

`main/` and `slice/` hold the same files for each run `<run>` = `city-<parts>-<api>-<camera>`:

| File | What |
| --- | --- |
| `<run>.json` | Exact `#result` text (`summary`, `memory`, `timings` including `medianChunkTiers`, `drawingBuffer`) |
| `<run>.hud.txt` | HUD text |
| `<run>.viewport.png` | Viewport screenshot via DevTools `Page.captureScreenshot` |
| `<run>.console.txt` | Console, exception and log entries for the tab (all empty) |
| `chrome-gpu.txt`, `chrome-systeminfo.json`, `browser-window.json`, `run.log` | chrome://gpu text, DevTools `SystemInfo.getInfo`, window and run metadata, driver log |

`macbook-info.txt` (top level) holds `sw_vers`, the hardware overview (serial and UUIDs removed), displays and power.
