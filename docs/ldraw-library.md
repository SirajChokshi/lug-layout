# LDraw library delivery

The import worker compiles parts that the part bundle doesn't ship. It fetches their `.dat` files, and every subfile they reference, through `LdrawMirror` (`packages/import/src/ldraw-mirror.ts`). Deployed apps read these files from the `brr-ldraw-library` R2 bucket. GitHub's raw mirror is only the fallback for local development.

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

Every object is stored with `Cache-Control: public, max-age=31536000, immutable`. Nothing is ever pruned, so a deployment keeps reading its own pinned commit.

## How the app finds it

`VITE_LDRAW_LIBRARY_BASE_URL` reaches the client as `ldrawLibraryBaseUrl` (`LDRAW_LIBRARY_BASE_URL` token). The import request passes it to the worker as `ldrawLibraryUrl`, and the worker passes it to `LdrawMirror`. Without it, the mirror reads `https://raw.githubusercontent.com`. Deployed apps never do that. `vite.config.ts` refuses a Vercel build without the URL. `vercel-build.sh` takes the URL from `public_base_url` in `infra/cloudflare/ldraw-library.json`. Once the part bundle is served, it runs `library/cli.ts served`, which HEADs the pinned library's index:

- **Served:** the build proceeds.
- **Absent** (no public URL, or the index answers 404): Production fails, and the previous deployment keeps serving. A preview deploys only `preview-skipped.html` and logs `Preview skipped: the pinned LDraw library is not published …`, the same way a preview whose part bundle isn't published is skipped.
- **Any other answer, or an unreachable bucket:** the build fails.

## CI

`.github/workflows/ldraw-library.yml` runs on pushes to `main` that change the lock, the publisher (`tools/asset-pipeline/src/library`), `ldraw-library.json` or the workflow. It can also be started by hand (*Run workflow*).

**`status`** has no environment and no secrets. It HEADs the index at the public URL: the repository variable `LDRAW_LIBRARY_BASE_URL` if it's set, otherwise `public_base_url`. If the index is served, the workflow ends there.

**`publish`** runs in `production`, so it waits for approval. It uses the same `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_API_TOKEN_ID` as the part bundle and the catalog deploy:
1. It checks the bucket for the index over R2's S3 API and stops if the index is there.
2. Without secrets, it restores the archive into `.cache/catalog/ldraw-library` (the same path and pin that `restore-ldraw` uses) and runs the checks above.
3. It uploads the objects the bucket doesn't have yet, checking each file against its index hash again just before upload, and then uploads the index.
4. It fetches every lock-pinned file from the public URL and compares SHA-256 values (`verify-served`).

## Commands

```sh
pnpm --filter @brr/asset-pipeline ldraw-library check
LDRAW_LIBRARY_BASE_URL=<url> pnpm --filter @brr/asset-pipeline ldraw-library served
LDRAW_LIBRARY_BASE_URL=<url> pnpm --filter @brr/asset-pipeline ldraw-library verify-served
LDRAW_LIBRARY_BASE_URL=<url> pnpm --filter @brr/asset-pipeline ldraw-library verify-served --all
```

- `check`: runs every publish check locally, with no credentials needed.
- `served`: reports whether the index is `served`, `absent` or `unknown`.
- `verify-served`: checks every lock-pinned file the URL serves against `ldraw.lock.json`.
- `verify-served --all`: checks all 37,155 published files against the index.

`upload` and `published` need the token, as in the workflow. `src/library` isn't a part bundle input (`turbo.json`), so changing the publisher doesn't republish the bundle.

## Setup

1. Apply `infra/cloudflare`, which creates `brr-ldraw-library`, its CORS and its r2.dev domain (*LDraw library bucket* in its README). After a merge, the catalog deploy workflow plans and applies it.
2. Run the LDraw library workflow (*Actions → LDraw library → Run workflow*) and approve `publish`.
3. Commit the Terraform output `ldraw_library_base_url` as `public_base_url` in `infra/cloudflare/ldraw-library.json`. `ignoreCommand` skips commits that touch only `infra/`, so redeploy Vercel Production by hand after that commit.

Until step 3, Production builds fail, the previous deployment keeps serving, and previews are skipped. To move to a custom domain later, follow the part bundle's three steps with `ldraw_library_domain` and `ldraw_library_r2_dev`.

## Local development

Nothing changes: `pnpm --filter @brr/web dev` reads library files from GitHub. To use the bucket, set `VITE_LDRAW_LIBRARY_BASE_URL=<ldraw_library_base_url>`.
