# M3 Studio `.io` import: evidence at `c15aa24`

Code: `siraj/m3-studio-io-d935` at `c15aa247e34b999e6bfc42710c8be6eb0386f206` (PR #31), stacked on #29 (`0b263b9`) and #24 (`5c6fe1a`). The bundle was built from that head with `pnpm --filter @brr/asset-pipeline build`: standard `ef26624ecd20b4a0`, with compiler `brick-compile.26ff61cf0e9777a2.wasm` and crosswalk `crosswalk.c279997ce9bc9c20.json`.

Machine: the project VM, Chromium (Google Chrome) on Xvfb, WebGL2 through SwiftShader (software rasterizer), 1920×1080. Frame rates are VM numbers for correctness only, never performance.

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

- 15,205 instances were kept under Studio's name.
- 74 were renamed through the BrickLink crosswalk: 9 distinct parts, each with exactly one LDraw candidate that exists at the pin.
- 5 were ambiguous and 2 were Studio CustomParts.

The importer's not-drawn list, with the Studio reason added, covers 24 distinct parts and 135 instances. Separately, 1,083 instances use Studio colour codes that have no RGB in the file and aren't in LDConfig, and one Studio-generated flexible rope section isn't drawn.
