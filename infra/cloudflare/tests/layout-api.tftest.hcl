mock_provider "cloudflare" {}

variables {
  account_id           = "0123456789abcdef0123456789abcdef"
  worker_bundle        = "../../apps/catalog-api/wrangler.json"
  layout_worker_bundle = "../../apps/layout-api/wrangler.json"
}

run "layout_api_deploys_nothing_by_default" {
  command = plan

  assert {
    condition = alltrue([
      length(cloudflare_d1_database.layouts) == 0,
      length(cloudflare_r2_bucket.layout_files) == 0,
      length(cloudflare_email_sending_subdomain.layout_mail) == 0,
      length(cloudflare_workers_script.layout_api) == 0,
      length(cloudflare_workers_cron_trigger.layout_api) == 0,
      length(cloudflare_workers_route.layout_api) == 0,
    ])
    error_message = "With layout_api null, no layout API resource may be planned."
  }

  assert {
    condition     = output.layout_api_base_url == null && output.layout_d1_database_id == null
    error_message = "With layout_api null, the layout API outputs are null."
  }
}

run "layout_api_deploys_a_private_bucket_a_database_and_a_bound_worker" {
  command = apply

  variables {
    zone_id = "fedcba9876543210fedcba9876543210"
    layout_api = {
      app_origin    = "https://layouts.example.org"
      mail_domain   = "mail.example.org"
      mail_from     = "sign-in@mail.example.org"
      route_pattern = "layouts-api.example.org/*"
    }
  }

  assert {
    condition     = cloudflare_workers_script.layout_api[0].script_name == "brr-layout-api"
    error_message = "The Worker takes its name from apps/layout-api/wrangler.json."
  }

  assert {
    condition = {
      for binding in cloudflare_workers_script.layout_api[0].bindings : binding.name => binding.type
      } == {
      LAYOUT_DB          = "d1"
      LAYOUT_FILES       = "r2_bucket"
      MAILER             = "send_email"
      APP_ORIGIN         = "plain_text"
      MAIL_FROM          = "plain_text"
      SIGN_IN_RATE_LIMIT = "ratelimit"
      ACCOUNT_RATE_LIMIT = "ratelimit"
    }
    error_message = "The Worker binds exactly the bindings apps/layout-api/wrangler.json declares."
  }

  assert {
    condition = one([
      for binding in cloudflare_workers_script.layout_api[0].bindings : binding.allowed_sender_addresses
      if binding.type == "send_email"
    ]) == tolist(["sign-in@mail.example.org"])
    error_message = "The mail binding may send only from layout_api.mail_from."
  }

  assert {
    condition = one([
      for binding in cloudflare_workers_script.layout_api[0].bindings : binding.text
      if binding.name == "APP_ORIGIN"
    ]) == "https://layouts.example.org"
    error_message = "Sign-in links open layout_api.app_origin."
  }

  assert {
    condition     = cloudflare_r2_managed_domain.layout_files[0].enabled == false
    error_message = "The layout files bucket has no public r2.dev domain."
  }

  assert {
    condition     = cloudflare_d1_database.layouts[0].name == "brr-layouts" && cloudflare_d1_database.layouts[0].read_replication.mode == "disabled"
    error_message = "Accounts and worlds live in brr-layouts, read from its primary only."
  }

  assert {
    condition     = [for schedule in cloudflare_workers_cron_trigger.layout_api[0].schedules : schedule.cron] == ["17 3 * * *"]
    error_message = "The daily cleanup runs on the cron apps/layout-api/wrangler.json declares."
  }

  assert {
    condition     = cloudflare_email_sending_subdomain.layout_mail[0].name == "mail.example.org"
    error_message = "Email Sending is set up on layout_api.mail_domain."
  }

  assert {
    condition     = output.layout_api_base_url == "https://layouts-api.example.org/"
    error_message = "The base URL is the route without its wildcard."
  }
}

run "layout_api_needs_a_zone_for_its_mail" {
  command = plan

  variables {
    layout_api = {
      app_origin  = "https://layouts.example.org"
      mail_domain = "mail.example.org"
      mail_from   = "sign-in@mail.example.org"
    }
  }

  expect_failures = [var.layout_api]
}

run "layout_api_refuses_a_sender_off_its_mail_domain" {
  command = plan

  variables {
    zone_id = "fedcba9876543210fedcba9876543210"
    layout_api = {
      app_origin  = "https://layouts.example.org"
      mail_domain = "mail.example.org"
      mail_from   = "sign-in@example.org"
    }
  }

  expect_failures = [var.layout_api]
}

run "layout_api_refuses_an_app_origin_with_a_path" {
  command = plan

  variables {
    zone_id = "fedcba9876543210fedcba9876543210"
    layout_api = {
      app_origin  = "https://layouts.example.org/app/"
      mail_domain = "mail.example.org"
      mail_from   = "sign-in@mail.example.org"
    }
  }

  expect_failures = [var.layout_api]
}
