# #29 at 8fdf9b4: the crosswalk on #79's R2 path, and one export rerun

- **Code:** `siraj/m3-bom-export-fdde` at `8fdf9b4dbdfbbbb865402ed156a5e4da7a27d56c`, a conflict-only rebase of `9a96c07` onto `main` at `f982e6d` (#79 R2 bundle, #41 look pass, #90 keyboard, #95 command palette). `range-diff-9a96c07-8fdf9b4.txt` is `git range-diff f6db3a6..9a96c07 f982e6d..8fdf9b4`.
- **Bundle:** `pnpm --filter @brr/asset-pipeline build` at that commit. The crosswalk is `crosswalk.60cb2f987568c642.json`, byte-identical to the 9a96c07 run.

## Published and fetched through #79's R2 path

1. `scripts/upload-local.ts` runs #79's own `uploadPartBundle` and `remoteManifestFile(bundleInputKey(repo))` against an `ObjectStore` that writes to a local directory instead of R2. It uploaded 2,454 objects for the three LODs, including `<lod>/crosswalk.60cb2f987568c642.json` with `Content-Type: application/json` and the immutable cache header (`r2-object-headers.json`). The remote manifest is `manifest.9671f8c8baa12051.json`.
2. `scripts/serve.py` serves that directory from a separate origin (`http://127.0.0.1:4180/`, with CORS).
3. The web app was built as the Vercel build does, with `VITE_BUNDLE_BASE_URL=http://127.0.0.1:4180/` and `VITE_BUNDLE_MANIFEST_FILE=manifest.9671f8c8baa12051.json`, so `dist/` holds no bundle. It was served by `vite preview` on port 4174.
4. `tools/e2e/src/export-parts-lists.ts --stage models` exported `?model=10218-1` through the real panel. `r2-access.log` shows the app fetching `GET /standard/manifest.9671f8c8baa12051.json` and then `GET /standard/crosswalk.60cb2f987568c642.json` from that origin. All 211 requests returned 200.

## The export

`exports/model/10218-1.{rebrickable.csv,bricklink.xml,parts.csv}` are byte-identical to the 9a96c07 run's files (`../vm-9a96c07/exports/model/`). They equal the independent recount (2,058 Rebrickable parts, 17 unmapped). The XML passes `xmllint` and carries the disclaimer comment, and the plain CSV ends with the disclaimer row.

Chrome 157, headed on Xvfb, WebGL2 on SwiftShader, 8-core cloud VM with no GPU. Only counts and files are claimed.
