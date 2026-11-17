# Part bundle delivery

The compiled part bundle lives only in the `brr-part-bundles` R2 bucket: GLBs, model JSON, the in-browser compiler (`brick-compile-wasm.wasm`) and one manifest per LOD. Nothing generated is committed, the web deploy ships only the app, and the app loads parts from the bucket's public URL. Terraform in `infra/cloudflare` manages the bucket, its CORS and its public domain (*Part bundle bucket* in its README).

Only `main` publishes. Pull requests never write or read R2. Their `check` job builds the bundle locally, and every test that loads parts reads `tools/asset-pipeline/dist/bundle` from disk.

## Keys

- `<lod>/<file>.<sha256 prefix>.glb|json|wasm`: content-addressed objects. Identical bytes get the same key, so a new bundle uploads only what changed. The uploader refuses any file whose name doesn't match its own SHA-256.
- `<lod>/manifest.<input key>.json`: one manifest per LOD. The input key is the first 16 hex digits of a SHA-256 over every git-tracked file that `turbo.json` lists as an input of `@brr/asset-pipeline#build`: the crates, the palette, the lock, the verified facts, the pipeline source except its tests, the bundle schema (`packages/schema/src/bundle`), and the two shared modules the pipeline runs (`packages/catalog/src/glb.ts`, `packages/domain/src/track/heading-footprints.ts`). `node tools/asset-pipeline/src/cli.ts manifest-file` prints it in about 0.2 s, without compiling anything.

Every object is stored with `Cache-Control: public, max-age=31536000, immutable`.

## What a LOD holds

The manifest is the small index the editor reads first. It holds the colours, stud primitives, model entries, track catalog and MILS edge rules. It also lists the `catalogParts`: the ground, road and track parts the editor offers, each with the file of its shape. And it holds each track piece's `trackShapes`: its plan footprint at all 16 headings and its height range, measured from its mesh. Everything else is in files the manifest names:
- `partTable`: every bundled part (id, path, GLB file, bounds, licence);
- `creditTable`: the attribution of every LDraw file the bundle uses;
- each model file is that model's record: its instances, stud cells and cover, plus the shape of every part it places;
- a part's shape (`shape-<id>.<sha>.json`) is what placement needs from it without its mesh: bounds, role, stud records, track ends and produced colours.

GLBs are only ever needed to draw.

## CI

`.github/workflows/part-bundle.yml` runs two jobs on every push to `main`.

**`status`** has no environment and no secrets. It HEADs the three manifests for the commit's input key at the bucket's public URL: the repository variable `PART_BUNDLE_BASE_URL` if it's set, otherwise `public_base_url` in `infra/cloudflare/part-bundles.json`. If all three are served, the workflow ends there. That covers every commit that doesn't touch the bundle inputs, and nobody is asked to approve anything. If the variable is unset, a manifest is missing, or the URL can't be reached, it falls through to `publish`.

**`publish`** runs in the `production` environment that #62's catalog deploy also uses, so it waits for the owner's approval:
1. Checks the bucket itself for the three manifests, over R2's S3 API, and stops if they're all there.
2. Otherwise, restores the pinned LDraw inputs and builds the bundle, including the compiler.
3. Uploads the objects the bucket doesn't have yet.
4. Uploads the manifests last, so a manifest never names a missing object.

`publish` uses #62's single Cloudflare account token. R2's S3 API takes the token's id as the access key and the SHA-256 hex digest of the token value as the secret, and the CLI derives both from `CLOUDFLARE_API_TOKEN_ID` and `CLOUDFLARE_API_TOKEN`. `CLOUDFLARE_ACCOUNT_ID`, the token and its id are passed only to the check step and the upload step. Installs, the Rust toolchain, `cargo` build scripts and the LDraw restore never see them. Without the token, the check step warns and nothing is published. It never reads `infra/cloudflare/part-bundles.json` in that case. The bucket name is that file's `bucket_name`.

**Approval is requested only when the bundle is missing**, which is after a merge that changes bundle inputs. Production then deploys only after the job is approved and has built and uploaded the bundle, about 20 minutes on `ubuntu-latest` (19.4 minutes for 4d08a77, 18.5 for 9cc703c). Runs share one concurrency group, so a merge that lands while another bundle is building waits for it, and only the newest queued run is kept. If publishing takes longer than `PART_BUNDLE_WAIT_MINUTES`, the Vercel build fails and the previous deployment keeps serving. Approve the job, then redeploy in Vercel.

## Vercel

`apps/web/vercel.json` applies when the project's Root Directory is `apps/web`. `main` deploys to Production, and other branches get previews.
- **Install:** only `@brr/web` and the asset pipeline.
- **Base URL:** `vercel-build.sh` takes the bucket's public URL from `public_base_url` in `infra/cloudflare/part-bundles.json` and exports it as `VITE_BUNDLE_BASE_URL`, so the Vercel project needs no environment variable. An explicit `VITE_BUNDLE_BASE_URL` in Vercel still wins.
- **Build:** in Production, waits until the three manifests for its input key are served from that URL, then runs `vite build` with `publicDir` off. If they don't appear within `PART_BUNDLE_WAIT_MINUTES`, the build fails and the previous deployment keeps serving. `vercel-build.sh` sets it to 42 unless Vercel sets one: two back-to-back publishes (about 40 minutes) fit, with room for the install and `vite build` under Vercel's 45-minute build limit. The CLI's own default stays 20, because the pipeline source is a bundle input and changing it would change the input key. A Vercel build without `VITE_BUNDLE_BASE_URL` refuses to run.
- **Input changes:** a merge that changes bundle inputs waits for `main`'s build, about 20 minutes, or about 40 if another bundle was already building. Other merges find the key already published and don't wait.
- **Previews:** a preview (any `VERCEL_ENV` other than `production`) checks once, with `cli.ts served`, whether its input key is served, and never waits. If it is, the build proceeds as in Production. If not, the build HEADs each LOD's manifest itself, and skips only when the bucket answers 404 for at least one and 200 or 404 for all. Then the branch changes bundle inputs, and only `main` publishes bundles, so there is no preview: the build logs `Preview skipped: part bundle manifest.<key>.json is absent from …` and deploys only `preview-skipped.html`, a page that says so. Any other answer, an unreachable bucket, or a `served` result other than exactly `served=true` or `served=false` fails the build. The check uses the input key itself, so it can't drift from the bundle inputs. A branch based on a `main` commit whose bundle is still publishing is skipped too; redeploy it once `main` deploys.
- **LDraw library:** while `public_base_url` in `infra/cloudflare/ldraw-library.json` is `null`, builds read the LDraw library from GitHub raw. Once it's committed, `vercel-build.sh` exports it as `VITE_LDRAW_LIBRARY_BASE_URL`, and unless the pinned library's index is served there, Production fails and previews are skipped (`docs/ldraw-library.md`).
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
