# Part bundle delivery

The compiled part bundle lives only in the `brr-part-bundles` R2 bucket: GLBs, model JSON, the in-browser compiler (`brick-compile-wasm.wasm`) and one manifest per LOD. Nothing generated is committed, the web deploy ships only the app, and the app loads parts from the bucket's public URL. Terraform in `infra/cloudflare` manages the bucket, its CORS and its public domain (*Part bundle bucket* in its README).

Only `main` publishes. Pull requests never write or read R2. Their CI jobs build the bundle locally, and every test that loads parts reads `tools/asset-pipeline/dist/bundle` from disk (test fixture models come from `tools/asset-pipeline/fixture-bundle`; see *Test fixture bundle*).

The `bundle` command records what it built from in `dist/bundle/build-key.json`: the input key (*Keys* below) and the SHA-256 of `pnpm-lock.yaml`. When that file matches the checkout, every LOD and the fixture bundle have their manifests and no untracked file matches the bundle inputs, the command keeps the existing output instead of compiling it again. CI's first job, also named `bundle`, computes the input key with `node tools/asset-pipeline/src/input-key-cli.ts`, which needs no installed packages, and looks up `part-bundle-<input key>-<lockfile hash>` in the GitHub Actions cache without downloading it. Only when that lookup misses does the job install the pipeline's packages, compile `dist/bundle` and `fixture-bundle` and save them under that key. `verify`, every `e2e` shard and `import-bundle-models` wait for the `bundle` job and restore that exact key, so when the lookup misses, the run compiles the bundle once, in that job, and runs that don't change the bundle inputs don't compile it at all. After a compile, the `bundle` job also uploads the output as the run's `part-bundle` artifact. A waiting job downloads it only if its cache restore misses, for example because the save failed while another run on the same branch was saving that key, so those jobs never compile the bundle themselves. The held-out models job restores the same key and saves it after a fresh build of its own. GitHub scopes a cache entry by its path list as well as its key, so every workflow lists exactly these two paths in this order. A job that caches only `dist/bundle` gets an entry of its own without the fixture bundle, and the `bundle` command rebuilds on every hit. `import-bundle-models` runs `@brr/import`'s `test:bundle-models`, which imports and bakes every palette model through the WASM compiler (about 7 minutes of single-threaded bake), beside `verify` rather than inside it; `@brr/import#test` skips those cases unless `IMPORT_EVERY_BUNDLE_MODEL=1`, which only that script sets, and `pnpm check` runs the script after the turbo tests. The required `check` status comes from a job that passes only when `bundle`, `verify`, every `e2e` shard, `import-bundle-models`, `library-connectors` and `library-bake` passed. Pushes to `main` fill the cache that pull requests read. Delete `build-key.json` to force a rebuild.

## Keys

- `<lod>/<file>.<sha256 prefix>.glb|json|wasm`: content-addressed objects. Identical bytes get the same key, so a new bundle uploads only what changed. The uploader refuses any file whose name doesn't match its own SHA-256.
- `<lod>/manifest.<input key>.json`: one manifest per LOD. The input key is the first 16 hex digits of a SHA-256 over every git-tracked file that `turbo.json` lists as an input of `@brr/asset-pipeline#build`: the crates, the palette, the fixture model list, the shadow patches, the lock, the verified facts, the pipeline source except its tests, the bundle schema and its decoder (`packages/schema/src/bundle`, `packages/schema/src/decode`), `@brr/math` (`packages/math/src`), and the shared modules the pipeline runs (`packages/catalog/src/glb.ts`, `packages/catalog/src/part-bundle.ts`, `packages/domain/src/track/heading-footprints.ts`). `bundle-inputs.test.ts` runs the pipeline CLI, records every repository file it loads and fails if one of them isn't an input. It also checks every data file the bundle command reads, listed once in `BUNDLE_DATA_FILES` (`bundle-data.ts`), which `cli.ts` reads them through, every tracked file under the data directories in `BUNDLE_DATA_DIRECTORIES` (the shadow patches), and every generated model the palette or the fixture model list compiles. `node tools/asset-pipeline/src/cli.ts manifest-file` prints it in about 0.2 s, without compiling anything.

