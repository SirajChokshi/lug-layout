#!/usr/bin/env bash
set -uo pipefail
cd /tmp/wt18
[ "$(pwd)" = /tmp/wt18 ] || exit 1
reset() {
  git checkout -q -- .
  git clean -qfd packages apps tools
}
cruise() {
  npx depcruise --config .dependency-cruiser.json packages apps tools/asset-pipeline/src 2>&1 | grep -E '^\s+error|^\s+warn|violation|cruised'
  echo "  exit=${PIPESTATUS[0]}"
}
mkpkg() {
  mkdir -p "packages/$1/src"
  printf '{ "name": "@brr/%s", "private": true, "type": "module", "exports": { ".": "./src/index.ts" }%s }\n' "$1" "${2:-}" > "packages/$1/package.json"
}
link() {
  pnpm install --prefer-offline > /dev/null 2>&1 || echo "  (pnpm install failed)"
}

echo "== P1 the original four violations"
reset
printf 'export { SCENE_BACKEND } from "@brr/render";\n' >> apps/web/src/main.tsx
printf 'export { World } from "@brr/domain";\n' >> packages/render/src/index.ts
printf 'export { Container } from "inversify";\n' >> packages/math/src/index.ts
printf 'export { STUD_LDU as S } from "@brr/math";\n' >> packages/client/src/index.ts
cruise

echo "== P2 client: import type from sim (allowed by the table)"
reset
mkpkg sim
printf 'export interface SimState { readonly tick: number }\n' > packages/sim/src/index.ts
printf 'import type { SimState } from "../../sim/src/index.ts";\nexport type ClientSim = SimState;\n' > packages/client/src/sim-probe.ts
cruise

echo "== P2b client: import type from @brr/sim through the workspace specifier (allowed)"
reset
mkpkg sim
printf 'export interface SimState { readonly tick: number }\n' > packages/sim/src/index.ts
node -e 'const f="packages/client/package.json";const j=require("./"+f);j.dependencies["@brr/sim"]="workspace:*";require("fs").writeFileSync(f,JSON.stringify(j,null,2))'
link
printf 'import type { SimState } from "@brr/sim";\nexport type ClientSim = SimState;\n' > packages/client/src/sim-probe.ts
cruise

echo "== P3 client: value import from sim (forbidden)"
reset
mkpkg sim
printf 'export const SIM = 1;\n' > packages/sim/src/index.ts
printf 'import { SIM } from "../../sim/src/index.ts";\nexport const CLIENT_SIM = SIM;\n' > packages/client/src/sim-probe.ts
cruise

echo "== P4 ui imports inversify and three, dependencies unlinked (forbidden)"
reset
mkpkg ui
printf 'import { Container } from "inversify";\nimport { Vector3 } from "three";\nexport const probe = [Container, Vector3];\n' > packages/ui/src/index.ts
cruise

echo "== P4b ui imports inversify and three with both declared and linked (forbidden)"
reset
mkpkg ui ', "dependencies": { "inversify": "8.3.0", "three": "0.187.0" }'
link
printf 'import { Container } from "inversify";\nimport { Vector3 } from "three";\nexport const probe = [Container, Vector3];\n' > packages/ui/src/index.ts
cruise

echo "== P4c ui imports client and react (allowed)"
reset
mkpkg ui ', "dependencies": { "@brr/client": "workspace:*", "react": "19.3.1" }'
link
printf 'import { useState } from "react";\nimport type { SceneSummary } from "@brr/client";\nexport type UiSummary = SceneSummary;\nexport const hook = useState;\n' > packages/ui/src/index.ts
cruise

echo "== P5 render: dynamic import and relative path into domain"
reset
printf 'export const lazyDomain = () => import("../../domain/src/index.ts");\n' > packages/render/src/domain-probe.ts
cruise

echo "== P6 catalog imports domain (forbidden)"
reset
printf 'export { World as CatalogWorld } from "../../domain/src/index.ts";\n' > packages/catalog/src/domain-probe.ts
cruise

echo "== P7 domain imports a node builtin (pure package)"
reset
printf 'import { readFileSync } from "node:fs";\nexport const r = readFileSync;\n' > packages/domain/src/fs-probe.ts
cruise

echo "== P8 tools/asset-pipeline imports render (forbidden)"
reset
printf 'export { SCENE_BACKEND } from "../../../packages/render/src/index.ts";\n' > tools/asset-pipeline/src/render-probe.ts
cruise

echo "== P9 client imports three (forbidden)"
reset
node -e 'const f="packages/client/package.json";const j=require("./"+f);j.dependencies["three"]="0.187.0";require("fs").writeFileSync(f,JSON.stringify(j,null,2))'
link
printf 'import { Vector3 } from "three";\nexport const v = Vector3;\n' > packages/client/src/three-probe.ts
cruise

echo "== P10 domain imports inversify, declared and linked (forbidden)"
reset
node -e 'const f="packages/domain/package.json";const j=require("./"+f);j.dependencies["inversify"]="8.3.0";require("fs").writeFileSync(f,JSON.stringify(j,null,2))'
link
printf 'export { Container } from "inversify";\n' >> packages/domain/src/index.ts
cruise

echo "== P11 tools/asset-pipeline imports an npm module (forbidden)"
reset
printf 'import { describe } from "vitest";\nexport const d = describe;\n' > tools/asset-pipeline/src/npm-probe.ts
cruise

echo "== P12 client imports math (allowed after the §14.2 amendment)"
reset
printf 'export { chunkOf } from "@brr/math";\n' >> packages/client/src/index.ts
cruise

echo "== P13 apps/web imports math (forbidden)"
reset
node -e 'const f="apps/web/package.json";const j=require("./"+f);j.dependencies["@brr/math"]="workspace:*";require("fs").writeFileSync(f,JSON.stringify(j,null,2))'
link
printf 'export { chunkOf } from "@brr/math";\n' >> apps/web/src/main.tsx
cruise

reset
link
git status --short
