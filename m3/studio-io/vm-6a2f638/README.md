# M3 Studio `.io` import: evidence at `6a2f638`

Code: `siraj/m3-studio-io-d935` at `6a2f638325d19f91dfd12bb59fe3be8c08291231` (PR #31), on #29 at `8949316`, which sits on #24 at `c63a540`. The bundle was built from that head: standard `dafd79fe795ee3a9`, with compiler `brick-compile.3c29395a81262607.wasm` and crosswalk `crosswalk.60cb2f987568c642.json`. `pnpm check` with the turbo cache forced off passed at this head (`pnpm-check.log`: 23 of 23 tasks, 0 cached).

#29's commit `8949316` changes only the crosswalk. 12 `bricklinkParts` entries changed, and none of them is among the 623 BrickLink ids the 14 plain files use. `runs/` and `modelv2-vs-model.txt` were re-captured at this head, and with timings stripped every `#import-result` and rejection message is identical to `../vm-9438ab7/`. `world/` and `rejected/` (the two videos and their captures) are copied from `../vm-9438ab7/`, because they don't involve the crosswalk.

Totals over the 14 plain files:

- 15,201 kept.
- 77 renamed (10 distinct parts).
- 2 ambiguous (`92338`).
- 2 custom.
- 4 with a missing sole candidate.

The not-drawn list has 24 entries (133 instances).

#24 changed its import API, and the last commit (`a2f261a`) adapts to it. The Studio reasons now key on `PartResolution.official`. The Studio flexible-section report was dropped, because #24's engine now reports Studio's generated rope section itself, as a headerless inline part (`__flexiblesubmodel_rope copy 9`, "defined inline"), and doesn't draw it.

Compared with `../vm-088e08b/`, with timings stripped, every Studio mapping, drawn count and rejection message is the same. The differences come from #24's engine: the landing pad lists the rope as an inline part (15,128 instances instead of 15,127, the same 14,324 drawn), and every report gains #24's new `looseGeometry` field (empty for these files).

## Samples

`samples.tsv` lists 25 real BrickLink Studio `.io` files from public GitHub repositories, each with its repository, commit, path, SHA-256 and licence. `fetch-samples.sh <dir>` downloads them and checks every hash. None are committed to the code branch.

## How it was run

1. Restore and build: `pnpm --filter @brr/asset-pipeline build`, then `pnpm --filter @brr/web dev --port 5173`.
2. Import every file through the real app. This drives `?scene=import` and its file input with Playwright: `cd tools/e2e && node src/import-models.ts --out <out> <dir>/*.io`. Each file gets a fresh page and is imported through the import panel's file input, then the screenshot, the scene-only screenshot and `#import-result` are captured into `runs/<name>.{png,json}` (`-scene.png` hides the panels).
3. World video: `node src/import-models.ts --out <out> --mode world --video` with five files imported one after another into one world (`world/`).
4. Rejection video: `--video` on `dr18.io` (`rejected/`).
5. `modelv2.ldr` against Studio's own `model.ldr`: `node --experimental-transform-types check-modelv2-vs-model.mts <bundle>/standard/brick-compile.<hash>.wasm <dir>` produced `modelv2-vs-model.txt`. It runs the bundle's published compiler WASM (`readStudio`) and compares the result with `unzip -p <file> model.ldr`, line by line after whitespace normalisation.

## Results

- 25 of 25 files were handled by the app with no crash.
- 11 encrypted files were rejected with "this .io file is an encrypted archive written by an older Studio; open it in a current Studio, save it again, and import the new file".
- 14 plain files were imported and placed as whole modules.
- In all 14 plain files, `modelv2.ldr` converted by `readStudio` is identical to Studio's `model.ldr`.

Across the 14 plain files, Studio's part references resolved like this:

- 15,201 instances were kept under Studio's name.
- 74 were renamed through the BrickLink crosswalk: 9 distinct parts, each with exactly one LDraw candidate that exists at the pin.
- 5 were ambiguous and 2 were Studio CustomParts.
- 4 (`7302` in `platypus.io`) had a sole crosswalk candidate that is missing at the pin.

The importer's not-drawn list, with the Studio reason added, covers 25 distinct entries and 136 instances: the 24 parts plus Studio's generated rope section, which #24's engine now lists as an inline part. Separately, 1,083 instances use Studio colour codes that have no RGB in the file and aren't in LDConfig.
