# Part bundle delivery

The compiled part bundle lives only in the `brr-part-bundles` R2 bucket: GLBs, model JSON, the in-browser compiler (`brick-compile-wasm.wasm`) and one manifest per LOD. Nothing generated is committed, the web deploy ships only the app, and the app loads parts from the bucket's public URL. Terraform in `infra/cloudflare` manages the bucket, its CORS and its public domain (*Part bundle bucket* in its README).

Only `main` publishes. Pull requests never write or read R2. Their CI jobs build the bundle locally, and every test that loads parts reads `tools/asset-pipeline/dist/bundle` from disk (test fixture models come from `tools/asset-pipeline/fixture-bundle`; see *Test fixture bundle*).

`bundle` records what it built from in `dist/bundle/build-key.json`: the input key (*Keys* below) and the SHA-256 of `pnpm-lock.yaml`. When that file matches the checkout, every LOD and the fixture bundle have their manifests and no untracked file matches the bundle inputs, `bundle` keeps the existing output instead of compiling it again. CI's `verify` job, every `e2e` shard, `import-bundle-models` and the held-out models job restore `dist/bundle` and `fixture-bundle` from the GitHub Actions cache under `part-bundle-<input key>-<lockfile hash>`, and `verify` and the held-out job save it there after a fresh build, so runs that don't change the bundle inputs skip the compile. GitHub scopes a cache entry by its path list as well as its key, so every workflow lists exactly these two paths in this order. A job that caches only `dist/bundle` gets an entry of its own without the fixture bundle, and `bundle` rebuilds on every hit. `import-bundle-models` runs `@brr/import`'s `test:bundle-models`, which imports and bakes every palette model through the WASM compiler (about 7 minutes of single-threaded bake), beside `verify` rather than inside it; `@brr/import#test` skips those cases unless `IMPORT_EVERY_BUNDLE_MODEL=1`, which only that script sets, and `pnpm check` runs the script after the turbo tests. The required `check` status comes from a job that passes only when `verify`, every `e2e` shard and `import-bundle-models` passed. Pushes to `main` fill the cache that pull requests read. Delete `build-key.json` to force a rebuild.

## Keys

- `<lod>/<file>.<sha256 prefix>.glb|json|wasm`: content-addressed objects. Identical bytes get the same key, so a new bundle uploads only what changed. The uploader refuses any file whose name doesn't match its own SHA-256.
- `<lod>/manifest.<input key>.json`: one manifest per LOD. The input key is the first 16 hex digits of a SHA-256 over every git-tracked file that `turbo.json` lists as an input of `@brr/asset-pipeline#build`: the crates, the palette, the fixture model list, the lock, the verified facts, the pipeline source except its tests, the bundle schema and its decoder (`packages/schema/src/bundle`, `packages/schema/src/decode`), `@brr/math` (`packages/math/src`), and the shared modules the pipeline runs (`packages/catalog/src/glb.ts`, `packages/catalog/src/part-bundle.ts`, `packages/domain/src/track/heading-footprints.ts`). `bundle-inputs.test.ts` runs the pipeline CLI, records every repository file it loads and fails if one of them isn't an input. It also checks every data file the bundle command reads, listed once in `BUNDLE_DATA_FILES` (`bundle-data.ts`), which `cli.ts` reads them through, and every generated model the palette or the fixture model list compiles. `node tools/asset-pipeline/src/cli.ts manifest-file` prints it in about 0.2 s, without compiling anything.

- `current/latest.json`: `{"manifestFile":"manifest.<input key>.json"}`, the newest bundle `main` published. The app reads it at startup (*Vercel* below). It's the only object ever overwritten, and its path has no `.<16 hex>.` segment, so nothing that caches content-addressed files forever (`isContentAddressedPath` in `@brr/schema/bundle-pointer`) keeps it.

Every object except the pointer is stored with `Cache-Control: public, max-age=31536000, immutable`. The pointer is stored with `public, max-age=60`.

## What a LOD holds

