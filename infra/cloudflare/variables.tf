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
  description = "Custom domain serving the part bundle bucket, for example parts.example.org, in zone_id. Null serves it on the bucket's r2.dev domain, which Cloudflare rate-limits."
  type        = string
  default     = null

  validation {
    condition     = var.part_bundle_domain == null || var.zone_id != null
    error_message = "part_bundle_domain needs zone_id."
  }
}

variable "worker_bundle" {
  description = "Worker module built by `pnpm --filter @brr/catalog-api build`."
  type        = string
  default     = "../../apps/catalog-api/dist/index.js"
}
