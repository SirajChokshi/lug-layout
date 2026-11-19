# Brick Railroad: architecture and phased roadmap

This is a browser sandbox for laying out LEGO cities from real models, with rail, roads, baseplates and MILS modules. You build with whole imported modules, connect track and roads exactly, run trains, and export a parts list you can buy.

It serves two jobs on one engine:
- **a boundless sandbox world** that you can extend in any direction, where rules are advisory;
- **a practical planner for a real layout**: draw your room and tables to scale, plan inside that footprint, and get a full parts list and a "buildable as planned" check before you buy or build anything.

Sources: [part-data.md](research/part-data.md), [engine-stack.md](research/engine-stack.md), [connection-rules.md](research/connection-rules.md), [product-scope.md](research/product-scope.md). Facts the reports could not confirm are collected in §11 and must be checked before anyone relies on them.

## 0. Owner decisions already made

| # | Decision | Effect on this plan |
|---|---|---|
| D1 | **The project is non-commercial.** | BrickLink API use and share-alike (CC BY-SA) connectivity data are now acceptable in principle. We import the LDCad shadow library directly and publish our connectivity dataset under CC BY-SA 4.0 (§3.4, §10). LEGO trademark rules and the ban on redistributing `OfficialNonCA` parts still apply in full. |
| D2 | **Users work with whole modules and models; we don't do brick-level modeling.** Users build in Studio, LDCad or LeoCAD and import the result. | The editor places imported models, OMR sets, modules, baseplates, track and road pieces. A model is immutable once imported, and users fix bricks in their own tool and re-import. Brick-level structural checks become import badges, never live editing rules. Renderer and storage work at model granularity (§4, §6, §9). |
| D3 | **Third-party track (BrickTracks, TrixBrix, ME Models) is out of scope for now, but adding it must be easy later.** | Parts come from pluggable *part sources*, each with provenance and license. Track rules live in *track profiles*. Exact track arithmetic is generic over the angle step. Everything third-party is flagged in the BOM. Only official LEGO track ships (§3.5, §5.4). |
| D4 | **It must be both a boundless sandbox and a solid tool for planning a real layout:** real table and room footprint, a parts list, buildable as planned. | **One world model in two modes.** The world is an unbounded, sparse chunk map, stored and streamed per super-chunk (§6, §9). **Plan regions** are bounded areas tied to a physical footprint (room, tables, obstacles, aisles) in millimetres. Inside a plan region the rules are strict, and the region gets its own complete BOM (including baseplates and module substructure), an "own vs buy" view, printable plans, and a **"Buildable as planned"** status (§7.3). Outside plan regions the rules only warn. Planning features move into the MVP. |
| D5 | **Catalog search is served from the server, on Cloudflare** (owner decision, 2026-11-16). | `apps/catalog-api` is a Worker that answers search, set inventory and theme browse from D1. Every catalog release is a content-addressed SQLite file kept in R2 as the source of truth and offline fallback. URLs name the release, so responses are immutable and edge-cached. `infra/cloudflare` provisions the Worker, D1 and R2 with Terraform. Search needs at least 3 characters (owner decision, 2026-11-16). |

## 1. One-paragraph architecture

An **offline data pipeline** (Rust plus scripts, run in CI) compiles the LDraw CA parts library, Rebrickable dumps, the LDraw OMR and the LDCad shadow library into a versioned, content-addressed **asset bundle** on a static CDN. That bundle holds part meshes with studs extracted, a connector database, the catalog, element-existence tables, verified set models and attribution. In the browser, a **TypeScript app** has five parts:
- a React UI shell;
- an **import worker**, the same Rust crate built for WASM, that parses `.ldr`, `.mpd` and plain-ZIP `.io` files, resolves parts and colors, computes badges, and bakes models;
- a **layout core** that holds the unbounded world of placements, exact track and road joins, plan regions with their physical footprints, and validation;
- a **sim worker** that runs trains on a derived track graph at a fixed timestep;
- a **renderer**: three.js `WebGPURenderer` with automatic WebGL2 fallback, drawing instanced and merged *models* with LODs, culled studs, SSAO and outlines.

A world is a manifest plus one JSON shard of placements and laid track per super-chunk, stored in IndexedDB and exported as a file. Plan regions export separately, together with their BOMs and printable plans. The MVP has no backend. Accounts, cloud saves and sharing come in P1.

## 2. How the reports' conflicts are resolved

| Topic | Conflict | Resolution |
|---|---|---|
| Scale target | Engine stack plans for 1M to 10M parts. Product scope plans for about 50k. | **MVP target: 250k parts *loaded near the camera* at 60 fps on an integrated GPU (Tier A) at 1080p. Stretch: 1M.** That covers a club layout of about 100 MILS modules at roughly 2k parts each. The boundless world (D4) can hold far more, so whole-world size is limited by streaming and far LOD, not by the frame budget: chunks beyond the near radius exist only as far-LOD meshes or aren't loaded at all. D2 makes models static, so per-model merging and instancing reach this without a GPU-driven pipeline. Engine stack's 10M-parts target is dropped as a frame budget; very large worlds are handled by streaming instead. |
| Renderer | Engine stack wants a custom WebGPU-only renderer with compute culling. Product scope and part data want three.js, instancing and `BatchedMesh`. | **Start with three.js `WebGPURenderer`, with automatic WebGL2 fallback, behind a thin `SceneBackend` interface** that takes model instances, not parts. Milestone M0 benchmarks it. A custom GPU-driven WebGPU backend becomes a P2 option, built only if the 250k/1M gates fail. Engine stack's domain techniques are kept either way: stud extraction, covered-stud culling, voxel far LOD, 32×32 chunks. |
| Runtime asset format | Part data proposes per-part glTF with meshopt. Engine stack proposes a custom `.lpa` binary atlas. | **GLB with `KHR_mesh_quantization` and `EXT_meshopt_compression`, packed into palette bundles.** Stud positions and connectors go in `extras` and sidecar tables. three.js loads this natively. A custom atlas waits for the custom backend. The pipeline already produces renderer-agnostic data either way. |
| Threads and isolation | Engine stack wants SharedArrayBuffer, WASM threads and COOP/COEP headers. | **Not in the MVP.** Heavy compilation happens offline. Import baking runs in single-threaded workers. That avoids cross-origin-isolation constraints on embeds and OAuth until a measured need appears. |
| Persistence | Engine stack wants OPFS, an op log and content-addressed chunks. Product scope wants IndexedDB and a JSON file. | **IndexedDB holding a JSON world split into one shard per super-chunk.** Placements are small, but D4 makes worlds unbounded, so they load per shard and never as one document. Imported model blobs are content-addressed in IndexedDB. OPFS is used only as an asset cache. The op log arrives with multiplayer in P2. |
| Studio `.io` | Part data says read plain ZIP and reject encrypted files. Product scope says MVP should rely on LDraw export from Studio. | **Read plain-ZIP `.io` in the MVP**, because D2 makes import the main workflow. Encrypted legacy files are rejected with an instruction to re-save. **We never ship the password**: anti-circumvention law doesn't depend on being commercial. LDraw export stays the documented fallback. |
| Connectivity source | Part data says generate our own data to avoid share-alike. Engine stack and product scope suggest LDCad data. | **With D1 settled, import the LDCad shadow library directly** and fill gaps by primitive inference. The connectivity dataset ships as a separate CC BY-SA 4.0 package, so the app code's license is unaffected. |
| BrickLink | Part data says avoid it beyond crosswalks. Product scope says Wanted List XML now, API later. | **Rebrickable stays the catalog backbone.** Wanted List XML export ships in the MVP and needs no API. BrickLink's API, for the price guide only, is a P1 option once its terms have been read for non-commercial use (D1 makes this likely but not certain). |
| Track gauge | Product scope says "6-stud internal gauge". Connection rules say "about 37.5 mm inside the rails, rail centers about 5 studs apart". | Unresolved; measure from LDraw 53401 (§11). Snapping doesn't depend on it because track ends are matched by pose. Only wheel-placement visuals do. |
| Validation level | Part data proposes levels 1 to 5, including structural checks while editing. Connection rules require every connection to be exact. | Under D2, **validation splits in two.** *Model badges* are computed at import and never block. *Layout rules* run live, are exact and zero-tolerance, and decide whether a layout is "Valid". See §7. |
| Rotation | Product scope allows 15° and free rotation. Connection rules allow only 90° steps on studs. | Models sit on studs with **90° rotations only.** Off-grid angles exist only for track (22.5° steps through connections) and for parts held by track. There's no free rotation; that would break "no fudging". |

## 3. Data pipeline (offline, in CI)

### 3.1 Inputs, by part source
Every part and model comes through a **`PartSource`** plugin. Each source declares an id, provenance, a per-item license, redistribution rights and a priority used when resolving.

| Source id | Provenance | Content | License or terms | Shipped |
|---|---|---|---|---|
| `ldraw-official` | `official` | LDraw `complete.zip`, filtered to CA parts | CC BY 2.0 / CC BY 4.0, with attribution | Yes |
| `ldraw-unofficial` | `unofficial` | `ldrawunf.zip`, specific parts by allowlist only | Per part | Opt-in, badged |
| `user-inline` | `custom` | Inline `0 FILE` parts or Studio CustomParts found in an import | User's own | Stays in the user's model only |
| `omr` | `official` model | OMR `.mpd` sets | CC BY 2.0 | Yes, after verification |
| `ldcad-shadow` | connectivity | `!LDCAD SNAP_*` metadata | CC BY-SA 4.0 | Yes, as a separate data package |
| `rebrickable` | catalog | Daily CSV dumps, plus nightly API crosswalks | Any use, attribution requested | Yes, derived tables |
| *(later)* `thirdparty-<vendor>` | `thirdParty` | Vendor track geometry and connectors | Per vendor, needs clearance | **No (D3)** |

### 3.2 Pipeline stages
1. **Fetch and pin.** Download the inputs, record versions and hashes, and fail if any input changes without a version bump.
2. **License gate.** Read the `!LICENSE` header of every LDraw file. **The build fails if any `OfficialNonCA` part, or a part without a license, enters the bundle.** Write `attribution.json` (part to authors, license, history and a "modified" note) and a generated credits page.
3. **Catalog database.** Load the Rebrickable CSVs into SQLite at build time, then emit static, sharded, compressed outputs:
   - `colors`, `parts`, `part_relationships` and the crosswalks to LDraw and BrickLink;
   - an **element-existence table** of (part, color) pairs, as a compact sorted array or bitset that loads lazily;
   - set metadata and inventories (latest version by default; the others kept);
   - a color table merged from LDConfig (render values) and Rebrickable (canonical ids). Rebrickable color ids are the canonical key.
4. **Part compiler** (Rust crate `brick-compile`):
   1. Flatten sub-files, tracking BFC winding through the matrix determinant and `INVERTNEXT`.
   2. Keep colors 16 and 24 as placeholders.
   3. Weld vertices (ε ≈ 0.05 LDU) and smooth normals using type-2 lines as hard edges and type-5 lines as soft edges.
   4. **Extract studs** (`stud*.dat`) into stud records holding position, type and a cover-test cell.
   5. Extract the underside (tubes and anti-studs) into a submesh.
   6. Build LODs: **LOD0** from `p/48` primitives plus a small bevel on hero parts; **LOD1** from standard primitives; **LOD2** from `p/8` primitives with the underside dropped, simplified with meshoptimizer.
   7. Emit GLB palette bundles plus optional edge-line data for an instruction-style look.
   8. Never substitute logo studs.
5. **Connector build.** Merge LDCad `SNAP_*` metadata over the parts, then add connectors inferred from primitives (`stud*`, tubes, Technic `peghole`/`axlehole`/`connect*`). Convert everything to our schema (§5). Hand-curate the **city palette**: track, road plates, baseplates, train bases and bogies, Technic bricks for module joins. Run the track field-membership test (§5.3) on every track part.
6. **OMR ingest.** Parse each set, match it to its Rebrickable set by number, run model badges L1 and L2 (§7.1), and bake the model (§3.3). Sets that pass L1 and L2 exactly become "Real set" catalog entries.
7. **Publish.** Upload a content-addressed CDN bundle with a manifest (`bundleVersion`, input versions, per-source license summary).