The manifest is the small index the editor reads first. It holds the colours, stud primitives, model entries and track catalog. It also lists the `catalogParts`: the ground, road and track parts the editor offers, each with the file of its shape. And it holds each track piece's `trackShapes`: its plan footprint at all 16 headings, the convex hull of its mesh in plan (the outline the editor's closure check uses), and its height range, all measured from its mesh. Everything else is in files the manifest names:
- `partTable`: every bundled part (id, path, GLB file, bounds, licence);
- `creditTable`: the attribution of every LDraw file the bundle uses;
- each model file is that model's record: its instances, stud cells and cover, plus the shape of every part it places;
- a part's shape (`shape-<id>.<sha>.json`) is what placement needs from it without its mesh: bounds, role, stud records, track ends and produced colours;
- `thumbnails` (standard LOD only) maps each palette item to its picture, `thumb/<item>.<sha>.png`: every ground and road part in each produced colour, and every model with a stud lattice. The pipeline renders them from the GLBs it has just compiled with a deterministic CPU rasterizer (`tools/asset-pipeline/src/thumbnails/`): 112×112 RGBA, a fixed three-quarter view of the item's box, LDConfig colours, key, fill and ambient light, translucent colours blended last, an edge outline and 3× supersampling. The same inputs give the same bytes, so the files content-address like everything else.

GLBs are only ever needed to draw.

## Test fixture bundle

Models that only tests load are listed in `tools/asset-pipeline/fixture-models.json`, not in `palette.json`. `bundle` bakes them, at the standard LOD only, with the same compiler, palette parts and post-processing as the shipped bundle, into `tools/asset-pipeline/fixture-bundle/standard`. The fixture bundle sits outside `dist/`, so `apps/web` never serves it (its local `publicDir` is `dist/`), `upload` never sees it, and no shipped manifest, palette, catalog search, credit or thumbnail names its models. CI caches it beside `dist/bundle` under the same key, and `bundle` rebuilds when it's missing. Client tests open it with `fixtureModel(name)` from `packages/client/src/edit/fixture-model.test-support.ts`. The verification scenes `cli.ts facts` writes to `docs/verified-facts/scenes/` are baked only when a test needs one (today `road-baseplates`, `baseplate-row` and `road-plates`).

## CI

`.github/workflows/part-bundle.yml` runs three jobs on every push to `main`, and on *Actions → Part bundle → Run workflow*.

**`status`** has no environment and no secrets. It HEADs the three manifests for the commit's input key at the bucket's public URL: the repository variable `PART_BUNDLE_BASE_URL` if it's set, otherwise `public_base_url` in `infra/cloudflare/part-bundles.json`. It also reads `current/latest.json` there. If all three manifests are served and the pointer already names them, the workflow ends there. That covers every commit that doesn't touch the bundle inputs, and nobody is asked to approve anything. If the variable is unset, a manifest is missing, or the URL can't be reached, it falls through to `publish`.

**`publish`** runs in the `production` environment that #62's catalog deploy also uses. That environment has no protection rules, so the job runs on its own after a merge:
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

## Precompiled bake records for the pinned library

`pnpm --filter @brr/asset-pipeline library-bake` compiles every part of the pinned LDraw library (`kulits/ldraw-parts` at the commit `ldraw.lock.json` pins, every `parts/*.dat`) once, natively. Each part gets two files:
- a **bake record**, which is everything the import-time bake reads from a compiled part;
- its **standard GLB**, the same bytes the import compiler's `compile` op returns.

They go to `tools/asset-pipeline/dist/library-bake`. The import will fetch them for pinned parts instead of compiling those parts. Parts outside the pinned library, such as MPD-embedded and Studio custom parts, keep compiling at import.

**Compile options.** The records use the palette's `studPrimitives` and `unofficialAllowlist` and the Technic primitive table `primitive-connectors.json`, the same options the bundle manifest gives the import compiler. The index records all three, so a reader with other options can tell the records don't apply.

**Failures.** A part that doesn't compile, or whose geometry bounds can't be read, is listed under `failed` with the compiler's own message and gets no record or GLB. Bounds fail only the way the part's geometry does: an unresolved reference, or malformed geometry with its findings. They are never defaulted.

**Run time:** 24,985 parts in about 25 s on 8 cores. 24,983 produce records; 2 (`93606dyf`, `93606dyg`) reference a file the pinned library doesn't have and are listed as failed.

### Record format

Every record is little-endian, versioned by its magic `BRRBAKE1`, and lossless. `BakeRecord` in `crates/brick-compile/src/record.rs` encodes and decodes it, refusing a truncated, padded or inconsistent record. The fields, in order:

