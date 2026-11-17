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
  description = "Bucket holding the content-addressed part bundle."
  value       = cloudflare_r2_bucket.part_bundles.name
}

output "part_bundle_base_url" {
  description = "Set VITE_BUNDLE_BASE_URL in the Vercel project to this."
  value       = var.part_bundle_domain == null ? "https://${cloudflare_r2_managed_domain.part_bundles.domain}/" : "https://${var.part_bundle_domain}/"
}

output "worker_name" {
  value = cloudflare_workers_script.catalog_api.script_name
}

output "route_pattern" {
  value = var.route_pattern
}
