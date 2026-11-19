# LDraw library delivery

The import worker compiles parts that the part bundle doesn't ship. It fetches their `.dat` files, and every subfile they reference, through `LdrawMirror` (`packages/import/src/ldraw-mirror.ts`). Deployed apps read these files from the `brr-ldraw-library` R2 bucket once its public URL is committed. Until then they keep reading GitHub's raw mirror, as they did before the bucket existed. After that, GitHub is only the fallback for local development.

## What is published

The pinned library is the one in `tools/asset-pipeline/ldraw.lock.json`: `source` names the mirror (`kulits/ldraw-parts` at a commit, root `ldraw`), and the lock's catalog pins the GitHub archive of that same commit by SHA-256. The publisher works from that archive only:

1. The archive's SHA-256 has to equal the lock's pin.
2. Every file the lock pins (the bundle closure and the audit closure) has to be in the archive with the pinned SHA-256.
3. It publishes only what imports can reach: every `.dat`, `.ldr` and `.mpd` file under `parts/` and `p/`, plus the license and readme texts at the library root (`CAlicense.txt`, `CAlicense4.txt`, `CAreadme.txt`, `Readme.txt`). Each published LDraw file has to carry a contributor-agreement `!LICENSE` line and can't be `Unofficial_`. `models/`, `LDConfig*.ldr`, textures and the `mklist` binaries stay out.
4. If any of these checks fails, nothing is uploaded.

For `c70360d` that's 37,155 files, about 500 MB, all of them unmodified.

## Keys

- `<repo>/<commit>/<root>/<path>`, for example `kulits/ldraw-parts/c70360d…/ldraw/parts/3001.dat`. These are the same paths as on `raw.githubusercontent.com`, so the mirror changes only its host. Stored as `text/plain; charset=utf-8`.
- `index/<repo>/<commit>/<root>.v1.json`: the index, uploaded last. It lists every published path with its SHA-256 and names the archive and its hash (`LdrawLibraryIndex` in `@brr/schema/bundle`). If the index is there, the whole library is there. A change to what gets published has to raise the index format, so that the next run writes a new index instead of finding the old one.

- `index/latest.json`: the pointer, `{"current": …, "previous": …}`, each naming a pinned commit (`repo`, `commit`, `root`). It's the only object ever overwritten (`Cache-Control: no-store`); nothing reads it but the publisher.

Every other object is stored with `Cache-Control: public, max-age=31536000, immutable`. An object never changes, but a commit no live bundle needs is pruned (*Pruning old commits*).

## How the app finds it

`VITE_LDRAW_LIBRARY_BASE_URL` reaches the client as `ldrawLibraryBaseUrl` (`LDRAW_LIBRARY_BASE_URL` token). The import request passes it to the worker as `ldrawLibraryUrl`, and the worker passes it to `LdrawMirror`. Without it, the mirror reads `https://raw.githubusercontent.com`.

## Switching deployed builds from GitHub to R2

`public_base_url` in `infra/cloudflare/ldraw-library.json` is the switch. Merging changes to the bucket, the publisher or the workflow never breaks Vercel Production or previews while it is `null`, whether or not the owner has applied, published or approved anything yet.

**While `public_base_url` is `null`:** deployed builds read the library from GitHub raw, exactly as before this bucket existed.
- `vercel-build.sh` leaves `VITE_LDRAW_LIBRARY_BASE_URL` unset and logs `LDraw library: … has no public_base_url yet, so this build reads library files from GitHub raw`.
- It skips the library check.
- `vite.config.ts` accepts the build.
- This holds for Production and for previews alike.

**Once `public_base_url` is committed:** deployed builds read only R2, and GitHub is the local-dev fallback from then on.
- `vercel-build.sh` exports the URL, unless Vercel sets `VITE_LDRAW_LIBRARY_BASE_URL` itself, in which case that value wins.
- `vite.config.ts` refuses a Vercel build without an absolute `VITE_LDRAW_LIBRARY_BASE_URL`, so a deployment can't fall back to GitHub by accident.
- The Vercel build doesn't check that the pinned library is published. After a merge that re-pins the library, imports that need a library file fail until its publish is approved. `library/cli.ts served` HEADs the pinned library's index to check it by hand.

Commit the URL only after the library is published and `verify-served` passes against it (*Setup*). Going back to GitHub means setting `public_base_url` to `null` again.

## CI

The library publishes from `.github/workflows/part-bundle.yml`, the part bundle's workflow, in two jobs of its own. They share the bundle's concurrency group, `part-bundle-production` with `cancel-in-progress: false`, because pruning the library reads the bundle's pointer (*Pruning old commits*), and runs of two differently triggered workflows sharing a group would cancel each other's pending runs. The workflow runs on every push to `main` and on *Actions → Part bundle → Run workflow*.

