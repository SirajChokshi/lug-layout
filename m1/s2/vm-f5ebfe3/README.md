# M1 S2 evidence, VM run at f5ebfe3

CDN behaviour tested locally: the real app's production build served by `vite preview` on port 4173, which sends the production cache headers through `apps/web/bundle-cache-headers.ts`. S1 at `d697e5d` served the same way on port 4176. `main` at `eda49e7` on port 4174.

Chrome for Testing 159.0.8154.6 on Xvfb, no GPU (WebGPU on SwiftShader, WebGL2 on llvmpipe), 1280×800.

- `headers.txt`: `curl -sI` of the manifest and three content-addressed files.
- `hashcheck.txt`: `scripts/hashcheck.mjs` fetches every file of the three LOD manifests over HTTP and checks that its sha256 starts with the 16 hex digits in its name and that it is served immutable.
- `network.txt`, `runs/network-*.json`, `har/`: `scripts/network.mjs`, cold load then reload in a fresh browser context per URL, from Resource Timing (buffer raised to 1,000,000 entries) plus a HAR.
- `determinism.txt`: two clean builds in two checkouts of `f5ebfe3`.
- `locality.txt`: a third build with model 4555-1 removed from `palette.json` (local edit, not committed), diffed against the clean build.
- `city-compare.txt`: city counts and load, `main` against S2.
- `runs/<set>-<api>.json`, `screens/`: all 10 models and the city rendered on S2.