- `current/latest.json`: `{"manifestFile":"manifest.<input key>.json"}`, the newest bundle `main` published. The app reads it at startup (*Vercel* below). It's the only object ever overwritten, and its path has no `.<16 hex>.` segment, so nothing that caches content-addressed files forever (`isContentAddressedPath` in `@brr/schema/bundle-pointer`) keeps it.

Every object except the pointer is stored with `Cache-Control: public, max-age=31536000, immutable`. The pointer is stored with `public, max-age=60`.

## What a LOD holds

The manifest is the small index the editor reads first. It holds the colours, stud primitives, model entries and track catalog. It also lists the `catalogParts`: the ground, road and track parts the editor offers, each with the file of its shape. And it holds each track piece's `trackShapes`: its plan footprint at all 16 headings, the convex hull of its mesh in plan (the outline the editor's closure check uses), and its height range, all measured from its mesh. Everything else is in files the manifest names:
- `partTable`: every bundled part (id, path, GLB file, bounds, licence);
- `creditTable`: the attribution of every LDraw file the bundle uses;
- each model file is that model's record: its instances, stud cells and cover, plus the shape of every part it places;
- a part's shape (`shape-<id>.<sha>.json`) is what placement needs from it without its mesh: bounds, role, stud records, track ends and produced colours;
- `connectivity` and `connectors` are the two connector packages. Each is an index from every bundled part id to that part's record file, or null when the part has no faces of that kind. `connectivity` holds tier 1 only: faces from the LDCad Shadow Library and the project's shadow patches, under CC BY-SA 4.0, with Roland Melkert's attribution and the pinned shadow commit in the index. `connectors` holds every other tier (primitives, and the faces tier 4 infers from geometry), and each record carries its LDraw part's own CA licence. Tier 4's section vocabulary is `tools/asset-pipeline/section-vocabulary.json`: every section size and length in the whole LDCad Shadow Library, derived from the library's GitHub archive, which `ldraw.lock.json` pins by SHA-256 (catalog source `ldcad-shadow-library`, fetched and restored, never committed). `section-vocabulary --check` re-derives it from the pinned archive and fails on drift. Being derived from the shadow library, the vocabulary is CC BY-SA 4.0 and carries its own licence and attribution (Roland Melkert and the LDCad Shadow Library contributors, the shadow repository and commit, and the archive's hash). The bundle ships the committed file byte for byte as its own content-addressed asset beside the connectivity package; the manifest's `compiler.sectionVocabulary` references it by file and SHA-256 and never carries its values. `ImportContext` fetches it, refuses it if its SHA-256 differs, and hands it to the import job, which passes it to every WASM `compile` request (`connectors`), so the bundle records, the pinned-library records and import-time inference identify sizes alike. Tier 4's cavity probe is `inferred-connectors.json`, which the manifest carries as `compiler.cavityProbe`. A `compile` request infers tiers 2 and 4, with no shadow, only for the references it lists in `connectors.infer`, and returns them in this record format; the import lists none, because it compiles only pinned-library parts, whose records are precomputed. Both use one record format (`ConnectorRecordFile` in `@brr/schema/bundle`): per-face columns, with origins in sixteenths of an LDU, and the raw origin and axis of any face that isn't exact kept in `free`. A record also lists the part's connectors of that tier that have no mating face in the engine's vocabulary yet (`unreadable`: generic snaps and female cylinders closed at both ends), so they are reported rather than dropped. A male closed at both ends, such as a bar handle, is an ordinary face at its start end with both caps set. Every face has a required `piece` (Uint16): the moulding of a composite part it belongs to, numbered by `brick_compile::pieces` in the walk the bake, the WASM compiler and the library precompute share. Walking the part's own type-1 lines depth-first, a Shortcut, or a Part-type file that references Part or Shortcut files, is descended into in place and gets no number; any other Part-type reference (Part, Part Alias, Part Physical_Colour, Part Flexible_Section, `Unofficial_` allowed) takes the next number from 1, repeated references separately; subparts, primitives and unresolved references get none. A shadow or primitive connector takes the number of the numbered reference it was placed through, or 0 when there is none (the own geometry, subparts and own shadow data of the part and of every file descended into). A tier 4 face takes the lowest number among the geometry that formed it: a stud its run's wall bands, a blind cavity its walls, entrance plane and floor within the probe's reach, a through hole both ends. Connectors that merge (duplicates within a tier, and a primitive candidate held by a shadow connector, both placed through references) take the lowest piece among them; a tier 4 candidate dropped at a slot held by a shadow or primitive connector contributes nothing to that slot's piece. The published faces then hold one row per exact slot (origin in sixteenths, axis code and gender) and receptor (sections, caps, slide and group), decided across the whole part and every piece together (`published_faces` in `brick_compile::connect`): a face of a lower tier at a slot a higher tier holds is dropped, a primitive's piece joining the holder's and a tier 4 face's contributing nothing; identical faces of one tier merge into one row at the lowest of their pieces, taking the source and status of the face that ranks first: a project patch before the shadow, then verified before unverified. Different receptors at one slot all stay, and a face whose origin or axis doesn't identify is never merged. A connector with some faces held by a higher tier keeps each of its other female faces only where that receptor's end is proven open, decided from geometry (its other male faces stay): the shadow closes it when a holding face's far end lands on that face's slot with its far cap set, and the mesh closes it when tier 4's floor probe (`InferredFeatures::entrance_closure`) starts inside solid or meets its first floor on a plane that identifies to the face's own plane. A face the mesh closes, or the shadow closes where the mesh also does, is withheld as closed by geometry; one the shadow closes but the mesh proves open is withheld as a disagreement; one the mesh can't measure is withheld as not proven open. Each is reported as `FreeFaceWithheld`. Equal pieces never mate; different pieces of one instance mate in part-local coordinates. The bake, the precompute and import-time inference run the same code natively and in WASM, and give byte-identical records and geometry: nothing in `brick-compile` calls a transcendental from `std` (glibc's and wasi-libc's differ in the last bit), only `brick_compile::trig`, which is the `libm` crate on both targets and `planar_length` (`sqrt(a² + b²)`, exact operations only) for `hypot`, and tier 4 maps a primitive's arc ends through the placement directly rather than through angles, so arcs that abut in the geometry abut exactly. `clippy.toml` forbids the `std` functions. A finger hinge (`SNAP_FGR`) is four faces, a male and a female at each end of its sequence, whose sections are its fingers in order (code 5 for a male finger, 6 for a female one, the stated `radius` as size or 0 when the line has none, the finger's width as length). `ConnectorRecords` in `@brr/catalog` joins a part's two records into one table, tier 1 rows first. The catalog's bundle loader and the import worker both load it. The credits page, its downloadable text and the about page show the licence and every attribution line of the connectivity package and the section vocabulary, read from each level of detail's connectivity index and vocabulary asset. The connector package's index and every connector record carry `sectionVocabulary`, the SHA-256 of the vocabulary they were inferred with (`stampSectionVocabulary`); connectivity records carry none, because tier 1 is not inferred. Publishing refuses a stamp that differs from the manifest's, and `ConnectorRecords` refuses one that differs from the import's vocabulary: the editor's loader throws, and an import leaves that part's table null and lists it in `ImportReport.refusedConnectorRecords`, which the import report shows. The same records are precomputed for the whole pinned library: `pnpm --filter @brr/asset-pipeline library-connectors` runs `library-connectors` (`brick-compile-cli`) over every `parts/*.dat` the LDraw library publisher would publish, in one shard per core, with the full pinned shadow, the patches, the primitive table, the cavity probe and the committed vocabulary. It refuses any part outside the CA licences, stamps the connector records, content-addresses every record and both package indexes into `tools/asset-pipeline/dist/library-connectors/`, puts the licence gate over both packages, and writes `library-connectors.json`, whose SHA-256 and counts are pinned in the committed `tools/asset-pipeline/library-connectors.json`. `--check` recomputes them and fails on drift, so any change to the extraction code or its inputs must re-pin; CI's `library-connectors` job and `pnpm check` run it. They are published to the part bundle bucket under `library-connectors/`, beside the LOD prefixes: every record and both package indexes at their content-addressed paths (`library-connectors/connectivity/<stem>.<sha256 prefix>.json`, `library-connectors/connectors/…`), then the top index at `library-connectors/library-connectors.<prefix of the pinned SHA-256>.json`, so the committed pin names the one key a reader starts from. `library-connectors published|upload|served|verify-served [--all] [--wait]` checks the bucket, uploads only absent objects (refusing a `dist` whose index isn't the pinned one or a file not named by its content), and checks what the public URL serves against the content addresses. Only `.github/workflows/library-connectors.yml` on `main` uploads, in the `production` environment with the part bundle's credentials: it runs when the pin, the command or the bucket config changes and the pinned index isn't served yet, recomputes the records with `--check` first, and verifies every served record afterwards. Publishing refuses a bundle whose connectivity package carries any other tier, licence or no attribution, whose connector package carries a tier 1 face or a non-CA licence, or whose index files a record under the wrong part. It also refuses a section vocabulary asset that isn't CC BY-SA 4.0, names no attribution, comes from another shadow commit than the connectivity package or doesn't match the manifest's SHA-256, and any other published JSON document (manifest, part table, models, shapes, connector indexes and records, credits, crosswalk, GLB JSON) that carries section vocabulary entries;
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