**`library-status`** has no environment and no secrets, and costs one filtered `pnpm install` and two small requests on every push: a `HEAD` of the pinned index and a `GET` of `index/latest.json` at the public URL (the repository variable `LDRAW_LIBRARY_BASE_URL` if it's set, otherwise `public_base_url`). It asks for `library-publish` when the index isn't served or the pointer doesn't name it as current, and on *Run workflow*. While neither URL is set it can't see the bucket, so only *Run workflow* publishes or prunes the library. Since it decides from what the bucket serves, not from what a push changed, a run that GitHub cancels while it's pending (a newer push replaces it) loses nothing: the next run sees the same unfinished state and does the work.

**`library-publish`** runs in `production`, so it waits for approval, after the bundle's `pointer` job, or when that job is skipped or fails. Neither publication's jobs depend on the other's success. It uses the same `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_API_TOKEN_ID` as the part bundle and the catalog deploy:
1. It checks the bucket for the index over R2's S3 API (`published`).
2. Unless the index is there, it restores the archive into `.cache/catalog/ldraw-library` (the same path and pin that `restore-ldraw` uses) without secrets, runs the checks above, and uploads the objects the bucket doesn't have yet, checking each file against its index hash again just before upload, and then the index.
3. With a public URL, it fetches every published file and compares SHA-256 values (`verify-served --all`).
4. It moves `index/latest.json` to the pinned commit, keeping the one it replaces as `previous` (`point`).
5. With a public URL, it checks the kept commits' indexes through the served pointer (`verify-pointer --wait`).
6. It lists what pruning would delete (`prune --dry-run`), then prunes (`prune`).

Every step is idempotent, so any later run that asks for `library-publish` finishes one an earlier run left unfinished; *Run workflow* always does.

## Pruning old commits

The bucket keeps only the commits a site can need: the current and previous commits of `index/latest.json`, and every commit that the part bundle's live manifests name in their `source`: its current, previous and committed fallback bundles (`docs/part-bundle.md`). The import worker reads library files from the commit the loaded bundle names, so those are the commits a rollback of the bundle pointer needs. `prune` deletes every other object in the bucket, which holds nothing but the library.
- **What a commit references:** its index, which has to decode and name that commit, and every path it lists, with the full SHA-256 the index gives (`src/library/library-pointer.ts`).
- **It refuses, deleting nothing,** if the library pointer, the bundle pointer, any of the bundle manifests or any kept commit's index can't be read or verified, if nothing is referenced, or if the pointer or the kept commits change while the bucket is being listed. It exits non-zero.
- **It is idempotent and interrupt-safe:** deletes are keyed and a missing key counts as deleted, so a rerun deletes nothing and a stopped prune is finished by the next one. There's no time-based grace period; the shared concurrency group keeps the bundle pointer still while the library prunes.
- **Storage is bounded by about 2 × 500 MB,** the current and previous commits (37,155 files, about 500 MB, for `c70360d`), plus any other commit a live bundle still names. Keys contain the commit, so commits share nothing.
- **No site reads the bucket yet.** While `public_base_url` is `null`, deployed builds read GitHub raw, so pruning affects no site.
- **A preview older than `previous` loses its library** once the bucket is live: a preview whose bundle names an older commit than any kept one finds its library files pruned, and its imports of parts outside the bundle fail.

## Commands

```sh
pnpm --filter @brr/asset-pipeline ldraw-library check
LDRAW_LIBRARY_BASE_URL=<url> pnpm --filter @brr/asset-pipeline ldraw-library served
LDRAW_LIBRARY_BASE_URL=<url> pnpm --filter @brr/asset-pipeline ldraw-library verify-served
LDRAW_LIBRARY_BASE_URL=<url> pnpm --filter @brr/asset-pipeline ldraw-library verify-served --all
LDRAW_LIBRARY_BASE_URL=<url> pnpm --filter @brr/asset-pipeline ldraw-library current
pnpm --filter @brr/asset-pipeline ldraw-library point
LDRAW_LIBRARY_BASE_URL=<url> pnpm --filter @brr/asset-pipeline ldraw-library verify-pointer [--all] [--wait]
pnpm --filter @brr/asset-pipeline ldraw-library prune [--dry-run]
```

- `check`: runs every publish check locally, with no credentials needed.
- `served`: reports whether the index is `served`, `absent` or `unknown`.
- `verify-served`: checks every lock-pinned file the URL serves against `ldraw.lock.json`.
- `verify-served --all`: checks all 37,155 published files against the index.
- `current`: reports whether `index/latest.json` at the URL names the pinned commit as current.
- `point`: moves `index/latest.json` to the pinned commit, keeping the one it replaces as `previous`.
- `verify-pointer`: checks the current, previous and live bundles' commits through the served pointer; `--all` checks every file they list.
- `prune`: deletes every object no kept commit references; `--dry-run` lists them with their sizes instead.

`upload`, `published`, `point` and `prune` need the token, as in the workflow; `prune` and `verify-pointer` also read the part bundle's public URL (`PART_BUNDLE_BASE_URL`, otherwise `public_base_url` in `infra/cloudflare/part-bundles.json`). `src/library` isn't a part bundle input (`turbo.json`), so changing the publisher doesn't republish the bundle.

## Setup

1. Apply `infra/cloudflare`, which creates `brr-ldraw-library`, its CORS and its r2.dev domain (*LDraw library bucket* in its README). After a merge, the catalog deploy workflow plans and applies it.
2. Run the part bundle workflow (*Actions → Part bundle → Run workflow*) and approve `library-publish`. It publishes the library and points `index/latest.json` at it; the bundle's jobs in the same run skip what's already published.
3. Check the bucket: `LDRAW_LIBRARY_BASE_URL=<ldraw_library_base_url> pnpm --filter @brr/asset-pipeline ldraw-library verify-served`. The publish job already ran this if the URL was known to it.
4. Commit the Terraform output `ldraw_library_base_url` as `public_base_url` in `infra/cloudflare/ldraw-library.json`. That commit is the switch to R2. `ignoreCommand` skips commits that touch only `infra/`, so redeploy Vercel Production by hand after it.

Until step 4, deployed builds keep reading GitHub raw, and nothing in steps 1 to 3 affects them. To move to a custom domain later, follow the part bundle's three steps with `ldraw_library_domain` and `ldraw_library_r2_dev`.

## Local development

Nothing changes: `pnpm --filter @brr/web dev` reads library files from GitHub. To use the bucket, set `VITE_LDRAW_LIBRARY_BASE_URL=<ldraw_library_base_url>`.
