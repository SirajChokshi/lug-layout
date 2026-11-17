---
cursor:
  subagentId: "bc-cae21e54-93ff-5ae4-b1ab-0ddc2ef76fc9"
---

# S8 look pass on the MacBook (M4 Max)

The branch is `siraj/m1-look-pass-996c` at `2ac9f890cfcd41754dabcde449c651b47e1f55e7`, served on :4174. Main is `838d956a19461afba0a0bed1a589efeaa4a314ac`, served on :4173. Each was served with `vite preview` of its own build, and each bundle was built from that commit's pinned inputs: `restore-ldraw`, then the asset-pipeline `build`. Both produced bundle standard `aa83d3a97cb22130`.

There were 66 runs and 0 errors.

## Setup

- **Machine:** MacBook Pro, Apple M4 Max (16 CPU cores, 40 GPU cores, 64 GB), macOS 26.6.2.
- **Browser:** Google Chrome 157.0.8103.52, the installed Chrome on the real GPU, headed, driven by playwright-core 1.63.0.
- **Window and tab:** a 1800×1130 window (`--window-size=1800,1130`) with the page sized by the window. Each run got a fresh browser context and tab, closed afterwards. The drawing buffer is 3600×2086 at devicePixelRatio 2 (see each `result.json`).
- **Power at the start (Mon Nov 16 13:38:47 PST 2026):** Now drawing from 'AC Power', -InternalBattery-0 (id=22610019)	100%; charged; 0:00 remaining present: true, powermode 2 (2 is High Power). Load: { 5.14 9.22 9.01 }.
- **At the end (Mon Nov 16 13:41:12 PST 2026):** Now drawing from 'AC Power', load { 6.90 8.69 8.85 }. Each run's 1-minute load is in the tables below.
- **Background load:** the owner's apps were running throughout. A "Grok (Next) Lab" app was using about 150% CPU, and `fseventsd` was busy after the worktree builds.
- **Columns:** "Median" and "p95" are the GPU-synced frame times. "CPU submit" is the median CPU submit time. "Draws" and "Triangles" are the medians of draw calls and drawn triangles.
- **Raw data:** each run's `result.json`, `hud.txt` (the HUD text), `console.txt` and `viewport.png` are in `internal/s8-mac-look/<part>/<run>/`, and every row is in `internal/s8-mac-look/summary.ndjson`.

## 1. City, 250k parts (`warmup=10&frames=120`)

