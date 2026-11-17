# #55 on #100 (95d439d), checked at the build of 4ddf7ed

The production build is served by `vite preview`, with headless Chrome 157, WebGL2 on SwiftShader and `lod=low`, viewport 1600×900, and a fresh profile. The driver is `../scripts/s9-track.mjs`, which uses only the UI.

`ec81fd6` and `4ddf7ed` differ only in the commit message and a docs/architecture.md wording change; the app build is the same.

| Check | Result |
|---|---|
| Draw track | One 3811 baseplate in green, then a track drag: "Saved · 1 placement · 3 track pieces · 3 shards" |
| Reload | 0 of 1,440,000 pixels differ (`before-reload.png`, `after-reload.png`). It still shows 3 track pieces. |
| Export before and after reload | 174,608 B, sha256 `fbb83c9d…83fa`, identical |
| Delete IndexedDB, then import A | Databases go from `[brr-world-…, brr-worlds]` to `[]`. After the import: 3 track pieces, and 0 pixels differ from before the reload (`after-import.png`). |
| Re-export after import | sha256 `fbb83c9d…83fa`, identical to A |
| Shards in A | Each holds its exact ℤ[ζ₁₆] track records (`ldraw:74746`, heading 13, indices 0–2), and the placement carries `"color":2` |
| `ui/` | Retry and refusal, two tabs (0 of 129 palette buttons enabled in the read-only tab), no storage, Import confirmation, long names, and delete, all as before |
