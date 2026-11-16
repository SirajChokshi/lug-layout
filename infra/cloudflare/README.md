# Catalog search on Cloudflare

Terraform for the server-side catalog search (`apps/catalog-api`):

| Resource | Name | Purpose |
|---|---|---|
| `cloudflare_r2_bucket.catalog_releases` | `brr-catalog-releases` | Every catalog release SQLite file at `catalog/<release>/catalog.sqlite`. The source of truth and the offline fallback. Never pruned. |
| `cloudflare_d1_database.catalog` | `brr-catalog` | Query copy of loaded releases, one table set per release (`r<release>_*`), with read replication on. |
| `cloudflare_workers_script.catalog_api` | `brr-catalog-api` | The Worker, bound to D1 (`CATALOG_DB`), R2 (`CATALOG_RELEASES`) and a rate limiter (`QUERY_RATE_LIMIT`). |
| `cloudflare_workers_script_subdomain.catalog_api` | | `brr-catalog-api.<account>.workers.dev` on or off. |
| `cloudflare_workers_route.catalog_api` | | Optional zone route. Needed for the edge cache: the Cache API does nothing on workers.dev. |

Names, the compatibility date and the rate limit come from `apps/catalog-api/wrangler.json`, so `wrangler dev`, the loader and Terraform can't drift apart. Terraform uploads the Worker bundle; nothing here runs `wrangler deploy`.

## Credentials

Nothing secret is committed. `*.tfvars`, `backend.hcl`, `.terraform/` and state files are git-ignored.

1. **Cloudflare API token** in `CLOUDFLARE_API_TOKEN` (or `cloudflare_api_token` in a git-ignored `terraform.tfvars`). Create it under *My Profile → API Tokens → Custom token* with:
   - Account · **Workers Scripts · Edit** (script, bindings, workers.dev toggle, rate-limit binding)
   - Account · **D1 · Edit** (database, and the loader's imports)
   - Account · **Workers R2 Storage · Edit** (bucket, and the loader's uploads)
   - Zone · **Workers Routes · Edit**, scoped to the zone, only if you set `route_pattern`
   - Account resources: only this account.
2. **Account id** in `terraform.tfvars` as `account_id`, or `TF_VAR_account_id`. The loader and wrangler read `CLOUDFLARE_ACCOUNT_ID`.
3. **State bucket credentials**: an R2 API token (*R2 → Manage API tokens*) with **Object Read & Write** on the state bucket only. Export its key pair as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.

The account needs a workers.dev subdomain registered once (*Workers & Pages → Overview*) before `workers_dev_enabled` can take effect.

## Remote state on R2

State lives in a separate R2 bucket that this configuration doesn't manage, so destroying the stack can't delete its own state. Create it once:

```sh
pnpm --filter @brr/catalog-api exec wrangler r2 bucket create brr-terraform-state
cp backend.hcl.example backend.hcl
```

Put your account id into the `endpoints.s3` URL in `backend.hcl`. The S3 backend has no lock here, so only one person runs `apply` at a time.

## Plan and apply

```sh
cp terraform.tfvars.example terraform.tfvars
pnpm --filter @brr/catalog-api build
terraform -chdir=infra/cloudflare init -backend-config=backend.hcl
terraform -chdir=infra/cloudflare plan -out=catalog.tfplan
terraform -chdir=infra/cloudflare apply catalog.tfplan
```

Run `init` from `infra/cloudflare` (or with `-chdir`) so `backend.hcl` resolves. Rebuild the Worker before every `plan`: the plan compares `content_sha256` of `apps/catalog-api/dist/index.js`.

## Load a catalog release

A release is a SQLite file with the BR-54 schema (`themes`, `sets`, `colors`, `part_categories`, `parts`, `minifigs`, `inventory_parts`, `inventory_minifigs`). Its release id is the first 16 hex digits of its SHA-256.

```sh
export CLOUDFLARE_ACCOUNT_ID=…  CLOUDFLARE_API_TOKEN=…
pnpm --filter @brr/catalog-api load-release \
  --sqlite /path/to/catalog.sqlite --source "rebrickable-db@ad9943cc" --remote
```

The loader checks the schema, uploads the file to R2 first, then imports one SQL file into D1. That file drops and recreates the release's tables, rebuilds both FTS5 indexes, records the release in `catalog_releases`, and moves `catalog_current` to it (`--no-promote` stages it without switching). A D1 import is all or nothing, so a failed load leaves the previous release serving. While D1 ingests the file it doesn't answer queries; responses already in the edge cache keep serving. `--local` does the same against `wrangler dev` state.

Older releases stay in D1 until their tables are dropped by hand; their SQLite files stay in R2 for good.