| Field | Encoding |
|---|---|
| Magic | `BRRBAKE1`, 8 bytes |
| Counts | vertices V, colour groups G and stud references S, each u32 |
| Whole-geometry bounds | min then max, 6 × f64 |
| Positions | 3V × f32, the compiled mesh's positions bit for bit |
| Group headers | G × (colour u32, index count u32) |
| Indices | every group's indices in group order; u16 when V ≤ 65,536, otherwise u32 |
| Stud references | S × (colour u32, primitive name as u16 length plus UTF-8, matrix as 12 × f64) |
| Tree order | T = indices / 3 entries; u16 when T ≤ 65,536, otherwise u32 |

**Whole-geometry bounds** are the part's bounds with stud geometry included, in f64 from the LDraw points. Vehicle detection measures every drawn part's contact graph from exactly these (`vehicle::part_bounds`). Zeros are stored as +0.0. `f64::min` and `f64::max` leave the sign of a zero result unspecified, and native and WASM code generation pick differently: the parity gate found 1,202 parts whose bounds differed only by that sign.

**Tree order** is the permutation `TriangleTree::build` produces for the part's triangles, taken in group order. `PartSolid::from_record` rebuilds the identical tree from it, without sorting, through `TriangleTree::from_order`:
- **Speed:** 105 ms instead of 1,160 ms over the distinct parts of 89 inputs.
- **Size cost:** 19% of the library's compressed record bytes, and 181 KB extra for 10185-1.
- **Builder invariants** that `BRRBAKE1` depends on:
  - leaves hold at most 4 triangles (`LEAF_TRIANGLES`);
  - a branch splits along the widest axis of its bounds;
  - the lower child takes the first half (`len / 2`) of its triangles, stably sorted by the sum of their corners on that axis.
- **Changing any invariant** changes the records: bump the magic and rebuild the pin.
- **Verification:** `library-bake` decodes every record it writes and refuses to finish unless the solid rebuilt from it equals `PartSolid::from_mesh` of the compiled part, bit for bit.

Normals, hard edges and file headers aren't recorded, because the bake doesn't read them. Attribution comes from the standard GLB's `extras`, as it does for parts compiled at import.

### Index and pin

The index is two levels, so a reader fetches only what its parts need:
- **`library-bake.json`** (about 4 KB compressed) holds the LDraw source, the compile options, the CA licences in use, the failed parts with their errors, and the content-addressed names of 256 bucket files.
- **Each bucket** (about 3 KB compressed) maps the part ids whose FNV-1a hash of the id's UTF-16 code units falls in it (`libraryBakeBucket` in `@brr/schema/bundle`) to their content-addressed record and GLB files.

`tools/asset-pipeline/library-bake.json` is committed and pins the index's SHA-256 together with the counts of parts, records, failures and licence refusals. Before anything is written, each part's source licences must all be CA. A refused part fails the command and is never shipped.

### Drift and parity

`library-bake --check` recomputes everything and fails when the result differs from the pin.

`pnpm --filter @brr/e2e library-bake-parity` then compiles every part, through `@brr/import`'s `BrickCompiler` on the shipped `brick_compile_wasm.wasm`, using the `compile` op with `records: true`. It compares every record, every standard GLB and every failure byte for byte with the native output, and fails on any difference. That takes about 50 s on 8 workers.

`pnpm library-bake:check` runs both, as does CI's `library-bake` job; the required `check` status needs it.

The `compile` op returns records only at the standard LOD, and refuses `records` at any other.

### Publishing

The records publish to `brr-part-bundles` under `library-bake/`, through `src/publication/pinned-publication.ts`; `src/library-bake/publish.ts` describes them to it:
- every record (`application/octet-stream`), standard GLB (`model/gltf-binary`) and bucket (`application/json`) under its own content-addressed name;
- then the top index as `library-bake/library-bake.<first 16 hex of its pinned SHA-256>.json`.

Uploading puts the index last, so a served index always has its files behind it. The upload skips any object the bucket already has, so an unchanged library uploads nothing new.

**Keeping only the current and previous libraries.** `library-bake/latest.json` is the pointer: `{ "current": …, "previous": … }`, each naming a top index and its SHA-256. One PUT writes it, so both change together. Pointing at a new index makes the old current the previous; pointing at the current again changes nothing. After the pointer moves, `prune` deletes every object under `library-bake/` that neither the current nor the previous manifest references. A manifest references its top index, its 256 buckets, and every record and GLB its buckets list. Keeping the previous library means a site rolled back to the earlier build still finds every file. `prune` refuses, deleting nothing, if:
- the pointer, either manifest or any bucket can't be read and verified against its pin or content address;
- the live set is empty;
- the pointer changes while the bucket is being listed.

