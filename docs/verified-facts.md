# Verified facts

Facts about LDraw parts, licenses, dimensions, connector poses and module standards that code or data relies on. Add rows with the `verify-ldraw-facts` skill (`.cursor/skills/verify-ldraw-facts/SKILL.md`). Never add a row from memory.

## Inputs

There is one LDraw pin, the one the bundle ships: `palette.json` `source`, which is `kulits/ldraw-parts@c70360d1c588be894997b2168c61909bc8058c4d` (`ldraw/`). That mirror is a daily, unmodified unzip of the official `complete.zip`, here library update 2026-10. LDCad connectivity comes from `palette.json` `connectivitySource`, `RolandMelkert/LDCadShadowLibrary@9b1131fb1991f8c0bfc072325e4e12f6271aba35` (CC BY-SA 4.0). It's used for verification only, and is never committed or bundled.

`pnpm --filter @brr/asset-pipeline run fetch` downloads, with the one fetcher (`src/fetch-ldraw.ts`):

- the bundle closure into `packages/test-fixtures/ldraw`;
- the closure of every part in `palette.json` `audit` into `.cache/ldraw-audit`;
- the matching LDCad patches into `.cache/ldcad-shadow`.

Every file is pinned by SHA-256 in `ldraw.lock.json`: `files` for the bundle and `audit` for the rest. `run facts` re-checks those hashes and writes `docs/verified-facts/license-audit.json`; `run facts --check` reports drift instead. `library.ldraw.org`, Rebrickable and the MILS site are blocked from the verification environment.

## Facts

| Claim | Verdict | Value | Source | Script | §11 item | Date |
|---|---|---|---|---|---|---|
| Every file the bundle ships is CA and official | VERIFIED | 115 `.dat` files in the bundle closure, all `Licensed under CC BY 4.0 : see CAreadme.txt`. None is `Unofficial_*`, unlicensed or non-CA | `ldraw.lock.json` `files`, at the pin | `cli.ts facts` (`closureLicenses`) | 1 | 2026-11-16 |
| 9V track 74746, 74747, 74747c04, the plastic sub-parts 2865a and 2867a, and the "moved" stubs 2865 and 2867 are CA | VERIFIED | `CC BY 4.0`, `Part`/`Shortcut UPDATE 2025-02`. `2865.dat` is `~Moved to 74746` and `2867.dat` is `~Moved to 74747`. Every dependency is CA and official, with 0 missing | `parts/74746.dat` and others, at the pin | `cli.ts facts` (`auditPart`) | 1, 5 | 2026-11-16 |
| 9V switches 75541-f1/-f2 (right) and 75542-f1/-f2 (left) and their bodies 2859/2861 are CA | VERIFIED | `CC BY 4.0`, `UPDATE 2025-08`. 75541-f1 keywords are `BrickLink 2859c01, Rebrickable 75541`. 148/151 dependencies, all CA and official | `parts/75541-f1.dat` and others, at the pin | `cli.ts facts` | 1, 5 | 2026-11-16 |
| 9V 90° crossing 32087 is CA | VERIFIED | `CC BY 4.0`, `Part UPDATE 2020-03`, `BrickLink 32087c01`. 44 dependencies, all CA and official | `parts/32087.dat`, at the pin | `cli.ts facts` | 1, 5 | 2026-11-16 |
| Plastic `Train Track 6 Studs Wide` straight 53401 and curve 53400/53400c04 are CA | VERIFIED | `CC BY 4.0`. 53401 is `Part UPDATE 2013-02` and 53400 is `Part UPDATE 2015-02`, both by Ronald Vallenduuk. All dependencies are CA and official | `parts/53401.dat`, `parts/53400.dat`, at the pin | `cli.ts facts` | 1, 5 | 2026-11-16 |
| The RC and Powered Up train sets use 53400/53401 | INCONCLUSIVE | The headers name no train system and carry no catalog keyword. Set inventories need Rebrickable (blocked) | `parts/53400.dat`, `parts/53401.dat` | — | 5 | 2026-11-16 |
| The 6-wide plastic switches 53404/53407 and the 6-wide ramp 53834 are official parts | REFUTED | Absent from the pinned official library (`absentFromPin`), so they can't ship as `ldraw-official` | `ldraw.lock.json` `audit.absentParts` | `cli.ts fetch` | 1 | 2026-11-16 |
| A 6-wide plastic crossing exists in LDraw | INCONCLUSIVE | No file at the pin is titled as one. Its LEGO number can't be identified without Rebrickable (blocked) | title search at the pin | manual title search | 1 | 2026-11-16 |
| Modern road plates (the 2018+ 32×32 plates of set 60304) exist in LDraw | INCONCLUSIVE | No file at the pin is titled or keyworded as a road plate other than the classic `Baseplate 32 x 32 Road …` family. Part numbers need Rebrickable (blocked) | title and keyword search at the pin | manual title search | 1, 7 | 2026-11-16 |
| Classic road baseplates are CA: 6-stud 44336/44341/44342/44343, 7-stud 2358–2361, 9-stud 606–609, 8-stud 610–613, 8-stud dual 30225b | VERIFIED | All `CC BY 4.0`, except 30225b, which is `CC BY 2.0 and CC BY 4.0`. All dependencies are CA and official | `parts/44336.dat` and others, at the pin | `cli.ts facts` | 1 | 2026-11-16 |
| Baseplates 3811 (32×32), 3857 (16×32), 3867 (16×16), 4186 (48×48) and 782 (50×50) are CA | VERIFIED | All `CC BY 4.0` (3811 and 782 are `UPDATE 2025-09`) | `parts/3811.dat` and others, at the pin | `cli.ts facts` | 1 | 2026-11-16 |
| Technic bricks for module joins (3700, 3701, 3702, 3894, 32000) are CA | VERIFIED | All `CC BY 4.0`, all dependencies official | `parts/3700.dat` and others, at the pin | `cli.ts facts` | 1 | 2026-11-16 |
| Flexible track 64022/64022c01/64022c02 and halves 88492/88493 are CA | VERIFIED | All `CC BY 4.0` | `parts/64022.dat` and others, at the pin | `cli.ts facts` | 1 | 2026-11-16 |
| The LDCad shadow library is CC BY-SA 4.0 | VERIFIED | `LICENSE.md` begins "Attribution-ShareAlike 4.0 International", and all 21 fetched patch files carry `!LICENSE CC BY-SA 4.0, see LICENSE.md` | `connectivitySource` pin | `cli.ts facts` | 3 | 2026-11-16 |
| The LDCad shadow library covers track, road plates, baseplates and Technic bricks | REFUTED (partial coverage) | Track: only 53400 (`s/53400s03`, `s/53400s04`) and 32087 (`s/2865s04`) carry `group=traintrk` snaps. 53401, 74746, 74747 and all switches have none. Baseplates and road baseplates have stud primitives only (44342 has an empty patch). The Technic bricks are covered | `connectivitySource` patches over the audit closures | `cli.ts facts` (`ldcadCoverage`) | 3 | 2026-11-16 |
| Train motors: PF 88002 and PU 88011 are LDraw part numbers | REFUTED | Both are absent from the pin. The Power Functions train motor is `87574.dat` (`Electric Power Functions Train Motor`, `BrickLink 87574c01`, CC BY 4.0); no Powered Up train motor is in the official library | `parts/87574.dat`, `audit.absentParts` | `cli.ts facts` | 18 | 2026-11-16 |

