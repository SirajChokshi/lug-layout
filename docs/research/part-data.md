# Part data, catalogs, buildability and mesh pipeline

Research for a web sandbox where people build LEGO cities (rail, roads, baseplates, MILS modules) out of real, buildable sets, parts and builds, rendered efficiently in a LEGO style without the logo.

Facts I checked on the web are stated plainly. Things I couldn't confirm are marked **(verify)**.

## TL;DR recommendations

1. **Use the LDraw parts library as the only source of geometry.** Ship only the redistributable "CA" parts (licensed CC BY 2.0 / CC BY 4.0) and leave out the `OfficialNonCA` set. Bake the parts offline into instanced glTF. Attribution is generated automatically from the part file headers.
2. **Use Rebrickable as the catalog backbone.** Load its daily CSV dumps into our own database rather than calling the API from the browser. They give us sets, inventories, part↔color existence, element IDs and cross-references to LDraw, BrickLink and LEGO IDs. Use BrickLink only for ID mapping and Studio compatibility, because its API terms are restrictive.
3. **Use the LDraw Official Model Repository (OMR) as the seed set of real models.** These are `.mpd` files of real sets under CC BY 2.0, and they include many Town and Train sets. Every OMR model can be checked against the matching Rebrickable inventory.
4. **Build our own connectivity schema for a curated palette.** LDraw has no native connection data. Start it from primitive-reference inference (`stud*.dat`, tube and Technic primitives). Use the LDCad shadow library as a reference only, because it is CC BY-SA 4.0 and copying it would make our connectivity data share-alike.
5. **Check buildability in layers.** First, every part and color combination must exist as a real element. Next, check the model against a set inventory if it claims to be a set. Then check structure: everything is connected to the ground and nothing collides. Stability is optional. Most checks run when a model is ingested. In the city editor itself, the checks are just grid and stud snapping plus layout rules for track, road and MILS.
6. **Mesh pipeline.** LDraw → flatten → smooth normals using the line metadata → strip studs into instances → optional bevel → LOD chain (`p/48`, standard, `p/8`, merged proxy) → glTF with `EXT_mesh_gpu_instancing`, quantization and meshopt compression. Part geometry has no color; color is an instance attribute. The city is a set of model instances, each made of part instances, rendered with batched/instanced draws.
7. **Imports.** Accept `.ldr`, `.mpd` and `.io`. Treat `.io` as a plain ZIP. Reject legacy encrypted `.io` files and ask the user to re-save them, rather than shipping the known password. Resolve parts and colors through the mapping tables, run the buildability checks, and attach vehicle attributes through a sidecar JSON file plus an optional `0 !<NS>` meta namespace so files round-trip.

---

## 1. LDraw library

### Format essentials
- Plain-text, line based. Each line starts with a type number:
  - `0` is a comment or meta command.
  - `1` is a sub-file reference: color, x y z, a 3×3 matrix, then the file name.
  - `2` is an edge line.
  - `3` and `4` are triangles and quads.
  - `5` is a conditional line, drawn only when it is on the silhouette.
- File types: `.dat` for parts, primitives and subparts; `.ldr` for models; `.mpd` for multi-part documents (several `0 FILE` sections in one file).
- Units: 1 LDU = 0.4 mm. Stud pitch is 20 LDU (8 mm), a plate is 8 LDU, and a brick is 24 LDU. The −Y axis points up. A 32×32 baseplate is 640 LDU (25.6 cm).
- Color `16` means "inherit the main color" and `24` means "edge color". This lets one part mesh render in any color.
- BFC (`0 BFC CERTIFY CCW`, `INVERTNEXT`) controls winding order. The pipeline must track the matrix determinant and `INVERTNEXT` to get faces facing the right way.
- Library layout:
  - `parts/` holds the parts.
  - `parts/s/` holds subparts.
  - `p/` holds primitives, with `p/48` (high-res) and `p/8` (low-res) variants. These variants give us free LOD tiers for curved geometry.
  - `models/` holds sample models.
  - `LDConfig.ldr` holds the colors.