| API | look | Median ms | p95 ms | CPU submit ms | Draws | Triangles | Load (1 min) | Screenshot |
|---|---|---|---|---|---|---|---|---|
| webgpu | branch `all` | 36.4 | 47.7 | 12.5 | 4,182 | 16,566,900 | 4.97 | [png](s8-mac-look/city250k/branch-webgpu-look-all/viewport.png) |
| webgpu | branch `-gtao` | 28.9 | 42.4 | 12.3 | 4,181 | 16,566,899 | 5.49 | [png](s8-mac-look/city250k/branch-webgpu-look--gtao/viewport.png) |
| webgpu | branch `-outlines` | 28.6 | 43.2 | 11.9 | 4,182 | 16,566,900 | 9.20 | [png](s8-mac-look/city250k/branch-webgpu-look--outlines/viewport.png) |
| webgpu | branch `-bevel` | 36.1 | 48.4 | 12.8 | 4,182 | 16,566,900 | 8.63 | [png](s8-mac-look/city250k/branch-webgpu-look--bevel/viewport.png) |
| webgpu | branch `-shadows` | 23.4 | 28.2 | 5.1 | 1,558 | 10,713,896 | 8.16 | [png](s8-mac-look/city250k/branch-webgpu-look--shadows/viewport.png) |
| webgpu | branch `-oit` | 30.4 | 43.0 | 11.6 | 4,182 | 16,566,900 | 8.23 | [png](s8-mac-look/city250k/branch-webgpu-look--oit/viewport.png) |
| webgpu | branch `none` | 21.1 | 23.2 | 4.0 | 1,557 | 10,713,895 | 7.74 | [png](s8-mac-look/city250k/branch-webgpu-look-none/viewport.png) |
| webgpu | branch `plastic` | 14.6 | 21.2 | 3.6 | 1,557 | 10,713,895 | 7.44 | [png](s8-mac-look/city250k/branch-webgpu-look-plastic/viewport.png) |
| webgpu | main, no look param | 18.2 | 20.8 | 3.5 | 1,557 | 10,713,895 | 7.16 | [png](s8-mac-look/city250k/main-webgpu-nolook/viewport.png) |
| webgl2 | branch `all` | 23.1 | 31.3 | 10.3 | 4,183 | 16,566,901 | 7.16 | [png](s8-mac-look/city250k/branch-webgl2-look-all/viewport.png) |
| webgl2 | branch `-gtao` | 23.2 | 31.5 | 11.1 | 4,182 | 16,566,900 | 6.83 | [png](s8-mac-look/city250k/branch-webgl2-look--gtao/viewport.png) |
| webgl2 | branch `-outlines` | 23.4 | 31.6 | 10.5 | 4,183 | 16,566,901 | 7.24 | [png](s8-mac-look/city250k/branch-webgl2-look--outlines/viewport.png) |
| webgl2 | branch `-bevel` | 24.1 | 33.1 | 11.6 | 4,183 | 16,566,901 | 7.30 | [png](s8-mac-look/city250k/branch-webgl2-look--bevel/viewport.png) |
| webgl2 | branch `-shadows` | 15.1 | 19.0 | 4.4 | 1,559 | 10,713,897 | 7.20 | [png](s8-mac-look/city250k/branch-webgl2-look--shadows/viewport.png) |
| webgl2 | branch `-oit` | 28.9 | 35.6 | 9.8 | 4,182 | 16,566,900 | 6.94 | [png](s8-mac-look/city250k/branch-webgl2-look--oit/viewport.png) |
| webgl2 | branch `none` | 15.1 | 18.3 | 3.4 | 1,557 | 10,713,895 | 6.71 | [png](s8-mac-look/city250k/branch-webgl2-look-none/viewport.png) |
| webgl2 | branch `plastic` | 15.2 | 18.0 | 3.4 | 1,557 | 10,713,895 | 6.65 | [png](s8-mac-look/city250k/branch-webgl2-look-plastic/viewport.png) |
| webgl2 | main, no look param | 12.6 | 14.8 | 2.9 | 1,557 | 10,713,895 | 6.44 | [png](s8-mac-look/city250k/main-webgl2-nolook/viewport.png) |

## 2. Before and after: main vs branch (`warmup=2&frames=8`, branch at its default look)

With only 8 measured frames, these timings are noisy; the screenshots are the main deliverable here.

### webgpu

