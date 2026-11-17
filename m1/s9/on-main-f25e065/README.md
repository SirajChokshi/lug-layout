# #55 on main 4f083af with #100's commits underneath, head f25e065

`main` 4f083af includes #79, #41 and #90. Underneath #55's commit sit #100's three commits, rebased onto `main`: 2e0ec56, a65fbe4 and e80c663, with the same patches as 95d439d, cf5d76d and 6fe9e11.

The conflicts resolved were:
- `apps/web/src/main.tsx`: #79's `bundleManifestFile` and the S9 `disclaimer`;
- `editor.ts`: #41's `ldrawColors` import and the credits imports;
- `editor.test.ts`: #41's `NO_LOOK`, also passed to the unsaved-edits harness;
- `editor-app.tsx`: #90's `useEditorKeys` and shortcuts button, plus `WorldMenu`.

The local preview still serves `/bundle/` (HTTP 200).

The full checks pass (36 tasks). The production build was served by `vite preview`, with #41's look pass on by default.

| Check | Result |
|---|---|
| Track (`track.log`) | Reload differs in 0 pixels. Exports are byte-identical, with sha256 `fbb83c9d…83fa`, the same as before the rebase. After a wipe and import: 0 pixels differ and the re-export is identical. |
| Two sets (`sets/recheck.log`, headed) | Reload differs in 0 pixels; export → import → export is byte-identical (`c9f7c5c6…42a7`). |
| UI (`ui/`) | Retry and refusal, two tabs (0 of 129 palette buttons enabled in the read-only tab), no storage, Import confirmation, long names and delete all behave as before. |