- Headers carry `Name:`, `Author:`, `!LDRAW_ORG` (part type and update), `!LICENSE`, `!CATEGORY`, `!KEYWORDS` and `!HISTORY`.
- Aliases and physical-colour parts exist: `OfficialCA_a` holds alternative numbers for the same part, and `OfficialCA_p` holds parts with hard-coded colors. We need the alias table so a part is identified the same way however it was numbered.
- Patterns and prints are modeled as colored polygons. `!TEXMAP` exists but is rare. Studio uses its own embedded textures (`PE_TEX_*` metas with base64 images) **(verify exact meta names)**.
- Logo-less look: plain `stud.dat` has no logo. Renderers only add a logo by substituting `stud-logo*`/`logo*.dat`. So the logo-less look is the default; we just never substitute.
- Size: roughly 20k+ official part files including patterns and aliases **(verify against the current `complete.zip`)**. The library is updated through the LDraw Parts Tracker in periodic releases. Unofficial parts (`ldrawunf.zip`) are not quality-reviewed, so treat them as opt-in.

### Licensing (confirmed)
- Parts covered by the Contributor Agreement carry `0 !LICENSE Redistributable under CCAL version 2.0` (older parts) or the CC BY 4.0 licence (newer parts, `CAlicense4.txt`). Both allow commercial use, modification and redistribution, provided we give attribution.
- CC BY 4.0 obligations:
  - Keep the creator identity, copyright notice, license notice, warranty disclaimer, and a link to the material.
  - Say when we have modified it.
  - A link to an attribution page counts as "reasonable manner".
- **`OfficialNonCA` parts may not be redistributed.** The pipeline must filter on the `!LICENSE` header and fail the build if any part without the CA licence gets in.
- Converted meshes are "adapted material", so we should say that the meshes are modified from LDraw.
- **Action:** the pipeline emits `attribution.json` (part → authors, license, history) and a generated attribution page. Each glTF part asset also keeps `extras.ldraw = {name, authors, license}`.
- "LDraw" is a trademark of the Estate of James Jessiman. LEGO is a trademark of the LEGO Group. Use a non-affiliation disclaimer and avoid "LEGO" in the product name (see the LEGO Fair Play policy).

## 2. Connectivity / snap metadata

LDraw files describe geometry only; they have no connection data. The available options:

| Source | What it gives | License / constraints |
|---|---|---|
| **LDCad shadow library** ([GitHub](https://github.com/RolandMelkert/LDCadShadowLibrary)) | `!LDCAD SNAP_CYL / SNAP_CLP / SNAP_FGR / SNAP_GEN / SNAP_INCL / SNAP_CLEAR` metas as patch files merged over library parts. Covers many parts and primitives. Cylinder snaps carry gender, caps, a radius/length section list, slide, position, orientation and grid. | **CC BY-SA 4.0.** Copying or deriving our data from it makes our connectivity data share-alike. Using it as a reference or validator is fine. Coverage is partial ("only one developer"). |
| **Studio `.conn` / `.col` files** | Studio's own connectivity and collision data per part, including CustomParts. | Proprietary and unlicensed. Don't extract or ship it. |
| **Inference from primitives** | Parts reference `stud.dat`, `stud2.dat`, `stud3.dat`, `stud4.dat`, box/tube primitives, Technic `peghole`/`axlehole`/`connect*` and so on, with transforms. Collecting these gives male/female connector positions automatically. | Our own data, under whatever license we choose. Weak for clips, hinges, bars and special connectors. |

**Recommendation.**
- Define our own connector schema: type, gender, position and orientation in LDU, grid, and allowed rotation steps.
- Generate it for the curated city palette (bricks, plates, tiles, slopes, windows and doors, track, road plates, baseplates, train bases and bogies, a few hundred to around 2k parts).
- Bootstrap it by primitive inference, then curate by hand.
- Optionally use the LDCad data as a diff reference for QA.
- Decide early whether we're willing to publish our connectivity data as CC BY-SA. If yes, importing the LDCad shadow data directly saves a lot of work.

For the city layer, the snapping we need is coarse: stud grid, baseplate edges, track connectors (track pieces join at fixed points), and road-plate edges. Track pieces need special connector types (track ends with a heading) that aren't stud-based anyway.

## 3. Catalogs and APIs

### Rebrickable (primary)
- Terms: the API "may be used for any purpose, including commercial", and attribution to Rebrickable is requested. Set, part and minifig images may be hotlinked or downloaded. **MOC images may not be used.**
- Daily CSV dumps (about 12 files, around 18 MB gzipped):
  - `themes`, `colors`, `part_categories`, `parts`, `part_relationships`, `elements`
  - `sets`, `minifigs`, `inventories`, `inventory_parts`, `inventory_sets`, `inventory_minifigs`
- Inventories have versions; pick the latest by default and keep the others.
- `part_relationships` covers prints (P), molds (M), alternates (A), pairs, sub-parts (B) and so on. We need these to normalize parts when comparing a model with an inventory.
- `elements` maps LEGO element IDs to part + color. This is the ground truth for "this part exists in this color".
- API v3 (key in a header) adds external ID crosswalks for parts (LDraw, BrickLink, BrickOwl, LEGO) and colors, plus part↔color lists. Rate limit is about 1 request/s **(verify)**. Fetch the crosswalks with a nightly job, not live.
- Gaps: no general MOC inventories through the API, and no pricing.

### BrickLink
- API: OAuth 1.0 (simplified), consumer registration tied to an IP (`0.0.0.0` allowed), 5,000 requests/day. Using it requires accepting the API Terms of Use. Community reports say the terms restrict monetized services built on it **(read the terms before any use)**.
- Catalog XML downloads are available after login.
- **Use:** BrickLink IDs only through Rebrickable's crosswalk. Don't depend on the BrickLink API for core features.

### Others
- **Brickset API** (needs a key): set metadata, themes, instruction links. Optional.
- **LEGO**: no public catalog API.

### Real models: the OMR
- [omr.ldraw.org](https://omr.ldraw.org) has official sets as `.mpd` files named like `311-1 - Ferry.mpd`. Each file's header has `!LICENSE Redistributable under CCAL version 2.0` and per-file authors.
- Files may embed unofficial parts inline (`!LDRAW_ORG Unofficial_Part`) and pre-synthesized flexible parts (LSynth).
- Coverage is a few thousand sets, skewed to classic Town, Train and Technic **(verify the current count and the Town/Train coverage)**.
- **Action:** ingest all OMR models, match each to a Rebrickable set by set number, run the inventory diff (section 5), and publish the ones that pass as verified "real set" assets.

## 4. Colors

- **`LDConfig.ldr`** has one `!COLOUR` line per color with the LDraw code, `VALUE` and `EDGE` hex, `ALPHA`, `LUMINANCE`, and finish keywords (`CHROME`, `PEARLESCENT`, `RUBBER`, `MATTE_METALLIC`, `METAL`, `MATERIAL GLITTER/SPECKLE`). Use it for render values.
- **Rebrickable `colors.csv`** has its own IDs plus crosswalks to LDraw, BrickLink, LEGO and BrickOwl. Use Rebrickable IDs as the canonical color key in our database.
- Studio has its own color table, which includes colors not in `LDConfig` (for example newer Trans-Black). Map Studio colors on import, and fall back to the nearest canonical color with a warning.
- Rendering:
  - Material classes: solid, transparent (sorted or OIT), chrome/metal, pearl, rubber, glow.
  - Store color as an instance attribute and look it up in a palette texture, so changing a color never re-uploads geometry.
  - Keep a "realistic" palette and an optional "instruction" palette.

## 5. How to verify buildability

These levels go from cheapest to most expensive. Each asset stores which levels it passed.

1. **Element existence.** Every (part, color) pair exists as a real element, either through Rebrickable `elements` or by appearing in some set inventory. Report pairs that aren't real.
2. **Inventory match**, for assets that claim to be set N:
   - Normalize both sides. Resolve aliases, collapse `part_relationships` alternates and molds, and treat prints as strict or relaxed depending on the setting.
   - Compute the model BOM minus the set inventory, and the set inventory minus the model BOM.
   - "Exact" means both are empty. "Buildable from set" means the model BOM is contained in the set inventory.
   - Multi-set builds (combos, MOCs from several sets) use the same comparison against a combined inventory.
3. **Structural validity**, which needs connectivity data:
   - Build a graph whose nodes are part instances and whose edges are matched connectors (positions within tolerance, compatible gender and type, orientation allowed).
   - Every part must be reachable from a grounded part (baseplate or base).
   - No interpenetration: AABB broad phase, then a mesh or convex-proxy narrow phase that ignores the declared connection zones.
   - Flag parts that float, overlap, or have no connection.
4. **Stability** (optional, research-grade): gravity and overhang analysis on the connection graph. There is academic work on LEGO stability analysis **(verify which methods suit a web runtime)**. Probably out of scope for v1, except as warnings.
5. **Layout legality** (city layer):
   - Models sit on studs. Track joins only at track connectors with matching heading and radius.
   - Road and baseplate edges line up.
   - MILS modules meet the height and connector conventions (section 9).

Policy suggestion: "Real set" assets need levels 1 and 2 to be exact. "Verified build" assets need levels 1 and 3. User imports get badges for the levels they pass, not a hard block.

## 6. Mesh pipeline: LDraw → optimized glTF

Run it offline as a batch job (Rust or Node) that produces versioned, content-addressed assets on a CDN.

**Existing tools to reuse or learn from:**
- `ldr_tools` (Rust, used by `ldr_tools_blender` and `ldraw2mesh`, which converts LDraw to glTF without Blender) **(verify the license before vendoring)**.
- three.js `LDrawLoader` with the `packLDrawModel` script, plus `LDrawConditionalLineMaterial`.
- `mpd2glb` (Node; LDraw to `.glb` with conditional-line cleanup, real-world scale, Draco/meshopt).
- Blender ImportLDraw (baked bevels, no-logo option, resolution choice). Good for producing reference renders.
- `gkjohnson/ldraw-parts-library`: a library mirror on GitHub/CDN, handy for prototypes.

**Steps per part:**
1. Parse the part and recursively flatten its sub-files, composing transforms and tracking BFC winding through determinant sign and `INVERTNEXT`. Keep color 16/24 as placeholders so the geometry stays color-free. Parts with hard-coded colors (multi-color patterns) get per-vertex color, or are split into sub-meshes by color.
2. Weld vertices with an epsilon of about 0.05 LDU, remove degenerate faces, and fix T-junctions where possible.
3. Smooth normals. Treat type-2 edge lines as hard edges and type-5 conditional lines as soft edges. Use an angle threshold of about 30–45° as a fallback.
4. Separate the studs. Find stud primitive references (`stud.dat`, `stud2.dat` and similar), remove them from the part mesh, and record them as stud instances (position, type). This lets us draw studs instanced, remove studs covered by parts above (section 7), and swap stud LOD separately. It also removes most of the triangle budget: on plates and baseplates, studs dominate the triangle count.
5. Remove hidden geometry for distant LODs: underside tubes, the inside of hollow bricks, and back-face shells. At LOD ≥ 1 the underside is rarely visible in a city view, so it can be dropped.
6. Bevels. Choose between:
   - Geometric bevels on type-2 edges (best look, more triangles; LOD0 only), or
   - A shader rounded-edge effect: a bevel-normal trick in screen space or from edge-distance attributes. Recommend the shader approach plus a small baked bevel on LOD0.
   - Also optional: a tiny inset gap between parts so seams read clearly.
7. LOD chain:
   - **LOD0:** `p/48` primitives, beveled, full detail.
   - **LOD1:** standard primitives, no bevel geometry.
   - **LOD2:** `p/8` primitives with the underside removed, simplified with meshoptimizer.
   - **LOD3:** per-model merged proxy: a whole-model mesh with studs baked as a normal map or omitted.
   - **LOD4:** impostor or billboard for very large cities.
8. Encode as glTF 2.0 with `KHR_mesh_quantization`, `EXT_meshopt_compression`, and `EXT_mesh_gpu_instancing` for model assets. Each part is one `.glb` (or packed into atlas bundles by palette group). Each model is a JSON instance list (part ID, color ID, 4×3 matrix in LDU) plus a merged proxy for LOD3.
9. Optionally keep edge lines for an "instruction look" mode: precomputed outline lines, or a screen-space edge detection pass.

## 7. Rendering at city scale

- Scene hierarchy: city → models (sets or builds placed on baseplates) → part instances.
- Render part instances with `BatchedMesh` / multi-draw-indirect (WebGL2 multi-draw where available, WebGPU later), grouped by material class.
- Remove covered studs when a model is baked: a stud that has a part's anti-stud on top of it is invisible, so drop it. This removes most stud instances in a dense build.
- Choose LOD per model by screen-space size. Far models switch to merged proxies so draw count scales with model count, not part count.
- Track, roads and baseplates are large repeated parts, so they are perfect for instancing; use a fixed small set of meshes for them.
- Budget idea: target around 1–3M triangles visible on mid-range GPUs **(validate with a prototype)**.

## 8. Importing user files and vehicle attributes

### Formats
- **`.ldr` / `.mpd` / `.dat`:** native. Inline `0 FILE` sections can carry unofficial or custom parts; take them through the license and QA path and mark the model "contains custom geometry".
- **Studio `.io`:** a ZIP containing:
  - `.info` (version and part count)
  - `model.ldr`
  - `model2.ldr` (with inline part definitions, including CustomParts)
  - `modelv2.ldr` in newer versions
  - a thumbnail
  - `errorPartList.err`

  Older `.io` files are password-protected ZIPs (AES). The password circulates publicly, but LeoCAD's maintainer declined to ship it to avoid legal trouble. **Recommendation:** read plain-ZIP `.io` only. For legacy files, ask the user to re-save in a current Studio.

  Prefer `modelv2.ldr`, then `model2.ldr`, then `model.ldr`. Some tools report non-standard line types in `modelv2.ldr` **(verify against real files)**. Studio part numbers and colors mostly follow LDraw and BrickLink, but not always; map them through crosswalk tables and log anything that doesn't match.
- **LDD `.lxf`** (discontinued LEGO Digital Designer): XML inside a ZIP with LDD design IDs. Lower priority, but convertible through community mapping tables.

### Import flow
1. Unpack and parse.
2. Resolve parts: our library first, then aliases, then the Rebrickable crosswalk, then inline definitions.
3. Map colors.
4. Build the BOM and run buildability levels 1, 2 (against a chosen set) and 3.
5. Bake an instance list and run LOD3 proxy generation as a server job.
6. Store the original file for re-export.
7. Show the user a report: missing parts, invalid colors, floating parts.

### Vehicle attributes
- **Auto-detection** by part signatures and submodel names:
  - Train wheels/bogies and the power units (PF train motor 88002, Powered Up train motor 88011) mean a train.
  - Car wheels and tires mean a road vehicle.
  - Magnetic couplers mean a car is couplable.
  - Seed the signature table with the curated palette **(build the list from the Rebrickable train and wheel categories)**.
- **Derived values:**
  - length, width in studs (4/5/6/7/8-wide), height
  - for trains: bogie pivot points, axle positions and the wheelbase between bogie centres; coupler points at each end
  - for road vehicles: axle positions, steering axle, ground clearance
  - collision hull
  - suggested minimum curve radius (for example R40 is the standard LEGO curve; long cars may need wider curves)
- **Storage:**
  - Primary: a sidecar JSON file per model (`vehicle: {kind, bogies[], couplers[], axles[], maxSpeed, power, length}`).
  - Optional embedding for round-trip: `0 !<NS> VEHICLE ...` metas in the `.ldr` (namespace TBD, e.g. our product short name). LDraw tools ignore unknown `0` metas, so files stay valid.
  - Bogies must be separate submodels so they can pivot. If an import has a bogie merged into the car body, the auto-split tool proposes a split and the user confirms it.

## 9. City-specific data notes

- **Track:** the standard plastic track system (for example straight 53401 and curve 53400, R40) plus switches and crossings. Each piece needs track-graph connectors (endpoints with heading) in our schema, separate from stud connectors. Wider-radius curves exist only from third parties; decide whether only official LEGO parts count as "real".
- **Roads:** modern road plates and the classic 32×32 road baseplates. Lane and sidewalk geometry metadata for vehicle path-following goes in our schema, not in LDraw.
- **Baseplates:** 32×32, 16×32, 48×48 and others; color variants exist per Rebrickable.
- **MILS:** a community standard of 32×32 modules. A baseplate sits on raised plate/brick layers, Technic bricks at the corners and edges connect neighbouring modules, and heights are counted in plates. The details (exact layer stack, connector positions, corner and slope variants) vary by club **(needs a dedicated MILS spec pass)**. MILSGen-style generators show the conventions: substructure with corner and Technic-brick connectors, plus edge identifiers.

## Open questions

1. **Definition of "real":** only official LEGO elements in colors that were actually produced (strict, level 1), or also unproduced color combinations, or also third-party parts (wider curves, MILS plates)? This drives the whole validation design.
2. **Share-alike:** are we OK publishing our connectivity dataset under CC BY-SA 4.0 so we can import the LDCad shadow library directly? If not, we generate everything ourselves.
3. **Unofficial and custom parts:** allow them in user imports (with a badge), or block them? Should OMR models that embed unofficial parts count as "real sets"?
4. **Studio `.io` legacy encryption:** confirm the decision not to ship the password (legal review).
5. **BrickLink:** do we need anything from BrickLink beyond Rebrickable's crosswalks? If yes, get a legal read of its API terms.
6. **Printed parts:** render print geometry (more triangles) or fall back to plain parts at distance? Should prints be strict in inventory matching?
7. **Server versus client checks:** run buildability level 3 (collision and connectivity) on the server only, or also in the browser for live editing? This affects whether the connector schema and collision proxies ship to the client.
8. **Granularity of city editing:** do users edit individual bricks in the city (which needs live connectivity), or only place whole verified models plus baseplates, track and roads? This changes how much of section 5 runs in the editor.
9. **Asset scale:** what is the target number of placed models and parts per city? This sets the LOD and impostor strategy and the triangle budget.
10. **MILS spec:** which MILS variant do we adopt as canonical (layer stack, connector positions, slope and corner modules)?
11. **Fallback geometry for missing parts:** for parts LDraw doesn't have yet, use a bounding-box placeholder, or block the import?
12. **Attribution UX:** a global credits page is enough under "reasonable manner", but do we also want per-model credits (OMR authors, set designers)?

## Key sources
- LDraw file format spec: https://www.ldraw.org/article/218.html ; legal info: https://ldraw.org/legal-info ; CC BY 4.0: https://creativecommons.org/licenses/by/4.0/legalcode
- LDCad meta docs: https://www.melkert.net/LDCad/tech/meta ; shadow library: https://github.com/RolandMelkert/LDCadShadowLibrary
- OMR: https://omr.ldraw.org
- Rebrickable terms and downloads: https://rebrickable.com/terms/ , https://rebrickable.com/downloads/ , API: https://rebrickable.com/api/
- BrickLink API: https://www.bricklink.com/v3/api.page
- Studio `.io` notes: https://github.com/leozide/leocad/issues/356 ; Studio CustomParts layout: https://github.com/Cheenzo/StudioParts
- Tools: three.js LDrawLoader ; https://github.com/AvaLovelace1/ldraw2mesh ; https://github.com/anteloc/mpd2glb ; https://github.com/TobyLobster/ImportLDraw