`prune --dry-run` lists every key and its size that it would delete. Each pointer command refuses any flag it doesn't take before doing any work, so `prune --dryrun` is an error, not a real prune.

The pointer and prune are generic, in `pinned-publication.ts` (`PointerAdapter`, `movePointer`, `verifyServedPointer`, `pruneUnreferenced`, `runPointerCommand`):
- **Adapters define the pointer.** An adapter gives the pointer's key and how to read and write it, so an existing pointer can keep its shape. The part bundle's `current/latest.json` can keep `manifestFile` and add `previous` beside it.
- **Manifests are generic.** An adapter says what a manifest references:
  - the index files it read and verified on the way;
  - every other file, each with the SHA-256 it must have. For content-addressed files that's the prefix in the name; for files an index lists by full hash, like an LDraw library commit's, it's that hash.

  `verify-pointer --all` checks every file against it.
- **Adapters can retain more manifests.** Their files are kept beyond the current and previous ones. `prune` and `verify-pointer` read and verify them the same way. The part bundle can retain its committed fallback manifest, and the LDraw library the commits the live bundle manifests name.
- **`library-bake`** is the first adapter. `pinnedIndexPointer` serves any publication pinned by an index's SHA-256.

`.github/workflows/library-bake.yml` runs on `main` when the pin, `src/library-bake/**`, `src/publication/**`, `src/r2.ts` or the bucket config change, and on demand:
- **`status`** asks whether the public URL already serves the pinned index, and whether `latest.json` names it as current.
- **`publish`** runs on every run. It uses the `production` environment, with the same Cloudflare token and secret handling as the part bundle's `publish`, in this order:
  1. unless the bucket already holds the pinned index, it rebuilds the records, checks them against the pin and the licence gate (`library-bake --check`), and uploads them;
  2. it checks every served file of the new manifest against its content address (`verify-served --all --wait`). It skips this only when the bucket already held the pinned index and `status` found it served and named as current by the pointer;
  3. it moves the pointer (`point`), after checking that the bucket holds the manifest and its buckets;
  4. it checks the current and previous manifests' index files through the served pointer (`verify-pointer --wait`; `--all` would also read every file);
  5. it lists what pruning would delete (`prune --dry-run`);
  6. it prunes (`prune`).

  Every step is idempotent, so any later run, pushed or on demand, finishes a publish or prune that an earlier run left unfinished. `--wait` polls the public URL for the index or the pointer for up to 20 minutes, then checks the files once.

**Publishing is serialized.** The workflow has one concurrency group with `cancel-in-progress: false`, so two runs never overlap. A prune never sees another run's freshly uploaded objects before that run has pointed at them. That, with the reference set, is what makes pruning safe: there is no time-based grace period. GitHub never cancels the running run, but keeps at most one pending run per group: a newer queued run cancels an older pending one. That loses nothing, because the newer run does the whole sequence for its own, later pin. Setting `cancel-in-progress` to `true` would be unsafe, since it could stop a run between its upload and its pointer move, or mid-prune.

**Between publishes the bucket holds the current and previous libraries.** During a publish it briefly holds a third, the new upload, until `prune` deletes the oldest. If a run stops before its prune, the third stays until the next run.

The same commands run by hand: `pnpm --filter @brr/asset-pipeline library-bake published | upload | served | verify-served [--all] [--wait] | point | current | verify-pointer [--all] [--wait] | prune [--dry-run]`. `upload` reads `dist/library-bake`, so run `library-bake` first. Readers find the records at the bucket's public URL (`public_base_url` in `infra/cloudflare/part-bundles.json`, or `PART_BUNDLE_BASE_URL`) plus `library-bake/`.

**A preview built against an older library loses its records.** A preview deployment built against a pin older than the previous one finds its records pruned, and its imports compile those parts instead.

`src/library-bake/**` isn't a bundle input, so changes there don't change the bundle key.

## Local development

Nothing changes locally. `pnpm --filter @brr/asset-pipeline build` writes `tools/asset-pipeline/dist/bundle`, and `vite` serves it at `/bundle/`. To use the published bundle instead:

```sh
VITE_BUNDLE_BASE_URL=<part_bundle_base_url> VITE_BUNDLE_MANIFEST_FILE=$(node tools/asset-pipeline/src/cli.ts manifest-file) pnpm --filter @brr/web dev
```
