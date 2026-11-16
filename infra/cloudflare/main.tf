locals {
  wrangler    = jsondecode(file("${path.module}/../../apps/catalog-api/wrangler.json"))
  d1          = one(local.wrangler.d1_databases)
  r2          = one(local.wrangler.r2_buckets)
  rate_limit  = one(local.wrangler.ratelimits)
  bundle_path = abspath("${path.module}/${var.worker_bundle}")
}

resource "cloudflare_r2_bucket" "catalog_releases" {
  account_id = var.account_id
  name       = local.r2.bucket_name
  location   = var.r2_location
}

resource "cloudflare_d1_database" "catalog" {
  account_id            = var.account_id
  name                  = local.d1.database_name
  primary_location_hint = var.d1_primary_location_hint

  read_replication = {
    mode = var.d1_read_replication ? "auto" : "disabled"
  }
}

resource "cloudflare_workers_script" "catalog_api" {
  account_id         = var.account_id
  script_name        = local.wrangler.name
  main_module        = basename(local.bundle_path)
  content_file       = local.bundle_path
  content_sha256     = filesha256(local.bundle_path)
  compatibility_date = local.wrangler.compatibility_date

  bindings = [
    {
      type = "d1"
      name = local.d1.binding
      id   = cloudflare_d1_database.catalog.id
    },
    {
      type        = "r2_bucket"
      name        = local.r2.binding
      bucket_name = cloudflare_r2_bucket.catalog_releases.name
    },
    {
      type         = "ratelimit"
      name         = local.rate_limit.name
      namespace_id = local.rate_limit.namespace_id
      simple = {
        limit  = local.rate_limit.simple.limit
        period = local.rate_limit.simple.period
      }
    },
  ]

  observability = {
    enabled = true
  }
}

resource "cloudflare_workers_script_subdomain" "catalog_api" {
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.catalog_api.script_name
  enabled          = var.workers_dev_enabled
  previews_enabled = false
}

resource "cloudflare_workers_route" "catalog_api" {
  count   = var.route_pattern == null ? 0 : 1
  zone_id = var.zone_id
  pattern = var.route_pattern
  script  = cloudflare_workers_script.catalog_api.script_name
}
