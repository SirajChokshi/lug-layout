import { decode, decodedOrThrow } from "@brr/schema/decode";
import { EmailAddress } from "@brr/schema/layout-api";
import * as v from "valibot";
import { AccountHandlers } from "./account-handlers.ts";
import { Accounts } from "./accounts.ts";
import type { IClock } from "./clock.ts";
import { EmailServiceMailer } from "./email-service-mailer.ts";
import { LayoutApi } from "./layout-api.ts";
import { LAYOUT_MIGRATIONS } from "./migrations.ts";
import type { IRandomSource } from "./random.ts";
import { RateLimitBindings } from "./request-limits.ts";
import { SchemaMigrations } from "./schema-migrations.ts";
import { ShareLinks } from "./share-links.ts";
import { WorldDirectory } from "./world-directory.ts";
import { WorldFiles } from "./world-files.ts";
import { WorldHandlers } from "./world-handlers.ts";
import { WorldHistory } from "./world-history.ts";

export interface LayoutEnv {
  readonly LAYOUT_DB: D1Database;
  readonly LAYOUT_FILES: R2Bucket;
  readonly MAILER: SendEmail;
  readonly SIGN_IN_RATE_LIMIT: RateLimit;
  readonly ACCOUNT_RATE_LIMIT: RateLimit;
  readonly APP_ORIGIN: string;
  readonly MAIL_FROM: string;
}

const Origin = v.pipe(
  v.string(),
  v.url("is not a URL"),
  v.check((origin) => new URL(origin).origin === origin, "must be an origin with no path"),
);

const LayoutConfig = v.object({ APP_ORIGIN: Origin, MAIL_FROM: EmailAddress });

export function createLayoutApi(env: LayoutEnv, clock: IClock, random: IRandomSource): LayoutApi {
  const config = decodedOrThrow(
    decode(LayoutConfig, { APP_ORIGIN: env.APP_ORIGIN, MAIL_FROM: env.MAIL_FROM }, "env"),
    "layout API configuration",
  );
  const db = env.LAYOUT_DB;
  const mailer = new EmailServiceMailer(env.MAILER, config.MAIL_FROM);
  const accounts = new Accounts(db, mailer, clock, random, config.APP_ORIGIN);
  const files = new WorldFiles(db, env.LAYOUT_FILES, clock);
  const directory = new WorldDirectory(db, files, clock, random);
  const history = new WorldHistory(db, files, clock);
  const shareLinks = new ShareLinks(db, clock, random, config.APP_ORIGIN);
  return new LayoutApi(
    new SchemaMigrations(db, LAYOUT_MIGRATIONS, clock),
    accounts,
    shareLinks,
    new RateLimitBindings(env.SIGN_IN_RATE_LIMIT, env.ACCOUNT_RATE_LIMIT),
    new AccountHandlers(accounts, directory, files, clock),
    new WorldHandlers(directory, files, history, shareLinks),
  );
}
