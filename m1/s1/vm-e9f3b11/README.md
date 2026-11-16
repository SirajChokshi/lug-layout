# M1 S1 evidence, VM run at e9f3b11

Real app (`apps/web` production build served by `vite preview`) on the bundle built at `e9f3b11`, driven by `scripts/models.mjs` and `scripts/city.mjs` with playwright-core.

- Browser: Chrome for Testing 159.0.8154.6 (Playwright chromium-1255), headed on Xvfb, flags `--enable-unsafe-webgpu --ignore-gpu-blocklist`.
- No GPU: WebGPU runs on SwiftShader, WebGL2 on llvmpipe. Frame times here are software-rasterizer times and only show the app runs; counts are the evidence.
- Viewport 1280×800, devicePixelRatio 1, `?model=<set>&api=<api>&measure=1&warmup=2&frames=5`.
- `runs/<set>-<api>.json`: URL, HUD text, `#result` JSON and console output per run.
- `screens/main-eda49e7-7936-1-webgl2.png`: the same URL on `main` (camera framing before this PR).
- `qualification.txt`, `flatten-check.txt`, `mirror-identity.txt`, `mirror-sha256.txt`: outputs of `scripts/qualify.py` and `scripts/flatten_check.py`, which are independent Python flatteners (no repo code).
