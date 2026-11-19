# AGENTS.md — Brick Railroad (`lug-layout`)

A browser sandbox for LEGO city and train layouts. Users place whole imported models (LDraw `.ldr`/`.mpd`, plain-ZIP Studio `.io`), official track, road plates, baseplates and MILS modules. Joins are exact, trains run, and plan regions give a real-table BOM and a "Buildable as planned" check. The project is non-commercial.

The source of truth is `docs/architecture.md`. Section numbers like "§14" refer to it. If code and plan disagree, stop and ask; don't silently pick one.

## Non-negotiables
1. **No code comments at all.** That includes JSDoc, `@ts-expect-error`, `oxlint-disable`, triple-slash directives and JSX comments. The `brr/no-comments` lint rule enforces this and fails CI. Make code self-explanatory with names, types and small functions. Put rationale in commit messages, PR descriptions or `docs/`. See `.cursor/rules/no-comments.mdc`.
2. **Real parts, exact joins.** No approximations, no hand-typed geometry, no snapping tolerance. See `.cursor/rules/real-parts.mdc`.
3. **License-clean.** No `OfficialNonCA` parts, no Studio library, never the legacy `.io` password. See `.cursor/rules/ldraw-licensing.mdc`.
4. **Layered packages.** Dependencies only point down. See `.cursor/rules/package-boundaries.mdc`.
5. **Inversify with explicit symbol tokens**, used only in `client`, `workers/*`, `apps/web` and the L2 adapters `storage`, `render`, `catalog`, `rpc`. See `.cursor/rules/dependency-injection.mdc`.
6. **Hot paths use typed arrays.** Per-part, per-stud, per-instance and per-car data never become JS objects, and frames and ticks allocate nothing. See `.cursor/rules/hot-path-data.mdc`.
7. **Whole models only.** We never do brick-level editing. Imported models are immutable.
8. **Official LEGO track only, for now.** Third-party track must stay addable through `PartSource` plus `TrackProfile`, with no core changes.
9. **Merge only with evidence in the PR:** screenshots, video, or measured performance or correctness numbers. Tests you wrote never count. Never push to `main`; the owner merges. When fixing forward, don't add overly specific tests. See `.cursor/rules/merge-evidence.mdc`.
10. **Real-world compatibility.** Connections come from real part geometry (studs, anti-studs, pins, holes, axles, clips, bars), never from knowing the set, category, prefab or model. Any user-made Studio or LDraw file (a custom MILS module, modular, track container or anything else) must connect to everything else exactly as the physical bricks would. No per-set or per-category special cases and no hand-tuned offsets. Tests and evidence must include custom inputs, not only curated official sets. If geometry data is missing, fix the pipeline instead of adding a rule. Reviewers request changes on violations. See `.cursor/rules/real-world-compatibility.mdc`.

## Layout
```
apps/web                Vite + React; main-thread composition root
apps/catalog-api        Cloudflare Worker: catalog search over D1, release files in R2. Imports no @brr/* package.
packages/
  config                shared tsconfig presets and the Vitest preset
  math                  L0: units, Rot90, lattice check, chunk key
  schema                L1: valibot schemas for every wire and file format; types inferred, subpath exports
  domain                L2: World, a sparse map of struct-of-arrays chunks
  catalog render        L2 adapters
  storage rpc           L2 (planned)
  sim import            L3 (planned)
  client                L4: OOP services (Inversify), no React
  ui  workers/*         L5 (planned)
  compile-wasm          generated from crates/brick-compile-wasm. Never hand-edit.
crates/                 brick-compile (lib), brick-compile-cli; -wasm (planned)
tools/oxlint-plugin     repo-specific oxlint rules (brr/no-comments)
tools/asset-pipeline    offline Node CLI: fetch and pin LDraw inputs, build the part bundle. Apps never import it.
tools/rust-comment-check  no-comments check for Rust sources
infra/cloudflare        Terraform for the catalog Worker, D1 and R2 (README has plan/apply and token scopes)
docs/                   architecture.md, verified-facts.md
```

