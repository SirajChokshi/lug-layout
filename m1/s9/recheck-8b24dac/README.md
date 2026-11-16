# Recheck at 8b24dac (S9 rebased onto main 4be9e89, after M4 #25 and #37 landed)

`main` moved after the full run at `06493b0`, so the branch was rebased again. The conflicts were additive wiring (sim worker and storage modules, tokens, the domain index). This recheck drives the production build of `8b24dac` on `vite preview`, using `../scripts/s9-head-recheck.mjs`, Chrome 157 on the same VM, and a fresh profile for each pass.

1. **First pass** imports `../vm-06493b0/A.brr.zip` (its `recheck.log`):
   - **Reload:** 0 of 1,440,000 pixels differ, chunk counts are equal, and 24 → 24 placements.
   - **Export:** 163,562 B, sha256 `6658263435a95107bc2d526174dd981d6afe6078f7ee39cbf93d2a6c21ab93f4`. Against A, `manifest.json` and all six shards are byte-identical. Only `CREDITS.txt` differs, because it's regenerated from this head's bundle (M4 changed the bundle versions and the credited file list).
2. **Second pass** (`second/`) imports that export into another fresh profile, which is equivalent to a wipe:
   - **Reload:** 0 pixels differ.
   - **Export:** 163,562 B, sha256 `6658263435a95107bc2d526174dd981d6afe6078f7ee39cbf93d2a6c21ab93f4`, identical to the archive it imported.
