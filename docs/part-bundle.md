# Part bundle delivery

The compiled part bundle lives only in the `brr-part-bundles` R2 bucket: GLBs, model JSON, the in-browser compiler (`brick-compile-wasm.wasm`) and one manifest per LOD. Nothing generated is committed, the web deploy ships only the app, and the app loads parts from the bucket's public URL. Terraform in `infra/cloudflare` manages the bucket, its CORS and its public domain (*Part bundle bucket* in its README).

Only `main` publishes. Pull requests never write or read R2. Their CI jobs build the bundle locally, and every test that loads parts reads `tools/asset-pipeline/dist/bundle` from disk.

`bundle` records what it built from in `dist/bundle/build-key.json`: the input key (*Keys* below) and the SHA-256 of `pnpm-lock.yaml`. When that file matches the checkout, every LOD has its manifest and no untracked file matches the bundle inputs, `bundle` keeps the existing output instead of compiling it again. CI's `verify` job and both `e2e` shards restore `dist/bundle` from the GitHub Actions cache under `part-bundle-<input key>-<lockfile hash>`, and `verify` saves it there after a fresh build, so runs that don't change the bundle inputs skip the compile. The required `check` status comes from a job that passes only when `verify` and every `e2e` shard passed. Pushes to `main` fill the cache that pull requests read. Delete `build-key.json` to force a rebuild.

## Keys

- `<lod>/<file>.<sha256 prefix>.glb|json|wasm`: content-addressed objects. Identical bytes get the same key, so a new bundle uploads only what changed. The uploader refuses any file whose name doesn't match its own SHA-256.
- `<lod>/manifest.<input key>.json`: one manifest per LOD. The input key is the first 16 hex digits of a SHA-256 over every git-tracked file that `turbo.json` lists as an input of `@brr/asset-pipeline#build`: the crates, the palette, the lock, the verified facts, the pipeline source except its tests, the bundle schema and its decoder (`packages/schema/src/bundle`, `packages/schema/src/decode`), `@brr/math` (`packages/math/src`), and the shared modules the pipeline runs (`packages/catalog/src/glb.ts`, `packages/catalog/src/part-bundle.ts`, `packages/domain/src/track/heading-footprints.ts`). `bundle-inputs.test.ts` runs the pipeline CLI, records every repository file it loads and fails if one of them isn't an input. It also checks every data file the bundle command reads, listed once in `BUNDLE_DATA_FILES` (`bundle-data.ts`), which `cli.ts` reads them through, and every generated model the palette compiles. `node tools/asset-pipeline/src/cli.ts manifest-file` prints it in about 0.2 s, without compiling anything.

- `current/latest.json`: `{"manifestFile":"manifest.<input key>.json"}`, the newest bundle `main` published. The app reads it at startup (*Vercel* below). It's the only object ever overwritten, and its path has no `.<16 hex>.` segment, so nothing that caches content-addressed files forever (`isContentAddressedPath` in `@brr/schema/bundle-pointer`) keeps it.

Every object except the pointer is stored with `Cache-Control: public, max-age=31536000, immutable`. The pointer is stored with `public, max-age=60`.

## What a LOD holds

The manifest is the small index the editor reads first. It holds the colours, stud primitives, model entries, track catalog and MILS edge rules. It also lists the `catalogParts`: the ground, road and track parts the editor offers, each with the file of its shape. And it holds each track piece's `trackShapes`: its plan footprint at all 16 headings and its height range, measured from its mesh. Everything else is in files the manifest names:
- `partTable`: every bundled part (id, path, GLB file, bounds, licence);
- `creditTable`: the attribution of every LDraw file the bundle uses;
- each model file is that model's record: its instances, stud cells and cover, plus the shape of every part it places;
- a part's shape (`shape-<id>.<sha>.json`) is what placement needs from it without its mesh: bounds, role, stud records, track ends and produced colours;
- `thumbnails` (standard LOD only) maps each palette item to its picture, `thumb/<item>.<sha>.png`: every ground and road part in each produced colour, and every placeable set and MILS module. The pipeline renders them from the GLBs it has just compiled with a deterministic CPU rasterizer (`tools/asset-pipeline/src/thumbnails/`): 112×112 RGBA, a fixed three-quarter view of the item's box, LDConfig colours, key, fill and ambient light, translucent colours blended last, an edge outline and 3× supersampling. The same inputs give the same bytes, so the files content-address like everything else.

GLBs are only ever needed to draw.

## CI

`.github/workflows/part-bundle.yml` runs three jobs on every push to `main`, and on *Actions → Part bundle → Run workflow*.

**`status`** has no environment and no secrets. It HEADs the three manifests for the commit's input key at the bucket's public URL: the repository variable `PART_BUNDLE_BASE_URL` if it's set, otherwise `public_base_url` in `infra/cloudflare/part-bundles.json`. It also reads `current/latest.json` there. If all three manifests are served and the pointer already names them, the workflow ends there. That covers every commit that doesn't touch the bundle inputs, and nobody is asked to approve anything. If the variable is unset, a manifest is missing, or the URL can't be reached, it falls through to `publish`.

**`publish`** runs in the `production` environment that #62's catalog deploy also uses, so it waits for the owner's approval:
1. Checks the bucket itself for the three manifests, over R2's S3 API, and stops if they're all there.
2. Otherwise, restores the pinned LDraw inputs and builds the bundle, including the compiler.
3. Uploads the objects the bucket doesn't have yet.
4. Uploads the manifests last, so a manifest never names a missing object.