### 3.3 Model bake
The browser import worker and the OMR ingest share the same code.
1. Unpack and parse the file. For `.io`, read `modelv2.ldr` with Studio's type-11 part lines rewritten as standard type-1 lines, which reproduces Studio's own `model.ldr` exactly, and fall back to `model.ldr`. `model2.ldr` is read only for each part's `BL_Item_No`; its embedded Studio geometry is never used. Encrypted legacy archives are rejected with a "re-save in current Studio" message.
2. Resolve each part against the pinned LDraw library: the prebuilt bundle first, then official parts compiled from the pinned mirror (license-gated; unofficial parts only through the allowlist). A Studio name that isn't an LDraw part is renamed only when the BrickLink crosswalk names exactly one LDraw part that exists at the pin. Inline definitions are compared with the official part and never drawn in its place. Parts that can't be resolved (not in the library, a missing subfile, refused by a gate, or an ambiguous, missing or custom Studio part) are skipped and reported, never turned into placeholders.
3. Map colors. Instances in an unknown colour, including Studio-only codes, are skipped and reported, never snapped to a nearby colour.
4. Build the **instance list**: part id, color id and a 4×3 matrix in LDU. Keep the **submodel tree**, because bogies and vehicles need it.
5. Build the **BOM**, normalized through aliases and `part_relationships`.
6. **Remove covered studs inside the model**: a stud with an anti-stud or solid underside directly above it is dropped.
7. Derive the **base footprint**: the set of bottom-facing anti-stud cells on the lattice, plus flat-bottom regions. Layout placement uses this for support checks.
8. Compute the 2.5D occupancy (a voxel column per stud cell) and the AABB.
9. Build **merged LOD meshes** per material class: mid LOD from LOD1 parts merged; far LOD as a voxel greedy mesh at 1 stud × 1 stud × 1 plate resolution.
10. Detect vehicles by part signatures (train motors, wheels, magnetic couplers) and propose a vehicle sidecar.
11. Store the original file unchanged so it can be re-exported.

### 3.4 Attribution and licenses in shipped assets
- Part GLBs carry `extras.ldraw = {name, authors, license}`.
- The credits page covers LDraw, the OMR authors of each model, Rebrickable and LDCad.
- The connectivity package carries its own CC BY-SA 4.0 notice and an attribution to Roland Melkert.
- The trademark disclaimer appears in the footer, the about page and every export.

### 3.5 Extension points for third-party parts (D3)
These are built now and used later:
- `PartSource` plugins with a `provenance` field. The BOM, the badges and the catalog filter all read it.
- Each `TrackProfile` declares a track system, a gauge class and an **angle step N**, where N = 16 for 22.5° steps and N = 32 for 11.25° steps (§5.3).
- A layout-level `allowThirdParty` flag that is off and hidden today. Validation refuses `thirdParty` parts unless the flag is on, and the BOM flags them.
- Catalog ids are namespaced (`ldraw:53401`, `bt:R56-curve`), so vendor packs can never collide with LDraw numbers.

Adding a vendor later means writing a source adapter, the vendor's connector data, and a profile with N = 32 if any of its pieces needs 11.25° steps. No core code changes.

## 4. System components (runtime)

| Component | Runs in | Tech | Responsibility |
|---|---|---|---|
| UI shell | main thread | TypeScript, React | Catalog browser, placement tools, inspector, BOM panel, Build and Run modes, import report |
| Layout core | main thread, pure TS module | TypeScript | World document (sparse chunks), placement poses, joins, undo/redo command stack, live validation. Headless and unit-tested. |
| Planner | main thread, pure TS module | TypeScript | Plan regions and physical footprints (room, tables, obstacles, aisles, in mm), footprint-fit and reach rules, the BOM for each plan (models, baseplates, track, road plates, module substructure), "own vs buy", printable plan export (SVG, then PDF) |
| Import worker | Web Worker | Rust → WASM (`brick-compile`, `import` feature) | Parse and bake models (§3.3), compute badges L1, L2 and (P1) L3 |
| Asset loader | worker | TypeScript | Fetches CDN bundles and caches them in OPFS and the HTTP cache. Lazy element table. |
| Sim worker | Web Worker | TypeScript | Fixed-timestep simulation of track and road graphs, consists and routing. Headless-testable. |
| Renderer | main thread for the MVP; OffscreenCanvas worker in P1 if the main thread misses its budget | three.js `WebGPURenderer` behind `SceneBackend` | Chunked scene, model instancing, LOD, stud handling, look |
| Persistence | main thread and worker | IndexedDB | Layouts, imported model blobs and bakes (content-addressed), settings |
| Backend (P1+) | server | Small API plus object storage | Accounts, cloud layouts, share links, model blob storage |

## 5. Connector and placement schema

Positions are in **integer LDU**. x and z are the plan axes and y points up. Layout heights are counted in **plates above the top surface of the baseplate**. Floats appear only in rendering, and in imported models' internal matrices, which are never used for joins.

### 5.1 Part record (connector database)
```ts
type Provenance = "official" | "unofficial" | "custom" | "thirdParty";

interface PartRecord {
  id: string;                 // namespaced: "ldraw:53401"
  source: string;             // PartSource id
  provenance: Provenance;
  license: string;            // SPDX-like
  cityRole?: "track" | "road" | "baseplate" | "moduleJoin" | "bogie" | "motor" | "wheel";
  footprint: { poly: [number, number][]; yMin: number; yMax: number }; // LDU
  keepOut?: Volume[];         // switch levers, motors: solid for collision
  connectors: Connector[];
  trackPaths?: TrackPath[];   // sim geometry per route (switches: 2)
  roadLanes?: Lane[];         // lane centerlines, direction, turn links
  bomFlags?: ("power9V" | "powerPlastic" | "thirdParty")[];
}

type Connector =
  | { kind: "stud" | "antiStud"; pos: Vec3i; grid: 20 }
  | { kind: "trackEnd"; pose: TrackPose; system: string /* "lego-9v-plastic" */; gauge: string }
  | { kind: "roadEdge"; pos: Vec3i; heading: Rot90; lanePattern: string }
  | { kind: "moduleEdge"; profile: string; edge: "N" | "E" | "S" | "W"; slots: Vec3i[] }
  | { kind: "technicHole" | "technicPin"; pos: Vec3i; axis: Vec3i };

type TrackPath =
  | { kind: "straight"; from: number; to: number; length: Exact }         // connector indices
  | { kind: "arc"; from: number; to: number; radius: Exact; turn: number /* steps of 360/N */ };
```

### 5.2 Placement poses (layout)
```ts
type Rot90 = 0 | 1 | 2 | 3;
type LatticePose = { kind: "lattice"; x: number; z: number; yPlates: number; rot: Rot90 }; // x,z in LDU, multiples of 20 (10 where half-stud allowed)
type TrackPose  = { kind: "track"; n: 16 | 32; coeffs: bigint[] /* length n/2, studs */; heading: number /* 0..n-1 */; yPlates: number };
type Placement  = { id: string; ref: CatalogRef | ModelHash; pose: LatticePose | TrackPose; layer: Layer; locked?: boolean };
```
- **The world is unbounded.** Coordinates are signed integers in LDU. Plan coordinates need int32, which spans ±859 km, but the sandbox allows int53 (JS safe integers). Chunk key = `floor(x/640), floor(z/640)`. The renderer and validators always work relative to a chunk origin, so floats never carry large world coordinates.
- Models, baseplates and road plates always use `LatticePose`.
- *M1 S5 status:* a placement is one `World` row (`refId`, x, z, `yPlates`, `rot`); `refId` indexes the editor's catalog (the 3811 baseplate and the ten OMR sets). The model's float matrices never enter the `World`. The bake records each model's lattice phase (the majority integer x and z mod 20 of its lowest stud layer; a tie fails the bake) and its AABB. The client shifts the model so those studs sit at 10 mod 20 like a baseplate's, moves the pivot to the stud corner nearest the footprint centre, and puts the AABB bottom at y = 0. Module placement poses are exact integer lattice poses: x and z at multiples of 20, whole plates, and a quarter turn about that pivot. The model's own matrices are never altered, so any stud deviation from the baseplate lattice comes from the source file and is the same at all four rotations. Several OMR files place parts or submodels a few hundredths of an LDU off the stud grid. Until S6, every model sits on the baseplate top (yPlates 0). Removed slots go on a per-chunk free-list, and a `PlacementHandle` carries a generation so a stale handle is refused.
- *M1 S6 status:* the bake (§3.3 steps 6–8) also records each model's rest plane, its base footprint, and a 2.5D column per stud cell (bottom and top in whole plates above the rest plane). There is one physical table plane at y = −t, where t is the measured thickness of the 3811 body (`tablePlane` in `docs/verified-facts/geometry.json`). A placeable whose lowest stud layer lands on whole plates when its lowest vertex rests on the table plane, meaning its studs sit t above its underside modulo one plate, rests there, and its rest plane is the plane t above its underside. Any other placeable puts its underside on the plate lattice, so on bare ground it rests at y = 0 (its rest plane is its lowest vertex). No role, kind or thickness test is involved, so a loose 3811, the 3811 inside a MILS module or a user's model, a modular on its own baseplates and a user's model of road baseplates all end with their baseplate top at y = 0. A studs-only model on bare ground sits t above the physical table, because world poses are whole plates and resting it on the table would put its studs half a plate off the lattice. The footprint is probed at the model's lowest vertex. A column spans the lowest to the highest point of any part's real mesh (studs excluded) over the cell, read from the triangles clipped to the cell's square shrunk by the 0.05 LDU weld on each side, and counted only where the clipped area is positive. So a slope's low cells stop at its sloped face, an inverted slope's column starts at its underside, and a cell that a wedge, round corner or turned part only covers with its bounding box stays empty. Part AABBs only bound the cell grid. The client pivots on the footprint's bounding-box centre instead of the AABB centre (the AABB when the footprint is empty) and puts the rest plane at y = 0. The axis-aligned parts below the rest plane form the placement's slab, and two slabs never share space. `domain` keeps a per-chunk `Uint16Array` occupancy grid of column tops in plates. A placement's `yPlates` is the lowest height at which none of its columns goes below what is already in the grid: max over its occupied cells of (grid top − column bottom), and 0 on bare ground. The ghost shows one brick above that height.
- Track pieces use `TrackPose`. A track piece whose pose lands on the lattice (only the ζ⁰ and ζ^(n/4) coefficients are non-zero, and both are whole numbers of studs) may also claim stud support.
- *Track seating:* off-grid angles come only through connections (§2). A run drawn on open ground starts on the anchor's stud corner facing the nearest quarter turn, and a held piece on open ground turns in quarter turns. A piece with two lattice ends (straight, switch, crossing) always lands with its body on the lattice: held by a lattice end, that end sits at the cursor; held by an off-lattice end (a switch's branch), the body takes the nearest quarter turn and stud corner and the end lands within half a stud diagonal of the cursor. A curve has one lattice end, so the held end sits at the cursor. Exact poses map to floats through the reduced basis (c₀ + (c₁ − c₇)cos π/8 + (c₂ − c₆)/√2 + (c₃ − c₅)sin π/8, and likewise for z), so a lattice pose is exactly whole studs at every heading and distance and a quarter turn maps (x, z) to exactly (−z, x).

