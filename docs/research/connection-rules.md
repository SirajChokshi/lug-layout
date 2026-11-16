# Connection rules: geometry, snapping and buildability

Spec for the LEGO city sandbox. Every rail, road and module piece must be a real part, and every connection must be physically valid. There is no fudging.

**Confidence tags:** **[C]** means certain (canonical LEGO geometry). **[H]** means high confidence, but check it against LDraw part files before shipping. **[V]** means verify: the value is from memory or a community convention and must be confirmed from source data (LDraw `.dat` files, LDCad snap metadata, or the standard's own document) before it goes into the part catalog. This research was done without network access, so no external source was fetched.

---

## 1. Unit system (the stud grid)

| Quantity | LDU | mm | Tag |
|---|---|---|---|
| 1 LDU (LDraw unit) | 1 | 0.4 | C |
| Stud pitch (horizontal module) | 20 | 8.0 | C |
| Plate height | 8 | 3.2 | C |
| Brick height (3 plates) | 24 | 9.6 | C |
| Stud diameter / height | 12 / 4 | 4.8 / 1.6–1.8 | C/H |
| Brick width clearance (1×1 is 7.8 mm wide) | — | 0.1 per side | C |
| Baseplate thickness | thinner than a plate (≈ 1/2 plate) | — | V |

Rules:
- **Internal coordinates are integer LDU** for everything on the stud grid. Use x and z for the plan view and y for height, counted in plates (8 LDU). Floats are used only for rendering.
- Horizontal stud lattice: positions are 20·(i, j). Vertical lattice: each layer is 8·k LDU above the reference surface, which is the top face of the baseplate (baseplates are not plate-thick, so don't count from underneath them).
- A brick's rotation on studs is limited to multiples of 90° about the vertical axis. Anything else needs a turntable or hinge part, which brings its own connector.

## 2. Official LEGO track systems in scope

All of these share one geometry: the plastic RC/PF/Powered Up track (2006 onward) kept the 9V layout of 1991–2006. 4.5V and 12V blue-rail track are out of scope.

| Piece | 9V (metal rails) | RC / PF / Powered Up (plastic) | Geometry | Tag |
|---|---|---|---|---|
| Straight | 2865 | 53401 | 16 studs long, 8 studs wide (sleepers) | C (geometry) / H (part numbers) |
| Curve R40 | 2867 | 53400 | 22.5°, radius 40 studs to the centerline, 16 make a circle | C / H |
| Switch L/R (points) | 2861 / 2859 | plastic versions (set 7895) | straight route 32 studs; diverging route 22.5° | H / V (exact diverging pose) |
| 90° crossing | 32087 | set 7996 | 16×16 studs, four ends | H / V |
| Flexible track | — | set 7499 (flex segments and straights) | chain of links with a limited angle at each joint | V (link length and maximum angle) |

Common facts **[C/H]**:
- Gauge is about 37.5 mm inside the rails, with rail centers about 5 studs apart. The sleeper footprint is 8 studs wide.
- Track ends are **genderless and symmetric**: any end mates with any end at 180°, in either direction. Both 9V and plastic tracks connect to each other mechanically, but power differs (9V rails conduct, plastic ones don't). Flag mixed 9V/plastic loops as a power issue, not a geometry issue.
- The track underside has anti-stud sockets, so axis-aligned track clicks onto plates.

### 2.1 Exact R40 math [C]
One curve turns θ = 22.5° about a center 40 studs to the side:
- Forward offset: 40·sin 22.5° = **15.3073 studs** (122.46 mm).
- Lateral offset: 40·(1 − cos 22.5°) = **3.0448 studs** (24.36 mm).
- Chord length: 80·sin 11.25° = 15.6073 studs.
- Four curves make 90°, ending at offset (40, 40) studs exactly, which is **back on the grid**.
- Two curves make 45°, ending at (28.284, 11.716), which is **off the grid**.
- A full circle is 80 studs in diameter at the centerline, about 88 studs at the sleeper edges.

Consequence: orientations at 22.5° and 45° are off the stud grid. Only multiples of 90° land back on it.

### 2.2 Switch geometry [V — must import]
Known with high confidence:
- The straight route is 32 studs long (two straights' worth).
- The diverging route leaves at 22.5°.

Not reliably known: the diverging end's lateral and forward offset, and whether that route is an exact R40 arc. Common recollections disagree on whether "switch + reversing curve" gives parallel tracks 8 studs apart or some non-integer spacing.

**Do not hand-code these values.** Derive every switch endpoint pose from the LDraw/LDCad connection data. Then run the exactness test in §4.3: if the pose is not in the 22.5° field, the part gets a proven exact pose of its own, and the closure check uses symbolic or interval arithmetic for it.

Switches also need a **mechanism keep-out zone**. That is the lever or motor box on one side, plus the swept area of the moving points.

### 2.3 Third-party track (optional flag `allowThirdParty`, off by default)
| Vendor | Typical parts | Tag |
|---|---|---|
| BrickTracks | R56, R72, R88, R104, R120 curves; switches; crossings | V (segment angles; some radii may use 11.25°) |
| ME Models | R56–R120 curves; switches; metal rail | V |
| TrixBrix | R40-compatible switches, curves and crossings | V |

They have the same gauge and genderless ends. When this flag is on, pieces are tagged `thirdParty` in the parts list (BOM), and the exact-arithmetic field may need to grow to 32 directions (11.25°).

## 3. Roads, modular buildings, MILS, ballast

| Item | Spec | Tag |
|---|---|---|
| Modern road plates (2018+, e.g. set 60304) | 32×32 studs; studded sidewalk/curb edges; roadway mostly smooth; straight, T-junction, crossroads, curve variants | H (size) / V (lane and sidewalk widths, stud zones) |
| Classic road baseplates (1978–2000s) | 32×32 baseplates printed with roads (straight, curve, T, cross) | H / V |
| Modular buildings (LUG / LEGO Creator Expert) | One 32×32 baseplate per module (also 16×32); sidewalk strip at the front; neighbors joined by **Technic 1×2 bricks with holes + pins** on the first layer | H / V (sidewalk depth, often cited as about 6 studs; exact hole positions) |
| MILS | 32×32 modules; raised surface: baseplate, then 1 brick (3 plates), then a cover plate, for a top **4 plates above the baseplate**; neighbors joined at the corners/edges with plates that bridge modules | V (heights and connector placement must come from the MILS spec document) |
| Train ballast / Train-tech-style module standards | Track on a raised ballast bed (layers of plates) with sloped shoulders; standard track-center offset from the module edge; standard spacing between parallel tracks | V — **no reliable numbers recorded here**; treat as a profile (see below) |

Because LUG and community standards vary, model them as **profiles**. A profile is a JSON file with these keys:

```
{ moduleSize:[32,32], surfaceHeightPlates:4, edgeConnectors:[...],
  trackCenterFromEdge, parallelTrackSpacing, ballastWidth, ballastHeightPlates,
  sidewalkDepth, roadLaneWidth }
```

Ship a `MILS`, a `LEGO-modular` and a `free` profile. Only fill in numbers whose [V] tag has been cleared.

## 4. Connection and snapping model

### 4.1 Parts and connectors
Each part = mesh + footprint (2D polygon plus height range) + a list of connectors. Each connector has a type, a pose (position in integer LDU when possible, plus orientation), and a gender.

| Connector type | Mates with | Allowed relative pose |
|---|---|---|
| `stud` / `antiStud` | the opposite gender | same lattice point; rotation a multiple of 90° about vertical |
| `trackEnd` (genderless) | `trackEnd` of a compatible gauge | coincident points; heading differs by exactly 180°; same height |
| `technicHole` / `technicPin` | the opposite gender | coaxial; position along the axis on the half-stud grid (10 LDU) |
| `moduleEdge` (profile-defined) | `moduleEdge` with the same profile | edges coincide; connector positions match |
| `roadEdge` | `roadEdge` with the same lane layout | coincident; 180°; lane and curb pattern equal |

### 4.2 Snapping (UI behavior)
1. When a free end is within the snap radius (UI-only, e.g. 2 studs), propose the **exact** mating pose. Never accept an approximate drop.
2. A track piece gets its pose only from the connection, not from where the cursor is. Rotating cycles through the variants that are actually valid (flip L/R curve, switch orientation).
3. Stud snapping: round to the lattice point, then rotate in 90° steps.
4. If a piece with a track connection also sits on studs, the two poses must agree exactly. If they don't, the piece floats (see §5, rule 5).

### 4.3 Exact arithmetic (the "no fudging" core)
With straights and R40 curves only, every heading is k·22.5°, k ∈ ℤ₁₆. Every position is an element of ℤ[ζ₁₆], where ζ₁₆ = e^{iπ/8} and the plane is treated as complex numbers:
- Straight at heading k: Δ = 16·ζᵏ (in studs).
- Left curve at heading k: Δ = 40·i·(ζᵏ − ζᵏ⁺¹)·(−1). Right curve is the mirror. The constant i = ζ⁴ keeps everything inside ℤ[ζ₁₆].
- Store each position as **8 integer coefficients**, using the basis ζ⁰…ζ⁷ (since ζ⁸ = −1). Track ends match only if the coefficient vectors are **identical** and the headings differ by 8 (180°).
- The same scheme covers third-party curves at 11.25° with ℤ[ζ₃₂] (16 coefficients).
- A part whose pose isn't in the field (possibly some switches, or flex track) gets an exact algebraic pose from its data. Numeric equality is then checked with epsilon = 1e−6 LDU. That epsilon only absorbs representation error; it is **not** physical slack.
- Being on the grid is decidable: a pose is on the stud lattice if and only if only the ζ⁰ and ζ⁴ coefficients are non-zero and both are integers (in studs, or in half-studs where half-stud offsets are allowed).

### 4.4 Tolerance policy
- **Default: zero tolerance.** Loops must close exactly in the algebra above.
- Optional `realWorldPlay` mode (off by default, clearly labeled, flagged in the BOM): allows up to a configured angle and gap per track joint, to mimic how people force near-closures. It is never used for official "valid" status.
- Flex track: each joint angle must be within the part's maximum angle [V]. Link length is fixed. The chain endpoint must match exactly. Solve with an exact or high-precision solver and verify the result.

## 5. Buildability validation (all must pass to be "valid")

1. **Real parts only.** Every part ID is in the catalog. Third-party parts are allowed only with the flag on. No scaled or cut parts.
2. **Connections are exact,** per §4.3. Track can't have open ends unless the user marks them (buffer stop parts count as terminations).
3. **No interpenetration.** 3D footprints (polygon × height) don't overlap except at declared connectors. Keep-out zones (switch levers, motors) count as solid.
4. **Stud support.** Each axis-aligned part on studs has at least one engaged stud/anti-stud pair on the lattice, with heights in whole plates.
5. **Off-grid track support.** Track at 22.5° or 45° can't claim stud engagement. It must rest fully on a continuous flat support (tiles or smooth surface) at a single height, and be anchored by track connections only. Show a "loose on studs" warning if it sits on exposed studs.
6. **Height consistency.** A connected track run stays at one height unless grade parts or approved ramp builds are used. Grades and inclines are a profile setting [V].
7. **Clearance.** Parallel tracks must be at least the profile spacing apart. Check a rolling-stock envelope along curves and switches, sweeping the widest and longest selected train; S-curves without a straight between them get a warning.
8. **Road continuity.** Matching `roadEdge`s must have equal lane and curb patterns. Rail–road level crossings must use real crossing parts or a builds-on-plates recipe.
9. **Module rules** (when a profile is active): modules are on the 32-stud grid; edge connectors are present and aligned; the surface height matches the profile.
10. **BOM output.** The validator emits the parts list with counts. Flagged items: third-party parts, mixed 9V/plastic power, `realWorldPlay` use.

## 6. Open items before implementation
- Import LDraw geometry for 53400/53401/2865/2867, both switches, 32087/7996 crossings and flex segments. Extract exact connector poses, including the switch diverging pose, and run the field-membership test.
- Get the MILS spec, a modular-building sidewalk/Technic-hole reference, and the chosen ballast/Train-tech standard document, then fill in the profile numbers.
- Confirm the road-plate stud zones and lane widths from the 60304 part geometry.
- Confirm BrickTracks segment angles per radius.