**The bundle is built only when it's missing**, which is after a merge that changes bundle inputs. The bundle is then built and uploaded in about 20 minutes on `ubuntu-latest` (19.4 minutes for 4d08a77, 18.5 for 9cc703c), and the pointer moves right after. Runs share one concurrency group, so a merge that lands while another bundle is building waits for it, and only the newest queued run is kept.

## Vercel

`apps/web/vercel.json` applies when the project's Root Directory is `apps/web`. `main` deploys to Production, and other branches get previews.
- **Install:** only `@brr/web` and what it depends on.
- **Base URL:** `vercel-build.sh` takes the bucket's public URL from `public_base_url` in `infra/cloudflare/part-bundles.json` and exports it as `VITE_BUNDLE_BASE_URL`, so the Vercel project needs no environment variable. An explicit `VITE_BUNDLE_BASE_URL` in Vercel still wins.
- **Build:** `vercel-build.sh` exports the base URLs and runs `vite build` with `publicDir` off. It never contacts the bucket, never waits and knows nothing about the bundle. A Vercel build without `VITE_BUNDLE_BASE_URL` refuses to run.
- **Runtime:** the app reads `current/latest.json` once per page load and loads whatever manifest it names, whatever version that is. If the pointer is missing or unreadable, it tries once more, then loads its fallback manifest, `VITE_BUNDLE_MANIFEST_FILE`. If that fails too, the editor shows "The part bundle is unreachable: …" with the file that failed.
- **Fallback:** `vercel-build.sh` sets `VITE_BUNDLE_MANIFEST_FILE` from `manifest_file` in `infra/cloudflare/bundle-fallback.json`, a manifest that is published on R2, and `vite.config.ts` refuses a Vercel build without one, so a deployed build never asks for `manifest.json`. Bundles are never pruned, so the committed name stays valid; moving it to a newer published manifest is optional. Builds without it, such as local dev, fall back to `manifest.json`, which is what local dev serves. Because of the fallback, a deploy works before the `pointer` job has ever run, with no seeding and no approval.
- **Skew:** the app and the bundle deploy independently, so right after a merge that changes the bundle format the new app can read the previous bundle until `publish` and `pointer` finish (about 20 minutes), and an app older than the bundle can read the new one. Either pairing can be partly broken during that window; nothing pins them together.
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

