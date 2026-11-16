# Far-cluster reload at 22e536a, before the render-origin fix

Same driver, same VM, production build of `22e536a` on `vite preview`. The world was built through the UI in one invocation; the reload checks ran in a second invocation on the same profile, after a timeout in the first.

- Origin cluster reload: 0 differing pixels.
- Far cluster (+10 km, -10 km) reload: 221 differing pixels of 1,440,000, max channel delta 130. The masks here mark them in red, on the sub-pixel studs of the two far baseplates.

The cause was traced with `../scripts/origin-probe.mjs`: it imports the exported world, goes to the origin, then to the far cluster, zooms, reloads, and reads the render origin from the editor HUD.

| commit | far, before reload | far, after reload |
|---|---|---|
| 22e536a plus the HUD row only | (39085, -39041) | (39090, -39036) |
| 633ca1c (origin follows the eye's chunk) | (39088, -39032) | (39088, -39032) |

S4 moved the render origin only once the eye was more than 8 chunks away, so the origin depended on the path the camera had taken. A saved camera restored fresh could land on a different origin, and different float32 rounding gave different coverage on studs smaller than a pixel. At 633ca1c the origin is always the eye's chunk, and both reload checks are 0 pixels (`../vm-633ca1c/reload-checks.json`).
