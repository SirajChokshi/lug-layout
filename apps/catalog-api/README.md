# @brr/catalog-api

Cloudflare Worker for read-only catalog search over D1, with each release's SQLite file served from R2, and for part search over the published part bundle's index. Infrastructure and deployment: [`infra/cloudflare`](../../infra/cloudflare/README.md).

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

Part search names a published part bundle instead, by the input key in its manifest file name:

| Path | Returns |
|---|---|
| `/v1/bundles/<key>/search?q=&limit=` | The editor's catalog items that match `q`, from `standard/manifest.<key>.json` under `PART_BUNDLE_BASE_URL`. Each hit has the editor's item id (`ldraw:<part>@<LDraw colour>` for each produced colour of a ground or road part, `omr:<set>`, `generated:<module>`, `track:<system>`), its label, palette section, kind, and its record or shape file (`null` for track). `q` follows the `/search` rules and matches the label, LDraw number, Rebrickable number, LEGO element ids, set number and name, colour name and section. `limit` 1–50, default 20. 404 when no manifest is published for the key, 502 when the bundle host fails or the manifest doesn't decode. |

The Worker reads the manifest once per key and keeps the ranked index for the last 4 keys in isolate memory. Answers are immutable per key: `ETag: "<key>"`, the edge cache and 304s as above, and the D1 query rate limit on misses. The Worker has no binding to `brr-part-bundles`. R2 Worker bindings have no read-only mode (neither wrangler 4.163's `r2_buckets` nor the Terraform provider 5.x `r2_bucket` binding has one), so a binding would let this public Worker write the bucket. It fetches the manifest over HTTPS from the bucket's public URL instead (`PART_BUNDLE_BASE_URL`, `public_base_url` from `infra/cloudflare/part-bundles.json`), through the edge cache. That costs one fetch per new key per isolate and edge location, far fewer than the web app's own requests to the same domain.

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

To search a locally built part bundle, serve its standard manifest under the input key, point the Worker at it, then measure an uncached miss, an edge hit and a 304 for each query:

```sh
key=$(node tools/asset-pipeline/src/cli.ts manifest-file | sed -E 's/manifest\.(.*)\.json/\1/')
mkdir -p /tmp/bundle/standard && cp tools/asset-pipeline/dist/bundle/standard/manifest.json /tmp/bundle/standard/manifest.$key.json
python3 -m http.server 8790 --bind 127.0.0.1 --directory /tmp/bundle &
pnpm --filter @brr/catalog-api dev --var PART_BUNDLE_BASE_URL:http://127.0.0.1:8790/
pnpm --filter @brr/catalog-api measure-bundle-search --manifest $key
```

`measure` draws queries from the release file and requests each one three times: an uncached miss, an edge-cache hit and an `If-None-Match` revalidation. Then it bursts one client past the rate limit.