| Scene | Main median / p95 ms | Branch median / p95 ms | Main CPU submit | Branch CPU submit | Main draws / triangles | Branch draws / triangles | Screenshots (main, branch) |
|---|---|---|---|---|---|---|---|
| model 7936-1 | 2.4 / 2.7 | 8.5 / 9.0 | 0.5 | 1.3 | 72 / 140,604 | 207 / 368,847 | [png](s8-mac-look/before-after/main-webgpu-model-7936-1/viewport.png), [png](s8-mac-look/before-after/branch-webgpu-model-7936-1/viewport.png) |
| model 10264-1 | 3.9 / 5.6 | 7.0 / 14.1 | 1.2 | 3.3 | 334 / 1,222,337 | 946 / 2,806,297 | [png](s8-mac-look/before-after/main-webgpu-model-10264-1/viewport.png), [png](s8-mac-look/before-after/branch-webgpu-model-10264-1/viewport.png) |
| model 10185-1 | 3.5 / 4.4 | 8.1 / 16.5 | 0.6 | 2.5 | 195 / 1,036,407 | 555 / 2,323,980 | [png](s8-mac-look/before-after/main-webgpu-model-10185-1/viewport.png), [png](s8-mac-look/before-after/branch-webgpu-model-10185-1/viewport.png) |
| model 10190-1 | 2.9 / 6.5 | 4.8 / 8.1 | 0.4 | 1.8 | 146 / 747,071 | 420 / 1,730,500 | [png](s8-mac-look/before-after/main-webgpu-model-10190-1/viewport.png), [png](s8-mac-look/before-after/branch-webgpu-model-10190-1/viewport.png) |
| model 10218-1 | 3.4 / 4.3 | 5.5 / 8.2 | 0.6 | 2.9 | 222 / 936,913 | 645 / 2,077,930 | [png](s8-mac-look/before-after/main-webgpu-model-10218-1/viewport.png), [png](s8-mac-look/before-after/branch-webgpu-model-10218-1/viewport.png) |
| model 2150-1 | 3.2 / 16.9 | 5.1 / 6.0 | 0.8 | 1.8 | 157 / 410,478 | 445 / 972,704 | [png](s8-mac-look/before-after/main-webgpu-model-2150-1/viewport.png), [png](s8-mac-look/before-after/branch-webgpu-model-2150-1/viewport.png) |
| model 4554-1 | 3.4 / 3.9 | 4.3 / 10.6 | 0.7 | 1.6 | 150 / 404,254 | 425 / 953,474 | [png](s8-mac-look/before-after/main-webgpu-model-4554-1/viewport.png), [png](s8-mac-look/before-after/branch-webgpu-model-4554-1/viewport.png) |
| model 4555-1 | 2.9 / 4.0 | 5.3 / 9.2 | 0.4 | 1.8 | 141 / 382,201 | 413 / 839,042 | [png](s8-mac-look/before-after/main-webgpu-model-4555-1/viewport.png), [png](s8-mac-look/before-after/branch-webgpu-model-4555-1/viewport.png) |
| model 10128-1 | 2.0 / 2.7 | 5.5 / 8.7 | 0.7 | 1.7 | 124 / 322,239 | 354 / 740,032 | [png](s8-mac-look/before-after/main-webgpu-model-10128-1/viewport.png), [png](s8-mac-look/before-after/branch-webgpu-model-10128-1/viewport.png) |
| model 10133-1 | 2.5 / 2.7 | 5.1 / 6.0 | 0.6 | 1.5 | 87 / 208,441 | 273 / 545,224 | [png](s8-mac-look/before-after/main-webgpu-model-10133-1/viewport.png), [png](s8-mac-look/before-after/branch-webgpu-model-10133-1/viewport.png) |
| city 20k street | 2.2 / 3.1 | 6.4 / 11.9 | 0.4 | 1.7 | 65 / 1,858,353 | 319 / 2,264,798 | [png](s8-mac-look/before-after/main-webgpu-city20k-street/viewport.png), [png](s8-mac-look/before-after/branch-webgpu-city20k-street/viewport.png) |
| city 20k aerial | 4.2 / 102.6 | 8.5 / 174.6 | 0.9 | 2.4 | 196 / 5,493,921 | 558 / 6,072,854 | [png](s8-mac-look/before-after/main-webgpu-city20k-aerial/viewport.png), [png](s8-mac-look/before-after/branch-webgpu-city20k-aerial/viewport.png) |

### webgl2

