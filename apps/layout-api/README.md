# @brr/layout-api

Cloudflare Worker for accounts and worlds saved to the cloud (plan item B6.1). Accounts sign in with a link sent by email and are kept in D1. Worlds are stored as content-addressed files in R2: world shards, the original model files the world places, and one snapshot document per saved version. Infrastructure and deployment: [`infra/cloudflare`](../../infra/cloudflare/README.md). Wire formats live in `@brr/schema/layout-api`.

Compiled custom geometry is never uploaded. A world carries only the original `.ldr`, `.mpd` or `.io` files it places, as a `.brr.zip` does, and each device compiles them itself. The API has no endpoint that takes anything else.

## Endpoints

Every endpoint except the first two needs `Authorization: Bearer <session token>`. Bodies are JSON unless noted, and every request body needs a `Content-Length`. Errors answer `{ "error": "…" }`.

| Method and path | Does |
|---|---|
| `POST /v1/sign-in-links` `{ email }` | Mails a sign-in link and answers 202 `{ expiresAt }`. The address is trimmed and lowercased; one account per address. |
| `POST /v1/sessions` `{ token }` | Exchanges the link's token for a session: 201 `{ session: { token, expiresAt }, account }`. Creates the account on its first sign-in. A used, expired or unknown token answers 401. |
| `DELETE /v1/sessions/current` | Signs this session out. |
| `GET /v1/account` | The account and its storage use: `{ account, usage: { bytes, quotaBytes, worlds, worldLimit } }`. |
| `DELETE /v1/account` | Deletes the account, its sessions, and every world it owns with all their files. |
| `GET /v1/worlds` | The account's worlds, most recently saved first. |
| `POST /v1/worlds` `{ name }` | Creates an empty world (no version yet). |
| `GET /v1/worlds/<id>` | The world: name, times and `head`, its newest version. |
| `DELETE /v1/worlds/<id>` | Deletes the world, its versions and its files. |
| `PUT /v1/worlds/<id>/shards/<sha256>` | Stores one world shard or note shard. The body must be the shard's canonical JSON (`canonicalJson` from `@brr/schema/world`), hash to `<sha256>` and decode as a `WorldShardV2`, or as a `NoteShardV2` when its `format` is `brr.notes`. 201 when stored, 200 when the world already had it. |
| `PUT /v1/worlds/<id>/imports/<sha256>` | Stores one original model file, any bytes that hash to `<sha256>`. |
| `GET /v1/worlds/<id>/shards/<sha256>`, `GET /v1/worlds/<id>/imports/<sha256>` | Reads a stored file. `ETag` is the SHA-256; `If-None-Match` answers 304. Cached as `private, immutable`. |
| `POST /v1/worlds/<id>/versions` `{ parent, snapshot }` | Saves a new version (see *Saving*). |
| `GET /v1/worlds/<id>/versions?before=&limit=` | Versions newest first, `limit` 1–200 (default 50), with a `next` link while there are more. |
| `GET /v1/worlds/<id>/versions/<n>` | One version and its snapshot. Cached as `private, immutable`. |

A world belongs to the account that created it, and no other account can read, write or even see it: every path under `/v1/worlds/<id>` answers 404 to anyone else. Sharing and roles come with B6.3.

## Saving

A snapshot is the world's manifest plus the SHA-256 of each shard, note shard and model file:

```json
{
  "format": "brr.world-snapshot",
  "schemaVersion": 1,
  "manifest": { "format": "brr.world", "…": "the WorldManifestV2" },
  "shards": { "0_0": "<sha256>", "-1_0": "<sha256>" },
  "notes": { "0_0": "<sha256>" },
  "imports": [{ "sha256": "<sha256>", "name": "my-module.io" }]
}
```

`shards` names exactly the manifest's super-chunks, `notes` exactly its note shards' super-chunks, and `imports` lists each model file once in ascending SHA-256 order.

1. `POST …/versions` with the snapshot. When some of its files aren't stored in this world yet, it answers 409 `{ missing: { shards, imports } }` and saves nothing.
2. `PUT` each missing file, then post the same snapshot again. A save that changes one shard uploads one shard.
3. The save is checked against what is stored, and answers 422 with every issue when:
   - a shard or note shard holds a different super-chunk, or a different number of placements, track pieces or notes, than the manifest says;
   - the shards' track indices don't run 0, 1, 2, … once each;
   - `imports` misses a model file that a placement or consist places as `import:<sha256>`, or lists one that nothing places;
   - `parent` isn't a version of this world.

   So every saved version reopens, with every model file it needs.
4. It answers 201 with the new version, numbered one past the newest, and `previousHead`. Every save becomes a new version and moves `head`, whatever `parent` says: nothing is overwritten. A client that saved from an older version than `previousHead` knows another save came in between (B6.2 shows that).

Saving the same state again stores nothing new: its files and snapshot are already there, so only the version row is added.

## Storage

D1 (`brr-layouts`) holds accounts, sign-in links and sessions (each only as the SHA-256 of its token, so the database never holds a usable token), worlds, their versions, and an index of each world's files with their sizes. R2 (`brr-layout-files`, private, no public domain) holds the files:

| Key | Holds |
|---|---|
| `worlds/<id>/shards/<sha256>.json` | A shard's canonical JSON |
| `worlds/<id>/imports/<sha256>` | An original model file |
| `worlds/<id>/snapshots/<sha256>.json` | A version's snapshot, as canonical JSON |

The Worker creates and upgrades its own D1 tables: before an isolate first touches D1 it applies, in one transaction each, the migrations in `src/migrations.ts` that the `schema_migrations` table doesn't list yet. Isolates that start together race harmlessly, because a migration that another isolate has already recorded fails as a whole and is then found applied. Deploying therefore needs nothing besides Terraform.

## Limits

| Limit | Value | Answer |
|---|---|---|
| A sign-in link | 15 minutes, one use | 401 afterwards |
| A session | 30 days | 401 afterwards |
| Open links per address | 3 | 429 with `Retry-After` until the oldest expires |
| Sign-in requests (links, token exchanges, failed sessions) per client address | 10 a minute | 429 |
| Requests per account | 1,200 a minute | 429 |
| A shard | 16 MiB | 413 |
| A model file | 32 MiB | 413 |
| A JSON request body | 4 MiB | 413 |
| Stored bytes per account (shards, model files and snapshots of the worlds it owns) | 2 GiB | 507 |
| Worlds per account | 500 | 507 |

A daily cron (`17 3 * * *` UTC) deletes expired links and sessions.

## Mail

Sign-in mail goes through Cloudflare Email Service's `send_email` binding (`MAILER`), from `MAIL_FROM` to any address, with no API key. The link opens the web app at `APP_ORIGIN` with the token in its fragment, `<APP_ORIGIN>/#sign-in=<token>`, so it never reaches a server log or a `Referer`, and a mail scanner that fetches it doesn't use it up: only the app's `POST /v1/sessions` does.

## Local

```sh
pnpm --filter @brr/layout-api dev --persist-to .wrangler/state
pnpm --filter @brr/layout-api measure <world directory>...
```

`wrangler dev` sends no mail. It keeps each message, and the local explorer lists them at `http://127.0.0.1:8787/cdn-cgi/local/explorer/api/local/email/sending`; the tests and `measure` read the link from there.

`measure` saves each world directory (the unpacked layout of a `.brr.zip`: `manifest.json`, `shards/<sx>_<sz>.json`, `imports/<sha256>/<name>`, as `apps/web/starters` holds them) as the next version of one new world, then reads every version back and checks each file byte for byte. It prints, per version, how many shards and model files the save had to upload and how long uploading, saving and reading back took.
