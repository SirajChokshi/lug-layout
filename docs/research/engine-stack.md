# Engine stack for a browser LEGO city sandbox

Goal: a web sandbox for building LEGO cities made of millions of real LDraw parts (trains, roads, baseplates, MILS modules). It has to look like LEGO and run well on ordinary laptops.

Status: research recommendation, not yet validated by a prototype. Platform facts that change quickly (browser support, WebGPU features) are marked **verify**. Check them before committing to the plan.

## TL;DR recommendation

| Decision | Recommendation | Main alternative considered |
|---|---|---|
| Graphics API | **WebGPU only** for the full editor. If analytics show demand, add a WebGL2 "viewer lite" later. | WebGL2-first: it has no compute and no indirect draws, so GPU-driven rendering at a million parts is impossible |
| Renderer | **Custom, thin WebGPU renderer in TypeScript + WGSL** | three.js or Babylon (general scene graphs that work against GPU-driven design); Bevy (not web-ready at this scale) |
| CPU-heavy kernels | **Rust → WASM in Web Workers** (LDraw compiling, connection graph, chunk meshing, simplification via meshoptimizer) | C++/Emscripten (also viable; pick Rust for safety and the tooling ecosystem) |
| Rendering model | GPU-driven: compute culling (frustum + Hi-Z occlusion), LOD selection, compacted instance lists, **vertex-pulling indirect draws**, optional visibility buffer | Per-object draws (CPU-bound beyond about 10k objects) |
| Studs | **Split from part bodies** and drawn as an implicit instanced stream with per-part visibility bitmasks; covered studs culled on edit; distance LOD down to a procedural normal pattern | Keeping studs inside part meshes (about 60–80% of triangles wasted) |
| Far LOD | **Plate-resolution voxel HLOD per chunk** (greedy-meshed, procedural studs), then impostors | Meshlet DAG à la Nanite (needs 64-bit atomics / mesh shaders that WebGPU doesn't have) |
| World layout | 32×32-stud chunks (one baseplate / MILS module), 8×8 super-chunks for HLOD and streaming | Octree (the city is 2.5D and grid-aligned, so a 2D grid wins) |
| Assets | Offline-compiled **binary part atlas** (quantized, meshlet-ordered, studs extracted). Scene = compact instance records. LDraw `.ldr`/`.mpd` for import and export, glTF + `EXT_meshopt_compression` for export only | Shipping raw LDraw text, or glTF for the scene (too large and slow) |
| Threads | Render in a worker via `OffscreenCanvas`, kernel workers on `SharedArrayBuffer` (requires COOP/COEP) | Main-thread rendering |
| Persistence | OPFS (sync access handles in workers) for chunk blobs, IndexedDB for metadata. Server stores content-addressed chunk blobs plus an op log | localStorage / JSON |
| Multiplayer (later) | Server-authoritative op log per chunk group, IDs as (client, counter), LWW per instance, WebSocket | Full CRDT (Yjs/Automerge): too heavy for millions of objects, and place/remove ops rarely conflict |

The core argument: at this scale **the problem is data and triangle volume, not API ergonomics**. The winning moves are domain-specific: split out and cull studs, exploit the LEGO grid (voxel HLOD, quantized transforms, 24-orientation rotations), and keep the CPU out of the per-frame path. A general-purpose engine gives you none of these and charges per-object overhead.

## 1. Sizing the problem

LDraw units: 1 LDU = 0.4 mm. A stud pitch is 20 LDU (8 mm), a brick is 24 LDU tall and a plate 8 LDU. `stud.dat` is a cylinder of radius 6 LDU and height 4 LDU.

| Quantity | 1M parts | 10M parts (stretch) |
|---|---|---|
| City footprint (≈2k parts per 32×32 MILS module) | ~500 modules ≈ 5.7 m × 5.7 m | ~5,000 modules ≈ 18 m × 18 m |
| Stud positions (≈5–10 per part) | 5–10M | 50–100M |
| Triangles, naive full-detail parts (1–5k tris each with studs and undersides) | 1–5 **billion** | 10–50 billion |
| Instance data at 16–32 B per part | 16–32 MB | 160–320 MB |
| Unique part types in a typical city | 1–3k | 2–5k |

Conclusion: a naive renderer is off by 2–3 orders of magnitude. Instance *data* is cheap. Instance *geometry* has to be culled and LOD'd aggressively, and studs dominate the triangle count.

## 2. Graphics API: WebGPU vs WebGL2

**WebGPU gives you** compute shaders, storage buffers, `drawIndirect`/`drawIndexedIndirect`, render bundles (cheap re-submission), timestamp queries (optional feature), and availability in workers. These are exactly what GPU-driven culling needs.

**WebGL2 lacks** compute and indirect draws. You can get some distance with `WEBGL_multi_draw` plus instancing plus CPU culling on merged chunk meshes, but every visibility decision crosses the CPU, and transform-feedback culling hacks are fragile.

**WebGPU gaps you must design around (verify current status):**
- **No multi-draw-indirect in core.** Chrome has an experimental extension. Workaround: put all part geometry in one mega vertex/index buffer and issue **one `drawIndirect` per pass**. The vertex shader decodes `vertex_index` into (visible cluster, triangle, corner) and pulls vertices from storage buffers. This is the standard "meshlets without mesh shaders" technique.
- **No mesh shaders, and no standard 64-bit atomics.** That rules out Nanite-style software rasterization with 64-bit depth+ID packing (a 32-bit packed variant is possible but lossy). Bevy's meshlet renderer depends on such features and does not run on WebGPU.
- **`indirect-first-instance` is optional.** Don't rely on a non-zero `firstInstance` in indirect args. Pass the offset through a storage buffer instead.
- **Default limits are low**: `maxStorageBufferBindingSize` defaults to 128 MiB and `maxBufferSize` to 256 MiB. Request the adapter's maximum, and design buffers to be pageable (multiple bindings, chunk pools).
- **Browser coverage (verify):** Chrome/Edge have shipped on desktop since 113 and on Android since 121. Safari 26 ships WebGPU on macOS/iOS. Firefox shipped on Windows in 2025, with other platforms following. Linux Chrome and older iOS remain gaps.

**Decision:** WebGPU-only for the editor and city view. Keep the *data pipeline* renderer-agnostic (part atlas, chunk HLOD meshes) so a WebGL2 viewer can reuse the chunk-merged HLOD meshes with CPU frustum culling if needed. Don't build that fallback until telemetry says so.

## 3. Engine choice

| Option | Strengths | Problems at this scale | Verdict |
|---|---|---|---|
| **three.js** (WebGPURenderer, TSL, `InstancedMesh`, `BatchedMesh`, `LDrawLoader`) | Huge ecosystem, fast to start, LDraw loader exists, good for gizmos/UI | Object-centric scene graph with per-object CPU traversal and matrix updates. No built-in GPU culling, meshlets or indirect pipeline. Building GPU-driven rendering means bypassing most of three. | **Use for the Phase 0 baseline and for throwaway tools**, not as the core |
| **Babylon.js** | Stronger WebGPU story (compute, render bundles/snapshot rendering, thin instances), good inspector | The same scene-graph model. Customizing culling and LOD deeply means working against the engine. | Viable plan B if the team strongly prefers an engine |
| **Bevy (Rust → WASM, wgpu)** | ECS, Rust, native and web from one codebase | Large WASM binaries (10–30 MB before tuning), effectively single-threaded on the web, meshlets unsupported on WebGPU, weak web UI integration, frequent breaking releases | **No** for the browser product |
| **Raw wgpu (Rust)** | Portable to native desktop, Rust performance, same WGSL | Every UI interaction crosses the JS↔WASM boundary. Debugging WebGPU through wgpu is harder. Little per-frame CPU win when rendering is GPU-driven. | Pick this **only if a native desktop build is a hard requirement** |
| **C++ + Emscripten (+ Dawn `webgpu.h`)** | Mature pthreads support, can reuse LeoCAD-style parsing code | Same boundary and UI costs as wgpu, worse memory safety | Fine for kernels. Prefer Rust. |
| **Custom TS + WGSL renderer + Rust WASM kernels** | Minimal per-frame CPU work (dozens of passes and dispatches, not millions of objects). Direct control of buffers, culling and LOD. Easy UI integration with a normal web framework. | You own the renderer (expect roughly 10–20k lines for the core) | **Recommended** |

Why TypeScript for the renderer but Rust for kernels: in a GPU-driven design the per-frame CPU work is small (upload dirty chunk ranges, update uniforms, encode a fixed pass list), so WASM buys little there. The heavy CPU work happens off the frame: parsing and flattening LDraw sub-file trees, BFC winding, smoothing, meshlet building, simplification, voxelization, greedy meshing and the connection graph. That work is branchy, allocation-heavy and parallel, which is where Rust/WASM plus threads wins. Use **meshoptimizer** (Rust bindings or its WASM build) for vertex cache optimization, meshlet building and simplification.

## 4. Rendering architecture

### 4.1 Data on the GPU
- **Part atlas buffers:** one mega vertex buffer (quantized positions as int16 with a per-part scale/offset, oct-encoded normals, and a per-vertex color slot where LDraw color 16 means "inherit") plus a meshlet table (≤64 vertices / ≤124 triangles, bounding sphere and normal cone). Each part has LOD0/LOD1/LOD2 meshlet ranges.
- **Instance buffers per chunk** (SoA, pooled pages): `partId:u16|u32`, `color:u16`, `orient:u8` (one of the 24 axis-aligned rotations, or an escape to a full quaternion table for hinges and curved track), chunk-local position as `int16×3` in ¼-LDU or plate units, flags, and a `studMaskOffset`. That comes to roughly **16 B** for grid parts.
- **Camera-relative rendering**: fp32 is precise enough even at 10M parts (an 18 m city is ~45k LDU, with sub-0.01 LDU error), but compute positions relative to the chunk origin anyway.

### 4.2 Frame pipeline (WebGPU)
1. **Chunk cull (compute):** test ~10k chunk AABBs against the frustum and last frame's Hi-Z, and pick a tier per chunk: near parts, mid parts, or far HLOD.
2. **Instance cull (compute):** for chunks in the parts tiers, test each instance's bounds against the frustum and Hi-Z, pick a LOD, and append to a visible list.
3. **Meshlet cull (compute, near tier only):** cone and frustum test per meshlet, then append visible clusters.
4. **Draw:** one vertex-pulling `drawIndirect` for opaque parts, one for studs, one for HLOD chunks, plus a transparent pass.
5. **Hi-Z build** from depth (two-pass occlusion à la "GPU-driven rendering pipelines": draw last frame's visible set, build Hi-Z, cull the rest, draw the newly visible).
6. **Shading:** either forward PBR or a **visibility buffer** (u32 instance+triangle ID) followed by a compute/fullscreen resolve. The visibility buffer is attractive here because triangles are small, materials are few (plastic, trans, chrome/metal, pearl, glitter, rubber), and it gives **picking for free**.
7. **Post:** SSAO/GTAO (essential for the LEGO look), edge detection, TAA/FXAA, tonemapping (AgX/ACES).

Budget for draw submissions: fewer than 50 render/compute passes, and fewer than 200 draw calls in the steady state. CPU encode should take under 1–2 ms.

### 4.3 Studs (the most important optimization)
- During part compilation, **extract stud primitives** (`stud.dat`, `stud2.dat`, logo variants, and so on) from part bodies and record them as local stud positions on the part. Do the same for underside tubes and anti-studs as an "underside" submesh.
- **Stud culling on edit, not per frame:** keep a per-chunk occupancy grid. A stud is hidden when the cell above it is covered by a part's underside or a solid region. Store a **visibility bitmask per part instance**. In a typical built city this removes **50–80% of studs**, and undersides of parts resting on something are skipped too.
- **Stud rendering:** studs form an implicit instance stream (part instance × stud index → transform derived on the GPU, no per-stud storage beyond the bitmask). LODs:
  - near: full cylinder (16–24 segments) with a logo (verify trademark use, see §9)
  - mid: 8-segment cylinder without a logo
  - far: no geometry at all, just a procedural stud pattern (normal/parallax and AO) on top faces, computed from `worldPos mod 20 LDU`
- With 10M studs, ~3M exposed, and ~1–5% in the near tier, the stud triangle count stays in the low millions.

### 4.4 LOD and HLOD
- **Part LODs (offline):** LOD0 = full LDraw geometry minus extracted studs. LOD1 = meshopt-simplified, internal faces removed, low-res primitives (LDraw ships `48/` high-res and low-res primitive variants; prefer low-res). LOD2 = a near-box hull for tiny screen sizes.
- **Chunk HLOD (built in a worker on edit and cached):** voxelize the chunk at **1 stud × 1 stud × 1 plate** resolution with one color per voxel, then greedy-mesh it. Grid-aligned LEGO maps onto this almost perfectly. Approximate slopes and curves with partial voxels or a few shape classes. Far HLOD for a whole module comes to roughly 1–10k triangles. Super-chunk HLOD (8×8 modules) feeds very far views. Beyond that, use impostors or a height-colored terrain.
- **Why not a Nanite-style meshlet DAG?** Without mesh shaders or 64-bit atomics, the payoff is smaller, the build is complex, and **instancing already gives the deduplication Nanite gets from clusters**. Reconsider only if WebGPU gains these features.

### 4.5 "Looks like LEGO"
- Plastic BRDF: low roughness (~0.2–0.35), a subtle clearcoat lobe, slight subsurface/wrap for light colors, LDConfig color values (calibrate against official LEGO colors), and IBL with a studio-style environment.
- **Edges and bevels are the signature.** Raw LDraw geometry has hard edges. Options:
  1. a post-process outline from instance ID, normal and depth: cheap, works at any scale. **Default.**
  2. true LDraw edge lines (type 2) and conditional lines (type 5) via instanced screen-space quads, **near tier only** ("instruction style")
  3. bevel highlights through a shader trick (a rounded-edge normal near face boundaries) or pre-beveled LOD0 meshes. Mecabricks' beveled library is a big part of its look.
- Transparent parts (windows, lights): weighted blended OIT. Sort only the near tier.
- Shadows: one cascaded directional shadow map rendered from HLOD/LOD1 geometry, with SSAO for contact shading.

## 5. World structure, streaming and editing

- **Chunk = 32×32 studs** (one baseplate, which matches MILS and road plates), covering full height. Chunks group into **8×8 super-chunks** for streaming, HLOD and persistence. A sparse hash map holds the chunks.
- **Streaming:** the camera picks the needed tier per chunk. Load instance data (small) widely, and part LOD geometry and HLOD meshes by distance. Fetch part-atlas entries on demand (5–50 KB each compressed) through a content-addressed HTTP cache plus OPFS.
- **Edit path (latency target <50 ms to visual update):** the main thread raycasts against the visibility buffer ID (or CPU BVH for snapping), then a kernel worker updates the chunk instance list, occupancy grid, stud masks and connection graph and posts dirty ranges. The render worker does a `queue.writeBuffer` on those ranges. HLOD rebuild is lazy and asynchronous (show stale HLOD for up to ~1 s).
- **Snapping/connections:** LDraw has no explicit connection data, but stud, anti-stud, tube and axle primitives can be **inferred from sub-file references** during compilation. LDCad's snap metadata (its "shadow library") is a richer source to evaluate (check its license).
- **Trains:** track pieces are parts. Run trains as spline followers along the track connection graph (no physics). A train is a handful of instances with per-frame transforms, which is trivially cheap.

## 6. Asset pipeline and formats

1. **Input:** the official LDraw library (CC BY 2.0, attribution required; verify current terms), LDConfig colors, plus unofficial parts as needed.
2. **Offline compiler (Rust, also used in-browser for custom parts):** resolve the sub-file tree, apply BFC, weld and crease-smooth normals, extract studs and undersides, generate LODs, build meshlets, quantize, and generate edge and conditional line data. Write **`.lpa` (LEGO part atlas)**: a header, part table, meshlet table and vertex/index blobs, compressed with meshopt codecs plus Brotli at the HTTP layer.
3. **Scene format (`.city` internal):** a manifest plus per-super-chunk binary blobs of instance records, an op-log tail and HLOD caches (derived, discardable). Hash chunks by content.
4. **Interchange:** import and export LDraw `.ldr`/`.mpd` (the universal format; LeoCAD, LDCad, Bricksmith and Stud.io all read it). Import Stud.io `.io` (a zip containing an LDraw-based model; verify specifics) and LDD `.lxf` (zip + XML) via part-ID mapping tables. Export glTF 2.0 + `EXT_meshopt_compression` for rendering in Blender and similar tools.

Avoid glTF as the live scene format: it describes geometry and node trees, not millions of (part, color, transform) records.

## 7. Threads, memory, WASM

- **Render worker:** `OffscreenCanvas.transferControlToOffscreen()` plus WebGPU in a dedicated worker, so a UI hitch never drops a frame.
- **Kernel workers:** 2–(cores−2), running Rust WASM with threads (wasm-bindgen-rayon; needs nightly + `build-std` with atomics) over `SharedArrayBuffer`. Shared rings handle edit ops and dirty-range notifications. The SAB requires **cross-origin isolation (COOP: same-origin, COEP: require-corp/credentialless)**, which constrains third-party embeds, ads and OAuth popups. Decide this early.
- **Memory:** wasm32 caps at 4 GB. Memory64 is shipping unevenly across browsers (verify). Keep per-worker heaps at or below 1 GB and keep bulk data in GPU buffers and OPFS, not WASM heaps.
- **Persistence I/O:** use OPFS `createSyncAccessHandle` in workers for chunk blobs (fast, binary) and IndexedDB for small metadata and settings.

## 8. Performance budgets

Reference tiers: **Tier A** is an integrated GPU (Intel Iris Xe / Apple M1 base / Radeon 680M) at 1080p and 60 fps. **Tier B** is a midrange discrete GPU at 1440p and 60 fps. Tier A is the design target.

| Budget | Tier A target |
|---|---|
| Frame | 16.6 ms; GPU ≤ 12 ms, render-worker CPU ≤ 3 ms, main thread ≤ 4 ms (UI only) |
| GPU pass split (approx.) | culling 1 ms · opaque raster 5 ms · studs 1.5 ms · shadow 1.5 ms · SSAO + post 2.5 ms · transparent 0.5 ms |
| Visible rasterized triangles | ≤ 5–8M per frame (Tier B: ≤ 20M) |
| Draw calls / passes | ≤ 200 draws, ≤ 50 passes in steady state |
| GPU memory | ≤ 1.5 GB total (shared memory on iGPUs): part atlas resident ≤ 300 MB, instances ≤ 200 MB, HLOD ≤ 400 MB, render targets ≤ 300 MB |
| JS heap / WASM | ≤ 500 MB JS, ≤ 1 GB summed WASM |
| Load | first frame of a 10k-part scene ≤ 3 s cold. 1M-part city interactive (HLOD visible) ≤ 10 s cold and ≤ 3 s warm (OPFS) |
| Edit latency | place/remove visible ≤ 50 ms. HLOD refresh ≤ 1 s |
| Scale goals | 1M parts at 60 fps on Tier A (**must**), 10M parts at ≥ 30 fps on Tier B (**stretch**) |

Measure with WebGPU `timestamp-query` (falling back to CPU timers) and run automated camera-path benchmarks in CI on real hardware.

## 9. Risks and open questions

- **Trademark/legal:** the "LEGO" stud logo and the name are trademarks. LDraw logo primitives reproduce the logo. Get a legal review, and consider a generic logo or none (LeoCAD makes the logo optional).
- **WebGPU feature drift:** multi-draw-indirect, subgroups and 64-bit atomics could change the meshlet calculus. Keep the cull/draw stage swappable.
- **Free-rotation parts** (hinges, curved track, minifigs) don't fit the voxel HLOD or the 24-orientation encoding. Use the escape path, and measure what share of a real city they make up.
- **Safari/iOS GPU memory limits** are tighter. Plan for a "mobile tier" with a smaller near radius and HLOD-only beyond.
- **COOP/COEP** constraints on integrations.
- **LDraw part quality varies.** Some parts are very heavy (baseplates with studs, curved parts), and the compiler must cap and simplify them.

## 10. Prototype plan (phases with exit criteria)

| Phase | Build | Exit criteria (go/no-go) |
|---|---|---|
| **P0 Baseline spike** | Rust compiler for ~500 common parts (bricks, plates, tiles, windows, track, road plates) → `.lpa`. Procedural city generator using a realistic part mix. **three.js `InstancedMesh`/`BatchedMesh` baseline** plus a minimal custom WebGPU instanced renderer. | Numbers recorded for 100k / 1M parts on Tier A. Confirms or refutes how badly the naive path fails |
| **P1 GPU-driven core** | Chunked instance pools, compute frustum + Hi-Z culling, LOD selection, vertex-pulling indirect draws, render worker on OffscreenCanvas | 1M parts with all part-tier LODs at ≥ 60 fps on Tier A from a street-level camera, render CPU ≤ 3 ms |
| **P2 Studs + HLOD** | Stud extraction, occupancy-based stud masks, stud LODs with procedural far studs, voxel greedy-mesh HLOD, super-chunks | 10M parts aerial flythrough at ≥ 30 fps on Tier B. Exposed studs ≤ 50% of total. GPU memory within budget |
| **P3 Look** | PBR plastic + IBL, SSAO, outline post, OIT trans, shadows, optional LDraw lines near | Side-by-side screenshots vs Mecabricks/Stud.io renders judged "reads as LEGO" by the team. Post ≤ 3 ms on Tier A |
| **P4 Editing** | Picking via visibility buffer, placement with stud snapping from inferred connections, undo/redo, async chunk rebuild, LDraw import/export | Place/remove ≤ 50 ms. Round-trip a LeoCAD/LDCad `.mpd` losslessly |
| **P5 Persistence + streaming** | OPFS chunk store, HTTP part-atlas streaming, content-addressed chunks | 1M-part city: warm reload ≤ 3 s, cold ≤ 10 s on a 50 Mbps link |
| **P6 Multiplayer spike** | WebSocket server (Rust/axum or Durable Objects per chunk group), op log, presence | 8 clients editing one district, op apply ≤ 100 ms p95, no divergence after a reconnect storm |

Gate after P1 and P2. If 1M parts at 60 fps on Tier A isn't reachable after P2, cut the near radius, push HLOD closer, or raise the hardware floor before investing in P3+.

## 11. Existing projects (what to learn from)

| Project | Tech (as publicly known) | Relevance |
|---|---|---|
| **Mecabricks** | Browser-based WebGL editor (three.js-based), its own beveled part library, photoreal rendering via a Blender add-on | Proof that "looks like LEGO" in the browser comes from bevels, good materials and AO. Not built for million-part scenes. |
| **Stud.io (BrickLink)** | Desktop app (Unity-based, verify), LDraw-derived library, PartDesigner, photoreal renderer, instruction maker. Became LEGO's de facto digital designer after LDD ended (2022). | Reference for UX, part catalog and the `.io` import path. It slows on very large models, which is our differentiator. |
| **LeoCAD** | C++/Qt/OpenGL, GPL, uses the LDraw library, configurable stud style and logo | Reference for LDraw parsing, BFC, stud styles and edge lines. Desktop scale. |
| **three.js `LDrawLoader`** and "ldraw.js"-style projects (e.g. *buildinginstructions.js* used by BrickHub) | JS/WebGL LDraw parsing, conditional-line shaders, packed `.mpd` model tooling | Fast path to P0. Shows browser LDraw parsing cost (slow for big models, which motivates offline compilation). "ldraw.js" names several small projects; review the specific one intended. |
| **LDCad** | Desktop editor with snapping metadata and flexible/path parts | Snap metadata source; flexible track/hose ideas |
| **LDView / Bricksmith / LDD (retired)** | Desktop viewers/editors | Format compatibility (LDD `.lxf`) |
| **Nanite (UE5), Bevy meshlets, "GPU-Driven Rendering Pipelines" (Haar & Aaltonen, SIGGRAPH 2015)** | Cluster culling, two-pass Hi-Z occlusion, visibility buffers | Technique sources. Adapt to WebGPU's missing features. |
| **Minecraft / Teardown-style voxel engines** | Chunking, greedy meshing, streaming | Direct model for our grid HLOD and chunk persistence |

## Next actions

1. Re-verify the **verify** items (browser WebGPU coverage, MDI extension status, Memory64, LDraw license, `.io` format) at kickoff.
2. Start P0 with a fixed benchmark scene set: an "aerial 1M", a "street 1M" and an "editing district 50k".
3. Decide early on COOP/COEP and on the stud logo legal question; both are hard to retrofit.
