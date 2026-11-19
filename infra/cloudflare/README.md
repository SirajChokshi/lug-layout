# Catalog search and part bundle on Cloudflare

Terraform for the server-side catalog search (`apps/catalog-api`) and for the bucket that serves the compiled part bundle to the web app:

| Resource | Name | Purpose |
|---|---|---|
| `cloudflare_r2_bucket.catalog_releases` | `brr-catalog-releases` | Every catalog release SQLite file at `catalog/<release>/catalog.sqlite`. The source of truth and the offline fallback. Never pruned. |
| `cloudflare_d1_database.catalog` | `brr-catalog` | Query copy of loaded releases, one table set per release (`r<release>_*`), with read replication on. |
| `cloudflare_workers_script.catalog_api` | `brr-catalog-api` | The Worker, bound to D1 (`CATALOG_DB`), R2 (`CATALOG_RELEASES`), the part bundle's public URL (`PART_BUNDLE_BASE_URL`, from `part-bundles.json`; part search fetches manifests from it, so the Worker holds no write access to `brr-part-bundles`), and two rate limiters (`QUERY_RATE_LIMIT` for D1 queries and part searches, `FILE_RATE_LIMIT` for release-file reads from R2). |
| `cloudflare_workers_script_subdomain.catalog_api` | | `brr-catalog-api.<account>.workers.dev` on or off. |
| `cloudflare_workers_route.catalog_api` | | Optional zone route. Needed for the edge cache: the Cache API does nothing on workers.dev, so there every uncached request reaches D1 or R2. |
| `cloudflare_r2_bucket.part_bundles` | `brr-part-bundles` | The compiled part bundle (GLBs, model JSON, one manifest per LOD) under content-addressed keys, and the pinned library's connector records under `library-connectors/`. Written only by CI on `main`; deployed apps read it. Pruned to the current, previous and committed fallback bundles, and `library-bake/` to its current and previous records plus those the live bundles name (`docs/part-bundle.md`); `library-connectors/` is never pruned. |
| `cloudflare_r2_bucket_cors.part_bundles` | | `GET` and `HEAD` from any origin, so apps on Vercel can read the bucket. |
| `cloudflare_r2_custom_domain.part_bundles` | `part_bundle_domain` | Public custom domain in `zone_id`, when `part_bundle_domain` is set. |
| `cloudflare_r2_managed_domain.part_bundles` | `pub-….r2.dev` | The bucket's r2.dev domain, on while `part_bundle_r2_dev` is true (the default). Cloudflare rate-limits r2.dev, so set `part_bundle_domain` for production. |
| `cloudflare_r2_bucket.ldraw_library` | `brr-ldraw-library` | The pinned LDraw library files the import worker reads, unmodified, at the same paths as on GitHub's raw mirror, plus one index per pinned commit. Written only by CI on `main` (`docs/ldraw-library.md`). Never pruned. |
| `cloudflare_r2_bucket_cors.ldraw_library` | | `GET` and `HEAD` from any origin, for the import worker. |
| `cloudflare_r2_custom_domain.ldraw_library` | `ldraw_library_domain` | Optional public custom domain in `zone_id`. |
| `cloudflare_r2_managed_domain.ldraw_library` | `pub-….r2.dev` | The library bucket's r2.dev domain, on while `ldraw_library_r2_dev` is true (the default). |

The web app finds the Worker through `base_url` in `catalog-api.json`, which `apps/web/vercel-build.sh` exports as `VITE_CATALOG_API_BASE_URL` unless Vercel sets it. While it is `null`, deployed apps search only locally. Copy the output `catalog_api_base_url` into it once `route_pattern` is set (workers.dev has no edge cache), commit it, and redeploy Production by hand, because `ignoreCommand` skips commits that touch only `infra/`.

Names, the compatibility date, the rate limits and observability come from `apps/catalog-api/wrangler.json`, so `wrangler dev`, the loader and Terraform can't drift apart. The part bundle bucket's name comes from `part-bundles.json`, which the asset pipeline's uploader reads too, and the LDraw library bucket's name comes from `ldraw-library.json` in the same way. Terraform uploads the Worker bundle; nothing here runs `wrangler deploy`. `pnpm check:infra` (run by CI and `pnpm check`) checks formatting and validates the configuration with the pinned provider.

