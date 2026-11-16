---
name: add-package
description: Add a new @brr/* workspace package in the correct layer with tsconfig preset, dependency edges and turbo scripts. Use when creating a package under packages/, packages/workers/ or tools/.
---

# Add a package

1. **Pick the layer.** Read `.cursor/rules/package-boundaries.mdc`. If the package doesn't fit the layer table, stop and ask the owner. The table is part of the architecture, not a suggestion.
2. **Scaffold** `packages/<name>/` (or `packages/workers/<name>-worker/`, or `tools/<name>/`):
   - `package.json`: `"name": "@brr/<name>"`, `"type": "module"`, `"private": true`, `exports` pointing at `./src/index.ts` (source-first). Add only the scripts it needs: `typecheck` (`tsc -p tsconfig.json`), `test` (`vitest run`), `build`. Lint and format run once at the root, so don't add per-package lint scripts.
   - `tsconfig.json` extending `@brr/config/tsconfig.lib.json` (pure or Node) or `@brr/config/tsconfig.react.json` (DOM or React), with `include: ["src"]`. When the first worker lands, add a `tsconfig.worker.json` preset to `@brr/config`.
   - With tests: `vitest.config.ts` containing `export default nodePreset;`, imported from `@brr/config/vitest-preset`.
   - `src/index.ts` as the public surface. Add `src/tokens.ts` and `src/<name>.module.ts` only in packages allowed to use Inversify.
3. **Declare the deps:** `workspace:*` in `package.json`, pinned exact external versions, and the boundary config once one exists. Run `pnpm install`.
4. **Pure packages** (math, schema, domain, sim) use `tsconfig.lib.json` (no DOM, `types: []`) and have no `inversify` dependency.
5. **Workers:** `src/entry.ts` builds the worker's own `Container` from modules and exposes its engine through `@brr/rpc`. `apps/web` loads it with `new Worker(new URL("@brr/<name>-worker/entry", import.meta.url), { type: "module" })`.
6. **Tests:** no placeholder or smoke tests just to make `test` non-empty. Follow `.cursor/skills/test-audit`. A package without real tests omits the `test` script.
7. **Verify:** `pnpm check` is green.
