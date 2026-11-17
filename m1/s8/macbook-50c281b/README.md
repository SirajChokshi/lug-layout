---
cursor:
  subagentId: "bc-cae21e54-93ff-5ae4-b1ab-0ddc2ef76fc9"
---

# S8 look pass re-run for #41 at 50c281b (MacBook, background window)

The branch is `siraj/m1-look-pass-996c` at `50c281b923cf8bdfbcd88fbf0e3acf8efee866a7`, served on :4174. Main is `95c2a5da5197e4d3191a124b2d86b8c122d43a75`, served on :4173. Each was served with `vite preview` of its own build, and each bundle was rebuilt from that commit's pinned inputs (`restore-ldraw`, then the asset-pipeline `build`). URL: `/?scene=city&parts=250000&api=A&measure=1&warmup=10&frames=120&look=L`.

There were 24 runs and 0 errors.

## Setup

- **Machine and browser:** M4 Max, macOS 26.6.2, Google Chrome 157.0.8103.52 . On AC, -InternalBattery-0 (id=22610019)	100%; charged; 0:00 remaining present: true, power mode 2 (High Power).
- **Background window:** Chrome was started with `open -g -n -a "Google Chrome" --args --remote-debugging-port=9334 --window-size=1800,1130` plus `--enable-unsafe-webgpu --ignore-gpu-blocklist --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`, and driven over CDP. Each run opened a fresh tab, closed afterwards.
- **Page:** 1800×1043 CSS px at DPR 2, `visibilityState` "visible", drawing buffer 3600×2086, adapter `apple / metal-3` (WebGPU) or ANGLE Metal Apple M4 Max (WebGL2).
- **Focus:** the frontmost app was Slack before the run and Google Chrome at the end. So the Chrome window was activated at some point during the run, or someone clicked it. In the earlier validation run it never took focus.
- **Background CPU:** the builds finished before the measurements. Before starting, the driver waited up to 10 minutes for `fseventsd` to drop under 30% and the 1-minute load under 6, sampling every 10 s (`s8-mac-look-50c281b/wait.log`). Neither happened: `fseventsd` stayed at about 100% from 14:51:50 to 15:01:48, even with no builds running, and is still at about 100% during the runs. It has been at that level for most of the afternoon, including before these worktree builds, so something other than the builds is driving it. Each row lists the processes using at least 20% CPU when that run started.
- **Load (1-minute average):** 8.36 at the first run and 4.56 at the last. At the end (Mon Nov 16 15:03:51 PST 2026): { 8.84 8.21 8.13 }.
- **Columns:** "Median" and "p95" are the GPU-synced frame times. "CPU submit" is the median CPU submit time. "Draws" and "Triangles" are the medians of draw calls and drawn triangles.

## WebGPU

| look | Median ms | p95 ms | CPU submit ms | Draws | Triangles | Load (1 min) | Background CPU ≥ 20% |
|---|---|---|---|---|---|---|---|
| `none&pace=tight` | 13.8 | 20.5 | 3.2 | 1,557 | 10,713,895 | 8.36 | fseventsd 101%, trustd 22% |
| `none` | 19.4 | 20.5 | 3.3 | 1,557 | 10,713,895 | 8.97 | fseventsd 101%, grok-workspaced 86% |
| `plastic&pace=tight` | 15.4 | 22.0 | 3.4 | 1,557 | 10,713,895 | 8.97 | fseventsd 100%, grok-workspaced 50% |
| `plastic` | 14.9 | 22.9 | 3.8 | 1,557 | 10,713,895 | 8.42 | fseventsd 100%, io.tailscale.ipn.macsys.network-extension 60% |
| `plastic,gtao` | 22.8 | 24.8 | 4.2 | 1,559 | 10,713,897 | 8.06 | fseventsd 103%, iconservicesagent 79% |
| `plastic,outlines` | 15.4 | 22.1 | 3.7 | 1,558 | 10,713,896 | 7.82 | fseventsd 99%, Cursor 77% |
| `plastic,bevel` | 15.0 | 22.7 | 3.7 | 1,558 | 10,713,896 | 7.35 | fseventsd 99% |
| `plastic,outlines,bevel` | 14.7 | 23.1 | 3.7 | 1,558 | 10,713,896 | 7.00 | fseventsd 100% |
| `plastic,shadows` | 22.5 | 31.1 | 5.5 | 1,939 | 16,480,909 | 6.60 | fseventsd 99% |
| `plastic,oit` | 17.5 | 22.7 | 4.8 | 1,558 | 10,713,896 | 6.39 | fseventsd 100% |
| `all` | 23.2 | 30.8 | 5.6 | 1,941 | 16,480,911 | 6.04 | fseventsd 100% |
| main 95c2a5d, no params | 15.4 | 21.2 | 3.3 | 1,557 | 10,713,895 | 5.65 | fseventsd 98%, Cursor 43% |

## WebGL2

| look | Median ms | p95 ms | CPU submit ms | Draws | Triangles | Load (1 min) | Background CPU ≥ 20% |
|---|---|---|---|---|---|---|---|
| `none&pace=tight` | 12.6 | 17.8 | 3.0 | 1,557 | 10,713,895 | 5.65 | fseventsd 139% |
| `none` | 14.9 | 19.3 | 3.4 | 1,557 | 10,713,895 | 5.51 | fseventsd 101%, grok-workspaced 74% |
| `plastic&pace=tight` | 13.8 | 16.7 | 3.4 | 1,557 | 10,713,895 | 5.63 | fseventsd 99%, grok-workspaced 90%, WindowServer 29% |
| `plastic` | 15.2 | 18.6 | 3.5 | 1,557 | 10,713,895 | 5.63 | fseventsd 99% |
| `plastic,gtao` | 15.3 | 20.6 | 3.7 | 1,559 | 10,713,897 | 5.26 | cursor-agent 187%, fseventsd 98% |
| `plastic,outlines` | 16.7 | 26.6 | 4.0 | 1,558 | 10,713,896 | 5.00 | fseventsd 96% |
| `plastic,bevel` | 15.4 | 21.4 | 3.9 | 1,558 | 10,713,896 | 4.84 | fseventsd 99% |
| `plastic,outlines,bevel` | 15.3 | 20.9 | 3.8 | 1,558 | 10,713,896 | 4.84 | fseventsd 99% |
| `plastic,shadows` | 18.1 | 23.8 | 4.6 | 1,939 | 16,480,909 | 4.85 | fseventsd 97%, Cursor 54%, WindowServer 29% |
| `plastic,oit` | 15.1 | 20.3 | 4.2 | 1,558 | 10,713,896 | 5.02 | fseventsd 99%, io.tailscale.ipn.macsys.network-extension 28% |
| `all` | 17.7 | 24.2 | 5.4 | 1,941 | 16,480,911 | 4.78 | fseventsd 99% |
| main 95c2a5d, no params | 13.4 | 15.6 | 3.4 | 1,557 | 10,713,895 | 4.56 | Slack 143%, fseventsd 100% |

Each run's `result.json`, `hud.txt`, `console.txt` and `viewport.png` are in `internal/s8-mac-look-50c281b/<run>/`. All rows, with the full background process lists, are in `summary.ndjson`.