| Scene | Main median / p95 ms | Branch median / p95 ms | Main CPU submit | Branch CPU submit | Main draws / triangles | Branch draws / triangles | Screenshots (main, branch) |
|---|---|---|---|---|---|---|---|
| model 7936-1 | 3.5 / 4.8 | 5.7 / 8.1 | 0.5 | 1.0 | 72 / 140,604 | 208 / 368,848 | [png](s8-mac-look/before-after/main-webgl2-model-7936-1/viewport.png), [png](s8-mac-look/before-after/branch-webgl2-model-7936-1/viewport.png) |
| model 10264-1 | 4.3 / 9.7 | 7.3 / 14.8 | 0.8 | 2.9 | 334 / 1,222,337 | 947 / 2,806,298 | [png](s8-mac-look/before-after/main-webgl2-model-10264-1/viewport.png), [png](s8-mac-look/before-after/branch-webgl2-model-10264-1/viewport.png) |
| model 10185-1 | 3.6 / 7.6 | 9.1 / 14.2 | 0.6 | 2.0 | 195 / 1,036,407 | 556 / 2,323,981 | [png](s8-mac-look/before-after/main-webgl2-model-10185-1/viewport.png), [png](s8-mac-look/before-after/branch-webgl2-model-10185-1/viewport.png) |
| model 10190-1 | 3.6 / 6.4 | 9.0 / 10.9 | 0.4 | 1.9 | 146 / 747,071 | 421 / 1,730,501 | [png](s8-mac-look/before-after/main-webgl2-model-10190-1/viewport.png), [png](s8-mac-look/before-after/branch-webgl2-model-10190-1/viewport.png) |
| model 10218-1 | 3.8 / 7.3 | 7.6 / 14.0 | 0.5 | 2.6 | 222 / 936,913 | 646 / 2,077,931 | [png](s8-mac-look/before-after/main-webgl2-model-10218-1/viewport.png), [png](s8-mac-look/before-after/branch-webgl2-model-10218-1/viewport.png) |
| model 2150-1 | 3.4 / 5.8 | 7.5 / 10.1 | 0.4 | 1.8 | 157 / 410,478 | 446 / 972,705 | [png](s8-mac-look/before-after/main-webgl2-model-2150-1/viewport.png), [png](s8-mac-look/before-after/branch-webgl2-model-2150-1/viewport.png) |
| model 4554-1 | 3.3 / 5.8 | 7.0 / 8.4 | 0.4 | 1.9 | 150 / 404,254 | 426 / 953,475 | [png](s8-mac-look/before-after/main-webgl2-model-4554-1/viewport.png), [png](s8-mac-look/before-after/branch-webgl2-model-4554-1/viewport.png) |
| model 4555-1 | 3.1 / 5.7 | 6.9 / 8.5 | 0.6 | 1.6 | 141 / 382,201 | 414 / 839,043 | [png](s8-mac-look/before-after/main-webgl2-model-4555-1/viewport.png), [png](s8-mac-look/before-after/branch-webgl2-model-4555-1/viewport.png) |
| model 10128-1 | 3.1 / 5.5 | 7.8 / 8.7 | 0.7 | 1.7 | 124 / 322,239 | 355 / 740,033 | [png](s8-mac-look/before-after/main-webgl2-model-10128-1/viewport.png), [png](s8-mac-look/before-after/branch-webgl2-model-10128-1/viewport.png) |
| model 10133-1 | 2.5 / 5.3 | 7.7 / 21.3 | 0.4 | 1.4 | 87 / 208,441 | 274 / 545,225 | [png](s8-mac-look/before-after/main-webgl2-model-10133-1/viewport.png), [png](s8-mac-look/before-after/branch-webgl2-model-10133-1/viewport.png) |
| city 20k street | 3.3 / 9.8 | 7.6 / 13.6 | 0.6 | 1.6 | 65 / 1,858,353 | 320 / 2,264,799 | [png](s8-mac-look/before-after/main-webgl2-city20k-street/viewport.png), [png](s8-mac-look/before-after/branch-webgl2-city20k-street/viewport.png) |
| city 20k aerial | 6.2 / 19.9 | 13.7 / 27.6 | 0.7 | 2.4 | 196 / 5,493,921 | 559 / 6,072,855 | [png](s8-mac-look/before-after/main-webgl2-city20k-aerial/viewport.png), [png](s8-mac-look/before-after/branch-webgl2-city20k-aerial/viewport.png) |

## HUD text, city 250k

<details><summary>branch-webgpu-look-all</summary>

```
Brick Railroad
API
webgpu
Adapter
apple / metal-3
Look
plastic, gtao, outlines, bevel, shadows, oit
Drawing buffer
3600×2086 px (devicePixelRatio 2)
Bundle
aa83d3a97cb22130
Parts
250,665
Modules
196
Stud instances (drawn of total)
325,871 of 1,391,563
Scene triangles
63,398,368
Load
269 ms
GPU buffers allocated so far, JS heap
vertex+index 41.9 MiB, other 0.7 MiB, JS heap 105.9 MiB
Render origin (chunks), rebases
(8, -9); 17 rebases, last at frame 137
Chunk tiers near/mid/far (median)
0 / 196 / 0
Draw calls (median)
4,182
Drawn triangles (median)
16,566,900
Scene coverage (sampled frames)
71%, 66%, 69%, 68%, 72%, 68%, 70%, 66%, 71%
Median frame (GPU-synced)
36.4 ms
p95 frame
47.7 ms
Median CPU submit
12.5 ms
Measured frames
120
```

</details>

<details><summary>branch-webgpu-look--gtao</summary>

```
Brick Railroad
API
webgpu
Adapter
apple / metal-3
Look
plastic, outlines, bevel, shadows, oit
Drawing buffer
3600×2086 px (devicePixelRatio 2)
Bundle
aa83d3a97cb22130
Parts
250,665
Modules
196
Stud instances (drawn of total)
325,871 of 1,391,563
Scene triangles
63,398,368
Load
277 ms
GPU buffers allocated so far, JS heap
vertex+index 41.9 MiB, other 0.7 MiB, JS heap 102.4 MiB
Render origin (chunks), rebases
(8, -9); 17 rebases, last at frame 137
Chunk tiers near/mid/far (median)
0 / 196 / 0
Draw calls (median)
4,181
Drawn triangles (median)
16,566,899
Scene coverage (sampled frames)
71%, 66%, 69%, 68%, 72%, 68%, 70%, 66%, 71%
Median frame (GPU-synced)
28.9 ms
p95 frame
42.4 ms
Median CPU submit
12.3 ms
Measured frames
120
```

