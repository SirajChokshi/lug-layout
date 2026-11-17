# #55 rebased on main f6db3a6 (#60 and #24, #45, #54, #62, #77, #81), head cc9913b

The production build is served by `vite preview`, with headless Chrome 157, WebGL2 on SwiftShader and `lod=low`, viewport 1600×900, fresh profiles.

**What the rebase changed:**
- **Catalog ids:** #81 makes them `part@colour` (for example `ldraw:3811@2`). World schema v1's ref pattern now allows an optional `@<colour code>`. The pre-rebase `ldraw:3811` refs in older dev archives, such as `vm-06493b0/A.brr.zip`, are no longer catalog ids, so importing them is refused rather than substituted.
- **Read-only palette:** the read-only disable now also covers #81's palette panel.
- **Track drawing:** a world switch resets #45's track drawing. Drawn track isn't saved yet (see the PR).

| Check | Result |
|---|---|
| Round trip | `two-sets.brr.zip`, built through the UI → `recheck/`: reload differs in 0 of 1,440,000 pixels. The export is 175,091 B with sha256 `92bb0d9c…6657`, byte-identical to the imported archive, and the same on a second pass. |
| Coloured baseplate refs saved and reopened | `ui/retry.log`: baseplates `ldraw:3811@2` save. A failed save refuses New; Retry then saves "2 placements"; World 1 reopens with 2. A `beforeunload` dialog appears while edits are unsaved. |
| Two tabs | `ui/tabs.log`: tab 2 is read-only with 0 of 129 palette buttons enabled. It takes over when tab 1 closes and saves 3 placements. |
| No storage | `ui/nostorage.log`, `ui/memoryimport.log`: the editor works, export packs 173,770 B from memory, and Import asks before replacing the world. |
| Critic A2 | `idb-faults/`: 0 placements lost. |
| Long name, delete | `ui/forcedname.log`, `ui/delete.log`: as before. |
