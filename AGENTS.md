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

## Layout
```
apps/web                Vite + React; main-thread composition root
packages/
  config                shared tsconfig presets and the Vitest preset
  math schema           L0/L1 (planned)
  domain catalog render storage rpc   L2 (planned)
  sim import            L3 (planned)
  client                L4: OOP services (Inversify), no React (planned)
  ui  workers/*         L5 (planned)
  compile-wasm          generated from crates/brick-compile-wasm. Never hand-edit.
crates/                 brick-compile (lib), brick-compile-cli; -wasm (planned)
tools/oxlint-plugin     repo-specific oxlint rules (brr/no-comments)
tools/asset-pipeline    offline Node CLI: fetch and pin LDraw inputs, build the part bundle. Apps never import it.
tools/rust-comment-check  no-comments check for Rust sources
docs/                   architecture.md, verified-facts.md
```

## Commands
- `pnpm install` (Node ≥ 22.18, pnpm from `packageManager`)
- `pnpm lint` runs oxlint with the `brr` plugin, and warnings fail
- `pnpm format` / `pnpm format:check` run oxfmt (there's no ESLint or Prettier)
- `pnpm typecheck`, `pnpm test`, `pnpm build` run through Turborepo (add `--filter=@brr/<pkg>...` to scope)
- `pnpm check` runs everything CI runs
- `pnpm --filter @brr/web dev`; the render spike lives at `/bench.html` (`?parts=&api=webgpu|webgl2&strategy=instanced|batched&lod=standard|low&camera=aerial|street`, `&measure=1` for GPU-synced frame timing)
- `pnpm --filter @brr/web bench` drives `bench.html?measure=1` in Playwright's Chromium over a parts × API × strategy matrix against `vite preview` and writes JSON plus screenshots (`npx playwright-core install chromium` once; needs a display for WebGPU)
- `pnpm lint:rust` (no comments in `crates/`) and `pnpm check:rust` (fmt, clippy `-D warnings`, `cargo test`)
- `pnpm --filter @brr/asset-pipeline fetch` re-pins LDraw inputs (network); `verify` checks them offline; `build` compiles the bundle
- Later: `turbo run bench`, `turbo run wasm`, and the package-boundary check (dependency-cruiser or Turborepo `boundaries`)

Before you finish: `pnpm check` is green.

## Conventions
- TypeScript style: `.cursor/rules/typescript-style.mdc`. Tests: `.cursor/rules/testing.mdc` and `.cursor/skills/test-audit`.
- Rust: stable toolchain pinned in `rust-toolchain.toml`, `clippy -D warnings`, no comments (`pnpm lint:rust`), and `brick-compile` stays free of I/O so it builds for WASM.
- Units: integer LDU (1 LDU = 0.4 mm; stud = 20, plate = 8, brick = 24). Layout heights are in plates above the top face of the baseplate. LDraw −Y-up data converts to y-up exactly once, at the compile and import boundary.
- Facts listed in §11 as unverified must not be hard-coded from memory. Verify them with `.cursor/skills/verify-ldraw-facts` and record them in `docs/verified-facts.md`.

## Skills
- `.cursor/skills/add-package`: new `@brr/*` package in the right layer
- `.cursor/skills/add-service`: interface, token, class, module binding, optional worker proxy
- `.cursor/skills/add-part-or-profile`: city-palette part, `TrackProfile`, `ModuleProfile` or `PartSource`
- `.cursor/skills/verify-ldraw-facts`: confirm a part, license, dimension or pose from source data
- `.cursor/skills/test-audit`: gate for writing, changing or auditing tests