</details>

<details><summary>branch-webgpu-look--outlines</summary>

```
Brick Railroad
API
webgpu
Adapter
apple / metal-3
Look
plastic, gtao, bevel, shadows, oit
Drawing buffer
3600×2086 px (devicePixelRatio 2)
Bundle
aa83d3a97cb22130
Parts
250,665
Modules
196
Stud instances (drawn of total)
325,871 of 1,391,563
Scene triangles
63,398,368
Load
274 ms
GPU buffers allocated so far, JS heap
vertex+index 41.9 MiB, other 0.7 MiB, JS heap 109.3 MiB
Render origin (chunks), rebases
(8, -9); 17 rebases, last at frame 137
Chunk tiers near/mid/far (median)
0 / 196 / 0
Draw calls (median)
4,182
Drawn triangles (median)
16,566,900
Scene coverage (sampled frames)
71%, 66%, 69%, 68%, 72%, 68%, 70%, 66%, 71%
Median frame (GPU-synced)
28.6 ms
p95 frame
43.2 ms
Median CPU submit
11.9 ms
Measured frames
120
```

</details>

<details><summary>branch-webgpu-look--bevel</summary>

```
Brick Railroad
API
webgpu
Adapter
apple / metal-3
Look
plastic, gtao, outlines, shadows, oit
Drawing buffer
3600×2086 px (devicePixelRatio 2)
Bundle
aa83d3a97cb22130
Parts
250,665
Modules
196
Stud instances (drawn of total)
325,871 of 1,391,563
Scene triangles
63,398,368
Load
271 ms
GPU buffers allocated so far, JS heap
vertex+index 41.9 MiB, other 0.7 MiB, JS heap 107.1 MiB
Render origin (chunks), rebases
(8, -9); 17 rebases, last at frame 137
Chunk tiers near/mid/far (median)
0 / 196 / 0
Draw calls (median)
4,182
Drawn triangles (median)
16,566,900
Scene coverage (sampled frames)
71%, 66%, 69%, 68%, 72%, 68%, 70%, 66%, 71%
Median frame (GPU-synced)
36.1 ms
p95 frame
48.4 ms
Median CPU submit
12.8 ms
Measured frames
120
```

</details>

<details><summary>branch-webgpu-look--shadows</summary>

```
Brick Railroad
API
webgpu
Adapter
apple / metal-3
Look
plastic, gtao, outlines, bevel, oit
Drawing buffer
3600×2086 px (devicePixelRatio 2)
Bundle
aa83d3a97cb22130
Parts
250,665
Modules
196
Stud instances (drawn of total)
325,871 of 1,391,563
Scene triangles
63,398,368
Load
253 ms
GPU buffers allocated so far, JS heap
vertex+index 41.9 MiB, other 0.4 MiB, JS heap 89.9 MiB
Render origin (chunks), rebases
(8, -9); 17 rebases, last at frame 137
Chunk tiers near/mid/far (median)
0 / 196 / 0
Draw calls (median)
1,558
Drawn triangles (median)
10,713,896
Scene coverage (sampled frames)
71%, 66%, 69%, 68%, 72%, 68%, 70%, 66%, 71%
Median frame (GPU-synced)
23.4 ms
p95 frame
28.2 ms
Median CPU submit
5.1 ms
Measured frames
120
```

</details>

<details><summary>branch-webgpu-look--oit</summary>

```
Brick Railroad
API
webgpu
Adapter
apple / metal-3
Look
plastic, gtao, outlines, bevel, shadows
Drawing buffer
3600×2086 px (devicePixelRatio 2)
Bundle
aa83d3a97cb22130
Parts
250,665
Modules
196
Stud instances (drawn of total)
325,871 of 1,391,563
Scene triangles
63,398,368
Load
267 ms
GPU buffers allocated so far, JS heap
vertex+index 41.9 MiB, other 0.7 MiB, JS heap 105.7 MiB
Render origin (chunks), rebases
(8, -9); 17 rebases, last at frame 137
Chunk tiers near/mid/far (median)
0 / 196 / 0
Draw calls (median)
4,182
Drawn triangles (median)
16,566,900
Scene coverage (sampled frames)
71%, 66%, 69%, 68%, 72%, 68%, 70%, 66%, 71%
Median frame (GPU-synced)
30.4 ms
p95 frame
43.0 ms
Median CPU submit
11.6 ms
Measured frames
120
```

