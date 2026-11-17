# Part bundle delivery

The compiled part bundle lives only in the `brr-part-bundles` R2 bucket: GLBs, model JSON, the in-browser compiler (`brick-compile-wasm.wasm`) and one manifest per LOD. Nothing generated is committed, the web deploy ships only the app, and the app loads parts from the bucket's public URL. Terraform in `infra/cloudflare` manages the bucket, its CORS and its public domain (*Part bundle bucket* in its README).

Only `main` publishes. Pull requests never write or read R2. Their `check` job builds the bundle locally, and every test that loads parts reads `tools/asset-pipeline/dist/bundle` from disk.

## Keys

- `<lod>/<file>.<sha256 prefix>.glb|json|wasm`: content-addressed objects. Identical bytes get the same key, so a new bundle uploads only what changed. The uploader refuses any file whose name doesn't match its own SHA-256.
- `<lod>/manifest.<input key>.json`: one manifest per LOD. The input key is the first 16 hex digits of a SHA-256 over every git-tracked file that `turbo.json` lists as an input of `@brr/asset-pipeline#build`: the crates, the palette, the lock, the verified facts, and the pipeline source except its tests. `node tools/asset-pipeline/src/cli.ts manifest-file` prints it in about 0.2 s, without compiling anything.

Every object is stored with `Cache-Control: public, max-age=31536000, immutable`.

## CI

`.github/workflows/part-bundle.yml` runs two jobs on every push to `main`.

**`status`** has no environment and no secrets. It HEADs the three manifests for the commit's input key at the bucket's public URL: the repository variable `PART_BUNDLE_BASE_URL` if it's set, otherwise `public_base_url` in `infra/cloudflare/part-bundles.json`. If all three are served, the workflow ends there. That covers every commit that doesn't touch the bundle inputs, and nobody is asked to approve anything. If the variable is unset, a manifest is missing, or the URL can't be reached, it falls through to `publish`.

**`publish`** runs in the `production` environment that #62's catalog deploy also uses, so it waits for the owner's approval:
1. Checks the bucket itself for the three manifests, over R2's S3 API, and stops if they're all there.
2. Otherwise, restores the pinned LDraw inputs and builds the bundle, including the compiler.
3. Uploads the objects the bucket doesn't have yet.
4. Uploads the manifests last, so a manifest never names a missing object.

`publish` uses #62's single Cloudflare account token. R2's S3 API takes the token's id as the access key and the SHA-256 hex digest of the token value as the secret, and the CLI derives both from `CLOUDFLARE_API_TOKEN_ID` and `CLOUDFLARE_API_TOKEN`. `CLOUDFLARE_ACCOUNT_ID`, the token and its id are passed only to the check step and the upload step. Installs, the Rust toolchain, `cargo` build scripts and the LDraw restore never see them. Without the token, the check step warns and nothing is published. It never reads `infra/cloudflare/part-bundles.json` in that case. The bucket name is that file's `bucket_name`.

**Approval is requested only when the bundle is missing**, which is after a merge that changes bundle inputs. Production then deploys only after the job is approved and has built and uploaded the bundle, about 6 minutes. If that takes longer than `PART_BUNDLE_WAIT_MINUTES`, the Vercel build fails and the previous deployment keeps serving. Approve the job, then redeploy in Vercel.

## Vercel

`apps/web/vercel.json` applies when the project's Root Directory is `apps/web`. Only Production deploys.
- **Install:** only `@brr/web` and the asset pipeline.
- **Base URL:** `vercel-build.sh` takes the bucket's public URL from `public_base_url` in `infra/cloudflare/part-bundles.json` and exports it as `VITE_BUNDLE_BASE_URL`, so the Vercel project needs no environment variable. An explicit `VITE_BUNDLE_BASE_URL` in Vercel still wins.
- **Build:** waits until the three manifests for its input key are served from that URL, then runs `vite build` with `publicDir` off. If they don't appear within `PART_BUNDLE_WAIT_MINUTES` (default 20), the build fails and the previous deployment keeps serving. A Vercel build without `VITE_BUNDLE_BASE_URL` refuses to run.
- **Input changes:** a merge that changes bundle inputs waits for `main`'s build, about 6 minutes on 8 cores. Other merges find the key already published and don't wait.
- **Needs git:** the input key comes from `git ls-files`. A deploy without `.git`, such as `vercel deploy` from a plain directory, fails with a git error or "git lists no part bundle inputs" rather than guessing a key.
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