They go to `.cache/library-bake`. The import will fetch them for pinned parts instead of compiling those parts. Parts outside the pinned library, such as MPD-embedded and Studio custom parts, keep compiling at import.

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

### At import
**Where the import finds them.** `bundle` copies the pin's index into each manifest's `compiler.libraryBake`. The pin file is a bundle input: the records have to match the compiler that ships beside them.

The import worker reads records from a base URL:
- **`VITE_LIBRARY_BAKE_BASE_URL`**, when it's set;
- otherwise **`library-bake/` beside the app** whenever the bundle is served locally. That's `pnpm --filter @brr/web dev` and `vite preview`, whose `brr-library-bake-files` plugin serves `.cache/library-bake` at `/library-bake/`. The records live outside `tools/asset-pipeline/dist`, so a local `vite build` doesn't copy their 2.5 GB into `apps/web/dist`.
- **Deployed builds have none until `VITE_LIBRARY_BAKE_BASE_URL` points at the published records** (the bucket's public URL plus `library-bake/`; `vercel-build.sh` doesn't set it), and until then they import exactly as before.

`.cache/library-bake` holds the top index under its content-addressed name too, `library-bake.<16 hex>.json`, as R2 will.

**`LibraryBakeStore`** (`@brr/import`) verifies everything it reads:
- the top index against the pinned SHA-256;
- its LDraw source, stud primitives, unofficial allowlist and Technic primitive table against the import's;
- every bucket, record and GLB against its content address.

