# Starter worlds

When a world opens empty (a fresh profile's first world, or a new one), the editor shows a welcome card with a few starter worlds and a "Start with an empty table" button. The world menu's **Starter worlds** button shows the card at any time. Picking a starter opens it as a new world of the user's own; the world that was open stays in the list.

## Starters are data

A starter is an ordinary saved world: an unpacked `.brr.zip` in the world format (`packages/schema/src/world`), without its `CREDITS.txt`, in its own directory under `apps/web/starters/`:

```
apps/web/starters/
  starters.json            the shelf: which starters the card offers, in order, with a one-line summary each
  <name>/manifest.json     world format v1, exactly as Export writes it
  <name>/shards/*.json
  <name>/imports/<sha256>/<file>   only if the world places an imported model
```

`CREDITS.txt` is left out because it's generated: Export writes the credits of the bundle it runs against, about 175 KB stamped with that bundle's versions, and writes them again for every export. A world archive must carry it; a world's files don't. `readWorldArchive` is `readWorldFiles` plus that one required file, so nothing in the format changes.

The card's title and counts come from each starter's `manifest.json`; only the summary lives in `starters.json`. The app bundles every file in the directory as an asset, and opening a starter hands its files to the same reader and the same import path as the world menu's **Import .brr.zip**, so a starter is checked and loaded exactly like a file a user imports. No code knows what any starter contains: there are no set numbers, categories, titles or per-starter branches, and a starter may place anything a world can, imported models included.

## Editing or adding a starter

1. Start from an empty world named as the card should show it, or reopen a starter: pick it on the welcome card (the world menu's **Starter worlds** button shows the card).
2. Build it with the editor like any layout. Placement rules apply as usual.
3. Frame the view you want the starter to open on, then **Export .brr.zip**.
4. Unzip the export into `apps/web/starters/<name>/` without `CREDITS.txt` (`unzip -o <file>.brr.zip -x CREDITS.txt -d apps/web/starters/<name>`), replacing the old files, run `pnpm format` so each record sits on its own line for review (any JSON layout reads the same), and add or update its entry in `starters.json`.

Keep starters small: everything a starter places is fetched the first time it opens.

## Checks

`tools/e2e/tests/starter-worlds.spec.ts` opens every starter on the shelf in the built app against the part bundle, through the welcome card, and checks that each one loads with the placements and track its manifest lists. A starter that places a part the bundle no longer ships fails there, as it would for a user. The client test `starter-worlds.test.ts` covers the mechanism on a synthetic world: a model built from official parts that isn't a palette item, drawn track, and a starter that names a missing part.
