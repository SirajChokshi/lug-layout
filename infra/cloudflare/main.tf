locals {
  wrangler    = jsondecode(file("${path.module}/../../apps/catalog-api/wrangler.json"))
  d1          = one(local.wrangler.d1_databases)
  r2          = one(local.wrangler.r2_buckets)
  bundle_path = abspath("${path.module}/${var.worker_bundle}")
  part_bundle = jsondecode(file("${path.module}/part-bundles.json"))
  ldraw       = jsondecode(file("${path.module}/ldraw-library.json"))

  layout             = jsondecode(file("${path.module}/../../apps/layout-api/wrangler.json"))
  layout_d1          = one(local.layout.d1_databases)
  layout_r2          = one(local.layout.r2_buckets)
  layout_mailer      = one(local.layout.send_email)
  layout_bundle_path = abspath("${path.module}/${var.layout_worker_bundle}")
  layout_count       = var.layout_api == null ? 0 : 1
  layout_route_count = var.layout_api == null ? 0 : (var.layout_api.route_pattern == null ? 0 : 1)
}

resource "cloudflare_r2_bucket" "part_bundles" {
  account_id = var.account_id
  name       = local.part_bundle.bucket_name
  location   = var.r2_location
}

resource "cloudflare_r2_bucket_cors" "part_bundles" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.part_bundles.name
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
  count       = var.part_bundle_domain == null ? 0 : 1
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.part_bundles.name
  domain      = var.part_bundle_domain
  zone_id     = var.zone_id
  enabled     = true
}

resource "cloudflare_r2_managed_domain" "part_bundles" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.part_bundles.name
  enabled     = var.part_bundle_r2_dev

  lifecycle {
    precondition {
      condition     = var.part_bundle_r2_dev || var.part_bundle_domain != null
      error_message = "Turning r2.dev off would leave the part bundle bucket with no public domain. Set part_bundle_domain first."
    }
  }
}

resource "cloudflare_r2_bucket" "ldraw_library" {
  account_id = var.account_id
  name       = local.ldraw.bucket_name
  location   = var.r2_location
}

resource "cloudflare_r2_bucket_cors" "ldraw_library" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.ldraw_library.name
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

resource "cloudflare_r2_custom_domain" "ldraw_library" {
  count       = var.ldraw_library_domain == null ? 0 : 1
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.ldraw_library.name
  domain      = var.ldraw_library_domain
  zone_id     = var.zone_id
  enabled     = true
}

resource "cloudflare_r2_managed_domain" "ldraw_library" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.ldraw_library.name
  enabled     = var.ldraw_library_r2_dev

  lifecycle {
    precondition {
      condition     = var.ldraw_library_r2_dev || var.ldraw_library_domain != null
      error_message = "Turning r2.dev off would leave the LDraw library bucket with no public domain. Set ldraw_library_domain first."
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
      {
        type = "plain_text"
        name = "PART_BUNDLE_BASE_URL"
        text = local.part_bundle.public_base_url
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

  lifecycle {
    precondition {
      condition     = local.wrangler.vars.PART_BUNDLE_BASE_URL == local.part_bundle.public_base_url
      error_message = "PART_BUNDLE_BASE_URL in apps/catalog-api/wrangler.json differs from public_base_url in part-bundles.json."
    }
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

resource "cloudflare_r2_bucket" "layout_files" {
  count      = local.layout_count
  account_id = var.account_id
  name       = local.layout_r2.bucket_name
  location   = var.r2_location
}

resource "cloudflare_r2_managed_domain" "layout_files" {
  count       = local.layout_count
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.layout_files[0].name
  enabled     = false
}

resource "cloudflare_d1_database" "layouts" {
  count                 = local.layout_count
  account_id            = var.account_id
  name                  = local.layout_d1.database_name
  primary_location_hint = var.d1_primary_location_hint

  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_email_sending_subdomain" "layout_mail" {
  count   = local.layout_count
  zone_id = var.zone_id
  name    = var.layout_api.mail_domain
}

resource "cloudflare_workers_script" "layout_api" {
  count              = local.layout_count
  account_id         = var.account_id
  script_name        = local.layout.name
  main_module        = basename(local.layout_bundle_path)
  content_file       = local.layout_bundle_path
  content_sha256     = filesha256(local.layout_bundle_path)
  compatibility_date = local.layout.compatibility_date

  bindings = concat(
    [
      {
        type = "d1"
        name = local.layout_d1.binding
        id   = cloudflare_d1_database.layouts[0].id
      },
      {
        type        = "r2_bucket"
        name        = local.layout_r2.binding
        bucket_name = cloudflare_r2_bucket.layout_files[0].name
      },
      {
        type                     = "send_email"
        name                     = local.layout_mailer.name
        allowed_sender_addresses = [var.layout_api.mail_from]
      },
      {
        type = "plain_text"
        name = "APP_ORIGIN"
        text = var.layout_api.app_origin
      },
      {
        type = "plain_text"
        name = "MAIL_FROM"
        text = var.layout_api.mail_from
      },
    ],
    [
      for limiter in local.layout.ratelimits : {
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
    enabled = local.layout.observability.enabled
  }

  depends_on = [cloudflare_email_sending_subdomain.layout_mail]

  lifecycle {
    precondition {
      condition     = toset(keys(local.layout.vars)) == toset(["APP_ORIGIN", "MAIL_FROM"])
      error_message = "apps/layout-api/wrangler.json declares vars that cloudflare_workers_script.layout_api doesn't bind. Bind each one here too."
    }
  }
}

resource "cloudflare_workers_cron_trigger" "layout_api" {
  count       = local.layout_count
  account_id  = var.account_id
  script_name = cloudflare_workers_script.layout_api[0].script_name
  schedules   = [for cron in local.layout.triggers.crons : { cron = cron }]
}

resource "cloudflare_workers_script_subdomain" "layout_api" {
  count            = local.layout_count
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.layout_api[0].script_name
  enabled          = var.layout_api.workers_dev
  previews_enabled = false
}

resource "cloudflare_workers_route" "layout_api" {
  count   = local.layout_route_count
  zone_id = var.zone_id
  pattern = var.layout_api.route_pattern
  script  = cloudflare_workers_script.layout_api[0].script_name
}