### 5.3 Exact track arithmetic
This comes from connection rules §4.3, generalized for D3.
- Positions live in ℤ[ζ_N] with N = 16 today. Each position is stored as N/2 integer coefficients in studs, and each heading as k ∈ ℤ_N.
- A straight adds 16·ζᵏ. An R40 curve adds the exact arc chord in the field.
- Two track ends **join if and only if their coefficient vectors are identical and their headings differ by N/2.** There is no epsilon.
- When a layout mixes N = 16 and N = 32, poses embed into ℤ[ζ₃₂] through ζ₁₆ = ζ₃₂², so adding fan track later doesn't migrate existing layouts.
- Parts whose poses fall outside the field get an exact algebraic pose from their data, compared with ε = 1e-6 LDU to absorb representation error only. Some switches may fall in this group, and flex track does (P1+).
- **Importing poses from LDraw decimals (project decision, delegated by the owner, 2026-11-16).** LDraw prints connector poses with 3 to 6 decimals, so a pose read from a file is identified with a field element when its residual to the unique ℤ[ζ₁₆] candidate is ≤ 0.0005 LDU per coordinate, half the last decimal of 3-decimal data. The candidate must be the only one in the search box (|c₀|, |c₄| ≤ 64 and |cₖ ± c₈₋ₖ| ≤ 64) within the file's printed precision. This is a data-identification tolerance used once, at import. It isn't physical slack and isn't the join ε: joins still compare the exact coefficients.
  - **Read per coordinate (approved 2026-11-18).** The rule says a pose "is identified with a field element when its residual to the unique ℤ[ζ₁₆] candidate is ≤ 0.0005 LDU, half the last decimal of 3-decimal data". Its stated basis is a bound on rounding each printed coordinate. So the residual is read per coordinate, the L∞ norm: every coordinate is within 0.0005 LDU. This matches how connector origins and axes are identified one component at a time (connector-engine plan §2.3). The field search (`findZeta16Representation`) and the track catalog's `residualLdu` report this per-coordinate residual, so the recorded number is the one the rule compares.
  - **At the limit (owner decision, 2026-11-18).** A sixteenth printed to three decimals (x.0625 as x.063) is exactly 0.0005 off, so it sits on the inclusive limit and identifies. In double precision the deviation lands a hair on either side depending on magnitude: 20.063 came out under the limit, while 0.063 and 100.063 came out at 0.0005000000000000004. That made the outcome arbitrary.
    - **Part-local identification** compares the parsed decimals exactly, in rational arithmetic, wherever they're available.
    - **Model-frame identification** compares against 0.0005 plus a 1e-9 LDU representation guard, because its values come from Float64 matrix products. The guard sits beside the join ε (1e-6) and, like it, absorbs representation error only and is never physical slack. It's six orders of magnitude below the residual.
    - Native and WASM builds give the same result at the limit, and tests pin that.
  - **Rail heads at track ends (owner decision, 2026-11-18).** The same 0.0005 LDU residual identifies each track end's rail head bands to a measured rail. The bands are measured on the end face along the end's identified normal. Official rail heads end in a half-lap, so the face carries only half of each head; the face's bands are closed with their image under the joint's half-turn about the vertical through the connector (negated lateral offsets), which is what a mating end of the same kind supplies, and must merge to exactly two bands. A band and its half-turn partner merge when they overlap or their gap is within the same 0.0005 LDU residual, because the seam ends are band ends identified like the outer ones. All four band ends must then lie within the residual of the unique `geometry.json` `rails[]` entry. Only connectors whose pose is certified (`status` is `certified` and `residualLdu` ≤ 0.0005) are identified; the rest record no rail and are reported as "pose not certified". The result is recorded per connector, once, at the pipeline and import boundary. Exact equality can't work here: curve ends sit at odd multiples of 11.25° and LDraw prints their vertices as rounded decimals. The two measured rails' bands are 0.475 LDU apart, so the candidate is unique. This isn't a join or contact tolerance: wheel-on-rail contact compares exactly with the `rails[]` decimals. An end that identifies to no rail (32087's 7 LDU heads) is reported and left out of rail-fit checks.
- **Identifying placed track in an imported model** (`modelTrackEnds`) applies that rule to every catalog track piece. It reads only the Float64 part transforms, never the Float32 render copy.
  - **Why not each end directly:** the search box holds about 1,049 candidates within 0.0005 LDU of a point, so no end's float position has a unique candidate on its own. Uniqueness is obtained in the steps below.
  - **Rotation, per printed entry:**
    - The heading is certified like an axis code. Each of the four plan rotation entries must lie within 0.0005 of the exact cos or sin of θ = k·22.5° plus the profile's half step (the part frame's heading offset), for one k ∈ ℤ₁₆.
    - Headings 22.5° apart differ by 0.39 in (cos θ, sin θ), and so by at least 0.27 in one entry, so the certified heading is unique.
    - A shear, a scale, a mirror or an angle off the ζ₁₆ steps doesn't certify, and the piece is `overLimit`.
    - Ends are then composed from the exact ζ₁₆ rotation, so the printed rotation decimals never multiply a connector's distance from the part origin. The residual measures the translation only. The placement is read from the translation with ζ₁₆ᵏ applied exactly.
  - **Seat (stud seating):**
    - A piece whose certified heading is a quarter turn, and whose placement is within 0.0005 per coordinate of a lattice pose (`isLatticePose16`: whole-stud x and z, quarter-turn heading), is anchored on that pose.
    - An axis-aligned track piece on a baseplate is on the lattice through its stud mates. Lattice poses are 20 LDU apart, so the seat is unique.
  - **Window anchor:** any other piece's placement offset from the nearest whole-stud point must be the only candidate in the search box within 1e-6 LDU on each axis. The stud lattice is an exact symmetry of the field, so the whole-stud shift lifts the box's limit on c₀ and c₄ without loosening uniqueness.
    - Two candidates in the box differ by an element whose coefficients lie within twice the box (128). The smallest nonzero such element is 3.86e-6 LDU on its larger axis, more than the window's 2e-6 LDU diameter, so the window never holds two candidates. A math test pins this.
    - This uniqueness covers only offsets inside the box. An offset always lies within a stud of the lattice, but its coefficients grow with every turned piece between it and a whole-stud point. In a 1,020-piece test layout they reach 208, and about half the offsets fall outside the box. For such a piece the search finds no candidate, or rarely a stray one.
    - A window candidate is only as good as the translation's printed precision. A 3-decimal translation lies up to 5e-4 LDU from its true offset, and about 0.5% of such points have an unrelated candidate inside the window. Before the rule below, a layout with 3-decimal translations had 21 of 1,020 pieces identified at exact but wrong poses.
  - **One embedding per run:**
    - Seats anchor first, then window anchors. Each anchor spreads through joins, and every anchor in the reached run votes for the shift between its own pose and the propagated one.
    - A shift is corroborated by a seat, or by at least two agreeing window anchors; correct anchors agree with each other, and strays don't. The run takes the corroborated shift with the most votes.
    - No corroborated shift leaves the run `noAnchor`. A tie is a contradiction.
    - Every other vote implies a rival embedding of the run. A piece whose data passes 0.0005 under both embeddings has two field candidates, and is a contradiction.
    - So a quarter-turn straight at the box element 3.59e-5 LDU from a stud point is never seated silently: if a neighbour's own anchor implies that true pose, the straight is a contradiction.
  - **End consistency:** a placement is accepted only if every composed end is within 0.0005 LDU of its exact ζ₁₆ end in each coordinate. Neighbour lookup searches twice that distance, because two float ends of one exact end can each be 0.0005 off. Acceptance still compares each float end with the exact end.
  - **Propagation:** a piece whose float end meets a certified exact end with the opposite heading takes the placement that end implies through `attachPose16`. Exactness follows the joins, so a piece whose offset leaves the box is identified only through them, however large its coefficients grow.
  - **Contradictions are off-field:** a piece whose passing candidates disagree is reported, never snapped and never joined. Its candidates can come from different neighbours, from a neighbour and its own anchor, or from rival embeddings. A loop that closes only approximately is reported this way, not forced shut.
  - **Every unidentified piece is reported with a reason:**
    - `notFlat`: it isn't flat, or it sits between plates.
    - `noAnchor`: nothing gave it a candidate. Neither its own anchor nor a certified neighbour did, and no certified neighbour's end faces one of its ends within the near-miss radius.
    - `overLimit`: its rotation doesn't certify, a candidate missed 0.0005, or one of its ends misses a certified neighbour's.
    - `contradiction`: two field candidates within 0.0005 LDU.
    - The editor counts `noAnchor` pieces separately from off-field ones.
  - **Printed precision of real files:**
    - Files that print 6 decimals are identified completely.
    - At 3 decimals, every run with an axis-aligned piece on the lattice is identified: the R40 circle 16 of 16, and a quarter-turned 117-piece set 117 of 117.
    - **Known limit:** a run turned off the quarter turns as a whole has no seat.
      - At 3 or 4 decimals it has no window anchor either, so it isn't identified on the field. At 5 decimals that happens only when two window anchors happen to agree: one 33-piece arrangement of the 117-piece set, and none of the 22 such runs in the 1,020-piece layout. At 6 decimals it is identified.
      - Below that, it is identified in a run frame (next bullet), not on the field.
    - No piece is identified at a wrong pose in any of these cases.