## Commands
- `pnpm install` (Node ≥ 22.18, pnpm from `packageManager`)
- `pnpm lint` runs oxlint with the `brr` plugin, and warnings fail
- `pnpm format` / `pnpm format:check` run oxfmt (there's no ESLint or Prettier)
- `pnpm typecheck`, `pnpm test`, `pnpm build` run through Turborepo (add `--filter=@brr/<pkg>...` to scope)
- `pnpm check` runs everything CI runs
- `pnpm e2e` builds `apps/web` and runs the Playwright layout scenarios in `tools/e2e/tests` against `vite preview`, in installed Google Chrome on WebGL2 (SwiftShader without a GPU; set `CHROME` to use another binary), at device pixel ratio 0.5 so software rendering draws a quarter of the pixels; CI splits them across three shards. They drive the editor only through the UI: cursor positions come from the HUD's lattice readout, and poses are read from `?state=1`. CI and `pnpm check` run them
- `pnpm --filter @brr/e2e measure-startup --app <dist>` measures editor startup: the bundle requests, bytes and time to `ready`, and when bundle traffic settles (`--settle-ms` quiet), cold and warm, on loopback, `desktop` (10 Mbit/s, 40 ms) and `slow4g` (`--profiles`). It serves `tools/asset-pipeline/dist/bundle` like R2 (HTTP/2, immutable, gzip JSON only; `--compress`) at `https://127.0.0.1:4443/`, so build `<dist>` with `VITE_BUNDLE_BASE_URL=https://127.0.0.1:4443/ VITE_BUNDLE_MANIFEST_FILE=manifest.json`. It trusts its throwaway certificate in a throwaway NSS database under a temporary `HOME` it launches Chrome with, and deletes both afterwards, so Chrome caches responses without touching your own `~/.pki`. It needs `certutil` (`libnss3-tools`) and stops without it, because uncached warm runs would be wrong; `--serve` only serves
- `pnpm --filter @brr/client bench:layout-memory` measures layout memory through the real editor in Node: each run is a fresh process that starts `IEditor` on `ThreeSceneBackend` without a renderer, meshes every item first (the baseline), then places baseplates, OMR sets, road plates and track at three scales (`LAYOUT_SCALES=small,medium,large`, about 14k, 38k and 123k parts). It reports V8 heap and ArrayBuffer growth per part, medians of 3 runs that must hand the backend identical render input, plus the first run's baseline and layout heap snapshots per scale, split by owner, and the three.js `Object3D` counts. Node has no pointer compression, so its JS object sizes run larger than Chrome's. `LAYOUT_WORLDS_DIR` also exports each layout as a `.brr.zip`, and `LAYOUT_MEMORY_REPORT` writes the table to a file
- `pnpm --filter @brr/e2e measure-layout --app <dist> --worlds <dir> --out <dir>` imports each `.brr.zip` in `<dir>` into the built editor through the world menu at the far tier, presses Fit all, then forces the far, near and mid tiers in turn with the L key. At each tier it waits until every chunk is at that tier, no network request has been in flight for `--settle-ms` and draw calls and triangles stop changing, and records that HUD reading (draw calls, triangles, chunk tiers and studs) and Chrome's heap and ArrayBuffer backing after forced GC (one run per world and tier), plus a canvas screenshot
- `pnpm --filter @brr/web dev`
- `pnpm lint:rust` (no comments in `crates/`) and `pnpm check:rust` (fmt, clippy `-D warnings`, `cargo test`)
- `pnpm --filter @brr/asset-pipeline fetch-ldraw` re-pins LDraw inputs (network; plain `fetch` would run pnpm's built-in). `restore-ldraw` downloads exactly the pinned files into the git-ignored `.cache/` (network once, then a no-op), `verify-ldraw` checks them offline, and `build` restores, verifies and compiles the bundle that `apps/web` serves at `/bundle/` in local dev, plus the test fixture bundle (`tools/asset-pipeline/fixture-bundle`, models from `fixture-models.json`) that only tests open, through `fixtureModel(name)`. `build` skips the compile while `dist/bundle/build-key.json` still matches the bundle inputs and `pnpm-lock.yaml`, and CI restores that output from the Actions cache; delete the file to force a rebuild. Deployed apps load it from R2 instead: CI uploads it when its inputs change, and the Vercel build ships no bundle (`docs/part-bundle.md`). LDraw `.dat` files and generated GLBs are never committed. `pnpm check` restores them first; the Rust integration test reads `.cache/ldraw`, so run `restore-ldraw` before a bare `cargo test`
- `pnpm --filter @brr/asset-pipeline ldraw-library check|published|upload|served|verify-served [--all]` checks, publishes and verifies the pinned LDraw library in the `brr-ldraw-library` R2 bucket. The import worker's `LdrawMirror` reads it in deployed apps through `VITE_LDRAW_LIBRARY_BASE_URL` once `infra/cloudflare/ldraw-library.json` has a `public_base_url`; until then, and in local dev, it reads GitHub raw (`docs/ldraw-library.md`). Only `.github/workflows/ldraw-library.yml` on `main` uploads
- `pnpm --filter @brr/asset-pipeline ldraw-library shadow-patches [--check]` extracts the pinned LDraw archive and measures the project shadow patches in `tools/asset-pipeline/shadow-patches` (CC BY-SA 4.0 project additions in LDCad's SNAP format, read after the pinned shadow library): it rewrites the patch files and the measured half of `manifest.json` from LDraw geometry, and `--check` fails when either has drifted. Every entry stays `unverified` until `verify-ldraw-facts` records it
- `pnpm --filter @brr/asset-pipeline library-connectors [--check]` precomputes connector records (with `piece` and the vocabulary's hash) for every pinned library part into `tools/asset-pipeline/dist/library-connectors/` and pins the index's SHA-256 in `library-connectors.json`; `--check` fails on drift (CI and `pnpm check` run it). The bundle manifest pins that index as `compiler.libraryConnectors`, and the import worker fetches a part's records from it when the bundle's own packages don't list the part (`docs/part-bundle.md`, *Library connector records at import*). `library-connectors published|upload|served|verify-served [--all] [--wait]` publishes them under `library-connectors/` in the part bundle bucket; only `.github/workflows/library-connectors.yml` on `main` uploads
- `pnpm --filter @brr/asset-pipeline section-vocabulary [--check]` derives tier 4's section vocabulary (`section-vocabulary.json`, CC BY-SA 4.0 with its attribution) from the pinned LDCad Shadow Library archive; `--check` fails on drift (CI and `pnpm check` run it). The bundle ships it as its own asset that the manifest references by SHA-256, and publishing refuses vocabulary values anywhere else
- `pnpm --filter @brr/asset-pipeline library-bake [--check]` compiles every pinned library part's lossless bake record and standard GLB into `.cache/library-bake` and writes (or checks) the pin `tools/asset-pipeline/library-bake.json`. `pnpm --filter @brr/e2e library-bake-parity` compiles every part again through the shipped WASM compiler and fails on any byte that differs. `pnpm library-bake:check` runs both, as do CI and `pnpm check`. `library-bake published|upload|served|verify-served [--all] [--wait]` publishes the records to the part bundle bucket under `library-bake/` and verifies them, and `point|current|verify-pointer [--all] [--wait]|prune [--dry-run]` moves the `latest.json` pointer and deletes what neither its current nor its previous manifest references; only `.github/workflows/library-bake.yml` on `main` uploads, and it runs `prune` only as `--dry-run` until deletion is enabled. Deployed imports read the published records only once `VITE_LIBRARY_BAKE_BASE_URL` points at them (`docs/part-bundle.md`, *Precompiled bake records*)
- `pnpm --filter @brr/asset-pipeline colors <dir>` re-derives the palette's `producedColors` (every colour a baseplate or road plate is offered in) from the S13 Rebrickable export in `<dir>` (hash-checked; the Project store keeps a copy under `internal/sources/rebrickable`). `--check` reports drift
- `pnpm --filter @brr/asset-pipeline facts` regenerates the verified-facts reports in `docs/verified-facts/` (`license-audit.json`, `geometry.json`, `track-catalog.json`, `track-loops.json`, the scenes) from the pinned inputs. Commit them with any change to `ldraw.lock.json`, `palette.json` or the code that derives them. `--check` fails on any drift; CI and `pnpm check` run it
- The app's viewer takes `?api=webgpu|webgl2&lod=standard|low`, and `&measure=1` for GPU-synced frame timing
- `pnpm lint:boundaries` runs dependency-cruiser (`.dependency-cruiser.json`) against the §14.2 layer table; CI and `pnpm check` run it
- `pnpm check:infra` runs `terraform fmt -check`, `init -backend=false` and `validate` on `infra/cloudflare` (needs Terraform ≥ 1.10); CI and `pnpm check` run it
- `pnpm --filter @brr/catalog-api dev`, `load-release` and `measure` run the catalog Worker locally, load a release into D1 and R2, and measure it (see `apps/catalog-api/README.md`)
- Later: `turbo run bench`, `turbo run wasm`

Before you finish: `pnpm check` is green.

## Conventions
- TypeScript style: `.cursor/rules/typescript-style.mdc`. Tests: `.cursor/rules/testing.mdc` and `.cursor/skills/test-audit`.
- Rust: stable toolchain pinned in `rust-toolchain.toml`, `clippy -D warnings`, no comments (`pnpm lint:rust`), and `brick-compile` stays free of I/O so it builds for WASM.
- Units: integer LDU (1 LDU = 0.4 mm; stud = 20, plate = 8, brick = 24). Layout heights are in plates above the top face of the baseplate. LDraw −Y-up data converts to y-up exactly once, at the compile and import boundary.
- Facts listed in §11 as unverified must not be hard-coded from memory. Verify them with `.cursor/skills/verify-ldraw-facts` and record them in `docs/verified-facts.md`.
- Editor overlays are fixed children of `.editor`, positioned from the layout tokens on `.editor` in `apps/web/src/app.css`; below 1340 px the editor switches to its compact layout (`use-compact-layout.ts`). `tools/e2e/tests/overlay-layout.spec.ts` fails if two overlays overlap, one leaves the screen or spills out of its box, or one catches another's clicks, at 1024×768, 1280×800 and 1440×900 in every mode.

## Skills
- `.cursor/skills/add-package`: new `@brr/*` package in the right layer
- `.cursor/skills/add-service`: interface, token, class, module binding, optional worker proxy
- `.cursor/skills/add-part-or-profile`: city-palette part, `TrackProfile`, `ModuleProfile` or `PartSource`
- `.cursor/skills/verify-ldraw-facts`: confirm a part, license, dimension or pose from source data
- `.cursor/skills/test-audit`: gate for writing, changing or auditing tests