</details>

<details><summary>branch-webgpu-look-none</summary>

```
Brick Railroad
API
webgpu
Adapter
apple / metal-3
Look
none (M0 look)
Drawing buffer
3600×2086 px (devicePixelRatio 2)
Bundle
aa83d3a97cb22130
Parts
250,665
Modules
196
Stud instances (drawn of total)
325,871 of 1,391,563
Scene triangles
63,398,368
Load
245 ms
GPU buffers allocated so far, JS heap
vertex+index 41.9 MiB, other 0.2 MiB, JS heap 86.9 MiB
Render origin (chunks), rebases
(8, -9); 17 rebases, last at frame 137
Chunk tiers near/mid/far (median)
0 / 196 / 0
Draw calls (median)
1,557
Drawn triangles (median)
10,713,895
Scene coverage (sampled frames)
71%, 66%, 69%, 68%, 72%, 68%, 70%, 66%, 71%
Median frame (GPU-synced)
21.1 ms
p95 frame
23.2 ms
Median CPU submit
4.0 ms
Measured frames
120
```

</details>

<details><summary>branch-webgpu-look-plastic</summary>

```
Brick Railroad
API
webgpu
Adapter
apple / metal-3
Look
plastic
Drawing buffer
3600×2086 px (devicePixelRatio 2)
Bundle
aa83d3a97cb22130
Parts
250,665
Modules
196
Stud instances (drawn of total)
325,871 of 1,391,563
Scene triangles
63,398,368
Load
249 ms
GPU buffers allocated so far, JS heap
vertex+index 41.9 MiB, other 0.4 MiB, JS heap 80.8 MiB
Render origin (chunks), rebases
(8, -9); 17 rebases, last at frame 137
Chunk tiers near/mid/far (median)
0 / 196 / 0
Draw calls (median)
1,557
Drawn triangles (median)
10,713,895
Scene coverage (sampled frames)
71%, 66%, 69%, 68%, 72%, 68%, 70%, 66%, 71%
Median frame (GPU-synced)
14.6 ms
p95 frame
21.2 ms
Median CPU submit
3.6 ms
Measured frames
120
```

</details>

<details><summary>main-webgpu-nolook</summary>

```
Brick Railroad
API
webgpu
Adapter
apple / metal-3
Drawing buffer
3600×2086 px (devicePixelRatio 2)
Bundle
aa83d3a97cb22130
Parts
250,665
Modules
196
Stud instances (drawn of total)
325,871 of 1,391,563
Scene triangles
63,398,368
Load
254 ms
GPU buffers allocated so far, JS heap
vertex+index 41.9 MiB, other 0.2 MiB, JS heap 86.7 MiB
Render origin (chunks), rebases
(8, -9); 17 rebases, last at frame 137
Chunk tiers near/mid/far (median)
0 / 196 / 0
Draw calls (median)
1,557
Drawn triangles (median)
10,713,895
Scene coverage (sampled frames)
71%, 66%, 69%, 68%, 72%, 68%, 70%, 66%, 71%
Median frame (GPU-synced)
18.2 ms
p95 frame
20.8 ms
Median CPU submit
3.5 ms
Measured frames
120
```

</details>

<details><summary>branch-webgl2-look-all</summary>

```
Brick Railroad
API
webgl2
Adapter
Google Inc. (Apple) / ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)
Look
plastic, gtao, outlines, bevel, shadows, oit
Drawing buffer
3600×2086 px (devicePixelRatio 2)
Bundle
aa83d3a97cb22130
Parts
250,665
Modules
196
Stud instances (drawn of total)
325,871 of 1,391,563
Scene triangles
63,398,368
Load
264 ms
GPU buffers allocated so far, JS heap
vertex+index 41.9 MiB, other 0.8 MiB, JS heap 101.8 MiB
Render origin (chunks), rebases
(8, -9); 17 rebases, last at frame 137
Chunk tiers near/mid/far (median)
0 / 196 / 0
Draw calls (median)
4,183
Drawn triangles (median)
16,566,901
Scene coverage (sampled frames)
71%, 66%, 69%, 68%, 72%, 68%, 70%, 66%, 71%
Median frame (GPU-synced)
23.1 ms
p95 frame
31.3 ms
Median CPU submit
10.3 ms
Measured frames
120
```

</details>

