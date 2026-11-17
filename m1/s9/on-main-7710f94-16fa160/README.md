# #55 on main 7710f94 (#87 sim and #97 camera), head 16fa160

This is a single commit on `main`.

**#97 replaced the editor's `OrbitCamera` with an injected `IEditorCamera`.** Resolving that took:
- dropping #55's old editor camera methods (orbit, pan, zoom, focus, centre, plan from above), which #97 moved to the camera service;
- adding `ViewCamera.savedView()` and `restore()`, and `IEditorCamera.savedView()` and `restoreView()`, so saving and reopening a world keeps its camera;
- the editor reading the camera's view once per frame and saving it 0.5 s after it changes, since camera input no longer passes through the editor;
- Go-to calling `camera.lookAt(x, z, false)`;
- #97's `setView` (with its orthographic plan camera) now calling #55's `followEye()`, with the eye-moved time, so the render origin still settles at rest.

`camera-parity.test.ts` passes `disclaimer`. The full checks pass (36 tasks; client tests ran uncached, 73 passed), as does the frozen install.

| Check | Result |
|---|---|
| Track plus a camera zoom (`track.log`, `MOVE=1`) | The zoom is saved: the exported view distance went from 2600 to 882.9. Reload restores it with 0 of 1,440,000 pixels differing. Exports are byte-identical (`1824be9f…6ead`). Wipe, then import: 0 pixels differ and the re-export is identical. |
| +10 km (`far/far.log`) | A baseplate at (25,000,000, −25,000,000) through Go-to; reload differs in 0 pixels. |
| Two sets (`sets/`, headed) | Reload differs in 0 pixels; export → import → export is byte-identical (`f7c81b6b…`, unchanged since 46eface). |
| Critic A2 (`idb-faults/`) | 0 placements lost. |
| UI (`ui/`) | Retry and refusal, two tabs (0 of 135 palette buttons enabled in the read-only tab), no storage, Import confirmation, long names and delete all behave as before. |
