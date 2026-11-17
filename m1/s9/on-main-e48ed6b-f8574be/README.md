# #55 on main e48ed6b (#109, #146, #88), head f8574be

This is a single commit on `main`.

The conflicts resolved were:
- #146's module imports and `setSnapModules`, plus the module data attributes beside the S9 ones;
- #88's `TrackGapView` import;
- `editor.test.ts`, which now uses #146's `HeadlessBackend.aim(x, z)` and `RAY_HEIGHT_LDU`; #55's duplicate fields and constant are dropped.

**One behaviour fix comes from #88.** Its open-end arrows were only refreshed after a drag, so a reopened or imported world drew its track without them, and the reload differed in 6,560 pixels; `before-track-ends-fix/` shows the arrows missing after the reload. `install()` now calls `showTrackEnds(null)`.

The full checks pass (36 tasks; client tests 77 of 77), as does the frozen install.

| Check | Result |
|---|---|
| Track plus a camera zoom (`track.log`) | Reload differs in 0 pixels, with the arrows restored. Exports are byte-identical (`62102ef2…df57`). Wipe, then import: 0 pixels differ and the re-export is identical. |
| +10 km (`far/`) | Reload differs in 0 pixels. |
| Two sets (`sets/`) | Reload differs in 0 pixels; export → import → export is byte-identical (`8b1481c6…cea2`). |
| Critic A2 | 0 placements lost. |
| UI | Retry and refusal, two tabs (0 of 135 palette buttons enabled in the read-only tab), no storage, Import confirmation, long names and delete all behave as before. |