<details><summary>branch-webgl2-look--gtao</summary>

```
Brick Railroad
API
webgl2
Adapter
Google Inc. (Apple) / ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)
Look
plastic, outlines, bevel, shadows, oit
Drawing buffer
3600×2086 px (devicePixelRatio 2)
Bundle
aa83d3a97cb22130
Parts
250,665
Modules
196
Stud instances (drawn of total)
325,871 of 1,391,563
Scene triangles
63,398,368
Load
266 ms
GPU buffers allocated so far, JS heap
vertex+index 41.9 MiB, other 0.8 MiB, JS heap 101.5 MiB
Render origin (chunks), rebases
(8, -9); 17 rebases, last at frame 137
Chunk tiers near/mid/far (median)
0 / 196 / 0
Draw calls (median)
4,182
Drawn triangles (median)
16,566,900
Scene coverage (sampled frames)
71%, 66%, 69%, 68%, 72%, 68%, 70%, 66%, 71%
Median frame (GPU-synced)
23.2 ms
p95 frame
31.5 ms
Median CPU submit
11.1 ms
Measured frames
120
```

</details>

<details><summary>branch-webgl2-look--outlines</summary>

```
Brick Railroad
API
webgl2
Adapter
Google Inc. (Apple) / ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)
Look
plastic, gtao, bevel, shadows, oit
Drawing buffer
3600×2086 px (devicePixelRatio 2)
Bundle
aa83d3a97cb22130
Parts
250,665
Modules
196
Stud instances (drawn of total)
325,871 of 1,391,563
Scene triangles
63,398,368
Load
276 ms
GPU buffers allocated so far, JS heap
vertex+index 41.9 MiB, other 0.8 MiB, JS heap 101.8 MiB
Render origin (chunks), rebases
(8, -9); 17 rebases, last at frame 137
Chunk tiers near/mid/far (median)
0 / 196 / 0
Draw calls (median)
4,183
Drawn triangles (median)
16,566,901
Scene coverage (sampled frames)
71%, 66%, 69%, 68%, 72%, 68%, 70%, 66%, 71%
Median frame (GPU-synced)
23.4 ms
p95 frame
31.6 ms
Median CPU submit
10.5 ms
Measured frames
120
```

</details>

<details><summary>branch-webgl2-look--bevel</summary>

```
Brick Railroad
API
webgl2
Adapter
Google Inc. (Apple) / ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)
Look
plastic, gtao, outlines, shadows, oit
Drawing buffer
3600×2086 px (devicePixelRatio 2)
Bundle
aa83d3a97cb22130
Parts
250,665
Modules
196
Stud instances (drawn of total)
325,871 of 1,391,563
Scene triangles
63,398,368
Load
268 ms
GPU buffers allocated so far, JS heap
vertex+index 41.9 MiB, other 0.8 MiB, JS heap 101.9 MiB
Render origin (chunks), rebases
(8, -9); 17 rebases, last at frame 137
Chunk tiers near/mid/far (median)
0 / 196 / 0
Draw calls (median)
4,183
Drawn triangles (median)
16,566,901
Scene coverage (sampled frames)
71%, 66%, 69%, 68%, 72%, 68%, 70%, 66%, 71%
Median frame (GPU-synced)
24.1 ms
p95 frame
33.1 ms
Median CPU submit
11.6 ms
Measured frames
120
```

</details>

<details><summary>branch-webgl2-look--shadows</summary>

```
Brick Railroad
API
webgl2
Adapter
Google Inc. (Apple) / ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)
Look
plastic, gtao, outlines, bevel, oit
Drawing buffer
3600×2086 px (devicePixelRatio 2)
Bundle
aa83d3a97cb22130
Parts
250,665
Modules
196
Stud instances (drawn of total)
325,871 of 1,391,563
Scene triangles
63,398,368
Load
262 ms
GPU buffers allocated so far, JS heap
vertex+index 41.9 MiB, other 0.5 MiB, JS heap 80.0 MiB
Render origin (chunks), rebases
(8, -9); 17 rebases, last at frame 137
Chunk tiers near/mid/far (median)
0 / 196 / 0
Draw calls (median)
1,559
Drawn triangles (median)
10,713,897
Scene coverage (sampled frames)
71%, 66%, 69%, 68%, 72%, 68%, 70%, 66%, 71%
Median frame (GPU-synced)
15.1 ms
p95 frame
19.0 ms
Median CPU submit
4.4 ms
Measured frames
120
```

