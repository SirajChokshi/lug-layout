# Second critic review fixes for PR #55 at 819433d (review: store `internal/critic/pr55-9deba0b.md`)

**Setup:**
- The production build is served by `vite preview`, with headless Chrome 157, WebGL2 on SwiftShader and `lod=low`, viewport 1600×900, fresh profiles.
- `main` at `334cfe6` still needs #66 to load the editor, so these runs use `819433d` with #66 (`17b32a2`, `c6e730b`) cherry-picked on top, served on :4174. #66 isn't part of #55.
- **Drivers:** the critic's own `s9-review.mjs` and `idb-faults.mjs`, unchanged, plus `../scripts/s9-fixes.mjs` (sections `retry` and `memoryimport`) and `../scripts/s9-head-recheck.mjs`.

| Review item | Result |
|---|---|
| Blocker: a switch after a failed save drops edits | Critic S1 (`critic-s9-review/`): step 3, New "Other" while World 1 shows Not saved, is refused with `new world refused: "World 1" has unsaved edits (saving failed: The transaction was aborted, …). Retry the save, or export the world first.` The world and its 2 placements stay. The critic's step 4 then times out, because World 1 is still the current world, so its row button reads "Current" rather than "Open". |
| Retry, beforeunload | `ui/retry.log`, `ui/retry-refused.png`: closing the tab with `runBeforeUnload` raises a `beforeunload` dialog, and dismissing it keeps the tab. Retry with writes working gives "Saved · 2 placements". New "Other" then works, and reopening World 1 shows 2 placements. |
| Test | `packages/client/src/edit/editor-unsaved.test.ts` drives the editor through the real modules with a repository whose saves fail. It checks that New, Import and Open are refused and keep the edits, and that Retry then saves both placements and lets Open through. It fails without the fix (3 of 3) and passes with it. |
| Writer deletes while a read-only tab waits | Critic T2 (`critic-s9-review/`): tab 2's reopen fails with "world list: no longer has this world". It falls back to the latest world (tab 1's new "World 1", which tab 1 holds, so tab 2 is correctly read-only again) and says why. Databases afterwards: `brr-worlds` plus tab 1's new world only. The deleted one isn't recreated. |
| No-storage Import | `ui/memoryimport.log`: with a placed baseplate, Import asks "Storage is unavailable, so importing replaces "World 1" and its 1 placement…". Dismissing it keeps the world. Critic X1: a no-storage export, imported with storage and re-exported, is byte-identical (167,857 B). |
| readZip reservation | Inflated chunks are collected as they arrive and joined at the end. Nothing is reserved from the declared size. |
| Still exact | `recheck/`: importing `../vm-06493b0/A.brr.zip` reloads with 0 of 1,440,000 pixels differing. The re-export is 175,071 B with sha256 `0d0232bd…eb1a`, identical to the `9deba0b` export, and a second import re-exports byte-identical. `idb-faults/`: critic repro A2 still loses 0 placements. |