- **Run frames: unanchored runs identified up to one shared translation.**
  - **The idea:** inside one imported model, a run's relative poses are exact compositions of certified profile vectors, given the certified headings and which ends join. So the run is identified up to one unknown translation t. That is the same structure the absolute rule has, minus the anchor.
  - **Who takes part:** every piece whose only failure is the anchor. That means `noAnchor` pieces, and pieces labelled `overLimit` only because an end misses a certified neighbour's within the near-miss radius. Never a contradiction, a rotation that doesn't certify, or a piece whose own candidate missed 0.0005.
  - **Joins:**
    - Two such pieces join when their float ends are within the neighbour lookup's reach, on the same plates, with exact headings half a turn apart.
    - An end with two partners, which a duplicated piece gives, makes every piece involved a contradiction.
    - Relative poses spread breadth-first through `attachPose16` from a root at the origin. A piece reached twice with different exact poses (a loop that doesn't close exactly) makes the run a contradiction.
  - **The test:**
    - Per coordinate, t must lie in the intersection over pieces of [fᵢ − Δᵢ − 0.0005 LDU, fᵢ − Δᵢ + 0.0005 LDU]. Here fᵢ is the float placement and Δᵢ the exact relative position. With exact rotations, an end's residual equals its placement's residual.
    - An empty intersection makes the run a contradiction, and a run needs at least one internal join.
    - This is the per-coordinate rule applied to the run as a whole. There is no new tolerance, and no field search, so there's no density problem: the joins fix the relations combinatorially.
  - **What the run frame is:** exact relative `Pose16`s and a float centre t̂ of the interval. Joined runs pass or fail as a whole; nothing is split to make one pass. Runs that come near without joining keep separate frames, and their gap is reported as a near-miss gap.
  - **Track graph:**
    - Each placed run gets a frame id, and `TrackLayout`, `TrackGraph` and `TrackEnd` carry it. Join keys include the frame, so ends join only inside one frame.
    - A run-frame end never joins world track or another run frame, even at the same exact pose.
    - `ModelConnectors` refuses a run-frame end, so it can't join another model's track either.
    - Drawn track can't attach to a run-frame end.
  - **Play and views:**
    - Play and the views use the float placement: the model's exact lattice frame, then t̂ rotated by the model's quarter turn, then the exact relative pose.
    - A train runs on a run frame's own graph, closed loops included.
    - No absolute ℤ[ζ₁₆] pose is ever claimed for run-frame track. If a later rule anchors one of its pieces, the run becomes absolute through the existing propagation.
  - **Validity:**
    - A run frame's internal joins satisfy the track rule (ends join exactly), so a closed run frame with no open ends counts toward Valid.
    - Its open ends are ordinary open-end errors unless capped by a buffer or marked open by the user, because no external join is possible.
    - All other rules apply unchanged. Run-frame track never claims stud support: off-lattice track must rest on flat support.
  - **Panel:** the editor counts model pieces on the field, in a run frame, and off the field or unanchored, on three rows.
- Every track part's connector poses are **imported from data and tested against the field at build time. Nothing is hand-coded.**

### 5.4 Profiles
`TrackProfile` holds the system, gauge class, angle step N, minimum radius, parallel spacing, clearance envelope and flags.

`ModuleProfile` holds module size, surface height in plates, edge connector slots, track centre from the edge, sidewalk depth, lane width, and ballast width and height.

Each `ModuleProfile` also carries a **substructure recipe**: the parts needed under one module (for MILS, the raising bricks, cover plates and Technic join bricks, per 32×32). The plan BOM includes these parts, so "buildable as planned" counts the hidden parts too.

The MVP ships four module profiles: `free`, `lego-modular`, `mils` and `club-road`. Numbers are filled in only once their verification item in §11 is cleared; until then a profile's rules show as "unverified" warnings. The cleared numbers, with sources, are in `docs/verified-facts.md` (Module standards):

- **`mils`** is MILS core only, as published in HispaBrick Magazine I–IX. It has 32×32 modules with the ground 4 plates above the baseplate (edge tolerance one plate). Each corner keeps a free 2×2, then a 1×4 Technic brick along each adjoining edge (8 per module). Paved roads are 16 studs wide, centred, with the surface at 5 plates. Paths are 4 studs and earth tracks 8 studs, both at 4 plates. Rivers are 8 studs, with water at 2 plates. Road and river curves are single 90° elements. The substructure recipe is the published minimal module: a 32×32 baseplate, 4 bricks 2×2, 8 Technic bricks 1×4, 8 bricks 2×4 and 4 plates 16×16 (25 parts).
- **`club-road`** is separate from `mils`, not a parameter of it, because club road systems are incompatible with MILS roads and with each other. Its defaults are L-Gauge MultiRoad: streets at 6 plates and walkways at 8 plates above the baseplate, against 5 plates for a MILS paved road. The sidewalk width is set per club (4, 5 or 6 studs are all in use), and there's no shared standard.
- **`lego-modular`** has a 32×32 footprint, joined by 1×2 Technic bricks on the first course at stud cells 9–10 and 21–22 of each joining edge, as modelled in the LEGO modular-building OMR files. Sidewalk depth isn't standardised. Its joins don't line up with MILS's corner joins, so mixing the two needs an adapter rule.
- **Track on modules:** MILS publishes no City or Train rules and no ballast standard, so track on `mils` modules needs a project decision. The one firm convention is 16-stud spacing between parallel track centres, which the 9V switch plus a reversed R40 curve gives exactly. *Decision (2026-11-17):* the rail module template is the basic terrain module with one pair of 9V straights centred on two opposite edges, on the 4-plate surface without ballast, and is labelled a project rule, not MILS. R40 curves don't fit a 32×32 module, so there's no rail curve template. As on MILS train modules built from 16-stud track sections (S18 in `docs/verified-facts.md`), the track's connectors sit exactly on the centres of the two rail edges, laid from the exact ℤ[ζ₁₆] piece poses onto integer LDU. The 9V end tongue reaches 9 LDU past the edge: it's part of the track end, a declared connector under §7.2 rule 4, and the owner's decision of 2026-11-17 lets a track piece's end tongue overhang a baseplate edge or a seam.
- **Module templates:** the palette's MILS modules are generated by `tools/asset-pipeline/src/mils/mils-modules.ts` from `mils-profile.json`: basic terrain, paved road straight, curve, T-junction and crossroads, earth track and path straight and curve, river straight and curve, and the rail module. Every edge is checked against the feature widths and heights above when the template is written. In the editor the templates are listed and placed like any other model and keep their credits. There is no module grid, edge classification, rail-edge refusal or track-tongue space. Only resting and the slab still read the bundle's `role: "mils-module"`: a template rests on the top of its own baseplate and keeps the slab below it, until one table plane replaces that branch for every model (`docs/connector-engine-plan.md` §2.5, E10). Module joins come back from real stud, anti-stud and Technic mates for any model (E6), and MILS road and river continuity comes back as an advisory check on the sampled edges of any model.

**Road plates.** The current LEGO road system (set 60304 and later) is official in LDraw as 69958 (16×16) and 71772/71772p01 (8×16). These are 2-plate-thick plates, not 32×32 baseplates. Their studs stand in pockets 1 plate below the top face, lane markings are separate 2×4 tiles laid in those pockets, and there are no clips. A 32×32 road chunk is four 69958s. The road layer therefore needs a "plates plus inlay tiles" model, and the stud-occupancy grid must handle studs below the top face. The classic 32×32 road baseplates stay supported.

**Drawing track to an open end.** When a drag ends on an open end, the editor suggests only a closure that joins it exactly and crosses nothing, or nothing at all. A closure is valid when no piece overlaps placed track at the same height, another piece of the same closure, or what the placed geometry offers it. That is read from geometry alone, the same way for a loose baseplate or road plate, a MILS module or a set, and never from what kind of thing a placement is: any measured part box that reaches into the track's height band is solid, and any part whose top face is the plane the track rests on must carry a stud, at that plane, under every stud cell the piece covers. So a baseplate's studs seat track, a road plate's roadway (which has no studs) refuses it while its sidewalk studs seat it, and a road plate inside a set is judged by exactly the boxes and studs it has there. Open ground, where nothing has its top face at that plane, is the sandbox table and stays free. Each piece's plan outline is the convex hull of its own mesh, which the pipeline bakes into the bundle's `trackShapes` (editing code never reads a mesh), placed at its exact pose; boxes that only touch don't overlap, and the only overlaps excused are a piece with the piece it joins. Among valid closures the editor prefers the fewest pieces, then the shortest centreline, then the fewest changes of direction: the exact algebraic minimum when it fits, else the cheapest valid run of up to three turns, else a bounded best-first search over exact poses. If none is found, the ghost is empty and release lays nothing ("blocked"). The free drag away from any open end is unchanged and isn't checked.

**Drawing roads.** Road kits are derived from the bundle, never listed by hand. Every road surface (a road plate) has a cell map of top, stud base and road flag. A side whose edge cells include a road cell is an *arm*. Square, centred pieces whose arms all share one edge pattern (for example 6 + 20 road + 6 studs on the classic 6-stud plates) and one colour form a kit. A kit offers whichever of straight, curve, T-junction and crossroads its pieces cover, and the palette shows the missing shapes. A drag becomes a 4-connected path of kit tiles: on the grid of an existing compatible plate under the start of the drag, or on the 32-stud chunk grid. Consecutive tiles need an arm towards each other, and a tile also connects into any compatible open road end facing it. Each tile gets the piece and quarter turn whose arms match exactly, or the smallest superset (a lone tile or a dead end becomes a straight). An existing plate of the same family on the path is swapped for the piece with its old arms plus the new ones, so branching off a straight lays a T. A plain baseplate with exactly the tile's footprint at plate 0 is swapped for the road piece, so a road can be drawn across a laid-out baseplate grid. Nothing else counts as ground: any model under a tile refuses it as an overlap. Every proposed piece is checked with the rule-7 join check: any mismatch, overlap or missing shape refuses the whole stroke with a reason per tile, and nothing is laid. A valid stroke is one undoable edit.

**Erasing roads.** In Erase, a drag lifts the active kit's plates under the stroke (never another family's). A junction left beside them becomes the smallest kit piece that covers its remaining arms and has fewer arms than before, exact matches first; if the kit has no such piece, or no arm is left, the junction stays and is reported. A plate laid over ground gives back exactly the ground piece that stroke swapped out (part, colour, pose), remembered per placement through later upgrades, undo and redo; a plate laid on an empty table is just lifted, so erasing never adds or recolours a part. The stroke is one undoable edit, and downgrades pass the same join check as drawing.

Third-party track arrives later as an extra `TrackProfile` plus a `PartSource` (§3.5).

## 6. Renderer

**Scene model.** The world is a **sparse, unbounded hash map of 32×32-stud chunks**, one per baseplate or MILS module, grouped into 8×8 super-chunks. Each chunk holds placements. The renderer draws **model instances**: a model placed 20 times is drawn instanced, and every track and road piece is instanced too.

**Streaming (D4).** The camera chooses a tier for each chunk. Near chunks load fully. Mid and far chunks load only their merged or voxel model meshes. Super-chunks beyond the far radius stay unloaded and show as a super-chunk far LOD, or as a flat ground color until that exists. Super-chunk shards load from IndexedDB on demand, so a world's total size doesn't affect frame time. Super-chunk far LOD moves from P1 into M6.

**Camera-relative rendering (M1 S4).** World positions are exact integer LDU, up to the whole int32 range. float32 has a spacing of 2 LDU at 10 km, so no world-scale coordinate is sent to the GPU. The renderer keeps a render origin at a chunk corner: chunk groups are placed at (chunk origin − render origin) and the camera at (eye − render origin), with both differences taken in float64 from exact values. While the camera moves, the origin stays put until the eye is more than 8 chunks away, then moves to the eye's chunk. That's hysteresis, so an orbit rebases about as rarely as it did in S4. Once the eye has been still for 250 ms, the origin moves to the eye's chunk if it isn't there already (S9). A camera at rest therefore always renders from the same origin, and a reload from a saved camera draws the same pixels however the camera got there. Each move is logged with its frame number; the log keeps the last 256, and the HUD counts them all.

**Plan overlay.** Plan regions draw their room walls, table tops (with their real heights as optional plinths), obstacles, aisles and reach zones as translucent overlays, with mm/cm/inch rulers. An optional "real table" view hides everything outside the region.

**LOD per model**, chosen by screen size:
| Tier | Geometry | Studs |
|---|---|---|
| Near | Per-part instancing (one `InstancedMesh` per part per 32×32 chunk, chosen in M0 over `BatchedMesh`; see §11 item 9), LOD0 or LOD1 parts | Instanced stud stream, covered studs removed |
| Mid | Merged model mesh built from LOD1 or LOD2 parts | 8-segment studs without logo, or a normal map |
| Far | Voxel greedy mesh of the model (1 stud × 1 stud × 1 plate) | A procedural pattern computed from `worldPos mod 20` |
| Very far (M6; impostors P1) | Voxel greedy mesh of the whole super-chunk, then impostors | none |

*M0 status (2026-11-16, slice 3):* the city picks a tier for each 32×32 chunk every frame from the projected stud pitch (near ≥ 12 px, mid ≥ 3 px, else far). Near draws the standard parts and the standard stud stream. Mid and far draw a far LOD instead of merged or voxel meshes: the `p/8` part triangles minus those the part itself appears to hide from above.

The far-LOD visibility test is sampled, not exact. A triangle is kept if any of 7 points on it (the centroid, plus points near each vertex and each edge midpoint) has an unblocked ray, on either face side, along any of 1,024 upper-hemisphere directions or a 64-direction horizontal ring, cast against the part's own triangles. An independent dense re-check (7 points, 512 + 64 directions) finds:
- 3001, 2412b and the other city bricks, plates and tiles: no visible dropped triangle;
- 3062b: nothing dropped;
- 53401: 1 visible triangle out of 1,203 dropped, covering 8 of 51,081 LDU² through 0.17% of directions.

The earlier 64-centroid-ray version dropped 122 visible 53401 triangles and all of 3062b's 60. "Above" means the part's own +Y, so the far LOD is valid only for upright parts. Mid adds 8-segment studs, and far drops studs. The M0 city also culled covered studs per chunk by part role; that path was deleted with the city on 2026-11-18, and covered studs now come only from each model's baked stud cover and the footprint rule below. The super-chunk meshes and impostors aren't built yet.

