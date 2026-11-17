# Catalog search on Cloudflare

Terraform for the server-side catalog search (`apps/catalog-api`):

| Resource | Name | Purpose |
|---|---|---|
| `cloudflare_r2_bucket.catalog_releases` | `brr-catalog-releases` | Every catalog release SQLite file at `catalog/<release>/catalog.sqlite`. The source of truth and the offline fallback. Never pruned. |
| `cloudflare_d1_database.catalog` | `brr-catalog` | Query copy of loaded releases, one table set per release (`r<release>_*`), with read replication on. |
| `cloudflare_workers_script.catalog_api` | `brr-catalog-api` | The Worker, bound to D1 (`CATALOG_DB`), R2 (`CATALOG_RELEASES`) and two rate limiters (`QUERY_RATE_LIMIT` for D1 queries, `FILE_RATE_LIMIT` for release-file reads from R2). |
| `cloudflare_workers_script_subdomain.catalog_api` | | `brr-catalog-api.<account>.workers.dev` on or off. |
| `cloudflare_workers_route.catalog_api` | | Optional zone route. Needed for the edge cache: the Cache API does nothing on workers.dev, so there every uncached request reaches D1 or R2. |

Names, the compatibility date, the rate limits and observability come from `apps/catalog-api/wrangler.json`, so `wrangler dev`, the loader and Terraform can't drift apart. Terraform uploads the Worker bundle; nothing here runs `wrangler deploy`. `pnpm check:infra` (run by CI and `pnpm check`) checks formatting and validates the configuration with the pinned provider.

## Credentials

Nothing secret is committed. `*.tfvars`, `backend.hcl`, `.terraform/` and state files are git-ignored. Use three separate credentials so the everyday loader can't touch infrastructure or state:

1. **Terraform token**, for `plan` and `apply` only. A custom API token (*My Profile → API Tokens*) limited to this account, in `CLOUDFLARE_API_TOKEN` or `cloudflare_api_token` in `terraform.tfvars`:
   - Account · **Workers Scripts · Edit** (script, bindings, workers.dev toggle, rate limiters)
   - Account · **D1 · Edit** (the database)
   - Account · **Workers R2 Storage · Edit** (the release bucket)
   - Zone · **Workers Routes · Edit**, scoped to the zone, only if you set `route_pattern`

   *Workers R2 Storage · Edit* is account-wide, so this token can also reach the state bucket. Keep it out of CI and out of the loader.
2. **Loader credentials**, for `load-release --remote`:
   - `CLOUDFLARE_API_TOKEN`: a custom API token with only Account · **D1 · Edit**.
   - `CLOUDFLARE_R2_API_TOKEN`: an R2 API token (*R2 → Manage API tokens*) with **Object Read & Write** on `brr-catalog-releases` only. The loader passes it to `wrangler r2 object put` and uses the D1 token for everything else.
   - `CLOUDFLARE_ACCOUNT_ID`.
3. **State credentials**: a second R2 API token with **Object Read & Write** on the state bucket only. Export its key pair as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.

The account id goes in `terraform.tfvars` as `account_id`, or in `TF_VAR_account_id`. The account needs a workers.dev subdomain registered once (*Workers & Pages → Overview*) before `workers_dev_enabled` can take effect.

## Remote state on R2

State lives in a separate R2 bucket that this configuration doesn't manage, so `terraform destroy` can't delete its own state. Create it once:

```sh
pnpm --filter @brr/catalog-api exec wrangler r2 bucket create brr-terraform-state
cp infra/cloudflare/backend.hcl.example infra/cloudflare/backend.hcl
```

Put your account id into the `endpoints.s3` URL in `backend.hcl`.

`backend.hcl.example` turns on `use_lockfile` (Terraform ≥ 1.10), which locks with a conditional `PUT` (`If-None-Match: *`). Cloudflare lists that header as supported on R2's `PutObject`, but **it is unverified here**. Check it once before relying on it: start `terraform -chdir=infra/cloudflare plan -lock-timeout=0` in two shells at the same moment. The second one must fail with `Error acquiring the state lock`. If both succeed, R2 isn't honouring the lock: set `use_lockfile = false`, and only one person runs `apply` at a time.

## Plan and apply

```sh
cp infra/cloudflare/terraform.tfvars.example infra/cloudflare/terraform.tfvars
pnpm --filter @brr/catalog-api build
terraform -chdir=infra/cloudflare init -backend-config=backend.hcl
terraform -chdir=infra/cloudflare plan -out=catalog.tfplan
terraform -chdir=infra/cloudflare apply catalog.tfplan
```

Rebuild the Worker before every `plan`: the plan compares `content_sha256` of `apps/catalog-api/dist/index.js`.

## Load a catalog release

A release is a SQLite file with the BR-54 schema (`themes`, `sets`, `colors`, `part_categories`, `parts`, `minifigs`, `inventory_parts`, `inventory_minifigs`). Its release id is the first 16 hex digits of its SHA-256.

```sh
export CLOUDFLARE_ACCOUNT_ID=…  CLOUDFLARE_API_TOKEN=…  CLOUDFLARE_R2_API_TOKEN=…
pnpm --filter @brr/catalog-api load-release \
  --sqlite /path/to/catalog.sqlite --source "rebrickable-db@ad9943cc" --remote
```

The loader refuses a release that fails the schema check or contains module rows (`kind = 1`): no real module data exists yet, and the BR-54 spike's synthetic modules must never reach production.

It then uploads the file to R2, and only after that imports one SQL file into D1. The import:
- drops and recreates the release's tables;
- rebuilds both FTS5 indexes;
- upserts the release into `catalog_releases`;
- points `catalog_current` at it, unless you pass `--no-promote`. With `--no-promote` the pointer stays where it was, even when the reloaded release is the current one.

A D1 import is all or nothing, so a failed load leaves the previous release serving. While D1 ingests the file it doesn't answer queries; responses already in the edge cache keep serving. `--local` does the same against `wrangler dev` state.

Older releases stay in D1 until their tables are dropped by hand; their SQLite files stay in R2 for good.
