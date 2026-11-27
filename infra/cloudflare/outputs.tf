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

output "ldraw_library_bucket_name" {
  description = "Bucket holding the pinned LDraw library files the import worker reads, written only from main."
  value       = cloudflare_r2_bucket.ldraw_library.name
}

output "ldraw_library_base_url" {
  description = "public_base_url for ldraw-library.json: the custom domain when one is set, otherwise r2.dev."
  value       = var.ldraw_library_domain == null ? "https://${cloudflare_r2_managed_domain.ldraw_library.domain}/" : "https://${var.ldraw_library_domain}/"
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

output "layout_api_worker_name" {
  description = "The layout API Worker. Null while layout_api is null."
  value       = one(cloudflare_workers_script.layout_api[*].script_name)
}

output "layout_d1_database_id" {
  description = "D1 database holding accounts, sessions, worlds and their versions. Null while layout_api is null."
  value       = one(cloudflare_d1_database.layouts[*].id)
}

output "layout_files_bucket_name" {
  description = "Private bucket holding worlds' shards, snapshots and original model files. Null while layout_api is null."
  value       = one(cloudflare_r2_bucket.layout_files[*].name)
}

output "layout_api_base_url" {
  description = "The layout API's zone route. Null without layout_api.route_pattern."
  value       = local.layout_route_count == 0 ? null : "https://${trimsuffix(var.layout_api.route_pattern, "/*")}/"
}
