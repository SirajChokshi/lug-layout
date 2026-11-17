locals {
  wrangler     = jsondecode(file("${path.module}/../../apps/catalog-api/wrangler.json"))
  d1           = one(local.wrangler.d1_databases)
  r2           = one(local.wrangler.r2_buckets)
  bundle_path  = abspath("${path.module}/${var.worker_bundle}")
  part_bundles = jsondecode(file("${path.module}/part-bundles.json"))
}

resource "cloudflare_r2_bucket" "part_bundles" {
  for_each   = local.part_bundles
  account_id = var.account_id
  name       = each.value.bucket_name
  location   = var.r2_location
}

resource "cloudflare_r2_bucket_cors" "part_bundles" {
  for_each    = cloudflare_r2_bucket.part_bundles
  account_id  = var.account_id
  bucket_name = each.value.name
  rules = [
    {
      allowed = {
        methods = ["GET", "HEAD"]
        origins = ["*"]
      }
      max_age_seconds = 86400
    },
  ]
}

resource "cloudflare_r2_custom_domain" "part_bundles" {
  for_each    = var.part_bundle_domains
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.part_bundles[each.key].name
  domain      = each.value
  zone_id     = var.zone_id
  enabled     = true
}

resource "cloudflare_r2_managed_domain" "part_bundles" {
  for_each    = cloudflare_r2_bucket.part_bundles
  account_id  = var.account_id
  bucket_name = each.value.name
  enabled     = contains(var.part_bundle_r2_dev, each.key)

  lifecycle {
    precondition {
      condition     = contains(var.part_bundle_r2_dev, each.key) || contains(keys(var.part_bundle_domains), each.key)
      error_message = "Turning r2.dev off for the ${each.key} part bundle bucket would leave it with no public domain. Add it to part_bundle_domains first."
    }
  }
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

  bindings = concat(
    [
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
    ],
    [
      for limiter in local.wrangler.ratelimits : {
        type         = "ratelimit"
        name         = limiter.name
        namespace_id = limiter.namespace_id
        simple = {
          limit  = limiter.simple.limit
          period = limiter.simple.period
        }
      }
    ],
  )

  observability = {
    enabled = local.wrangler.observability.enabled
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
