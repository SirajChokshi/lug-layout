output "d1_database_id" {
  description = "D1 database the loader imports releases into."
  value       = cloudflare_d1_database.catalog.id
}

output "d1_database_name" {
  value = cloudflare_d1_database.catalog.name
}

output "r2_bucket_name" {
  description = "Bucket holding every catalog release SQLite file."
  value       = cloudflare_r2_bucket.catalog_releases.name
}

output "part_bundle_bucket_name" {
  description = "Bucket holding the content-addressed part bundle, written only from main."
  value       = cloudflare_r2_bucket.part_bundles.name
}

output "part_bundle_base_url" {
  description = "VITE_BUNDLE_BASE_URL for Vercel Production: the custom domain when one is set, otherwise r2.dev."
  value       = var.part_bundle_domain == null ? "https://${cloudflare_r2_managed_domain.part_bundles.domain}/" : "https://${var.part_bundle_domain}/"
}

output "worker_name" {
  value = cloudflare_workers_script.catalog_api.script_name
}

output "route_pattern" {
  value = var.route_pattern
}

output "catalog_api_base_url" {
  description = "base_url for catalog-api.json: the Worker's zone route. Null without route_pattern, since workers.dev has no edge cache."
  value       = var.route_pattern == null ? null : "https://${trimsuffix(var.route_pattern, "/*")}/"
}