It keeps verified files in the worker's IndexedDB (`brr-library-bake`).

**What comes from records.** For every official reference the index lists:
- **GLB:** the standard GLB, and its header, come from the GLB's `extras` instead of the compile op. That's at the standard LOD only.
- **Bake:** the bake takes the part's record. The solid is rebuilt from the record's tree order, and vehicle detection uses the record's bounds.

**What still compiles.** The bake fetches LDraw only for the stud primitives, the wheelset, bogie-pivot and coupler parts vehicle detection analyses, and parts without a record. Parts the index doesn't list (MPD-embedded and Studio custom parts, and anything unresolvable) compile as before, and so do inline comparisons. If the store can't be read, or a file fails verification, those parts compile too.

**The report.** `report.records` gives:
- the pinned parts found;
- the parts the bake actually took from records (`bakedFromRecords`, counted by the bake itself);
- files fetched and cached, and bytes read.

**Exactness and evidence.**
- **Exactness:** an import that bakes and draws pinned parts from records equals the import that compiles them: the same part resolutions, GLBs, lattice, cover, cells and vehicles (`model-import.test.ts`, `tests/record.rs`).
- **CI:** the held-out workflow builds `.cache/library-bake` with `library-bake --check`, and the harness reads it from disk. The report's import-time section says how many pinned parts used records.

### Publishing

The records publish to `brr-part-bundles` under `library-bake/`, through `src/publication/pinned-publication.ts`; `src/library-bake/publish.ts` describes them to it:
- every record (`application/octet-stream`), standard GLB (`model/gltf-binary`) and bucket (`application/json`) under its own content-addressed name;
- then the top index as `library-bake/library-bake.<first 16 hex of its pinned SHA-256>.json`.

Uploading puts the index last, so a served index always has its files behind it. The upload skips any object the bucket already has, so an unchanged library uploads nothing new.

**Keeping only the current and previous libraries.** `library-bake/latest.json` is the pointer: `{ "current": …, "previous": … }`, each naming a top index and its SHA-256. One PUT writes it, so both change together. Pointing at a new index makes the old current the previous; pointing at the current again changes nothing. After the pointer moves, `prune` deletes every object under `library-bake/` that neither the current nor the previous manifest references. A manifest references its top index, its 256 buckets, and every record and GLB its buckets list. Keeping the previous library means a site rolled back to the earlier build still finds every file. `prune` refuses, deleting nothing, if:
- the pointer, any kept manifest (current, previous or retained, below) or any bucket can't be read and verified against its pin or content address;
- the live set is empty;
- the pointer, or the set of manifests it keeps, changes while the bucket is being listed.

