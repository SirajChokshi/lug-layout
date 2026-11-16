# M1 S9 evidence: save, reload and export (VM, 633ca1c)

## Setup

- **App:** the production build of `633ca1c` (branch `siraj/m1-save-export-9df4`), served by `vite preview` on :4173. Bundle `standard` is `98e35309687db0a2`.
- **Browser:** Chrome 157.0.8103.50, headed on Xvfb, with a fresh persistent profile. `?state=1&api=webgl2`, viewport 1600×900.
- **Hardware:** an 8-core Intel Xeon VM with no GPU. WebGL2 runs on ANGLE/SwiftShader, about 0.5 fps on this world, so these numbers are for correctness only.
- **Driver:** `../scripts/s9-evidence.mjs`, playwright-core 1.65.1. It uses only the UI:
  - catalog buttons, R and click to place;
  - the "Go to x, z" form, and the mouse wheel over the canvas;
  - New, Export and Import in the world menu.

  The world reached the app only through those UI actions. Every saved byte came from the app's own autosave.
- **Screenshots:** pixel captures are the canvas rectangle of a page screenshot. While capturing, the overlay panels are hidden with a CSS `visibility: hidden` rule, and the mouse is moved off the canvas.

## Run (one uninterrupted invocation, `driver-stdout.log`)

1. **Build.** On a fresh profile, create the world "Two clusters" and place 24 models:
   - a 3811 baseplate plus each of the ten sets in a 5 × 2 grid at x ∈ {−2560 … 2560} and z = ±640, with rotations 0, 1, 2, 3 cycling;
   - a second cluster of 3811 + 10133-1 at (25,000,000, −25,000,000), which is +10 km, −10 km, and 3811 + 7936-1 at (25,001,280, −25,000,000).

   Building took 915 s, all at software-rendering speed. `session-16x.mp4` is the whole session sped up 16×.
2. **Reload checks**, once with the camera on the ten-set cluster and once with it on the far cluster:
   - wait for the camera save to finish, capture the canvas and the `World` dump, reload the tab, capture again;
   - see `reload-checks.json`, `reload-*-{before,after}.png`, `reload-*-state-*.json` and `reload-*.hud.txt`.
3. **Shards.** `indexeddb-dump.json` is read in the page with plain IndexedDB calls.
4. **Round trip.** Export A, then go to a static URL on the same origin (the bundle manifest, so the app isn't running) and delete every IndexedDB database (`wipe.json`). Open the app, which starts a fresh "World 1". Import A through the file input, then export B (`round-trip.json`).
5. **Credits scoping.** `../scripts/s9-credits-scope.mjs` builds and exports a separate two-set world (`two-sets.brr.zip`).
6. **Cold start.** `../scripts/s9-cold-start.mjs` reloads the profile from step 4 five times (`cold-start-webgl2.json`).
7. **DevTools.** `../scripts/s9-devtools.mjs` opens a copy of that profile with DevTools open on a same-origin static page. The Application → IndexedDB view was captured, then the databases were deleted with the same code as step 4 (`devtools-delete.json`) and the view captured again.

## Results

| Check | Result |
|---|---|
| Reload, ten-set cluster | 0 of 1,440,000 pixels differ (max delta 0); 24 = 24 placements; per-chunk counts equal; placements equal as sets |
| Reload, far cluster (+10 km, −10 km) | 0 of 1,440,000 pixels differ (max delta 0); 24 = 24; counts equal; render origin (39066, −39060) before and after |
| Export A → wipe → import → export B | A = B = 160,076 bytes, sha256 `88e2e5b8f75e8692f2dde6808914432b60ca77812fc6c57168a1c8559c6b58de` (`cmp` identical) |
| IndexedDB after the wipe | `indexedDB.databases()` before: `brr-worlds` and two `brr-world-<id>`; after: `[]` |
| Shards | 6 shards for 24 placements: `-1_-1` 4 (318 B), `-1_0` 4 (312 B), `0_-1` 6 (427 B), `0_0` 6 (419 B), `4882_-4883` 2 (219 B), `4883_-4883` 2 (218 B); manifest 622 B. The far cluster is its own two shards (its two baseplates straddle a super-chunk edge). |
| Credits scoping | `two-sets.brr.zip` `CREDITS.txt` lists only 7936-1 and 10133-1; A lists all ten placed sets; neither lists generated scenes |
| Cold start (VM, 5 reloads, median) | World open (IndexedDB read, validate, decode, build all chunks) 44 ms; first presented frame with the world 5,655 ms after navigation, dominated by SwiftShader drawing 6.3 M triangles; bundle and sets load 702 ms |

The cold-start number on the M4 Max is owed by the MacBook. Run `node s9-cold-start.mjs http://localhost:4173 <profile> <out> 5 webgpu`, and the same with `webgl2`, against `vite preview` at this commit, on a profile holding this world (import `A.brr.zip` first).

## Archive

```
$ unzip -l A.brr.zip
  Length      Date    Time    Name
---------  ---------- -----   ----
      622  1980-01-01 00:00   manifest.json
      318  1980-01-01 00:00   shards/-1_-1.json
      312  1980-01-01 00:00   shards/-1_0.json
      427  1980-01-01 00:00   shards/0_-1.json
      419  1980-01-01 00:00   shards/0_0.json
      219  1980-01-01 00:00   shards/4882_-4883.json
      218  1980-01-01 00:00   shards/4883_-4883.json
   156647  1980-01-01 00:00   CREDITS.txt
---------                     -------
   159182                     8 files
$ unzip -t A.brr.zip | tail -1
No errors detected in compressed data of A.brr.zip.
```
