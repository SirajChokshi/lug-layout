# Verified facts

Facts about LDraw parts, licenses, dimensions, connector poses and module standards that code or data relies on. Add rows with the `verify-ldraw-facts` skill (`.cursor/skills/verify-ldraw-facts/SKILL.md`). Never add a row from memory.

| Claim | Verdict | Value | Source (file, library version, hash) | Script | §11 item | Date |
|---|---|---|---|---|---|---|
| `!LICENSE` of 3811, 3001, 3003, 3004, 3009, 3010, 3020, 3022, 3024, 3062b, 3068b, `stud.dat`, `stud2.dat` and every sub-file and primitive they reference (46 files) is CA | VERIFIED | `Redistributable under CCAL version 2.0 : see CAreadme.txt` on all 46 files | GitHub mirror `gkjohnson/ldraw-parts-library` @ `1f24cac1821b9a86a5a84cd3a40291aad24679b3` (`complete/ldraw`; LDConfig dated 2022-03-31, so older than the current library). SHA-256 per file in `tools/asset-pipeline/ldraw.lock.json`. library.ldraw.org is blocked from the build VM, so the mirror was used. | `tools/asset-pipeline/src/cli.ts fetch`; `brick-compile` license gate fails the build on any non-CA or missing header | 1 (partial: these parts are not the city palette) | 2026-11-16 |
| `LDConfig.ldr` carries no `!LICENSE` line | VERIFIED | no `!LICENSE` header; used only for colour values, attributed to LDraw.org in the bundle credits | same mirror and lock | `packages/test-fixtures/ATTRIBUTION.md` (generated) | — | 2026-11-16 |
