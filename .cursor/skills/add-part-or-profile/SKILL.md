---
name: add-part-or-profile
description: Add a city-palette part (track, road plate, baseplate, module join), a TrackProfile, a ModuleProfile, or a PartSource, entirely from source data with license and field checks. Use when extending the catalog, track systems, module standards, or (later) third-party packs.
---

# Add a part, profile or part source

Geometry and connectors always come from data. If you find yourself typing a pose or a dimension, stop.

## City-palette part
1. **Check the license first.** Use the `verify-ldraw-facts` skill to confirm the part's `!LICENSE` is CA. If it's `OfficialNonCA`, stop and report back; it can't ship.
2. **Add the id** to the curated palette list in `tools/asset-pipeline` using a namespaced id (`ldraw:<num>`) and a `cityRole`. Don't touch app code.
3. **Get the connectors** from the LDCad shadow `SNAP_*` data, plus inference from primitives. A part with no data source is a blocker to report, not something to hand-author.
4. **Track parts:** the pipeline's field-membership test must pass, meaning every `trackEnd` pose is in ℤ[ζ_N] for the profile's N. Out-of-field parts need an exact algebraic pose and get the ε = 1e-6 treatment, and the reason is documented.
5. Map the part to Rebrickable and BrickLink ids, and set `bomFlags` (`power9V`, `powerPlastic`).
6. **Tests:** a golden part record in `test-fixtures`. For track, also a join test with an existing piece, plus a negative test where it doesn't join.

## TrackProfile or ModuleProfile
1. Add it to `domain` profiles as data, typed by `schema`. A track profile needs system, gauge class, N (16 or 32), minimum radius, parallel spacing, clearance envelope and flags. A module profile needs size, surface height in plates, edge slots, track centre, sidewalk, lanes, ballast and a substructure recipe.
2. Every number cites its source (spec document or LDraw file and version). Unverified values are set `unverified: true`, so their rules emit "unverified" warnings.
3. Bump `schema` and add a migration if the stored shape changes.
4. Write rule tests for the profile in sandbox mode (warnings) and plan mode (errors).

## PartSource (for example, a future `thirdparty-<vendor>`)
1. Add an adapter in `tools/asset-pipeline` that declares id, `provenance`, a license per item, redistribution rights and priority.
2. Use the vendor namespace for ids (`bt:...`). `thirdParty` stays gated by `allowThirdParty` and flagged in the BOM.
3. Core code must not change. If it seems to need a change, the extension point is wrong, so raise it instead of special-casing.
4. Don't ship vendor geometry without written license clearance.