Why wrangler is used only for `dev` and the loader:
- **The code upload stays in Terraform.** `wrangler deploy` uploads the script together with its bindings and settings. If it ran next to Terraform, the two would overwrite each other's view of the same `cloudflare_workers_script`, and every plan would show drift. With one owner, a plan shows exactly what an apply changes, including a new bundle (`content_sha256`).
- **There are no D1 migrations.** The schema belongs to each release, not to the database. Every load creates `catalog_releases` and `catalog_current` if they don't exist, and drops and recreates its own `r<release>_*` tables (`apps/catalog-api/src/release-schema.ts`). A new database therefore needs no step between `apply` and the first load, and `wrangler d1 migrations` has nothing to apply.
- **No database id is pasted anywhere.** Terraform binds the Worker to `cloudflare_d1_database.catalog.id`. `wrangler.json` carries only `database_name`; with no `database_id`, wrangler 4.163 looks the database up by name (`GET /accounts/<account>/d1/database/brr-catalog`) for `--remote` commands. The id is still printed as the `d1_database_id` output.

## Credentials

Nothing secret is committed. `*.tfvars`, `backend.hcl`, `.terraform/` and state files are git-ignored.

One account API token does everything: Terraform's Cloudflare API calls, Terraform's R2 state backend, the release loader and the part bundle upload. Create it under *Manage Account → Account API Tokens → Create Token → Create Custom Token*, limited to this account:

- Account · **Workers Scripts · Edit** (`Workers Scripts Write`: script, bindings, workers.dev toggle, rate limiters)
- Account · **D1 · Edit** (`D1 Write`: the database and the loader's imports)
- Account · **Workers R2 Storage · Edit** (`Workers R2 Storage Write`: the buckets and their objects, which covers `brr-catalog-releases`, `brr-part-bundles`, `brr-ldraw-library` and the state bucket `brr-terraform-state`)
- Zone · **Workers Routes · Edit** (`Workers Routes Write`), scoped to the zone, only if you set `route_pattern`

The dashboard's **Edit** is the API's **Write**: Account · D1 · Edit is the permission group `D1 Write`. The groups above are the ones Cloudflare's OpenAPI schema (`x-api-token-group`, [`cloudflare/api-schemas`](https://github.com/cloudflare/api-schemas) at `023a080`) lists for every endpoint the provider calls: D1 database create, read, update and delete; R2 bucket create, update and delete; Worker script upload, settings and subdomain; zone Workers routes. The schema names no group for the D1 import API, which `wrangler d1 execute --file --remote` uses, for R2 single-object `PUT`, for the R2 bucket CORS endpoints, for the r2.dev managed-domain endpoints, or for custom-domain create and update; a custom domain also adds a DNS record to the zone. Those are unverified until the first remote load or the first apply that creates them. If one fails with an authorization error, report the endpoint rather than widening the token blindly.

**S3 credentials come from the same token.** R2's S3 API, which the Terraform state backend and the part bundle uploader use, accepts an API token with R2 permissions: the Access Key ID is the token's **id**, and the Secret Access Key is the **SHA-256 hex digest of the token value**. Cloudflare documents this in *R2 → Authentication → Get S3 API credentials from an API token*. The *Data localization → R2* guide uses exactly this setup: an account API token with Account · Workers R2 Storage · Edit, token id as the access key, `echo -n "<token>" | shasum -a 256` as the secret. Account API tokens are listed as supported for R2. `ci/terraform.sh` derives both values from `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_API_TOKEN_ID` and runs `terraform -chdir=infra/cloudflare` with them, in CI and locally alike, printing nothing of its own so `terraform show -json` output stays valid JSON. In GitHub Actions, `ci/configure.sh` registers the derived secret as a log mask earlier in the same job. This hasn't been checked against a live account yet.

The token id is a 32-hex string on the token's page in the dashboard. `curl -s https://api.cloudflare.com/client/v4/accounts/<account_id>/tokens/verify -H "Authorization: Bearer <token>"` also returns it as `result.id`.

*Workers R2 Storage · Edit* is account-wide, so this token can read and write every bucket in the account, the Terraform state included. That's the price of one token. Keep it only in the protected `production` environment; the `check` job and pull requests never see it.

The account id goes in `terraform.tfvars` as `account_id`, or in `TF_VAR_account_id`. The account needs a workers.dev subdomain registered once (*Workers & Pages → Overview*) before `workers_dev_enabled` can take effect.

## Remote state on R2

State lives in a separate R2 bucket that this configuration doesn't manage, so `terraform destroy` can't delete its own state. Create it once:

```sh
pnpm --filter @brr/catalog-api exec wrangler r2 bucket create brr-terraform-state
cp infra/cloudflare/backend.hcl.example infra/cloudflare/backend.hcl
```

Put your account id into the `endpoints.s3` URL in `backend.hcl`.

`backend.hcl.example` turns on `use_lockfile` (Terraform ≥ 1.10), which locks with a conditional `PUT` (`If-None-Match: *`). Cloudflare lists that header as supported on R2's `PutObject`, but **it is unverified here**. Check it once before relying on it: start `infra/cloudflare/ci/terraform.sh plan -lock-timeout=0` in two shells at the same moment. The second one must fail with `Error acquiring the state lock`. If both succeed, R2 isn't honouring the lock: set `use_lockfile = false`, and only one person runs `apply` at a time.

## Plan and apply

```sh
export CLOUDFLARE_API_TOKEN=…  CLOUDFLARE_API_TOKEN_ID=…
cp infra/cloudflare/terraform.tfvars.example infra/cloudflare/terraform.tfvars
pnpm --filter @brr/catalog-api build
infra/cloudflare/ci/terraform.sh init -backend-config=backend.hcl
infra/cloudflare/ci/terraform.sh plan -out=catalog.tfplan
infra/cloudflare/ci/terraform.sh apply catalog.tfplan
```

Rebuild the Worker before every `plan`: the plan compares `content_sha256` of `apps/catalog-api/dist/index.js`.

## Deploy from GitHub Actions

Pull requests need no secrets. The `check` job in `ci.yml` runs `pnpm check:infra` (formatting and `terraform validate` with the pinned provider), and nothing a pull request runs talks to Cloudflare. Pull requests from forks are therefore no different from any other.

Two workflows replace the manual steps above. Neither commits or prints a secret, and neither uses `backend.hcl`: `ci/configure.sh` writes it to the runner's temp directory from `backend.hcl.example` and the account id secret on every run.

**`.github/workflows/catalog-deploy.yml`** runs on pushes to `main` that touch its deploy inputs: `apps/catalog-api`, `infra/cloudflare`, `pnpm-lock.yaml` or the workflow itself, but not the two READMEs. The list lives once, in the workflow's `on.push.paths`, and `ci/apply-guard.sh` reads it from there.

| Job | Environment | What it does |
|---|---|---|
| Build Worker | none, no secrets | Installs only `@brr/catalog-api`, typechecks, tests and builds it, and uploads `dist/index.js` as an artifact. |
| Terraform plan | `production` | Skips if main has moved on to different deploy inputs (see below). Otherwise `init`, `plan`, and writes the plan summary (resource addresses and actions, never attribute values) to the run's summary page for review. The full plan is in the job log. |
| Terraform apply | `production` | Same guard, then plans again and refuses unless that plan is the reviewed one: the same resources, actions and before and after values, compared by digest. Then applies exactly that plan. |

**Reviewing a deploy.** `production` has you as its required reviewer, and GitHub asks for approval once per job that uses it:
1. Approve **Terraform plan**. It changes nothing.
2. Open the run's summary and read *Terraform plan for review*.
3. Approve **Terraform apply** if that's what should change; reject it otherwise, and production stays as it is.

Plan and apply both refuse a plan that destroys or replaces the D1 database or any R2 bucket (`ci/plan-report.sh` matches every `cloudflare_r2_bucket`). Do that locally, on purpose. If `production` lacks a secret, the plan job fails and names it.

Push runs share one run-level concurrency group, `catalog-deploy-main`, with `cancel-in-progress: false`. A run joins the group when it is created, so builds, plans and applies run one whole run at a time, in push order, and never overlap. GitHub keeps one run in the group and one waiting. A newer push replaces the waiting run, which shows as cancelled; nothing is lost, because the newer commit contains it. Before planning and again before applying, `ci/apply-guard.sh` compares the run's commit with main's tip, using a full-history checkout. It skips with a notice if the commit isn't an ancestor of the tip, or if `git diff` shows the deploy inputs differ between them. When the inputs differ, a newer push changed them and started its own run, queued behind this one. Otherwise the commit's deploy inputs are the tip's, so it applies even when unrelated commits have landed on `main` since. Re-running an old run therefore can't roll production back.

Remote release loads have their own group, `catalog-release-load`, so loads never overlap each other. A newer waiting load replaces an older waiting one; dispatch the cancelled one again if it still matters. A load may run during an apply. That's safe because they touch different things: the load writes D1 rows and R2 objects, while apply changes the Worker and resource settings, and the destroy guard refuses any plan that would remove the database or a bucket.

All of this serializes CI only. A local `apply` can still collide with CI unless the lock check in *Remote state on R2* passes. Plan and apply wait up to 10 minutes for the lock.

**`.github/workflows/catalog-load-release.yml`** is started by hand (*Actions → Catalog load release → Run workflow*):

| Input | Meaning |
|---|---|
| `release_url` | HTTPS URL of an already built release SQLite file. Run inputs are visible to everyone who can read the repository, so a presigned URL there should expire soon. |
| `release_sha256` | Its SHA-256. The file is refused unless it matches. |
| `source` | The `--source` label, for example `rebrickable-db@ad9943cc`. |
| `remote` | Off: only the `--local` load runs, into throwaway state on the runner. This checks the schema, the module refusal and the D1 import. On: after the local load passes, the same bytes load into production with `--remote`, in the `production` environment, using `CLOUDFLARE_API_TOKEN` for both the D1 import and the R2 upload. |
| `promote` | Off passes `--no-promote`. |

No script builds a release file from the Rebrickable dumps yet, so a release has to be built elsewhere and hosted at an HTTPS URL.

### Secrets

Three environment secrets in `production`, and nothing in repository secrets:

| Secret | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | The 32-hex account id. |
| `CLOUDFLARE_API_TOKEN` | The account API token's value (see *Credentials*). |
| `CLOUDFLARE_API_TOKEN_ID` | That token's id, 32 hex characters. Not secret on its own, but it's half of the R2 key pair. |

The non-secret Terraform variables (`d1_primary_location_hint`, `r2_location`, `workers_dev_enabled`, `zone_id`, `route_pattern`, `part_bundle_domain`, `part_bundle_r2_dev`, `ldraw_library_domain`, `ldraw_library_r2_dev`) come from the repository variable `CATALOG_TFVARS_JSON`, a JSON object like `{"d1_primary_location_hint":"wnam","r2_location":"wnam"}`. It may not contain `account_id` or `cloudflare_api_token`. Leave it unset for the defaults in `variables.tf`. It must match what earlier applies used: a different `d1_primary_location_hint` can plan a new database, which the workflow refuses.

### One-time setup

1. Create the state bucket: `pnpm --filter @brr/catalog-api exec wrangler r2 bucket create brr-terraform-state` after `wrangler login`, or *R2 → Create bucket* in the dashboard. CI and local runs share `cloudflare/catalog.tfstate` in it, so state from an earlier local apply carries over. Don't create `brr-catalog`, `brr-catalog-releases`, `brr-part-bundles` or `brr-ldraw-library` by hand: the first apply creates them, and Terraform never adopts a resource that isn't in its state.
2. Register the account's workers.dev subdomain in *Workers & Pages → Overview*. Without it, `workers_dev_enabled` has no effect.
3. Create the account API token (see *Credentials*). Copy its value and its id.
4. Create the `production` environment under *Settings → Environments*, before adding secrets and before merging any change that triggers the deploy workflow, because the merge push starts a deploy. Add yourself as a required reviewer, and under *Deployment branches and tags* allow `main` only.
5. Add the three secrets to `production`, and optionally `CATALOG_TFVARS_JSON` under *Settings → Secrets and variables → Actions → Variables*.
6. Run the lock check in *Remote state on R2* once.

## Load a catalog release

A release is a SQLite file with the BR-54 schema (`themes`, `sets`, `colors`, `part_categories`, `parts`, `minifigs`, `inventory_parts`, `inventory_minifigs`). Its release id is the first 16 hex digits of its SHA-256.

```sh
export CLOUDFLARE_ACCOUNT_ID=…  CLOUDFLARE_API_TOKEN=…
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

## Part bundle bucket

`brr-part-bundles` holds the compiled part bundle that the web app loads at runtime: content-addressed objects at `<lod>/<file>.<sha256 prefix>.<ext>` and one manifest per LOD. It also holds the connector records precomputed for the whole pinned library, at `library-connectors/<package>/<stem>.<sha256 prefix>.json` under the index `library-connectors/library-connectors.<sha256 prefix>.json` (`docs/part-bundle.md`). Nothing in it is generated by hand, and nothing generated is committed. Only CI on pushes to `main` writes it, in the `production` environment, with `CLOUDFLARE_API_TOKEN` and S3 credentials derived from it as in *Credentials*. Pull requests have no secrets, so they never write it. Terraform owns the bucket and how it's reached:

- **Public access.** Browsers fetch the objects directly, so the bucket needs a public domain. It's served on its r2.dev domain while `part_bundle_r2_dev` is true, which is the default. Cloudflare rate-limits r2.dev and recommends a custom domain for production. When `part_bundle_domain` is set (with `zone_id`), the bucket is also served on that domain, which goes through Cloudflare's cache. Terraform refuses a plan that would leave the bucket with no public domain.
- **Switching from r2.dev to a custom domain.** Apps bake the base URL in at build time, so r2.dev has to stay on until nothing loads from it:
  1. Set `part_bundle_domain` and apply. `part_bundle_r2_dev` stays true, so both domains serve the same objects.
  2. Commit the new `part_bundle_base_url` output as `public_base_url` in `part-bundles.json`, then redeploy Vercel Production.
  3. Set `part_bundle_r2_dev` to false and apply, but only once no deployment you might serve or roll back to was built against r2.dev. Such deployments lose their parts when r2.dev goes off.
- **CORS.** `GET` and `HEAD` from any origin. The objects are public and immutable.
- **Caching.** The uploader stores every object with `Cache-Control: public, max-age=31536000, immutable`. Manifests can be immutable too, because their name changes whenever their inputs do.
- **The app's URL.** `public_base_url` in `part-bundles.json` is a committed copy of the `part_bundle_base_url` output. Terraform doesn't read it. The Vercel build and the part bundle workflow do, so neither needs a variable set.

## LDraw library bucket

`brr-ldraw-library` holds the unmodified LDraw library files that the import worker fetches for parts the bundle doesn't ship. `docs/ldraw-library.md` covers what is published, the key layout and the workflow. Terraform owns the bucket and how it's reached, the same way as the part bundle bucket:

- **Public access.** The import worker fetches the files directly, so the bucket is public on its r2.dev domain while `ldraw_library_r2_dev` is true (the default). Set `ldraw_library_domain` (with `zone_id`) for a custom domain that goes through Cloudflare's cache. Terraform refuses a plan that would leave the bucket with no public domain.
- **The app's URL.** `public_base_url` in `ldraw-library.json` is a committed copy of the `ldraw_library_base_url` output. It's `null` until the first apply. While it's `null`, deployed builds keep reading the library from GitHub raw; committing it switches them to this bucket, and from then on GitHub is dev-only (`docs/ldraw-library.md`). Switch domains in the same three steps as the part bundle, using `ldraw_library_domain`, `ldraw_library_r2_dev` and `ldraw-library.json`.
- **CORS and caching.** `GET` and `HEAD` from any origin. Every object is immutable: its key contains the pinned commit.
- **Pruning.** The part bundle workflow's `library-publish` job keeps only the current and previous commits and those the live part bundles name, and deletes the rest (*Pruning old commits* in `docs/ldraw-library.md`).