</details>

<details><summary>branch-webgl2-look--oit</summary>

```
Brick Railroad
API
webgl2
Adapter
Google Inc. (Apple) / ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)
Look
plastic, gtao, outlines, bevel, shadows
Drawing buffer
3600×2086 px (devicePixelRatio 2)
Bundle
aa83d3a97cb22130
Parts
250,665
Modules
196
Stud instances (drawn of total)
325,871 of 1,391,563
Scene triangles
63,398,368
Load
267 ms
GPU buffers allocated so far, JS heap
vertex+index 41.9 MiB, other 0.8 MiB, JS heap 100.2 MiB
Render origin (chunks), rebases
(8, -9); 17 rebases, last at frame 137
Chunk tiers near/mid/far (median)
0 / 196 / 0
Draw calls (median)
4,182
Drawn triangles (median)
16,566,900
Scene coverage (sampled frames)
71%, 66%, 69%, 68%, 72%, 68%, 70%, 66%, 71%
Median frame (GPU-synced)
28.9 ms
p95 frame
35.6 ms
Median CPU submit
9.8 ms
Measured frames
120
```

</details>

<details><summary>branch-webgl2-look-none</summary>

```
Brick Railroad
API
webgl2
Adapter
Google Inc. (Apple) / ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)
Look
none (M0 look)
Drawing buffer
3600×2086 px (devicePixelRatio 2)
Bundle
aa83d3a97cb22130
Parts
250,665
Modules
196
Stud instances (drawn of total)
325,871 of 1,391,563
Scene triangles
63,398,368
Load
250 ms
GPU buffers allocated so far, JS heap
vertex+index 41.9 MiB, other 0.3 MiB, JS heap 75.3 MiB
Render origin (chunks), rebases
(8, -9); 17 rebases, last at frame 137
Chunk tiers near/mid/far (median)
0 / 196 / 0
Draw calls (median)
1,557
Drawn triangles (median)
10,713,895
Scene coverage (sampled frames)
70%, 66%, 69%, 68%, 72%, 68%, 70%, 66%, 71%
Median frame (GPU-synced)
15.1 ms
p95 frame
18.3 ms
Median CPU submit
3.4 ms
Measured frames
120
```

</details>

<details><summary>branch-webgl2-look-plastic</summary>

```
Brick Railroad
API
webgl2
Adapter
Google Inc. (Apple) / ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)
Look
plastic
Drawing buffer
3600×2086 px (devicePixelRatio 2)
Bundle
aa83d3a97cb22130
Parts
250,665
Modules
196
Stud instances (drawn of total)
325,871 of 1,391,563
Scene triangles
63,398,368
Load
254 ms
GPU buffers allocated so far, JS heap
vertex+index 41.9 MiB, other 0.5 MiB, JS heap 78.0 MiB
Render origin (chunks), rebases
(8, -9); 17 rebases, last at frame 137
Chunk tiers near/mid/far (median)
0 / 196 / 0
Draw calls (median)
1,557
Drawn triangles (median)
10,713,895
Scene coverage (sampled frames)
70%, 66%, 69%, 68%, 72%, 68%, 70%, 66%, 71%
Median frame (GPU-synced)
15.2 ms
p95 frame
18.0 ms
Median CPU submit
3.4 ms
Measured frames
120
```

</details>

<details><summary>main-webgl2-nolook</summary>

```
Brick Railroad
API
webgl2
Adapter
Google Inc. (Apple) / ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)
Drawing buffer
3600×2086 px (devicePixelRatio 2)
Bundle
aa83d3a97cb22130
Parts
250,665
Modules
196
Stud instances (drawn of total)
325,871 of 1,391,563
Scene triangles
63,398,368
Load
256 ms
GPU buffers allocated so far, JS heap
vertex+index 41.9 MiB, other 0.3 MiB, JS heap 74.7 MiB
Render origin (chunks), rebases
(8, -9); 17 rebases, last at frame 137
Chunk tiers near/mid/far (median)
0 / 196 / 0
Draw calls (median)
1,557
Drawn triangles (median)
10,713,895
Scene coverage (sampled frames)
70%, 66%, 69%, 68%, 72%, 68%, 70%, 66%, 71%
Median frame (GPU-synced)
12.6 ms
p95 frame
14.8 ms
Median CPU submit
2.9 ms
Measured frames
120
```

</details>

The HUD text for every before-and-after run is in its `hud.txt`.
