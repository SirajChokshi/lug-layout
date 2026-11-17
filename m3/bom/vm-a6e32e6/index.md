# M3 parts list export: evidence at a6e32e6

- **Code:** `siraj/m3-bom-export-fdde` at `a6e32e62b99483d7f8f07dc9db73077ded5d43d0` (PR #29, based on #24 at `c63a540`).
- **Bundle:** `23f00958bf078021` (standard), built by `pnpm --filter @brr/asset-pipeline build` at that commit. `inputs.lockSha256` equals the committed lock, and the crosswalk file is `crosswalk.c279997ce9bc9c20.json`.
- **App:** the production build, served by `vite preview` on port 4173.
- **Browser:** Google Chrome 157.0.8103.50, headed on Xvfb (`DISPLAY=:1`), WebGL2 on SwiftShader.
- **Hardware:** an 8-core cloud VM with no GPU. Only counts and files are claimed; no timing is claimed.

## Files

| Path | What it is |
|---|---|
| `exports/model/<set>.{rebrickable.csv,bricklink.xml,parts.csv}` | Downloaded from the Parts list panel at `?model=<set>` |
| `exports/editor/editor-world.*`, `exports/editor/selection-omr_10264-1.*` | From the editor at `/`: 10264-1 and 7936-1 placed through the catalog and canvas, 10264-1 selected, then World and Selection exported. `exports/editor-state.json` is the editor's own world dump |
| `exports/import/imported-world.*` | The ten OMR `.mpd` files imported into one world at `?scene=import` (#24), World scope |
| `exports/import/imported-world.region_*` | The same world, Region scope: a 20×20 LDU box around each module's origin (`exports/placements.json`) |
| `exports/*.png`, `exports/panels-all.json` | Screenshots and the panel text for every export |
| `demo/` | Files from the screen-recorded demo. It covers the editor (World, then Selection of 10264-1) and `?scene=city&parts=2000`: World, then one chunk as a Region, with the world dump (`city-result.json`) |
| `bom-check-model.{md,json}` | `node tools/asset-pipeline/src/cli.ts bom-check exports/model --out …` against the pinned Rebrickable inventories |
| `before.json`, `after.json` | `scripts/independent_bom.py`: an independent recount from the bundle's model files and a crosswalk. "Before" uses the crosswalk built at 29f174f; "after" uses this commit's, and compares against the app's exports |
| `check-exports.json` | `scripts/check_exports.py`. It checks:<ul><li>every exported id exists in Rebrickable's tables or its BrickLink column;</li><li>the import world equals the sum of the per-set exports;</li><li>each region equals its set's export;</li><li>the editor's world equals the sum of its placed sets, and its selection equals the selected set's export.</li></ul> |
| `city-region-check.json` | The city World and Region exports against the placements dumped from the running app's `World` |
| `scripts/demo.ts` | The Playwright script behind the recorded demo. The batch run is `tools/e2e/src/export-parts-lists.ts` in the PR |

## Commands

```
pnpm --filter @brr/asset-pipeline build
pnpm --filter @brr/web exec vite build && pnpm --filter @brr/web exec vite preview --port 4173
cd tools/e2e && DISPLAY=:1 node src/export-parts-lists.ts --out exports --base http://localhost:4173/ <the ten .cache/omr/*.mpd>
cd tools/asset-pipeline && node src/cli.ts bom-check exports/model --out bom-check-model.json
python3 scripts/independent_bom.py tools/asset-pipeline/dist/bundle/standard exports/model
python3 scripts/check_exports.py exports .cache/catalog 7936-1,10264-1,10185-1,10190-1,10218-1,2150-1,4554-1,4555-1,10128-1,10133-1
```