`publish` uses #62's single Cloudflare account token. R2's S3 API takes the token's id as the access key and the SHA-256 hex digest of the token value as the secret, and the CLI derives both from `CLOUDFLARE_API_TOKEN_ID` and `CLOUDFLARE_API_TOKEN`. `CLOUDFLARE_ACCOUNT_ID`, the token and its id are passed only to the check step and the upload step. Installs, the Rust toolchain, `cargo` build scripts and the LDraw restore never see them. Without the token, the check step warns and nothing is published. It never reads `infra/cloudflare/part-bundles.json` in that case. The bucket name is that file's `bucket_name`.

**`pointer`** runs once `publish` succeeded or was skipped, unless `status` found the pointer already current. It waits up to 5 minutes for all three manifests to be served at the public URL, then writes `current/latest.json` naming them, in the `production` environment with the same token as `publish`.

**Approval is requested only when the bundle is missing**, which is after a merge that changes bundle inputs. The bundle is then built and uploaded in about 20 minutes on `ubuntu-latest` (19.4 minutes for 4d08a77, 18.5 for 9cc703c), and the pointer moves right after. Runs share one concurrency group, so a merge that lands while another bundle is building waits for it, and only the newest queued run is kept.

## Vercel

`apps/web/vercel.json` applies when the project's Root Directory is `apps/web`. `main` deploys to Production, and other branches get previews.
- **Install:** only `@brr/web` and what it depends on.
- **Base URL:** `vercel-build.sh` takes the bucket's public URL from `public_base_url` in `infra/cloudflare/part-bundles.json` and exports it as `VITE_BUNDLE_BASE_URL`, so the Vercel project needs no environment variable. An explicit `VITE_BUNDLE_BASE_URL` in Vercel still wins.
- **Build:** `vercel-build.sh` exports the base URLs and runs `vite build` with `publicDir` off. It never contacts the bucket, never waits and knows nothing about the bundle. A Vercel build without `VITE_BUNDLE_BASE_URL` refuses to run.
- **Runtime:** the app reads `current/latest.json` once per page load and loads whatever manifest it names, whatever version that is. If the pointer is missing or unreadable, it tries once more, then loads its fallback manifest, `VITE_BUNDLE_MANIFEST_FILE`. If that fails too, the editor shows "The part bundle is unreachable: …" with the file that failed.
- **Fallback:** `vercel-build.sh` sets `VITE_BUNDLE_MANIFEST_FILE` from `manifest_file` in `infra/cloudflare/bundle-fallback.json`, a manifest that is published on R2, and `vite.config.ts` refuses a Vercel build without one, so a deployed build never asks for `manifest.json`. Bundles are never pruned, so the committed name stays valid; moving it to a newer published manifest is optional. Builds without it, such as local dev, fall back to `manifest.json`, which is what local dev serves. Because of the fallback, a deploy works before the `pointer` job has ever run, with no seeding and no approval.
- **Skew:** the app and the bundle deploy independently, so right after a merge that changes the bundle format the new app can read the previous bundle until `publish` and `pointer` finish (about 20 minutes plus approval), and an app older than the bundle can read the new one. Either pairing can be partly broken during that window; nothing pins them together.
- **Previews:** previews build exactly like Production and read the same pointer.
- **LDraw library:** while `public_base_url` in `infra/cloudflare/ldraw-library.json` is `null`, builds read the LDraw library from GitHub raw. Once it's committed, `vercel-build.sh` exports it as `VITE_LDRAW_LIBRARY_BASE_URL`; the build doesn't check that the library is published (`docs/ldraw-library.md`).
- **Ignored builds:** `ignoreCommand` skips deploys whose changes are only Markdown, tests, benchmarks, `.cursor`, `.github`, `infra`, `apps/catalog-api` or `docs/research`. Any git error, such as no previous deployment, builds.

## Setup

1. Apply `infra/cloudflare`. It creates the bucket, public on its r2.dev domain.
2. No new secrets. `publish` uses `production`'s `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_API_TOKEN_ID`, set up for #62 (*Credentials* in the infra README). The token's Workers R2 Storage permission covers the bucket.
3. Copy the Terraform output `part_bundle_base_url` into `public_base_url` in `infra/cloudflare/part-bundles.json` and commit it. The Vercel build and the `status` job both read it from there. In the Vercel project, check that Root Directory is `apps/web`.
4. Optionally, override the committed URL with Vercel's `VITE_BUNDLE_BASE_URL` or the repository variable `PART_BUNDLE_BASE_URL`; neither is needed.
5. To move to a custom domain later, follow the three steps in the infra README; step 2 is now committing the new URL as `public_base_url`. `ignoreCommand` skips commits that touch only `infra/`, so redeploy Production by hand after that commit. r2.dev stays on until no deployment loads from it.

## Local development

Nothing changes locally. `pnpm --filter @brr/asset-pipeline build` writes `tools/asset-pipeline/dist/bundle`, and `vite` serves it at `/bundle/`. To use the published bundle instead:

```sh
VITE_BUNDLE_BASE_URL=<part_bundle_base_url> VITE_BUNDLE_MANIFEST_FILE=$(node tools/asset-pipeline/src/cli.ts manifest-file) pnpm --filter @brr/web dev
```
