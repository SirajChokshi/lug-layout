# M3 Studio `.io` import: evidence at `b5666ce`

Code: `siraj/m3-studio-io-d935` at `b5666ce98fb12d977111b82010562a5e526b5963` (PR #31), on #29 at `9a96c07`, squashed onto `main` at `f6db3a6` (#60, `@brr/schema`). The bundle was built from that head: standard `5f2eaececf8ec4ea`, with compiler `brick-compile.84cfdb1b97910557.wasm` and crosswalk `crosswalk.60cb2f987568c642.json`, both byte-identical to `../vm-05d57d5/`. `pnpm check` with the turbo cache forced off passed at this head (`pnpm-check.log`: 34 of 34 tasks, 0 cached).

The new commit, `b5666ce`, defines `readStudio`'s output once, as the valibot schemas `StudioArchive`, `StudioRejection` and `StudioRead` in `@brr/schema/bundle`. `BrickCompiler.readStudio` now decodes the compiler's stdout with `decode` and `decodedOrThrow`, in place of a hand-written guard. Every Studio import below went through that decoder.

With timings and the HUD's bundle hash stripped, every `#import-result` and rejection message here is identical to `../vm-05d57d5/` in all 25 files except one. In `383-knights-tournament`, which is also in the world capture, `3497.dat` (Baseplate 8 x 24) now comes from the bundle instead of being compiled from the mirror, because `main` added it to the bundle. That cuts that file's mirror fetches from 201 to 187. Every Studio mapping, drawn count, module count, stud count and triangle count is unchanged.

Totals over the 14 plain files:

- 15,201 kept.
- 77 renamed (10 distinct parts).
- 2 ambiguous (`92338`).
- 2 custom.
- 4 with a missing sole candidate.

The not-drawn list has 24 entries (133 instances).

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
- 77 were renamed through the BrickLink crosswalk: 10 distinct parts, each with exactly one LDraw candidate that exists at the pin.
- 2 were ambiguous (`92338`) and 2 were Studio CustomParts.
- 4 (`7302` in `platypus.io`) had a sole crosswalk candidate that is missing at the pin.

The importer's not-drawn list, with the Studio reason added, covers 24 distinct parts and 133 instances. Studio's generated rope section is listed separately, as an inline part that #24's engine doesn't draw. In addition, 1,083 instances use Studio colour codes that have no RGB in the file and aren't in LDConfig.
