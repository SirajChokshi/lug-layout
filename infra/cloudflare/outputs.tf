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

output "part_bundle_bucket_names" {
  description = "Buckets holding the content-addressed part bundles: production is written only from main, preview from pull requests."
  value       = { for target, bucket in cloudflare_r2_bucket.part_bundles : target => bucket.name }
}

output "part_bundle_base_urls" {
  description = "VITE_BUNDLE_BASE_URL for Vercel: production for the Production environment, preview for Preview. The custom domain when one is set, otherwise r2.dev."
  value = {
    for target, managed in cloudflare_r2_managed_domain.part_bundles :
    target => contains(keys(var.part_bundle_domains), target) ? "https://${var.part_bundle_domains[target]}/" : "https://${managed.domain}/"
  }
}

output "worker_name" {
  value = cloudflare_workers_script.catalog_api.script_name
}

output "route_pattern" {
  value = var.route_pattern
}
