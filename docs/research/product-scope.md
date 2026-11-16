# Product scope: web LEGO-city sandbox (working name "Brick Railroad")

A browser sandbox where you lay out a city from real LEGO sets and parts, connect rail and roads, import Studio/LDraw models, and give vehicles attributes that drive a light simulation. Then you export a parts list you can actually buy.

**Recommendation in one line:** don't build a brick editor. Studio, LDCad and LeoCAD already cover part-level building. Build the **layout + simulation + BOM layer** that sits above them: import models, place them on a stud grid, snap track and roads, run trains and cars, and export to BrickLink. LDraw is the interchange format.

> This is product research, not legal advice. The IP section lists the risks to raise with counsel before going public or making money.

---

## 1. Prior art

| Tool | Platform / model | What it does well | Gap we can fill |
|---|---|---|---|
| **BrickLink Studio 2.x** | Desktop (Win/macOS), free, owned by the LEGO Group since the 2019 BrickLink acquisition | Full part-level CAD, huge catalog, BrickLink pricing and wanted lists, instructions, photoreal renders. `.io` files can be exported to LDraw. | Not a layout tool: no track/road graph, no vehicles, no simulation. Very large cities get slow. Desktop only. |
| **Mecabricks** | Web (WebGL), freemium; Blender add-on for renders | Shows browser-based brick CAD works; good materials; sharing | Model-scale only; closed format; no layout or simulation; limited BOM/marketplace tie-in |
| **LDCad** | Desktop (Win/Linux), free | LDraw editor with the best flexible-part and path tooling (hoses, chains, flex track), scripting, snapping metadata (`!LDCAD SNAP_*`) | Expert UX, no simulation. Its snap metadata is worth reusing for connection points. |
| **LeoCAD** | Desktop, GPL, cross-platform | Simple open-source LDraw editor | Model-scale only |
| **Bricksmith** | macOS, open source | Native Mac LDraw editor | Mac only, model-scale |
| **TrackDesigner** (legacy) / **BlueBrick** | Windows freeware; BlueBrick is open source | 2D train layout planning with real track geometry; BlueBrick handles 32×32 baseplate modules, roads and track, plus a parts list | 2D only, dated UX, no 3D sets, no simulation. **This is the closest prior art to our MVP.** |
| **LEGO Digital Designer** (discontinued around 2022) | Desktop | Was the official casual builder (`.lxf`) | Gone; Studio replaced it. Old `.lxf` files exist (possible later import). |
| **LEGO Worlds** (TT Games, 2017), LEGO Fortnite, LEGO Universe | Licensed games | Sandbox fun, driveable vehicles | Not real sets/parts, no BOM, no real-world buildability |
| **Rebrickable** | Web + API + CSV dumps | Set and part inventories, part-ID cross-references (LDraw ↔ BrickLink ↔ LEGO element), user collections, MOCs | Data source, not a builder. Our main catalog dependency. |
| **LDraw OMR** (Official Model Repository) | Files | Official sets modeled in LDraw by the community | The quickest legal source of whole-set 3D models for placing sets |
| Train-sim adjacents: OpenTTD, Transport Fever, NIMBY Rails, Rail Route | Games | Track graphs, signaling, consists, timetables | Proven sim patterns to copy at small scale |

**Takeaways**
- No tool combines **3D real-set layout + track/road graph + vehicle simulation + buyable BOM**. That combination is the product.
- Users already build in Studio. **Import is mandatory; editing is optional.**
- BlueBrick shows the demand from LEGO train clubs (LUGs) for layout planning. Modular-layout standards (32×32 baseplates, MILS, track at fixed baseplate positions) give us a natural grid.

---

## 2. Data, formats and licensing inputs

- **LDraw** (`.ldr`, `.mpd`, `.dat`): open text format. 1 stud = 20 LDU, 1 plate = 8 LDU, 1 brick = 24 LDU (1 stud = 8 mm). three.js ships an `LDrawLoader`.
  - Parts library licensing is **per part**: CC BY 4.0 or CCAL 2.0 for contributor-agreement parts. The **OfficialNonCA set may not be redistributed**, so filter it out of the hosted bundle and keep attribution and license notices.