*M1 S7 status (2026-11-16):* baked models tier like city chunks. Near is unchanged. Mid draws the far-LOD shells for upright instances and the full part mesh for any instance whose own +Y isn't world +Y, because the self-hidden test only holds for upright parts. Far draws the model's voxel greedy mesh instead of its parts. The far bundle carries one `model-<name>-far.glb` per model. Its mesh has one primitive per LDraw colour, and its extras hold the voxel grid (`origin`, `dims`, `cellLdu` [20, 8, 20]) with two uint32 accessors, `voxelCells` (x + dims[0]·(y + dims[1]·z)) and `voxelColors`. The grid phase comes from the model's lowest stud layer, the same rule placement uses (`lattice.rs`). A cell is occupied if any standard-LOD body triangle (studs excluded) meets the cell's box, shrunk by 0.1 LDU on every side, over a positive area. Its colour is the one with the largest clipped area, opaque colours first; areas within 1e-6 LDU² of each other count as a tie, and the lowest colour code wins. Chunks mark the part instances a voxel mesh replaces with `ChunkInstances.voxelized`. `ISceneBackend.setFarModel` registers each placed model's voxel mesh along with every chunk its parts landed in. The mesh shows whenever any of those chunks is far, so a model split across chunks never has a hole. The only overlap is a voxel mesh over mid shells at about 3 px stud pitch: a model spans under 700 LDU, so its chunks can't be near and far at once. A model whose bake finds no stud lattice gets `farMesh: null`, and viewers draw it with no far model, so its far chunks draw the parts' shells. A model's `notDrawn` sections never reach its far mesh. Each far GLB carries `extras.ldraw` (the model's file, source, section authors and licenses, a modified-from-LDraw note describing the voxelization, and every LDraw file that shaped it), and the far bundle's credits include those files. `?tier=near|mid|far` forces a tier, and in the editor L cycles it.

**Studs.**
- Studs inside a model are culled when the model is baked.
- Baseplate and road-plate studs under a placed model's base footprint are culled at placement time, using a per-chunk occupancy grid.
- We never draw a logo.

*M1 S6 status:* a stud is culled at bake when two tests pass.
- **Enclosed from above:** one other opaque part of the same model has its bottom plane at the stud's base (same up direction, within the compiler's 0.05 LDU weld tolerance) and encloses the stud's volume. The test probes the stud's axis and four points at 0.9 of its radius, at half its height; the stud's height and radius come from the compiled stud primitives. From each probe, rays at the zenith and at elevations 0°, 30° and 60° in 16 azimuths (every 22.5°, so including the lattice axes and diagonals) must all hit that part's opaque standard-LOD triangles.
- **Closed below:** from points just outside the stud's surface at 8 heights ((k + ½)/8 of its height), rays every 2.5° from −2.5° to −90°, along the stud's own 64 azimuths and the model's 64 lattice-axis azimuths, must each hit opaque geometry of any part of the model within 3 studs (60 LDU). This keeps the edge studs under an overhang, which are visible from below through the open underside.

A triangle whose resolved colour has an LDConfig `ALPHA` below 255 neither covers nor blocks. The model's visible studs ship as a bitset in the model file, and the editor and `?model=` viewer (`view=below` orbits under the model) drop culled studs before building the stud stream. A footprint cell is a lattice cell at the model's lowest vertex where a hypothetical upright stud would be enclosed from above. It is *flat* when a ray straight down from the probe also hits the part (a solid bottom, such as a modular's own baseplate), and *anti-stud* otherwise. At placement, a stud of any placed thing (a baseplate, or a lower model's roof) is dropped when its integer cell lies in another placement's footprint and its integer base height equals that placement's rest plane in LDU. Under an anti-stud cell, all 8 neighbouring cells must also be closed at that height by another placement's column; otherwise the stud could show from below. Off-lattice or non-upright studs are never dropped.

**Look.**
- A plastic material: roughness about 0.25, a clearcoat lobe and calibrated LDConfig colors.
- IBL lighting, SSAO or GTAO, and an outline pass driven by instance id, normal and depth (the default).
- A bevel-normal shader trick for rounded edges, plus optional baked bevels on LOD0.
- One cascaded shadow map rendered from the mid tier.
- Weighted blended OIT for transparent parts.
- Optional instruction-style edge lines on the near tier.

*M1 status (S8):* every item above except the baked LOD0 bevels and the instruction-style lines is in `render`, each toggled by the viewer's `look=` parameter (`plastic`, `gtao`, `outlines`, `bevel`, `shadows`, `oit`; `all`, `none` for M0's lighting and material, a list, or `-name` to drop one from `all`).
- **Transparency in every mode, including `none`:** LDConfig colours with `ALPHA` below 255 get their own instanced meshes and materials and blend. This is a correctness fix: M0 drew them opaque. So `none` matches M0 pixel for pixel only where nothing is transparent.
- **Defaults** follow the M1 rule that a pass is on by default only if 250k aerial stays under 16.7 ms on the M4 Max with it. Measured at `50c281b` (median ms, WebGPU / WebGL2, a loaded machine): `plastic` 14.9 / 15.2 and `plastic,outlines,bevel` 14.7 / 15.3 are on; `gtao` 22.8 / 15.3, `shadows` 22.5 / 18.1 and `oit` 17.5 / 15.1 are off. Without OIT, transparent parts use three's sorted alpha blending.
- **Material and light:** roughness 0.25 for the diffuse base with its specular turned off, and the ABS surface reflection as a single clearcoat lobe (strength 1, roughness 0.08). A specular lobe at the base roughness spread the sun's reflection into a wide glare that washed flat track and plates near white wherever the camera sat near the mirror angle. The scene is lit by a sun, a diffuse-only hemisphere fill and a procedural sky dome as IBL. Intensities are calibrated so an exposed top face renders close to its LDConfig sRGB value.
- **Post:** the scene pass is single-sampled with a G-buffer of RGBA8 normals and RG16F ids, and FXAA runs last on both APIs. GTAO at CSS-pixel resolution multiplies the scene colour. Outlines come from an id, normal and depth G-buffer: silhouettes where the neighbour lies behind and off the centre pixel's tangent plane, seams between different parts on one surface, and concave creases. The bevel trick shades convex creases with the averaged normal of the two faces. Edges fade with the projected stud pitch.
- **Shadows:** one sun `CSMShadowNode` (3 cascades, 2048²). Casters live on their own layer. In tiered scenes each chunk casts from one instanced unit box per opaque part, scaled to the part's bundle bounds. Scenes without tiers cast from the detailed geometry. Transparent parts don't cast.
- **OIT:** three's `OITPassNode` (McGuire and Bavoil).
- **Frame cadence:** three's pass and shadow nodes refresh once per animation frame, so measured frames each wait for one `requestAnimationFrame` before the timed submit-to-GPU-done interval.
- **2D plan view:** the editor's plan view renders through an orthographic camera and skips the post pipeline, so it has no outlines, bevel glints, GTAO or FXAA; the plastic material, IBL and shadows still apply. The edge pass assumes a perspective camera throughout (`perspectiveDepthToViewZ`, a view direction per pixel, edge fade by projected stud pitch at each depth), and three's pass and GTAO nodes bind one camera when they are built. Outlines in the plan need a second `LookPipeline` built for the orthographic camera, with orthographic view depth, a constant view direction and a stud pitch from the plan's scale, which is a separate change to the look pass.

**Picking.** GPU id picking at model granularity. Under D2 nothing below model level is ever picked, except switch levers and vehicles. *M1 S5 status:* the editor picks on the CPU: a ray against the ground plane (y = 0, the baseplate top) for placement, and against each placed model's world AABB for selection. A placed model's part and stud instances go into the render chunk that contains each instance, and only the chunks it touches are rebuilt.

**Budgets** (Tier A: Iris Xe, Apple M1 or Radeon 680M at 1080p and 60 fps):
- GPU ≤ 12 ms and main-thread render CPU ≤ 4 ms.
- ≤ 5M visible triangles.
- ≤ 1 GB GPU memory.
- Placing a model shows up in ≤ 50 ms; rebuilding the far LOD takes ≤ 1 s and runs asynchronously.
- A 250k-part layout is interactive in ≤ 10 s cold and ≤ 3 s warm.

**Upgrade path.** `SceneBackend` takes chunked lists of model and part instances. If M0 or M6 fails the gates, a custom WebGPU backend can replace three.js underneath it without touching the data model. That backend would use compute culling, Hi-Z occlusion and vertex-pulling indirect draws (engine stack §4).

## 7. Validation (scoped by D2)

### 7.1 Model badges (computed at import, never blocking)
| Badge | Check | Needed for |
|---|---|---|
| L1 Real elements | Every (part, color) pair is in the element-existence table | "Real set", "Verified model" |
| L2 Matches set N | Normalized BOM diff against the Rebrickable inventory: *exact*, or *buildable from* the set (combined inventories for multi-set builds). Prints relaxed by default. | "Real set" |
| L3 Structure (P1) | Connection graph from the LDCad and inferred connectors: no floating parts, no interpenetration outside connection zones | "Verified model" |
| Provenance | The model contains unofficial, custom or placeholder parts | Shown as a warning |

Failing a badge never blocks placement. Users fix their bricks in their own CAD tool and re-import. Stability analysis is out of scope.

### 7.2 Layout rules (live and exact; they decide whether a layout is "Valid")
1. **Real catalog items only.** `thirdParty` parts are refused unless `allowThirdParty` is on, which it isn't in this release.
2. **Lattice placement.** Models, plates and baseplates sit on the 20-LDU lattice with 90° rotations, at whole plate heights.
3. **Support.** A placed model's base footprint engages at least one stud of what lies beneath it, or rests fully on a flat area at one height.
4. **No overlap.** Placements' occupancy and keep-out volumes don't intersect, except at declared connectors.
5. **Track.** Ends join exactly (§5.3). Open ends are errors unless capped by a buffer part or marked open by the user. Track at an angle off the lattice can't claim stud support and must rest on flat support. A connected run stays at one height (the MVP is flat).
6. **Clearance.** The profile's parallel spacing is respected, and the swept envelope of the widest and longest consist placed on a layout is checked along curves and switches. S-curves without a straight between them get a warning.
7. **Roads.** Road edges that meet have equal lane and curb patterns. Level crossings must use real crossing parts.
8. **Modules** (when a profile is active): modules are on the 32-stud grid, edge connectors are present and aligned, and the surface height matches the profile.
9. **BOM flags.** Third-party parts, mixed 9V and plastic track in a powered loop, and any use of the optional "real-world play" tolerance mode (off by default and never counted as Valid).

Layouts can always be saved in an invalid state. They then show as **Draft** with a list of issues.

**How strictly rules apply depends on the mode (D4).**
- In the **sandbox** (outside plan regions), rules 1 to 9 show as warnings. Building never stops.
- Inside a **plan region**, the same rules are errors, and a region can only reach "Buildable as planned" (§7.3) with zero errors.

### 7.3 Plan regions and "Buildable as planned"
A plan region is a polygon in the world, aligned to the 32-stud grid, linked to a **physical footprint**:
- the room outline, doors and obstacles;
- tables: polygon, height and seams;
- access aisles;
- a maximum reach depth.

These are drawn in mm and snapped to the stud grid at 8 mm per stud. Room scans or imported floor plans come later.

Extra plan rules:
1. **Fits the footprint.** Every placement in the region lies on a table top, and nothing overhangs a table edge beyond the profile's limit (0 by default).
2. **Reach.** Every point of the layout is within the maximum reach depth from an aisle or table edge you can access. The default depth is an owner decision (§12).
3. **Seams.** Table seams fall on module boundaries, with a warning for any track that crosses a seam off a module edge.
4. **Complete BOM.** Every part is mapped to Rebrickable and BrickLink ids. Nothing is a placeholder. Substructure, baseplates, track and road plates are all counted.
5. **Real elements.** Every placed model has badge L1. Models claiming to be sets have badge L2, either exact or "buildable from".
6. All layout rules from §7.2 pass with zero errors.

**Plan outputs:**
- a BOM for the region and for each module, in two views: "whole sets vs loose parts" and "own vs buy" (using an imported Rebrickable collection or CSV);
- Wanted List XML for the shortfall;
- a printable plan: a dimensioned top view on the tables, module numbering, track piece positions, switch ids, and one sheet per module listing its pieces and models;
- the plan exported as an LDraw `.mpd`.

## 8. Simulation

- **Where it runs.** A fixed timestep of 60 Hz in a worker. Simulation state is kept separate from render state, so it can run headless in tests.
- **Track graph.** Derived from track-end joins. Nodes are the joined ends, each with a pose. Edges are the part's `trackPaths` (straight or arc, with exact length). A switch is a node with one entry, two exits and a state. Each physical edge gives two directed edges, so reversing loops and wyes work.
- **Trains.** A consist is an ordered list of vehicles. Each vehicle has a length, bogie offsets, coupler points, max speed, acceleration and braking, a power system (9V, PF, PU or none; cosmetic) and discrete power steps.
  - A train's position is (directed edge, offset). Cars are placed by walking back along the path, and bogies pivot.
  - Control is manual throttle plus "go to": A* over the directed graph, throwing switches automatically.
  - The MVP prevents collisions by stopping a train on occupancy. Fixed-block signals come in P1.