## Manual reads

These aren't produced by the pipeline. They were read by hand from the named pinned artifact and can be rechecked there.

| Claim | Verdict | Value | Source | §11 item | Date |
|---|---|---|---|---|---|
| The official `complete.zip` contains only CA parts; `OfficialNonCA` is a separate download that may not be redistributed | VERIFIED | `ldraw/Readme.txt` lists `OfficialNonCA` as its own library ("MAY NOT be re-distributed"), and no `.dat` file in the archive has a non-CA `!LICENSE` or none at all | full tarball of the same pin, `codeload.github.com/kulits/ldraw-parts/tar.gz/c70360d1c588be894997b2168c61909bc8058c4d`, SHA-256 `31a407b5b251d3b6c37497d19459ea2b1c58858b7682c38ba97f4afd9a33d2d2` | 1, 2 | 2026-11-16 |
| LDraw library size and license split, update 2026-10 | VERIFIED | 37,151 `.dat` files (34,306 under `parts/`, 2,845 under `p/`): 35,140 `CC BY 4.0`, 2,011 `CC BY 2.0 and CC BY 4.0`, 0 `CCAL 2.0` | same tarball | 2 | 2026-11-16 |
| `ldr_tools` license | VERIFIED | MIT (`LICENSE`, "Copyright (c) 2023 SMG"). The `ldr_tools` crate lives in that repository and its `Cargo.toml` has no license field of its own | `ScanMountGoat/ldr_tools_blender@89281a1fc891d67deeac98404c0e1086c2dc1a2e`, file `LICENSE` | 17 | 2026-11-16 |
