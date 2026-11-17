# M3 parts list export: evidence at 1cc157f

- **Code:** `siraj/m3-bom-export-fdde` at `1cc157f3ed2945984d17f9440d8ee633ff110836` (PR #29, based on #24 at `47f5257`).
- **Local patch for the editor phase only:** `local-editor-filter.diff`. main's editor throws on the stud-less train sets (10020-1, 10013-1, 10016-1); #66 fixes that. The patch skips models with no lattice from the editor catalog. It is not in #29.
- **Bundle:** `ced130d84c0ef419` (standard), built by `pnpm --filter @brr/asset-pipeline build` at that commit. `inputs.lockSha256` equals the committed lock, and the crosswalk file is `crosswalk.60cb2f987568c642.json`.
- **App:** the production build, served by `vite preview` on port 4173.
- **Browser:** Google Chrome 157.0.8103.50, headed on Xvfb (`DISPLAY=:1`), WebGL2 on SwiftShader.
- **Hardware:** an 8-core cloud VM with no GPU. Only counts and files are claimed; no timing is claimed.

## Files

| Path | What it is |
|---|---|
| `exports/model/<set>.{rebrickable.csv,bricklink.xml,parts.csv}` | Downloaded from the Parts list panel at `?model=<set>` |
| `exports/editor/editor-world.*`, `exports/editor/selection-omr_10264-1.*` | From the editor at `/`: 10264-1 and 7936-1 placed through the catalog and canvas, 10264-1 selected, then World and Selection exported. `exports/editor-state.json` is the editor's own world dump |
| `exports/import/imported-world.*` | The ten OMR `.mpd` files imported into one world at `?scene=import` (#24), World scope |
| `exports/import/imported-world.region_*` | The same world, Region scope: a 20×20 LDU box around each module's origin |
| `exports/*.png`, `exports/panels-all.json` | Screenshots and the panel text for every export |
| `demo/` | Files from the recorded demo: `?model=10218-1` with its Not counted list, the editor (World, then Selection of 10264-1), and `?scene=city&parts=2000` World and a one-chunk Region with the world dump (`city-result.json`) |
| `media/m3-parts-list-1cc157f.mp4` | The demo recording, 4 min 35 s, real time |
| `reports/bom-check-model.{md,json}` | `node tools/asset-pipeline/src/cli.ts bom-check exports/model --out …` against the pinned Rebrickable inventories |
| `reports/recount.json` | `scripts/independent_bom.py`: an independent recount from the bundle's model files and crosswalk, compared with the app's exports |
| `reports/check-exports.json` | `scripts/check_exports.py`: ids exist in Rebrickable's tables, the import world equals the sum of the per-set exports, each region equals its set's export, and the editor's World and Selection equal the placed sets' exports |
| `reports/city-check.json` | `scripts/city_check.py`: the city World and Region exports against the app's dumped `World`, by part and colour |
| `reports/crosswalk-rules-audit.json` | `scripts/audit_rules.py`: R1, N5 and N6 checked against the crosswalk and the keywords of every `parts/*.dat` in the pinned LDraw archive |
| `reports/modular-scenario-unmapped.json` | `scripts/scenario_unmapped.py`: #36's modular-buildings scenario (10185-1, 10218-1, 10264-1), its Rebrickable-unmapped lines under the crosswalks of a6e32e6, 1eb97e4 and this commit, with the reason for each line |
| `scripts/derive_crosswalk_at.ts` | Derives a commit's crosswalk from its own lock, run from that commit's checkout. a6e32e6 and 1eb97e4 still need `elements.csv.gz`, refetched at its pinned sha `e20caa54…` |

## Commands

```
pnpm --filter @brr/asset-pipeline build
pnpm --filter @brr/web exec vite build && pnpm --filter @brr/web exec vite preview --port 4173
cd tools/e2e && DISPLAY=:1 node src/export-parts-lists.ts --out exports --base http://localhost:4173/ <the ten .cache/omr/*.mpd>
cd tools/asset-pipeline && node src/cli.ts bom-check exports/model --out reports/bom-check-model.json
python3 scripts/independent_bom.py tools/asset-pipeline/dist/bundle/standard exports/model
python3 scripts/check_exports.py exports .cache/catalog 7936-1,10264-1,10185-1,10190-1,10218-1,2150-1,4554-1,4555-1,10128-1,10133-1
python3 scripts/city_check.py tools/asset-pipeline/dist/bundle/standard demo
python3 scripts/audit_rules.py tools/asset-pipeline/dist/bundle/standard .cache/catalog/ldraw-library/ldraw-parts.tar.gz
python3 scripts/scenario_unmapped.py tools/asset-pipeline/dist/bundle/standard .cache/catalog/ldraw-library/ldraw-parts.tar.gz 10185-1,10218-1,10264-1 crosswalk-a6e32e6.json crosswalk-1eb97e4.json crosswalk-1cc157f.json
```
