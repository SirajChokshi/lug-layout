# Recheck at ffb629e: world schema v1 on valibot (`@brr/schema/world`), rebased on main 66680f4

The production build of `ffb629e` on `vite preview`, Chrome 157 on the same VM, with a fresh profile for each pass. Scripts: `../scripts/s9-head-recheck.mjs` and `../scripts/s9-import-error.mjs`.

1. **First pass** imports `../vm-06493b0/A.brr.zip`, which was written by the hand-written validators before the valibot conversion:
   - **Reload:** 0 of 1,440,000 pixels differ, chunk counts are equal, and 24 → 24 placements.
   - **Export:** 163,562 B, sha256 `6658263435a95107bc2d526174dd981d6afe6078f7ee39cbf93d2a6c21ab93f4`. That's byte-identical to the export at `8b24dac`, before the conversion, so moving the validators to valibot changed no saved byte.
2. **Second pass** imports that export into another fresh profile:
   - **Reload:** 0 pixels differ.
   - **Export:** identical to the archive it imported.
3. **Rejection** (`tampered-deflate.brr.zip`, `tampered-deflate-ui.png`). The archive was re-zipped by Info-ZIP with deflate (`zip -X -9`), with a `shards/` directory entry. One placement was moved off the lattice (x = 25,000,010) and an unknown key `colour` was added. The import was refused, nothing was stored, and the World panel shows the valibot issues mapped through `decode`:

   `import failed: shards/0_0.json.placements.5.colour: is not part of this format; shards/4882_-4883.json.placements.0.x: must be a multiple of 20 LDU`
