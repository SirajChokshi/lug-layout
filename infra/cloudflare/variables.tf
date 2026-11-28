variable "account_id" {
  description = "Cloudflare account that owns the bucket, database and Worker."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id is the 32-character hex id from the Cloudflare dashboard."
  }
}

variable "cloudflare_api_token" {
  description = "API token. Leave null to read CLOUDFLARE_API_TOKEN from the environment."
  type        = string
  default     = null
  sensitive   = true
}

variable "r2_location" {
  description = "R2 location hint for the release bucket (apac, eeur, enam, weur, wnam, oc). Only honored when the bucket is created."
  type        = string
  default     = null
}

variable "d1_primary_location_hint" {
  description = "Region for the D1 primary (wnam, enam, weur, eeur, apac, oc). Null lets Cloudflare pick near the caller."
  type        = string
  default     = null
}

variable "d1_read_replication" {
  description = "Let D1 place read replicas worldwide. Releases are immutable, so any replica serves correct data."
  type        = bool
  default     = true
}

variable "workers_dev_enabled" {
  description = "Serve the Worker on <name>.<account>.workers.dev. The edge Cache API is a no-op there; use a zone route for caching."
  type        = bool
  default     = true
}

variable "zone_id" {
  description = "Zone that owns route_pattern. Required when route_pattern is set."
  type        = string
  default     = null
}

variable "route_pattern" {
  description = "Zone route for the Worker, for example catalog.example.org/*. Null serves workers.dev only."
  type        = string
  default     = null

  validation {
    condition     = var.route_pattern == null || var.zone_id != null
    error_message = "route_pattern needs zone_id."
  }
}

variable "part_bundle_domain" {
  description = "Custom domain serving the part bundle bucket in zone_id, for example parts.example.org."
  type        = string
  default     = null

  validation {
    condition     = var.part_bundle_domain == null || var.zone_id != null
    error_message = "part_bundle_domain needs zone_id."
  }
}

variable "part_bundle_r2_dev" {
  description = "Keep the part bundle bucket public on its r2.dev domain. Leave it on while any deployment, including a rollback target, still loads from the r2.dev URL; setting part_bundle_domain doesn't turn it off."
  type        = bool
  default     = true
}

variable "ldraw_library_domain" {
  description = "Custom domain serving the LDraw library bucket in zone_id, for example ldraw.example.org."
  type        = string
  default     = null

  validation {
    condition     = var.ldraw_library_domain == null || var.zone_id != null
    error_message = "ldraw_library_domain needs zone_id."
  }
}

variable "ldraw_library_r2_dev" {
  description = "Keep the LDraw library bucket public on its r2.dev domain. Leave it on while any deployment, including a rollback target, still reads the library from the r2.dev URL; setting ldraw_library_domain doesn't turn it off."
  type        = bool
  default     = true
}

variable "worker_bundle" {
  description = "Worker module built by `pnpm --filter @brr/catalog-api build`."
  type        = string
  default     = "../../apps/catalog-api/dist/index.js"
}

variable "layout_api" {
  description = "Deploys the layout API (apps/layout-api): accounts by emailed sign-in link and worlds saved to the cloud. Null, the default, deploys none of it. app_origin is the web app origin that sign-in links open. mail_domain is the subdomain of zone_id that Cloudflare Email Service sends from, and mail_from an address on it. route_pattern is an optional zone route such as layouts-api.example.org/*; workers_dev serves <name>.<account>.workers.dev."
  type = object({
    app_origin    = string
    mail_domain   = string
    mail_from     = string
    route_pattern = optional(string)
    workers_dev   = optional(bool, true)
  })
  default = null

  validation {
    condition     = var.layout_api == null || var.zone_id != null
    error_message = "layout_api needs zone_id: its sign-in mail is sent from a subdomain of that zone."
  }

  validation {
    condition     = var.layout_api == null ? true : can(regex("^https://[a-z0-9.-]+(:[0-9]+)?$", var.layout_api.app_origin))
    error_message = "layout_api.app_origin is an https origin with no path or trailing slash, for example https://layouts.example.org."
  }

  validation {
    condition     = var.layout_api == null ? true : endswith(var.layout_api.mail_from, "@${var.layout_api.mail_domain}")
    error_message = "layout_api.mail_from must be an address on layout_api.mail_domain."
  }
}

variable "layout_worker_bundle" {
  description = "Worker module built by `pnpm --filter @brr/layout-api build`."
  type        = string
  default     = "../../apps/layout-api/dist/index.js"
}