- **Vehicle data.** A sidecar file attached to the model hash holds the kind, bogies, couplers, axles, length and suggested minimum radius. It can optionally round-trip as `0 !BRKRR VEHICLE ...` metas in the LDraw file.
  - Bogies must be separate submodels. When they aren't, the user re-exports from their CAD tool.
  - A metadata-only "designate parts as bogie" tool is P1. It groups parts and doesn't edit any.
- **Roads (P1).** Lanes are directed edges with turn connectors at intersections. Cars use IDM-lite car-following. Intersections start with first-come or stop-sign rules, with traffic lights later, plus ambient traffic.
- **Derailment at open ends (in scope now, manual Play mode only).**
  - **Rule.** A manually driven train under the opt-in `derail` open-end rule doesn't brake for an open end. It keeps running until the leading axle of its leading guide leaves the rail, taken from the imported running-gear geometry. Then it derails and skids to rest along the end's tangent. A train that stops with only its front overhanging stays on the rails. Rerail puts a derailed train back at the track end.
  - **What doesn't change.**
    - Routed and autopilot trains still stop where their route ends.
    - The default `brake` rule still stops every train short of an open end.
  - **The skid** at the train's braking rate is a game choice, not a physical model.
  - **Decision.** Made by the project coordinator under the owner's delegation of design decisions, to serve the owner's request for a product that is fun, playful and correct (2026-11-17).
- **Out of scope.** Physics beyond that rule, derailment anywhere else (curves, switches, collisions), grades and power draw, pedestrians, economy, and timetables before P1.

## 9. Storage and formats

| Data | Format | Location |
|---|---|---|
| Asset bundle | GLB palette bundles, JSON or binary tables, manifest | CDN; cached in the HTTP cache and OPFS |
| World | A manifest (schema and bundle versions, profiles, flags, plan regions with their footprints, consists, vehicle sidecars) plus one shard per super-chunk (placements as catalog ref plus LDraw colour code, so a palette id like `ldraw:3811@2` saves as ref `ldraw:3811` and colour 2; laid track as exact ℤ[ζ₁₆] poses with their global order, filed by the exact floor of their stud position; switch states) | IndexedDB, loaded per shard; exported as a `*.brr.zip` |
| Plan export | `*.brrplan.zip`: the region's placements, its footprint and the models it references, so it reopens on its own | File |
| Collection | An imported Rebrickable collection or CSV of what the user owns | IndexedDB |
| Printable plan | SVG in the MVP, PDF in P1 | Download |
| Imported model | Original file plus the bake (instance list, BOM, footprint, LOD meshes, badges), keyed by content hash | IndexedDB; P1 object storage |
| Shareable package | `*.brr.zip`: the world (or `*.brrplan.zip` for a single plan) plus the original files of the models it references | File (MVP), share link (P1) |
| BOM export | BrickLink Wanted List XML, Rebrickable CSV, plain CSV | Download |
| Interchange | Export the layout as one LDraw `.mpd` (each model a submodel, placed); glTF export in P2 | Download |

Layouts reference catalog items by namespaced id and imported models by hash, and they pin `bundleVersion`. A migration step remaps ids when part aliases change.

*M1 S9 status:*
- **Schema.** `@brr/schema/world` defines world schema v1 as valibot `strictObject` schemas, each type inferred from its schema (`WorldManifestV1`, `WorldShardV1`, `PlacementRecordV1`, `WorldIndexEntry`, `TrackRecordV1`, …):
  - a manifest with `format`, `schemaVersion`, `name`, `bundleVersion`, the placement and track counts, the shard list, the saved camera `view`, `credits` and the trademark `disclaimer`;
  - one shard per 8 × 8-chunk super-chunk, holding the placements (`ref`, `color`, x, z, `yPlates`, `rot`) whose x and z fall in it, and the laid track pieces (global `index`, `ref`, heading 0–15, the eight exact ℤ[ζ₁₆] coefficients of the position, `yPlates`) whose position falls in it.
- **Canonical form.** Keys are sorted with no whitespace. Shards are sorted by super-chunk, placements by value, and track by index. The editor builds each chunk's instances in the same value order, so a reloaded world draws the same pixels. Everything read back goes through `decode` from `@brr/schema/decode`, which returns issue lists. The schemas check that poses sit on the 20-LDU lattice, that each placement lies inside its own super-chunk, that a newer schema version is refused, that no unknown keys appear, and that the counts agree.
- **IndexedDB.** `@brr/storage` gives each world its own database `brr-world-<id>`, with a `manifest` store and a `shards` store. Each value is the canonical JSON text, keyed by `sx_sz`. A `brr-worlds` database indexes the worlds. Each edit, including undo and redo, rewrites only the shards it touched, plus the manifest. Laying track rewrites the super-chunks that hold track. Placements loaded from a save are adopted into a fresh `EditHistory`, so opening a world starts with empty undo and redo stacks. Camera moves are saved after 0.5 s.
- **Export.** `*.brr.zip` is a stored (uncompressed) ZIP with fixed 1980-01-01 timestamps. It contains `manifest.json`, then `shards/<sx>_<sz>.json` in order, then `CREDITS.txt`. That file is the S10 credits text (`ICredits.exportText`), with the OMR set credits narrowed to the sets placed in the world. The LDraw file list stays bundle-wide, because the manifest doesn't record which subfiles each part draws on. The same world therefore always exports the same bytes.
- **Import.** Import reads stored or deflated entries, checks each CRC, refuses encrypted entries, and refuses any placement `ref` and `color` pair that isn't in the catalog, and any track `ref` that isn't a drawable piece, rather than substituting something.

## 10. Licensing and IP posture (non-commercial)

- **We can use:**
  - LDraw CA parts and OMR models, with attribution and a "modified from LDraw" note.
  - Rebrickable data and set, part and minifig images (hotlinking allowed; MOC images never).
  - The LDCad shadow library, imported directly. Our derived connectivity dataset is published under **CC BY-SA 4.0** as a separate package.
  - BrickLink Wanted List XML export.
  - The BrickLink API price guide, as a **P1 option only after reading its terms** for a free, non-commercial site.
- **Still prohibited, whatever D1 says:**
  - redistributing `OfficialNonCA` parts or Studio's part library;
  - shipping the legacy `.io` password;
  - the LEGO logo or stud logo, red-square branding, LEGO fonts or trade dress, the minifigure as a mascot or icon;
  - box art and instruction images;
  - featuring licensed themes in marketing;
  - scraping BrickLink or LEGO.com.
- **Non-commercial means:** no ads, no paid tier and no affiliate links (§12 decides donations). The disclaimer appears on every page and export. If the site accepts user uploads (P1), it needs a DMCA process.

## 11. Unverified facts to check

