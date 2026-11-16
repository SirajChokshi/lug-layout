---
name: verify-ldraw-facts
description: Confirm an LDraw/LDCad/Rebrickable fact (part license, part number, dimension, connector pose, gauge, switch geometry, module spec) from pinned source data and record it with provenance. Use before hard-coding or relying on any §11 item or any part fact recalled from memory.
---

# Verify an LDraw fact

Memory, forum posts and older research notes are leads, not evidence.

1. **State the claim** so it can be shown false, for example "53401's `!LICENSE` is CC BY 4.0" or "the 2861 diverging end is at (x, z, heading) = …". Note its §11 item number if it has one.
2. **Use the pinned source.** That's the `complete.zip` or `ldrawunf.zip` version in the pipeline lock (or download from library.ldraw.org and record the version and hash), the LDCad shadow library, the Rebrickable dumps, or the standard's own published document (MILS and so on). If the network blocks it, report the claim as **inconclusive**. Don't fill in from memory.
3. **Read it from the file.**
   - License, type and author: the header lines `0 !LICENSE`, `0 !LDRAW_ORG`, `0 Author:`. `Part` vs `Unofficial_Part` matters, and so does CA vs `OfficialNonCA` (check the library's NonCA list).
   - Geometry: compose the type-1 sub-file matrices exactly. LDraw is −Y up, 1 LDU = 0.4 mm, stud = 20, plate = 8, brick = 24.
   - Connectors: the LDCad `!LDCAD SNAP_*` metas in the shadow file. Cross-check them against the geometry.
   - Aliases and moves: follow `~Moved to` and alias files to the canonical part.
4. **Prefer a script.** Compute the value with a small script in `tools/asset-pipeline/verify/` so it can be rerun. For track, run the result through the ℤ[ζ_N] field test.
5. **Record it** in `docs/verified-facts.md`: claim, verdict (VERIFIED, REFUTED or INCONCLUSIVE), value, source file plus library version plus hash, script path and date. Remove the `unverified` flag on the matching data, and update the architecture plan's §11 when an item is cleared.
6. **Lock it in.** Add a test that reads the fixture or pipeline output and asserts the value, so a library update that changes it fails CI.
