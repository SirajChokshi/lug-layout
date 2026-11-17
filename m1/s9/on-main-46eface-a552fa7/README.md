# #55 on main 46eface (#100 merged), head a552fa7

This is a single commit on `main`; #100's three commits were dropped because #100 squash-merged as 46eface. `main`'s `packages/schema/src/world` is byte-identical to what #55 carried.

The conflicts resolved were with #53 (S6 occupancy and culling), #98, #108 and #145:
- **`placed-chunks.ts`:** `addAll` uses #53's `rebuildKeys()`. `clear()` also empties #53's footprint, column and stud maps and the occupancy grid. `rebuildChunk` keeps #55's value order, with #53's covers and closers.
- **`editor.ts`:** the `BRICK_LDU` and `CHUNK_LDU` imports are kept. #53's resting-height rotate keeps the read-only guard, and `historyView()` is used in #53's update. After a world loads, the stud totals refresh once.
- **The rest:** the index exports and #108's MILS test sit beside the unsaved-edits tests.

The full checks pass (36 tasks), as does the frozen install. The local preview serves `/bundle/` (HTTP 200).

| Check | Result |
|---|---|
| Track | Reload and wipe-then-import both differ in 0 pixels. Exports are byte-identical, with sha256 `4cf55f9e…b6b1`. Against the pre-rebase export, only `manifest.json`'s `bundleVersion` and the bundle-wide `CREDITS.txt` changed, because #108 rebuilt the bundle; the shards are byte-identical. |
| Two sets (headed) | Reload differs in 0 pixels; export → import → export is byte-identical (`f7c81b6b…5ebd`). |
| UI | Retry and refusal, two tabs (0 of 135 palette buttons enabled in the read-only tab), no storage (export 174,257 B), Import confirmation, long names and delete all behave as before. |