**Blocking for M0 and M1.**
1. **The license of every city-palette part:** track 53400, 53401, 2865 and 2867, the switches and crossings, the road plates (60304 set pieces) and the baseplates must all be CA, not `OfficialNonCA`. If any is NonCA, we can't ship it and need a replacement plan.
   *Status 2026-11-16 (`docs/verified-facts.md`, at the bundle's pin):* the 9V straight, curve, switches (75541/75542) and crossing (32087), the 6-wide plastic straight and curve (53401/53400), the classic road baseplates and the baseplates are all CA and official. **Not cleared:** the 6-wide plastic switches 53404/53407 aren't in the official library. No 6-wide plastic crossing and no 60304-style road plate exists in LDraw under any title we could find, and identifying them needs Rebrickable, which is blocked. These need a replacement plan.
2. The current LDraw parts count and the CC BY 2.0 / CC BY 4.0 license split. *Cleared 2026-11-16 (manual read of the pinned tarball):* update 2026-10 has 37,151 files, 35,140 CC BY 4.0 and 2,011 dual-licensed.
3. **Whether the LDCad shadow library covers** track, road plates, baseplates and Technic bricks, and that it really is CC BY-SA 4.0. *Cleared 2026-11-16:* it is CC BY-SA 4.0. Coverage is partial: track snaps exist only for 53400 and 32087, baseplates have stud primitives only, and Technic bricks are covered.
4. The exact connector poses for both switches (the diverging end), the 90° crossing and the R40 curve, extracted from data and run through the field test. *Cleared 2026-11-16 for 9V track:* the R40 curve exit is 40ζ³ − 40ζ⁴ and the switch diverging end is 48 − 40ζ³ + 24ζ⁴ studs (mirrored for the left switch), both in ℤ[ζ₁₆]. A switch plus a reversed R40 gives a parallel track 16 studs over (48 − 16ζ⁴, derived exactly from the two certified parts). The 3-decimal plastic 53400's printed ends agree with 74747's to 7.4e-4 LDU per coordinate, but its exit is 1.456e-3 LDU per coordinate from the R40 candidate and has no unique candidate at its precision, so it can't be certified (`docs/verified-facts.md`). The plastic switches aren't in the official library. **Project decision (delegated by the owner, 2026-11-16; see §5.3):** an imported pose is certified iff its residual to the unique ℤ[ζ₁₆] candidate is ≤ 0.0005 LDU per coordinate, half the last decimal of 3-decimal LDraw data.
5. Track gauge and rail spacing (the "6-stud" vs "about 37.5 mm" conflict), and the official track part numbers. *Cleared 2026-11-16:* the 53401 inner gauge is 37.52 mm with rail centres 5 studs apart, and the track is 8 studs wide, so "6-stud internal gauge" is refuted. The 9V parts are 74746/74747/75541/75542/32087 (2865/2867 are moved stubs). RC and Powered Up sets used 53401/53400 until 2024; the 2025–2026 train sets use 7389, 2827, 2824 and 7442, **none of which is in LDraw**. Rebrickable marks 7389 and 2827 as mould variants of 53401 and 53400; using that geometry for them would be a substitute and needs an explicit decision.
6. Baseplate thickness, which sets the height datum. *Cleared 2026-11-16:* 4 LDU (half a plate) as modelled; the top face is y = 0 in the part frame.
7. Road plate geometry: size, clip connectors, lane and sidewalk widths, and stud zones. *Partly cleared 2026-11-16:* the classic 32×32 road baseplates have studless roadways of 20, 18, 16 and 14 studs (6-, 7-, 8- and 9-stud verges), and printed 44336 lanes are 176 LDU between lines. *Updated 2026-11-16:* the 60304-era plates are official LDraw parts 69958, 71772 and 71772p01. Measured at the pin, they're 16 LDU (2 plates) thick with every stud recessed 8 LDU (1 plate) below the top face, in 1×4 edge strips and 2×4 centre pockets, and they have no clips (see §5.4, Road plates). Their lane and sidewalk widths come from tile placement, so the plates don't fix them.
8. The OMR's current set count and how well it covers Town and Train sets. *2026-11-16:* the OMR lists 1,470 sets; Town and Train coverage is still open.
9. Three.js `WebGPURenderer` with `BatchedMesh`: performance and WebGL2 fallback behavior at 250k parts.
   *Closed 2026-11-16 at 250k (M0 slices 2 and 3, PR #15 and #16):* `WebGPURenderer` with chunked `InstancedMesh`, not `BatchedMesh`, renders the 250,665-part city on a MacBook Pro M4 Max at 3600×2086. Measured at `0b81a76`, aerial medians are 12.1 ms on WebGPU and 13.3 ms on the WebGL2 fallback, and street medians are 7.2 and 8.6 ms, with identical counts on both APIs.
   - **Tiering:** the 250k aerial view ran **every chunk at the mid tier** (0/196/0): far-LOD shells with 8-segment studs, 10.7M of 63.4M scene triangles drawn, and 76% of studs culled as covered.
   - **`BatchedMesh`:** it lost to chunked instancing on both APIs up to 100k in slice 2 and was removed.
   - **Past 250k:** frame time grows with draw calls. At 500k, aerial is about 24 ms (3,144 draws). **At 1M, aerial is about 40 ms** (40.6 ms WebGPU, 38.9 ms WebGL2, 5,670 draws, 14–15 ms CPU submit); street is 15.3 and 16.1 ms.
   - **Memory:** GPU vertex and index buffers actually allocated through WebGL2 `bufferData` and WebGPU `createBuffer` are 41.9 MiB at 250k aerial and 168.8 MiB at 1M aerial. The figure depends on resolution because allocation is lazy and follows the tiers. At 1920×1081 every 1M chunk stays far and only 72.8 MiB is allocated; at 3600×2086, 376 chunks reach mid and also upload the 1.33M-stud stud stream (96 MiB).
   - **Hardware:** these are M4 Max figures, much faster than Tier A.
   - *2026-11-18:* the procedural city behind these figures, the `?scene=layout` bench and the `?scene=parts` showcase were deleted, because they picked parts by role and placed sets by hard-coded number. A new large-scene measurement opens a saved world of real sets in the editor and runs its "Measure 60 GPU-synced frames of this view" command (M).
10. Browser WebGPU coverage today: Safari 26, Firefox on platforms other than Windows, Linux Chrome.

**Needed before M5 (plan mode) or P1.**
11. The MILS spec: layer stack, the "4 plates above the baseplate" surface height, connector and corner positions. *Cleared 2026-11-16 from HispaBrick Magazine MILS I–IX:* the surface is 4 plates above the baseplate; each corner has a free 2×2 and a 1×4 Technic brick on each side; paved roads are 16 studs at 5 plates. MILS has no City or Train rules. Club road systems (MultiRoad at 6 plates) are a separate `club-road` profile (§5.4).
12. Modular-building sidewalk depth and Technic hole positions. *2026-11-16:* the Technic joins are 1×2 Technic bricks at stud cells 9–10 and 21–22 per joining edge (all five OMR modular buildings checked). Sidewalk depth has no standard: clubs use 4, 5 or 6 studs, and the LEGO models vary.
13. A ballast or Train-tech module standard, if one is adopted. *2026-11-16:* none exists in MILS, and ballast dimensions appear only as club practice. 16-stud parallel track spacing is the one widely adopted convention.
14. BrickLink API terms for non-commercial use.
15. The Rebrickable API rate limit (about 1 request/s?) and how complete its LDraw crosswalk is for our palette. *2026-11-16:* the limit is one request per second on average with a small burst allowance; Rebrickable asks for the CSV dumps instead where possible. The API filters parts by `ldraw_id`; measuring coverage needs an API key.
16. `.io` internals: whether `modelv2.ldr` contains non-standard line types, Studio's `PE_TEX_*` texture meta names, and its color table differences.
17. The `ldr_tools` license, if we vendor it. *Cleared 2026-11-16:* MIT.
18. The train motor part numbers (PF 88002, PU 88011) and the Rebrickable categories for vehicle signatures. *Cleared 2026-11-16:* 88002 and 88011 are product numbers. Their motors are parts 87574 (in LDraw) and 28740 (**not in LDraw**). Rebrickable categories split by track system: RC and Powered Up plastic track is category 36, but 9V track (74746, 74747, 75541, 75542, 32087) and 12V track are category 45 with the motors and hubs, so signatures match on part numbers, not category alone.
19. Flex track link length and maximum joint angle. *2026-11-16:* the joint angle is ±5.625° (stated and modelled); the link pitch is still open.
20. Size of the element-existence table once compressed.
21. The MILS substructure part list per module (needed for the plan BOM), and the overhang and reach norms clubs use for layout tables (reach is often quoted as 60 to 80 cm, unconfirmed). *2026-11-16:* the published minimal module is 25 parts (§5.4). No source gives reach or overhang norms.
22. The Rebrickable collection export format (CSV columns and the API endpoints for a user's parts and sets). *2026-11-16:* the API endpoints are documented (user token, then `/users/{user_token}/sets/`, `/parts/`, `/allparts/` and others). The collection CSV columns are still open, because the help pages sit behind a Cloudflare challenge.

**Later.**
23. Fan-track segment angles per radius (BrickTracks R56 to R120 and others), and whether any needs 11.25° steps (D3).
24. The Powered Up BLE protocol and the state of Web Bluetooth.
25. Memory64 and multi-draw-indirect status, which matter only for a custom backend.
26. Current wording of the LEGO Fair Play policy.
27. Whether Studio is Unity-based (background only).

**Code architecture (check in M0).**
28. Whether Inversify (current major version) works with explicit `@inject(TOKEN)` parameter decorators when compiled by Vite's esbuild and Vitest with `experimentalDecorators` on and `emitDecoratorMetadata` off, and whether it still needs the `reflect-metadata` polyfill at runtime. If parameter decorators cause trouble, fall back to `toDynamicValue` factory bindings (§14.3).
    **Cleared 2026-11-16 (M0).** Inversify 8.3.0 works. Vite 8.3.8 transforms with Oxc instead of esbuild; Oxc reads `experimentalDecorators` from tsconfig and emits the legacy `__decorate`/`__decorateParam` helpers, with no `design:*` metadata. The production build in Chromium 159 and Vitest 5.1 on Node both resolve `@injectable` classes through `@inject(TOKEN)` parameters, with singleton scope intact. TypeScript 7.0.2 typechecks the decorators. The app needs no `reflect-metadata` import: Inversify 8 keeps its own metadata through the `Reflect` metadata API and imports `reflect-metadata/lite` itself from `@inversifyjs/container`, with `reflect-metadata` 0.2.2 as a peer. No `toDynamicValue` fallback is needed.
29. Whether Turborepo's `boundaries` check is mature enough to enforce package layers. If not, use dependency-cruiser (§14.2).
   *Closed 2026-11-16 (M1 slice S3):* dependency-cruiser 18.7.2 enforces the §14.2 table in CI (`pnpm lint:boundaries`, `.dependency-cruiser.json`). Turborepo `boundaries` is still experimental and lacks exact allowed-edge rules.
   - **Per-package allow-lists:** every package has a rule listing the packages and third-party modules it may import. The table's "types only" edges (`client` → `sim`/`import`, `ui` → `schema`) are checked as type-only.
   - **Third-party rules:** only `client`, `workers/*`, `apps/web`, `storage`, `render`, `catalog` and `rpc` may import `inversify`, and only `render` may import `three`.
   - **Unresolvable imports fail.**
   - **Scratch probes** in a throwaway worktree confirm that allowed edges pass (a type-only `client → sim`, `ui → client` plus React, `client → math`) and that forbidden ones fail. The forbidden cases were `ui` → `inversify`/`three` with both linked, a value `client → sim`, `client → three`, `domain → inversify`, `render → domain` (including dynamic and relative imports), `catalog → domain`, a Node built-in in `domain`, `tools/asset-pipeline → render` or an npm module, and `apps/web → math`.
   - **TypeScript 7:** it publishes no compiler API, so dependency-cruiser parses with SWC (`@swc/core`).

## 12. Owner decisions still open (recommended default first)

1. **Definition of "real."** Default: official LDraw CA parts, in colors produced in at least one real element. Imports that fail get badges, not blocks; "Real set" and "Verified" need badges to pass.
2. **Layout validity.** Default: exact, zero-tolerance rules decide "Valid". Draft layouts can always be saved. A "real-world play" tolerance mode is off and never counts as Valid.
3. **Scale target.** Default: 250k parts loaded near the camera at 60 fps on an integrated GPU (MVP), 1M as a stretch. Total sandbox world size is unlimited, handled by streaming. Phones and tablets are view-only after the MVP.
4. **Renderer path.** Default: three.js `WebGPURenderer` with WebGL2 fallback, behind `SceneBackend`. A custom WebGPU backend only if the M0 or M6 gates fail.
5. **Unofficial and custom parts in imports.** Default: allowed and rendered from inline geometry, with a badge. They exclude a model from "Real set" and "Verified".
6. **MILS variant.** Default: adopt MILS core as published in HispaBrick Magazine I–IX as the `mils` profile. Ship club road systems (MultiRoad first) as a separate `club-road` profile, and also ship `lego-modular` and `free`.
7. **Simulation ambition.** Default: a cozy toy for the MVP (throttle, A* routing, occupancy stop). Block signals and stations come in P1, timetables after that.
8. **Audience and accounts.** Default: adult fans and LUG planners on desktop. No accounts in the MVP, which avoids COPPA and moderation; P1 accounts are 13+ with a DMCA process.
9. **BOM economics.** Default: file exports only. Price estimates in P1 only if BrickLink's terms allow non-commercial use. No affiliate links, and an optional donation link if you want one.
10. **Power systems.** Default: cosmetic attribute only. Mixed 9V and plastic loops get a BOM flag, not an error.
11. **Starter content.** Default: OMR City and Train sets, stations and a few modular buildings that pass L1 and L2, plus the official track and road palette.
12. **Name.** Default: keep "Brick Railroad" and check the domain and handles. No "LEGO" in the name.
13. **Real-hardware twin (Powered Up over Bluetooth).** Default: out of scope until P2 or later.
14. **How strict the sandbox is.** Default: rules only warn outside plan regions, and inside a plan they're errors. The alternative is one strict mode everywhere.
15. **Plan defaults.** Default: metric units with an inch toggle, a 70 cm reach depth, no overhang allowed past a table edge, and table seams required on module boundaries. All of these can be changed per plan.
16. **Collection source for "own vs buy".** Default: Rebrickable collection CSV import in the MVP, with Rebrickable API sync (the user's own key) in P1. No BrickLink store-inventory import.

## 13. Phased roadmap

### Phase 0: prototype milestones (de-risk before building the product)
| Milestone | Build | Exit criteria |
|---|---|---|
| **M0 Verify and spike** | Clear §11 items 1 to 10. Compile about 500 city parts to GLB with studs extracted. Load Rebrickable into SQLite. Run a three.js benchmark scene of procedurally generated modules at 100k, 250k and 1M parts. | Every palette part is CA-licensed, or there's a replacement plan. Every track pose passes the field test. Benchmark figures are recorded for Tier A. **Gate:** 250k parts at ≥ 60 fps on Tier A, or a decision to bring the custom backend forward. |
| **M1 Static city** | Asset bundle v0 on the CDN. **Unbounded sparse chunk world** with super-chunk shards in IndexedDB. Place 10 baked OMR sets with lattice snapping and 90° rotation. Near, mid and far LODs, covered-stud culling, the look pass, save and export, credits page and disclaimer. | A 50-module scene "reads as LEGO" in side-by-side screenshots. Placement shows up in ≤ 50 ms. A world spread across far-apart coordinates (±10 km) renders without jitter. A world survives save, reload and export. |
| **M2 Track and roads** | Official track palette with exact `TrackPose` joins. Drag-to-draw track (straights and R40 curves). Live open-end and overlap warnings. Road plates with road-edge snapping. Layout rules 1 to 5 and 7. | A loop with two switches closes exactly. Deliberately broken joins are rejected. A rule test suite runs headless in CI. |

### MVP: "Plan, build and run your real train layout, inside an endless sandbox"
| Milestone | Build | Exit criteria |
|---|---|---|
| **M3 Import** | Import worker for `.ldr`, `.mpd` and plain-ZIP `.io`. Import report (missing parts, colors, provenance). Badges L1 and L2. "My models" library. BOM panel with Wanted List XML and Rebrickable CSV export. | 20 real Studio exports import without crashing. The L2 result for OMR sets matches Rebrickable. The exported Wanted List uploads to BrickLink. |
| **M4 Run** | Track graph and sim worker. Consist builder with vehicle auto-detection and sidecar. Throttle, "go to" with A* and automatic switches, occupancy stop. Build and Run modes. | Three trains run on a layout with reversing loops without colliding. The sim tests pass headless. |
| **M5 Plan mode** | Plan regions with a room, tables, obstacles and aisles drawn in mm. Fit, reach and seam rules (§7.3). Strict rules inside the plan, warnings outside it. Substructure recipes in profiles. BOM per plan and per module. Rebrickable collection import for "own vs buy". Shortfall Wanted List. Printable SVG plan. `.brrplan.zip` export. | A real test case: a measured 2.4 m × 1.2 m table with a planned loop, station and two modules reaches "Buildable as planned". Its BOM matches a hand count. A real build from the printout needs no extra parts and no forced joints. |
| **M6 Hardening and scale** | 250k-part club layout benchmark. Super-chunk far LOD and shard streaming for large sandbox worlds. Clearance envelopes (rule 6). Undo/redo. Shareable `.brr.zip`. | Performance budgets met on Tier A near the camera. A world of 2,000+ modules opens in ≤ 3 s warm, and frame time stays flat however many modules are loaded. A loaded world is bit-identical after a round trip. |

### P1: "Living city and clubs"
- Road vehicle simulation, block signals and stations.
- `mils`, `club-road` and `lego-modular` profile validators (§11 items 11 and 12 are cleared; see §5.4).
- L3 structure badge.
- The "designate bogie" metadata tool.
- Rebrickable API collection sync, plus BrickLink price estimates and a cost total per plan (if the terms allow).
- Planner extras: PDF plans, build-phase splits ("stage 1 needs these parts"), import of floor plans or room photos for tracing, a moving and storage view (which modules fit in which boxes).
- Elevation with grade parts.
- Flex track.
- Accounts, cloud saves, share links (including shared plans) and a read-only embed.
- An OffscreenCanvas render worker and impostors for very far views, if measurements need them.

### P2: "Club platform"
- Multiplayer: a server-authoritative op log per chunk group, ids as (client, counter), last write wins per placement.
- Custom WebGPU GPU-driven backend, if needed.
- `.lxf` import, glTF export.
- Club layout planning: combine several members' plans into one event layout, with module ownership in the BOM.
- Powered Up digital twin (if chosen).

### Later, unscheduled (D3)
**Third-party track packs.** Each needs a `thirdparty-<vendor>` source, vendor connectors, a `TrackProfile` with N = 32 if any piece needs it, a UI toggle for `allowThirdParty`, BOM flags and vendor license clearance. No core changes are expected thanks to §3.5 and §5.3.

### Cross-cutting rules
- Every rule and simulation module stays headless-testable.
- Asset builds are reproducible from pinned inputs.
- The license gate fails the build.
- Benchmarks run on real Tier A hardware before each phase gate.

## 14. Code architecture

### 14.1 Repository layout
This is a **Turborepo** monorepo using pnpm workspaces, plus a Cargo workspace for the Rust compiler. The web app is built with **Vite**. Tests run under Vitest; end-to-end smoke tests (Playwright) start in M3. Package scope is `@brr/*`.

```
apps/
  web/                    Vite + React app; main-thread composition root
  catalog-api/            Cloudflare Worker: catalog search, set inventory and theme browse over D1; release files from R2 (D5)
packages/
  math/                   exact ℤ[ζ_N] arithmetic, lattice poses, Rot90, SoA vector helpers
  schema/                 valibot schemas for every wire and file format, one subpath each (bundle, catalog-api, world, decode); types are inferred from them
  domain/                 world/chunk store, placements, joins, track and road graph derivation, layout and plan rules, BOM engine, profiles
  sim/                    fixed-timestep simulation core (consists, routing, occupancy, later IDM-lite)
  catalog/                asset-bundle client: manifest, part records, connector tables, element-existence table, GLB loading
  import/                 import pipeline orchestration around compile-wasm: resolve, badges, bake
  compile-wasm/           generated wasm-bindgen output of crates/brick-compile (build artifact, not hand-written)
  render/                 SceneBackend interface, three.js backend, GPU buffer pools, look/post passes, plan overlay
  storage/                IndexedDB/OPFS repositories (world shards, model blobs, collections, settings)
  rpc/                    typed worker message protocol, transferable typed-array envelopes, proxy helpers
  client/                 application services (OOP, Inversify): commands/undo, selection, tools, plan, BOM export, sim/import proxies; no React
  workers/
    import-worker/        worker entry + its own container
    sim-worker/           worker entry + its own container
    render-worker/        (P1) OffscreenCanvas entry + its own container
  ui/                     React components, hooks, design tokens; talks only to client service interfaces
  test-fixtures/          LDraw/.io samples, golden worlds and plans, benchmark scenes
  config/                 shared tsconfig and vitest presets (lint and format: oxlint and oxfmt at the root)
crates/
  brick-compile/          Rust: LDraw parse/flatten, BFC, normals, stud extraction, LODs, bake (lib)
  brick-compile-cli/      offline pipeline entry
  brick-compile-wasm/     wasm-bindgen wrapper → packages/compile-wasm
tools/
  asset-pipeline/         Node CLI: fetch/pin inputs, license gate, Rebrickable → SQLite → shards, connector merge, OMR ingest, publish
infra/
  cloudflare/             Terraform for the catalog Worker, its D1 database and its R2 release bucket (D5)
```

### 14.2 Dependency direction
Dependencies only point downward; nothing imports a package from its own layer or a layer above.

```
L6  apps/web                             apps/catalog-api (server; imports only schema)
L5  ui                                   workers/*  (entry points)
L4  client
L3  sim · import
L2  domain · catalog · render · storage · rpc
L1  schema
L0  math
```

| Package | May depend on |
|---|---|
| `math` | nothing |
| `schema` | math, valibot |
| `domain` | math, schema |
| `catalog` | math, schema, valibot, inversify |
| `render` | math, schema, catalog (asset formats), inversify — **not** domain; client adapts domain data into render buffers |
| `storage` | schema, inversify |
| `rpc` | schema, inversify |
| `sim` | math, schema, domain (graph types) |
| `import` | math, schema, domain, catalog, compile-wasm |
| `client` | math, schema (`@brr/schema/decode`, bundle wire types, world files), domain, catalog, render, storage, rpc, plus *types only* from sim and import (it reaches them through worker proxies) |
| `workers/*` | rpc plus their engine (`sim`, `import`, later `render`) and its dependencies, plus inversify |
| `ui` | client (service interfaces, tokens, view models), schema types |
| `apps/web` | ui, client, workers (as `new Worker(new URL(...))` entries), and *types only* from schema (owner ruling, 2026-11-17: no re-export layers, so `apps/web` names wire types where they are defined) |
| `tools/asset-pipeline` | math, schema, domain, catalog, valibot, the brick-compile CLI; never imported by apps |
| `apps/catalog-api` | schema and valibot only; `@brr/config` presets as dev tooling. Nothing imports it. |

**Enforced rules:**
- Every wire and file format is one valibot schema in `schema`, with its type inferred from it (owner decision, 2026-11-16). That covers the CDN bundle (manifest, model files, GLB JSON) and the palette that feeds its compiler, the catalog API and the D1 release rows behind it, and saved worlds. A query's projection of D1 rows is composed from the row schemas next to its SQL in `apps/catalog-api`. Packages that run schemas depend on `valibot`; packages that only name the types use `import type` from `schema`.
- `math`, `schema`, `domain` and `sim` are **pure**: no DOM, no three.js, no IndexedDB, no workers and no Inversify. They run unchanged in Node tests, in workers and in the pipeline.
- Only `client`, `workers/*`, `apps/web` and the L2 adapter packages `storage`, `render`, `catalog` and `rpc` import `inversify` (owner decision, 2026-11-16). Only `apps/web` and each worker entry **create containers**; they are the composition roots.
- `ui` never imports `domain`, `render` or `storage` directly. It goes through `client`.
- CI checks the boundaries with dependency-cruiser (§11 item 29, closed): one allow-list rule per package covering packages and third-party modules, global rules restricting `inversify` to the DI packages and `three` to `render`, and a rule failing any unresolvable import. `tsc --build` project references that mirror the table are still to come.
- Turbo tasks: `build`, `typecheck`, `lint`, `test`, `bench`, `wasm` (cached and keyed on `crates/**`). `apps/web#build` depends on `^build` and `compile-wasm#wasm`.

### 14.3 Services and dependency injection
- Application logic lives in **OOP service classes behind interfaces** (`ILayoutService`, `IPlanService`, `IBomService`, `ISimClient`, `IImportClient`, `ISceneBackend`, `IWorldRepository`, …). Pure engines from `domain` and `sim` are plain classes with constructor parameters, wrapped by services.
- **Every binding uses an explicit, typed symbol token.** Each package exports a `tokens.ts`:

```ts
import type { ServiceIdentifier } from "inversify";
export const LAYOUT_SERVICE: ServiceIdentifier<ILayoutService> = Symbol.for("brr.client.LayoutService");
export const WORLD_REPOSITORY: ServiceIdentifier<IWorldRepository> = Symbol.for("brr.storage.WorldRepository");
```

```ts
@injectable()
export class LayoutService implements ILayoutService {
  constructor(
    @inject(WORLD_REPOSITORY) private readonly repo: IWorldRepository,
    @inject(RULE_ENGINE) private readonly rules: RuleEngine,
  ) {}
}
```

- tsconfig sets `experimentalDecorators: true` and **`emitDecoratorMetadata: false`**. Vite's esbuild can't emit decorator metadata anyway, so nothing may depend on type reflection. A lint rule rejects `@inject()` without a token and rejects class-as-identifier bindings. Classes from pure packages are bound with `toDynamicValue(ctx => new RuleEngine(ctx.get(PROFILE_REGISTRY)))`, which needs no decorators. This is also the fallback for every binding if §11 item 28 finds problems.
- Bindings are grouped into one `ContainerModule` per package (`clientModule`, `storageModule`, `renderModule`, …). Composition roots load the modules they need, and tests load modules with fakes substituted.
- Services are singletons by default and are resolved once at startup or when a tool activates. **Nothing is resolved from a container in a hot path.**

### 14.4 Per-worker containers
- Each thread owns **its own Inversify container**, built in its worker entry from that worker's modules. No singletons and no service instances are shared across threads.
  - **Main thread:** client, render (MVP), storage and ui-facing modules. Remote engines are bound to **proxy implementations** from `rpc`: `SIM_CLIENT → SimWorkerProxy`, `IMPORT_CLIENT → ImportWorkerProxy`.
  - **Sim worker:** `sim` engine, a track/road graph snapshot and a clock. It exposes `ISimEngine` over `rpc`.
  - **Import worker:** `import`, `catalog` (read-only) and compile-wasm. It exposes `IImportEngine`.
  - **Render worker (P1):** `render`, `catalog` and the OffscreenCanvas. The main thread then binds `SCENE_BACKEND → RenderWorkerProxy`.
- Cross-thread traffic only goes through `rpc` messages:
  - typed request and response unions;
  - versioned;
  - bulk data sent as **transferable typed arrays**, with SharedArrayBuffer rings reserved for when COOP/COEP is adopted.
- The same service interface has a local and a remote implementation, so moving an engine between threads only changes bindings.

### 14.5 Hot-path data rule
**Per-part, per-stud, per-instance and per-vehicle-car data never becomes a JS object.** It lives in typed arrays or GPU buffers, and code refers to it by integer handles.

| Data | Representation |
|---|---|
| Chunk placements | struct-of-arrays per chunk: `Int32Array` x/z, `Int16Array` yPlates, `Uint8Array` rot, `Uint32Array` refId, `Uint8Array` flags, a free-list for slots |
| Model instance lists (bake output) | `Uint32Array` partId, `Uint16Array` colorId, `Float32Array` 12-float matrices |
| Stud visibility | `Uint32Array` bitsets per model and per chunk |
| Occupancy | `Uint16Array` or `Uint8Array` column grids per chunk |
| Render instances | GPU buffers written straight from those arrays through pooled pages; CPU mirrors are typed arrays only |
| Sim state | `Float64Array` edge offsets and speeds, `Int32Array` edge ids per car, consist index ranges |
| Track graph | CSR adjacency in `Int32Array`s; exact `bigint` poses kept only on the edit-time join and validation path, never per frame |
| Element-existence table | a sorted `Uint32Array` of packed (part, color) keys, searched with binary search |

**Rules:**
- Zero allocations per frame and per sim tick. That means no closures, no iterators and no `Map`s keyed by part on those paths.
- The domain API hands out **views** (`ChunkView`, `PlacementHandle`) over the arrays. Objects are fine for cold data: catalog metadata, profiles, plan footprints, UI view models, and a single facade for the current selection.
- Exact `bigint` arithmetic runs only when editing or validating. The sim and the renderer use float64 or float32 data derived from exact poses.
- Enforced by review checklists and `bench` tasks: a frame and tick allocation probe, plus the camera-path benchmarks. Those run in CI, and the benchmarks gate each phase.