- **Studio `.io`**: a proprietary container (zipped, LDraw-derived plus Studio extras). **MVP: ask users to "Export → LDraw (.ldr/.mpd)" in Studio** rather than parsing `.io` directly. Direct `.io` import is an open question (ToS and reverse-engineering risk; see section 8).
- **Rebrickable**: CSV dumps (sets, inventories, parts, colors, element IDs) plus a REST API. Its terms allow any use, including commercial, with attribution requested. Set, part and minifig images may be hotlinked; **MOC images may not be used**.
- **BrickLink**:
  - The **Wanted List XML** upload needs no API key and is the right MVP BOM export.
  - The full API (OAuth 1.0, store-oriented) and price guide are for later, and come with rate limits and ToS review.
  - BrickLink and LDraw part IDs and color IDs differ, so map them through Rebrickable cross-references.
- **Track geometry facts** (official LEGO train track):
  - Straight is 16 studs long.
  - The standard curve is R40, 16 pieces per circle (22.5° each).
  - Switches pair with R40 curves; there are also crossings.
  - Track is 8 studs wide with a 6-stud internal gauge.
  - Fan track (BrickTracks, TrixBrix and others) adds R56/R72/R88/R104 and wider switches. Support it as data packs later.
- **Roads**: LEGO City road plates are 32×32 and clip together (straight, curve, T, crossroad). Older 32×32 baseplates and fan standards also exist. A 32-stud road module grid fits both.

---

## 3. IP and trademark constraints for a fan tool

What the LEGO Group actively enforces (from its Fair Play policy and observed DMCA notices):
- The **LEGO word mark and red-square logo**.
- The **minifigure figurine design**: registered 3D trademarks in the US and EU, plus copyright registrations.
- **Official images**: box art, instructions, product photos.
- **Licensed-theme IP** (Star Wars, Harry Potter and others), which is owned by third parties and riskier still.

**Do**
- Use a name and domain **without "LEGO"** (or "Lego"-style variants). "Brick Railroad" is fine; "brick" is generic.
- Use "LEGO" only descriptively ("works with LEGO® sets"), and show the standard disclaimer in the footer, about page and exports: *"LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize or endorse this site."*
- Use community geometry (LDraw, with attribution) and Rebrickable data and images per their terms. Credit them on an About/Credits page.
- Default to set **numbers** plus neutral names. Show Rebrickable images, never our own copies of box art.
- Represent minifigures as LDraw parts inside user models only. **Don't use a minifigure as the logo, mascot or UI icon.**

**Avoid**
- LEGO logo, LEGO-style red-square branding, official fonts and trade dress, the official instruction look.
- Redistributing Studio's part library or proprietary assets, or LDraw NonCA parts.
- Featuring licensed themes in marketing.
- Monetization that looks like selling LEGO IP. Fan tools that stay free, or monetize hosting and features rather than the brand, have historically been tolerated (LDraw, Rebrickable, BlueBrick, and BrickLink before the acquisition).
- Scraping BrickLink or LEGO.com.

