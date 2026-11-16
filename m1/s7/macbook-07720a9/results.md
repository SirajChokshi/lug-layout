---
cursor:
  subagentId: "bc-cae21e54-93ff-5ae4-b1ab-0ddc2ef76fc9"
---

# S7 voxel far LODs for #52 at 07720a9, MacBook M4 Max

The run used `s7-macbook.sh 07720a9a1c0c213461b4fd79ca7b1505a46d7c61` from `siraj/m1-s7-evidence-134d` (bundle standard `c040b2122ae7cf55`) in background-window mode. `machine.txt` records macOS 26.6.2, Chrome 157 and AC power. Resolution: 1800×1000 at DPR 2 for the scenes; the model runs used the script's default viewport, which gives a 2560×1600 drawing buffer.

## How it was run, and focus

- **Launch:** the S7 scripts launch Chrome themselves, so a preloaded shim (`run-notes/bg-window-shim.cjs`) redirects `chromium.launch` to a Chrome started with `open -g` and driven over CDP.
- **First pass:** everything except WebGL2 scene 10 and scene 50 ran with the first version of the shim. That version opened a new Chrome window per context and used Playwright's screenshot, both of which activate Chrome. There were 75 activations, each re-activated within about 1 s (`run-notes/focus.log`). Activations happened around tab creation and screenshots, outside the measured frames.
- **Paused and resumed:** I stopped the run during WebGL2 scene 10 (partial output kept as `scene10-webgl2.interrupted/`) and resumed with the final shim. It uses one shared background Chrome (`run-notes/shared-chrome.sh`) and creates tabs with `Target.createTarget({ background: true })`. Viewport and DPR use `Emulation.setDeviceMetricsOverride`, screenshots use `Page.captureScreenshot`, and video comes from the CDP screencast encoded to WebM. A watcher polls the frontmost app every 250 ms.
- **Residual activations:** probes of every Playwright action these scripts use, with the final shim, produced 0 activations. The resumed runs still logged a few: 7 in scene 50 and 14 in the final scene 10. Each was reverted within 250 to 500 ms; the cause isn't identified.
- **WebGL2 scene 10:** the resumed run's video failed to encode because Playwright's bundled ffmpeg lacks the concat options. That output is kept as `scene10-webgl2.novideo/`. `scene10-webgl2/` is a complete re-run with video, encoded with Homebrew's ffmpeg.

## Models (`?model=<set>&tier=…`), median / p95 frame ms

| Set | Voxels | Far tris | WebGPU near | mid | far | WebGL2 near | mid | far |
|---|---:|---:|---|---|---|---|---|---|
| 7936-1 | 3,012 | 1,958 | 1.3 / 1.8 | 1.2 / 1.7 | 1.0 / 1.4 | 1.6 / 2.3 | 1.6 / 2.9 | 2.3 / 2.6 |
| 10264-1 | 23,239 | 13,964 | 2.4 / 4.5 | 2.2 / 2.7 | 0.5 / 1.3 | 3.8 / 6.3 | 3.5 / 5.2 | 1.2 / 2.6 |
| 10185-1 | 20,753 | 9,590 | 2.5 / 2.9 | 2.0 / 2.6 | 0.6 / 1.3 | 2.5 / 3.4 | 2.3 / 4.4 | 1.2 / 2.3 |
| 10190-1 | 13,272 | 6,636 | 2.1 / 2.6 | 1.8 / 2.3 | 1.0 / 1.5 | 4.0 / 4.4 | 2.3 / 3.7 | 1.2 / 2.2 |
| 10218-1 | 18,940 | 9,770 | 3.0 / 3.3 | 2.5 / 3.1 | 0.5 / 1.3 | 5.4 / 5.7 | 4.3 / 5.0 | 1.3 / 1.7 |
| 2150-1 | 11,464 | 5,088 | 1.8 / 2.2 | 1.7 / 2.2 | 0.9 / 1.3 | 3.3 / 3.8 | 1.8 / 2.3 | 1.3 / 1.8 |
| 4554-1 | 11,494 | 5,012 | 1.3 / 2.4 | 1.6 / 2.2 | 0.8 / 1.5 | 2.1 / 3.6 | 1.8 / 3.4 | 1.3 / 2.6 |
| 4555-1 | 8,820 | 4,826 | 1.9 / 2.4 | 1.5 / 2.1 | 0.5 / 1.4 | 3.2 / 3.8 | 1.7 / 3.2 | 1.2 / 2.7 |
| 10128-1 | 7,715 | 5,918 | 1.6 / 2.2 | 1.4 / 2.0 | 0.8 / 1.3 | 3.3 / 3.8 | 1.7 / 2.9 | 1.2 / 2.3 |
| 10133-1 | 4,422 | 2,696 | 1.4 / 2.1 | 0.9 / 1.9 | 1.0 / 1.5 | 3.1 / 3.5 | 1.5 / 2.9 | 1.1 / 2.1 |

## Scenes (median / p95 frame ms; draws, triangles)

| Scene | View, tier | WebGPU | WebGL2 | Draws | Triangles |
|---|---|---|---|---:|---:|
| 10 sets | street auto | 12.0 / 13.3 | 11.1 / 17.5 | 1,136 | 3,729,007 |
| 10 sets | street near | 12.0 / 16.0 | 13.8 / 14.8 | 1,136 | 3,729,007 |
| 10 sets | street mid | 10.7 / 13.7 | 11.8 / 12.8 | 1,228 | 1,755,467 |
| 10 sets | street far | 2.8 / 4.1 | 3.4 / 5.2 | 13 | 48,357 |
| 10 sets | aerial auto | 2.6 / 3.1 | 3.5 / 5.1 | 21 | 65,839 |
| 10 sets | aerial near | 18.9 / 20.1 | 15.9 / 19.3 | 2,399 | 6,303,296 |
| 10 sets | aerial mid | 16.8 / 17.3 | 16.8 / 18.9 | 2,548 | 2,840,550 |
| 10 sets | aerial far | 2.6 / 2.8 | 3.5 / 8.0 | 21 | 65,839 |
| 50 sets | street auto | 37.9 / 39.6 | 33.2 / 41.1 | 4,909 | 8,048,936 |
| 50 sets | street near | 41.3 / 46.6 | 35.9 / 44.7 | 4,663 | 12,542,939 |
| 50 sets | street mid | 36.3 / 38.5 | 33.0 / 40.0 | 4,977 | 5,490,063 |
| 50 sets | street far | 5.4 / 7.5 | 7.9 / 9.7 | 34 | 136,267 |
| 50 sets | aerial auto | 6.7 / 8.8 | 8.4 / 10.7 | 101 | 329,191 |
| 50 sets | aerial near | 93.3 / 105.1 | 89.4 / 96.8 | 13,093 | 31,516,476 |
| 50 sets | aerial mid | 94.9 / 98.7 | 86.4 / 93.1 | 13,929 | 14,202,746 |
| 50 sets | aerial far | 6.9 / 8.6 | 7.5 / 10.8 | 101 | 329,191 |

Per-run screenshots, JSON, HUD text and videos are in the `models-*`, `scene10-*` and `scene50-*` folders.
