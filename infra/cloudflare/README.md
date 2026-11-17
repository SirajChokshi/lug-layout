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

   *Workers R2 Storage · Edit* is account-wide, so this token can also reach the state bucket. Keep it out of the loader. In GitHub Actions only the apply job sees it, through the protected `production` environment; the `check` job and PR plans never do.
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

## Deploy from GitHub Actions

Two workflows replace the manual steps above. Neither commits or prints a secret, and neither uses `backend.hcl`: `ci/configure.sh` writes it to the runner's temp directory from `backend.hcl.example` and the account id secret on every run.

**`.github/workflows/catalog-deploy.yml`** runs when a change touches `apps/catalog-api`, `infra/cloudflare`, `pnpm-lock.yaml` or the workflow itself (README-only changes don't count).

| Job | When | Environment | What it does |
|---|---|---|---|
| Build Worker | every run | none, no secrets | Installs only `@brr/catalog-api`, typechecks, tests and builds it, and uploads `dist/index.js` as an artifact. |
| Terraform plan | pull requests from this repository | `production-plan` | Downloads the bundle, `init` against the R2 backend, `plan -lock=false`, then posts a summary (resource addresses and actions only, never attribute values) as one PR comment that later runs update. |
| Terraform apply | push to `main` | `production` | Skips unless the commit is still main's tip. Otherwise downloads the bundle, `init`, `plan`, then `apply` of exactly that plan. |

Pull requests from forks build but never plan, so they never get a secret. The workflow uses `pull_request`, never `pull_request_target`. Plan and apply both refuse a plan that destroys or replaces the D1 database or the release bucket. Do that locally, on purpose. If `production-plan` lacks a secret, the PR plan is skipped with a warning and a comment naming the secret. If `production` lacks one, apply fails.

Push runs share one run-level concurrency group, `catalog-deploy-main`, with `cancel-in-progress: false`. A run joins the group when it is created, so builds and applies run one whole run at a time, in push order, and never overlap. GitHub keeps one run in the group and one waiting. A newer push replaces the waiting run, which shows as cancelled; nothing is lost, because the newer commit contains it. Apply also skips with a notice unless the run's commit is still main's tip, so re-running an old run can't roll production back. Each pull request has its own group, and a new push to it cancels the stale run.

Remote release loads have their own group, `catalog-release-load`, so loads never overlap each other. A newer waiting load replaces an older waiting one; dispatch the cancelled one again if it still matters. A load may run during an apply. That's safe because they touch different things: the load writes D1 rows and R2 objects, while apply changes the Worker and resource settings, and the destroy guard refuses any plan that would remove the database or the bucket.

All of this serializes CI only. A local `apply` can still collide with CI unless the lock check in *Remote state on R2* passes. Apply waits up to 10 minutes for the lock.

**`.github/workflows/catalog-load-release.yml`** is started by hand (*Actions → Catalog load release → Run workflow*):

| Input | Meaning |
|---|---|
| `release_url` | HTTPS URL of an already built release SQLite file. Run inputs are visible to everyone who can read the repository, so a presigned URL there should expire soon. |
| `release_sha256` | Its SHA-256. The file is refused unless it matches. |
| `source` | The `--source` label, for example `rebrickable-db@ad9943cc`. |
| `remote` | Off: only the `--local` load runs, into throwaway state on the runner. This checks the schema, the module refusal and the D1 import. On: after the local load passes, the same bytes load into production with `--remote`, in the `production` environment. |
| `promote` | Off passes `--no-promote`. |

No script builds a release file from the Rebrickable dumps yet, so a release has to be built elsewhere and hosted at an HTTPS URL.

### Secrets

Every secret is an environment secret. Nothing goes in repository secrets.

| Environment | Secret | Value |
|---|---|---|
| `production` | `CLOUDFLARE_ACCOUNT_ID` | The 32-hex account id. |
| `production` | `TERRAFORM_CLOUDFLARE_API_TOKEN` | The Terraform token (credential 1 above). |
| `production` | `TERRAFORM_STATE_R2_ACCESS_KEY_ID` | Access key id of the state token (credential 3). |
| `production` | `TERRAFORM_STATE_R2_SECRET_ACCESS_KEY` | Its secret access key. |
| `production` | `CATALOG_LOADER_D1_API_TOKEN` | The loader's D1-only token (credential 2, `CLOUDFLARE_API_TOKEN`). |
| `production` | `CATALOG_LOADER_R2_API_TOKEN` | The loader's R2 token, Object Read & Write on `brr-catalog-releases` only (credential 2, `CLOUDFLARE_R2_API_TOKEN`). |
| `production-plan` | `CLOUDFLARE_ACCOUNT_ID` | The same account id. |
| `production-plan` | `TERRAFORM_CLOUDFLARE_API_TOKEN` | A **read-only** token: Account · Workers Scripts · Read, Account · D1 · Read, Account · Workers R2 Storage · Read, and Zone · Workers Routes · Read if `route_pattern` is set. |
| `production-plan` | `TERRAFORM_STATE_R2_ACCESS_KEY_ID` | Access key id of an R2 API token with **Object Read only** on the state bucket. |
| `production-plan` | `TERRAFORM_STATE_R2_SECRET_ACCESS_KEY` | Its secret access key. |

PR plans get read-only credentials because anyone who can push a branch can change a workflow on it and read that job's secrets. That's also why `production` must be limited to `main`. Read-only should be enough for a plan, since `-lock=false` writes nothing to state and the refresh only reads, **but this hasn't been checked against a live account yet**. If a plan fails with an authorization error, report it rather than giving PR plans an Edit token.

The non-secret Terraform variables (`d1_primary_location_hint`, `r2_location`, `workers_dev_enabled`, `zone_id`, `route_pattern`) come from the repository variable `CATALOG_TFVARS_JSON`, a JSON object like `{"d1_primary_location_hint":"wnam","r2_location":"wnam"}`. It may not contain `account_id` or `cloudflare_api_token`. Leave it unset for the defaults in `variables.tf`. It must match what earlier applies used: a different `d1_primary_location_hint` can plan a new database, which the workflow refuses.

### One-time setup

1. Create the state bucket: `pnpm --filter @brr/catalog-api exec wrangler r2 bucket create brr-terraform-state`. CI and local runs share `cloudflare/catalog.tfstate` in it, so state from an earlier local apply carries over.
2. Register the account's workers.dev subdomain in *Workers & Pages → Overview*. Without it, `workers_dev_enabled` has no effect.
3. Create the tokens in the table above.
4. Create both environments under *Settings → Environments* before adding secrets, and before merging any change that triggers the workflow, because the merge push runs apply:
   - `production`: add yourself as a required reviewer, and under *Deployment branches and tags* allow `main` only.
   - `production-plan`: no reviewers and no branch restriction, because pull-request runs need it.
5. Add the secrets to each environment, and `CATALOG_TFVARS_JSON` under *Settings → Secrets and variables → Actions → Variables*.
6. Run the lock check in *Remote state on R2* once.

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