**Risk points to decide early:** commercial vs hobby, direct Studio `.io` parsing, BrickLink affiliate links or price display, user-uploaded content (we'd need a DMCA process and a moderation policy).

---

## 4. Vehicle and train simulation scope

Goal: **readable, satisfying motion**, not physics. Simulate kinematically along graph edges; never use rigid-body physics in the MVP.

### Track graph
- **Nodes** are connection points of track pieces, each with a position and heading.
- **Edges** are traversable segments (straight or arc) with length in studs.
- **Switches** are nodes with one entry and two exits plus a state. Trains may only pass in valid directions (no "diverging into the frog" from the wrong side).
- Store a directed traversal graph (each physical edge gives two directed edges) so reversing and loops work. Reversing loops and wyes come for free.
- The graph is derived automatically from the snap connections of placed pieces. Open ends and misalignment show as red warnings ("unbuildable layout").

### Trains
- A **consist** is an ordered list of vehicles (locomotive(s), cars). Each vehicle has a length in studs, bogie offsets and a coupler type.
- Position is (directed edge, offset). Car positions are derived by walking back along the path, so curves render correctly.
- **Attributes:**

| Attribute | Notes |
|---|---|
| Max speed | studs/s, with an optional derived "scale km/h" at minifig scale (about 1:42) |
| Acceleration / braking | rate limits on speed changes |
| Power system | 9V, Power Functions, Powered Up, or none (cosmetic) |
| Power level | discrete steps, mimicking PU/PF speed steps |
| Capacity / cargo type | passengers, containers, and so on |
| Source | the set or model it came from |

- **Routing:** A* or Dijkstra over the directed graph, respecting switch directions. Click a destination and the train follows the route, throwing switches as needed.
- **Control:**
  - MVP is manual (throttle) plus "go to station."
  - Later: **block signaling** (fixed blocks, one train per block, prevents collisions), timetables and loops, station dwell.
- **Collision:** in the MVP, stop on overlap (occupancy check). Block signaling comes later.

### Road vehicles
- The road graph comes from road-plate pieces: lanes as directed edges, intersections as nodes with turn connectors.
- Cars follow lanes with a simple car-following model (IDM-lite: keep a gap, accelerate toward a target speed). Intersections use first-come or stop-sign logic first, traffic lights later.
- **Attributes:** max speed, accel, length, type (car/truck/bus/emergency), cargo or passenger capacity, home and destination buildings.
- Ambient traffic ("spawn N cars wandering") is cheap and makes the city feel alive. Put it in the late MVP or P1.

### Out of scope early
Derailment physics, grades and power draw, realistic signaling systems (ATP, path signals), pedestrians, economy and tycoon mechanics.

### Stretch: real hardware
Powered Up hubs speak BLE, and Web Bluetooth can drive real trains from the sandbox (a digital twin). This would be a strong differentiator later. It is Chrome-only, needs user consent, and is a safety concern.

---

## 5. Sandbox UX

**Core loop:** browse the catalog, place a set or module, connect track and roads, add vehicles, press Play, then export the parts list.

### Placement
- A world grid in studs. Coarse snapping to 32×32 baseplate modules, with fine snapping at 1 stud or 1 plate.
- Rotate in 90° steps (15° and free rotation available).
- Layers: ground, baseplates, roads/track, buildings, vehicles.

### Catalog
- **Sets** from the LDraw OMR, mapped to Rebrickable set numbers.
- **Track and road pieces** as a built-in palette with connection metadata.
- **Imported models**: the user's LDraw/MPD files, stored as "My models."
- Raw parts come later (placing single bricks for decoration and filler).

### Track and road tools
- A drag-to-draw track tool that auto-picks straights and R40 curves (as BlueBrick and Transport Fever do), plus manual piece placement with snapping.
- Live feedback for an open end, a misaligned joint, or a clearance clash with buildings.

### Inspector
- For a vehicle: its attributes.
- For a set: its inventory.
- For a switch: its state.

### Modes
**Build** (edit) and **Run** (simulate). Edits during Run pause the sim.

### BOM panel
- The aggregate parts list (part × color × quantity) for the whole city, or for a selection.
- Toggles: "subtract parts I own" (import a Rebrickable collection or CSV) and "count whole sets vs loose parts."
- Exports:
  - **BrickLink Wanted List XML**
  - **Rebrickable CSV**
  - plain CSV
- Price estimates are P1, pending the BrickLink API and ToS.

### Save and share
- MVP: local autosave (IndexedDB) plus a JSON layout file.
- Later: accounts, cloud saves, share links.

### Performance budget
- Cities reach tens of thousands of parts. Plan for GPU instancing per (part, color), merged static geometry per placed model, LOD (stud-less meshes at distance) and Web Worker parsing.
- Target 60 fps at about 50k parts on a mid-range laptop. Mobile is view-only at first.

---

## 6. Phased plan

### MVP (P0): "Plan and run a train layout"
1. A three.js/WebGL scene, stud grid, camera, and 32×32 baseplate modules.
2. LDraw parts library (CA-licensed only) plus LDraw/MPD import (including Studio's LDraw export).
3. Set catalog: a curated starter list of OMR sets (city buildings, stations, trains) with Rebrickable metadata.
4. Official track palette (straight, R40 curve, switches, crossing) with snapping and an auto-generated track graph.
5. Road plates with snapping (graph built but no road sim yet, or a minimal one).
6. Trains with consists, attributes, throttle, A* routing with automatic switches, and occupancy stop.
7. BOM aggregation and export (BrickLink Wanted List XML, Rebrickable CSV).
8. Local save/load, JSON file, a credits page and the trademark disclaimer.

### P1: "Living city"
- Road vehicle sim (lanes, intersections, ambient traffic).
- Block signals, stations, schedules.
- Rebrickable collection import ("what I own" vs "what to buy") and price estimates.
- Fan-track packs (R56+ curves, wide switches), elevation (ramps, bridges, Technic-style risers).
- Accounts, cloud saves, share links, a read-only embed.

### P2: "Creator platform"
- Part-level editing inside placed models (lightweight; still not a Studio competitor).
- Multiplayer and co-editing for club (LUG) layout planning, with modular-standard validators (MILS, club track standards).
- Powered Up Web Bluetooth digital twin.
- Direct `.io` or `.lxf` import if cleared.
- Cargo and passenger logic, simple missions.
- Render and screenshot mode, layout instructions and printable module maps.

---

## 7. Technical sketch (non-binding)

| Area | Proposal |
|---|---|
| Frontend | TypeScript, three.js (`LDrawLoader` as a base, extended for instancing), React UI shell |
| Simulation | A fixed-timestep loop in a Worker. Graph and sim state are kept separate from render state so it can be tested headless. |
| Data | A preprocessed catalog: parts packed to glTF or binary meshes with LOD at build time, plus Rebrickable dumps converted to static JSON. Served from a CDN. |
| Backend (P1+) | Auth, layout storage, sharing. A small API, since the MVP can be fully static. |
| Key risks | Rendering performance at city scale; the part-ID and color mapping between LDraw and BrickLink (incomplete mappings mean BOM gaps, so flag unmapped parts); keeping track snap metadata correct |

---

## 8. Open questions for the owner

1. **Commercial intent:** free hobby project, donation-supported, or a paid tier? This drives the IP risk posture and the BrickLink API usage.
2. **Name and brand:** keep "Brick Railroad"? Do you need a domain/handle check?
3. **Buildability strictness:** must every layout be physically buildable (real pieces only, legal geometry), or can it be a looser "toy" sandbox?
4. **Editing depth:** is set/model/module placement plus track and roads enough for v1? Or do users expect to edit bricks in-app?
5. **Studio `.io`:** is "export LDraw from Studio" acceptable for the MVP, or is direct `.io` import a must-have?
6. **Track systems:** official LEGO track only at first, or fan radii from day one? 9V/PF/PU all cosmetic, or do they matter?
7. **Simulation ambition:** a cosy toy (manual driving, routing) vs an operations sim (signals, timetables, cargo)? Which matters more for the first users: train fans or city builders?
8. **Audience and platform:** adult fans/LUG planners on desktop, kids, or both (which raises COPPA and child-safety concerns for accounts and UGC)? Mobile support?
9. **Social:** single-player files only, or accounts, galleries and multiplayer? (UGC means moderation and a DMCA process.)
10. **Real hardware:** is the Powered Up Bluetooth digital twin in the vision, or out of scope?
11. **BOM economics:** should the app show prices and links to BrickLink stores (affiliate?), or just export files?
12. **Starter content:** which sets and themes should the catalog launch with (for example City trains, stations, modular buildings)?
