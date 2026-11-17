# Critic review fixes for PR #55 at 9deba0b (review: store `internal/critic/pr55-ffb629e.md`)

**Setup:**
- The production build is served by `vite preview`, with headless Chrome 157, WebGL2 on SwiftShader and `lod=low`, viewport 1600×900, fresh profiles.
- `main` at `334cfe6` can't load the editor: #39's train sets have no stud lattice, and the editor throws `model 10020-1 has no stud lattice from the bake`. PR #66 is the fix (`17b32a2`). So these runs use `9deba0b` with #66 cherry-picked on top, in a scratch worktree, served on :4174. #66 isn't part of #55.

**Scripts:**
- the critic's own drivers (`pr55-ffb629e-repro/scripts`, unchanged): `idb-faults.mjs`, `roundtrip.mjs` and `origin-cost.mjs`;
- this branch's drivers: `../scripts/s9-fixes.mjs` and `../scripts/s9-head-recheck.mjs`.

| Review item | Result |
|---|---|
| 1. A failed autosave drops edits | Critic repro A2 (`idb-faults/idb-faults-abort.log`): with shard writes aborting, the panel shows "Not saved" with the error. When writes work again, the next save writes the restored shard too: "Saved · 3 placements · 2 shards", with 3 in the editor. After a reload there are 3 placements and none are lost. Before: 2 after the reload, while the panel said "Saved". |
| 2. Writes not validated; long name; no delete | `ui/name.log`: the New field holds at most 200 characters. `ui/forcedname.log`, `forced-name-refused.png`: with `maxlength` removed, a 215-character name disables New and shows "The name must be 1 to 200 characters, not all spaces." Enter creates nothing. The repository decodes the header, the shards and the next manifest before writing. `ui/delete.log`, `delete-*.png`: deleting another world removes its database; deleting the open world opens the next one, or a new "World 1". |
| 3. No IndexedDB | Critic repro B (`idb-faults/idb-faults-noidb.log`): `open()` throwing `SecurityError` and an async `UnknownError` both leave the editor ready, with all 30 catalog buttons. `ui/nostorage.log`, `nostorage-panel.png`: the panel shows "Not saved: storage unavailable" with the reason. Editing works, and Export packs a 167,281 B archive from memory. |
| 4. Two tabs | `ui/tabs.log`, `tabs-read-only.png`: tab 2 on the same world gets a read-only warning, 0 of 30 catalog buttons enabled, and Ctrl+Z is ignored. Tab 1 keeps saving. When tab 1 closes, tab 2 reloads the world with tab 1's 2 placements, then edits and saves 3. |
| 5. Duplicate types in client | `client` now imports `@brr/schema` (`SavedViewV1`, `Issue`, `issueText`, `WorldIndexEntry`, `WorldName`). Shown by code; there's no UI evidence. |
| 6. Rebase frequency | `origin-cost-316069f/` (the critic's script; rebase code unchanged since): 1, 1 and 23 rebases for 20k aerial, 20k street and 400k aerial. That's the old 8-chunk rule's counts (1, 1, 23), where the every-chunk rule had 46, 11 and 74. |
| Reload and round trip still exact | `recheck/`: importing `../vm-06493b0/A.brr.zip` reloads with 0 of 1,440,000 pixels differing (camera at rest at +10 km). A second import of its export re-exports byte-identical (175,071 B, sha256 `0d0232bd…eb1a`). Against A, the shards are identical; `bundleVersion` and `CREDITS.txt` follow this head's bundle. |
