# @brr/catalog-api

Cloudflare Worker for read-only catalog search over D1, with each release's SQLite file served from R2. Infrastructure and deployment: [`infra/cloudflare`](../../infra/cloudflare/README.md).

## Endpoints

Every catalog URL names a release, `/v1/catalogs/<release>/…`, where `<release>` is the first 16 hex digits of the release file's SHA-256. Ids inside a release are Rebrickable keys (set numbers, part numbers, theme ids), so a versioned URL always returns the same bytes. Those responses carry `Cache-Control: public, max-age=31536000, immutable` and `ETag: "<release>"`, are stored in the edge cache, and answer `If-None-Match` with 304.

| Path | Returns |
|---|---|
| `/v1/catalogs/current` | The current release and its links. Cached 60 s. |
| `/v1/catalogs/current/<rest>` | 307 to the same path under the current release. |
| `/v1/catalogs/<release>` | Release metadata: SHA-256, size, source, row counts, data attribution. |
| `/v1/catalogs/<release>/search?q=&kind=set,module,part&limit=` | FTS5 search, ranked by bm25. Sets and modules match name and theme path; parts match number, name and category. `q` needs at least 3 characters after trimming, or the answer is 400. Earlier words must match whole words; the last word matches as a prefix when it has 3 or more letters, otherwise as a whole word. Up to 8 words, `limit` 1–50. |
| `/v1/catalogs/<release>/sets/<set_num>/inventory` | The set or module, its lots (part, color, quantity, spare) and minifigs. |
| `/v1/catalogs/<release>/themes` | Root themes with subtree set and module counts. |
| `/v1/catalogs/<release>/themes/<id>?limit=&offset=` | A theme, its children with counts, and its subtree's sets newest first. |
| `/v1/catalogs/<release>/catalog.sqlite` | The release file from R2. Supports a single `Range` (416 when it starts past the end), `If-None-Match` (304) and `If-Match`/`If-Unmodified-Since` (412). |

Search ranks inside the FTS index and joins only the top `limit` hits, and `kind` is a column of the sets index, so a request reads at most about `2 × limit` D1 rows per kind, however many documents match.

Rate limits are per client address and come from `wrangler.json`. They count only requests that miss the edge cache:
- D1 queries: 100 a minute.
- Release-file reads from R2: 1,200 a minute, about 50 cold queries a minute for a range-request SQLite client at 22–24 requests each.

Either limit answers 429 with `Retry-After`. A full download of the release file goes into the edge cache, and later requests for it (ranged or not) are served from there. Responses from D1 report `Server-Timing: d1;dur=…` and `X-D1-Rows-Read`.

## Local

```sh
pnpm --filter @brr/catalog-api load-release --sqlite <file> --source <label> --local --persist-to .wrangler/state
pnpm --filter @brr/catalog-api dev --persist-to .wrangler/state
pnpm --filter @brr/catalog-api measure --sqlite <file>
```

`measure` draws queries from the release file and requests each one three times: an uncached miss, an edge-cache hit and an `If-None-Match` revalidation. Then it bursts one client past the rate limit.