`prune --dry-run` lists every key and its size that it would delete. Each pointer command refuses any flag it doesn't take before doing any work, so `prune --dryrun` is an error, not a real prune.

The pointer and prune are generic, in `pinned-publication.ts` (`PointerAdapter`, `movePointer`, `verifyServedPointer`, `pruneUnreferenced`, `runPointerCommand`):
- **Adapters define the pointer.** An adapter gives the pointer's key and how to read and write it, so an existing pointer can keep its shape. The part bundle's `current/latest.json` can keep `manifestFile` and add `previous` beside it.
- **Manifests are generic.** An adapter says what a manifest references:
  - the index files it read and verified on the way;
  - every other file, each with the SHA-256 it must have. For content-addressed files that's the prefix in the name; for files an index lists by full hash, like an LDraw library commit's, it's that hash.

  `verify-pointer --all` checks every file against it.
- **Adapters can retain more manifests.** Their files are kept beyond the current and previous ones. `prune` and `verify-pointer` read and verify them the same way. The part bundle can retain its committed fallback manifest, and the LDraw library the commits the live bundle manifests name. An adapter whose retained manifests come from another publication, like the LDraw library's, must publish in the same concurrency group as that publication. `prune` refuses if the retained set changes during its listing, but only the group stops it changing between that check and the deletes.

Sharing a group across two differently triggered workflows has a catch: a newer run of one cancels a pending run of the other, and the cancelled publication doesn't run again until its next trigger. So such publications belong in one workflow that runs both, or the other workflow must be re-dispatched.
- **`library-bake`** is the first adapter. `pinnedIndexPointer` serves any publication pinned by an index's SHA-256.

`.github/workflows/library-bake.yml` runs on `main` when the pin, `src/library-bake/**`, `src/publication/**`, `src/r2.ts` or the bucket config change, and on demand:
- **`status`** asks whether the public URL already serves the pinned index, and whether `latest.json` names it as current.
- **`publish`** runs on every run. It uses the `production` environment, with the same Cloudflare token and secret handling as the part bundle's `publish`, in this order:
  1. unless the bucket already holds the pinned index, it rebuilds the records, checks them against the pin and the licence gate (`library-bake --check`), and uploads them;
  2. it checks every served file of the new manifest against its content address (`verify-served --all --wait`). It skips this only when the bucket already held the pinned index and `status` found it served and named as current by the pointer;
  3. it moves the pointer (`point`), after checking that the bucket holds the manifest and its buckets;
  4. it checks the current and previous manifests' index files through the served pointer (`verify-pointer --wait`; `--all` would also read every file);
  5. it logs what pruning would delete (`prune --dry-run`), and deletes nothing.

  Every step is idempotent, so any later run, pushed or on demand, finishes a publish that an earlier run left unfinished. `--wait` polls the public URL for the index or the pointer for up to 20 minutes, then checks the files once.

**The workflow doesn't delete yet.** It publishes and logs a prune dry run, but never runs `prune` itself. Once every bundle manifest names a records index (`compiler.libraryBake`), keeping only library-bake's own current and previous could delete the index a live bundle names, such as the committed fallback, and sites on that bundle would silently compile. Deletion is enabled together with retaining the library-bake indexes that live bundle manifests name. Until then, storage grows by at most a few library versions.

**Publishing is serialized.** The workflow has one concurrency group with `cancel-in-progress: false`, so two runs never overlap. A prune never sees another run's freshly uploaded objects before that run has pointed at them. That, with the reference set, is what makes pruning safe: there is no time-based grace period. GitHub never cancels the running run, but keeps at most one pending run per group: a newer queued run cancels an older pending one. Within this workflow that loses nothing, because the newer run does the whole sequence for its own, later pin. Setting `cancel-in-progress` to `true` would be unsafe, since it could stop a run between its upload and its pointer move, or mid-prune.

