# M1 S8 look pass: evidence

PR: https://github.com/SirajChokshi/lug-layout/pull/41. Code head: `93bb24e`. Main for "before": `95c2a5d`.

## `vm-93bb24e/` (this VM)
- **Machine and browser:** Google Chrome 157.0.8103.50, headed on Xvfb, WebGL2 on ANGLE/SwiftShader, 8-core VM, no GPU. WebGPU fails to create a device on this VM for main and branch alike. VM frame times count for correctness only.
- **Serving:** each build runs under `vite preview`, main on :4173 and the branch on :4174, both on the bundle built from the pinned inputs (standard `1fd935a2278f8b65`).
- **`pairs/`:** `before-*` is main and `after-*` is the branch at its default look (no `look` parameter). URL: `?model=<set>&api=webgl2&measure=1&warmup=2&frames=8`, and `?scene=city&parts=20000&camera=street|aerial&...` for the city. Each run has a canvas-only screenshot (HUD and footer hidden) and a JSON file with the `#result` text, the HUD text and the console log. Driver: `scripts/pairs.sh`, which runs `scripts/shoot.mjs`.
- **`composites/`:** cropped before|after pairs, made by `scripts/composites.mjs`, plus `oit-windows-10218.png` (main, `look=-oit`, `look=all`).
- **`extra/`:** `look=all` and `look=-oit` runs at the same cameras.
- **`scene/`:** the ten sets placed on 3811 baseplates through the editor UI (`scripts/s8-scene.cjs`, using S5's `scripts/s5-lib.cjs`), on main and on the branch. The views are at several zoom steps, all from the same inputs.
- **`color/`:** ΔE2000 of exposed top faces, from `scripts/color-accuracy.mjs`.
  - Method: `?model=<set>&camera=top` (straight down), default look. Exposed upright tiles are sampled at their centre, and exposed 2-wide plates and bricks at the gaps between studs. "Exposed" means no instance's bounds lie above the face.
  - Each sample is projected from the bundle's instance matrices and the app's camera formula, and the reading is the median of a 5×5 block.
  - The reference is the LDConfig sRGB value. `*-samples-<code>.png` are 4× insets of the first samples, and `outliers.png` shows every sample with ΔE above 10.
- **`washout/`:** the track washout investigation.
  - The scenes are the run scene of #38 (`95e64d1`), alone and locally merged with this branch. The merge was never pushed.
  - URL: `?api=webgl2&run=1&trains=60@100&track=<dogbone>`, live view after 20 s, at 960×600.
  - The one-term variants: `e1-rough1` (M0 material, roughness 1), `e2-nosun` (sun off), `v0-base` (plastic before the fix), `v1`–`v4` (specular and clearcoat variants), with `v4` the fix. Brightness bands come from `scripts/band.mjs`.

## `macbook-2ac9f89/` and `macbook-50c281b/` (M4 Max)
These were recorded by the MacBook worker, and its README is copied as-is. They hold `result.json`, `hud.txt`, `console.txt` and `summary.ndjson` for every run, and the 50c281b run adds four viewports. Both runs had background CPU load, as each README records.

## `vm-a25c0f4/` (after rebasing onto main `ecd8f23`)
- **`equivalence/`:** five views re-shot at `a25c0f4` (branch) and `ecd8f23` (main): 10185-1, 10264-1 and city 20k aerial for the branch, 10185-1 and city 20k aerial for main. Compared with `scripts/diff.mjs` against the `vm-93bb24e/pairs` shots, each has 0 differing pixels (max channel delta 0), so the `vm-93bb24e` evidence holds at this head.
- **`run-scene/`:** main's own run scene (#38 merged), `?api=webgl2&run=1&trains=60@100&track=<dogbone>`, live after 20 s at 960×600. Shown for main, the branch at its default look, and the branch at `look=all`. Median track brightness (rows 0–160 against 320–480): main 130 / 202, default 114 / 119, `look=all` 116 / 135.
- **`pnpm-check.log`:** `pnpm check` at `a25c0f4`, exit 0.

## `vm-ebf2b15/` (after rebasing onto main `f1026d3`, #44 merged)
- **`equivalence/`:** the same five views re-shot at `ebf2b15` (branch) and `f1026d3` (main). Each has 0 differing pixels against `vm-93bb24e/pairs`.
- **`pnpm-check.log`:** `pnpm check` at `ebf2b15`, exit 0.

## `vm-ed936a6/` (review fixes, rebased onto main `504846e`, #59 and #39 merged)
- **`equivalence/`:** five views at `ed936a6` (branch) and `504846e` (main), with the bundle rebuilt for #39 (standard `6462e3f858d42279`). Each has 0 differing pixels against `vm-93bb24e/pairs`.
- **`pnpm-check-terraform-missing.log`:** `pnpm check` stops at `check:infra`, the Terraform validation of `infra/cloudflare` that main added in #59, because this VM has no `terraform`. This PR doesn't touch `infra/`.
- **`pnpm-check-steps-without-infra.log`:** every other `pnpm check` step run in order (restore-ldraw, lint, lint:boundaries, lint:rust, format:check, check:rust, turbo typecheck, test and build). Exit 0.