**Until deletion is enabled, every published library stays.** Each new one adds only its changed files: 1,813 objects (85.6 MB) for three LDraw syncs, and 2.58 GB only if every part changes. Once `prune` runs, the bucket holds the current and previous libraries between publishes, and briefly a third, the new upload, until `prune` deletes the oldest: about 7.75 GB for three full libraries sharing nothing, against 5.17 GB for two.

The same commands run by hand: `pnpm --filter @brr/asset-pipeline library-bake published | upload | served | verify-served [--all] [--wait] | point | current | verify-pointer [--all] [--wait] | prune [--dry-run]`. `upload` reads `.cache/library-bake`, so run `library-bake` first. Readers find the records at the bucket's public URL (`public_base_url` in `infra/cloudflare/part-bundles.json`, or `PART_BUNDLE_BASE_URL`) plus `library-bake/`.

**Once deletion is enabled, a preview built against an older library loses its records.** A preview deployment built against a pin older than the previous one, and named by no live bundle, finds its records pruned, and its imports compile those parts instead.

`src/library-bake/**` isn't a bundle input, so changes there don't change the bundle key.

## Library connector records at import
**Where the import finds them.** `bundle` copies the pinned index in `tools/asset-pipeline/library-connectors.json` into each manifest's `compiler.libraryConnectors`, in the same shape as `compiler.libraryBake`. The pin is a bundle input: the records have to match the compiler, primitive table and section vocabulary that ship beside them.

The import worker reads them from a base URL:
- **`VITE_LIBRARY_CONNECTORS_BASE_URL`**, when it's set;
- otherwise **`library-connectors/` under `VITE_BUNDLE_BASE_URL`** when the bundle is remote. That's the part bundle bucket, which `library-connectors.yml` publishes them to, so Vercel builds need no setting of their own;
- otherwise **`library-connectors/` beside the app** whenever the bundle is served locally. `tools/asset-pipeline/dist` is the dev server's public directory, and `library-connectors` also writes the top index under its content-addressed name, as R2 holds it.

A manifest without the pin reads only the bundle's connector packages. A base URL that doesn't serve the records shows as an unreadable index, part by part.

**`LibraryConnectorStore`** (`@brr/import`) verifies everything it reads, through the same `VerifiedFiles` layer as `LibraryBakeStore`:
- the top index against the pinned SHA-256;
- both package indexes and every record against their content addresses, on download and again on every cache hit.

It reads the package indexes and records with `ConnectorRecords`, the loader the bundle's own packages use. At import it refuses every part, saying why, when the index was computed from another LDraw source than the import's, or with another section vocabulary than the bundle's; the pin, as a bundle input, ties the records to the compiler and primitive table that ship beside them. It keeps verified files in the worker's IndexedDB (`brr-library-connectors`, apart from `brr-library-bake`). A failed download isn't remembered: the next lookup tries again.

**Which record a part gets.** The bundle's, whenever the bundle's packages list the part or refuse its record; otherwise the pinned library's. Parts neither lists get none: MPD-embedded and Studio custom parts, and primitives used as parts, such as `stud.dat`. The import report lists them under *Without connector records*, and lists every part whose record was refused or couldn't be read under *Connector records refused or unreadable*, with the reason.

**Held-out.** The held-out workflow runs `library-connectors --check`, and its harness reads `dist/library-connectors` from disk.

## Local development

Nothing changes locally. `pnpm --filter @brr/asset-pipeline build` writes `tools/asset-pipeline/dist/bundle`, and `vite` serves it at `/bundle/`. To use the published bundle instead:

```sh
VITE_BUNDLE_BASE_URL=<part_bundle_base_url> VITE_BUNDLE_MANIFEST_FILE=$(node tools/asset-pipeline/src/cli.ts manifest-file) pnpm --filter @brr/web dev
```
