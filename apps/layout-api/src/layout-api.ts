import { decode } from "@brr/schema/decode";
import { Token } from "@brr/schema/layout-api";
import type { AccountHandlers } from "./account-handlers.ts";
import type { IAccounts } from "./accounts.ts";
import {
  RATE_LIMIT_RETRY_SECONDS,
  preflight,
  problem,
  tooManyRequests,
  unauthorized,
  withoutBody,
} from "./http.ts";
import type { IRequestLimits } from "./request-limits.ts";
import { parseRoute, type RouteResult } from "./routes.ts";
import type { ISchemaMigrations } from "./schema-migrations.ts";
import type { WorldHandlers } from "./world-handlers.ts";

type SignedInRoute = Extract<RouteResult, { kind: "account" } | { kind: "world" }>;

const BEARER = /^Bearer (\S+)$/u;

function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

function bearerToken(request: Request): Token | undefined {
  const credentials = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
  const token = decode(Token, credentials);
  return token.ok ? token.value : undefined;
}

function throttledSignIn(): Response {
  return tooManyRequests(
    "too many sign-in attempts from this address; wait a minute",
    RATE_LIMIT_RETRY_SECONDS,
  );
}

export class LayoutApi {
  constructor(
    private readonly schema: ISchemaMigrations,
    private readonly accounts: IAccounts,
    private readonly limits: IRequestLimits,
    private readonly accountHandlers: AccountHandlers,
    private readonly worldHandlers: WorldHandlers,
  ) {}

  async handle(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return preflight();
    const response = await this.respond(request);
    return request.method === "HEAD" ? withoutBody(response) : response;
  }

  async maintain(scheduledTime: number): Promise<void> {
    await this.schema.ready();
    await this.accounts.removeExpired(scheduledTime);
  }

  private async respond(request: Request): Promise<Response> {
    const parsed = parseRoute(request.method, new URL(request.url));
    switch (parsed.kind) {
      case "not-found":
        return problem(404, "no such endpoint");
      case "invalid":
        return problem(400, parsed.message);
      case "method-not-allowed":
        return problem(405, `${request.method} isn't supported here`, { allow: parsed.allow });
      case "public":
        if (!(await this.limits.allowSignIn(clientAddress(request)))) return throttledSignIn();
        await this.schema.ready();
        return this.accountHandlers.handlePublic(parsed.route, request);
      case "account":
      case "world":
        return this.respondSignedIn(parsed, request);
      default: {
        const exhaustive: never = parsed;
        throw new Error(`unhandled route result ${String(exhaustive)}`);
      }
    }
  }

  private async respondSignedIn(parsed: SignedInRoute, request: Request): Promise<Response> {
    const session = bearerToken(request);
    if (session === undefined) {
      return unauthorized("sign in first, then send Authorization: Bearer <session token>");
    }
    await this.schema.ready();
    const account = await this.accounts.authenticate(session);
    if (account === undefined) {
      if (!(await this.limits.allowSignIn(clientAddress(request)))) return throttledSignIn();
      return unauthorized("this session has ended or never existed; sign in again");
    }
    if (!(await this.limits.allowAccount(account.id))) {
      return tooManyRequests(
        "too many requests for this account; wait a minute",
        RATE_LIMIT_RETRY_SECONDS,
      );
    }
    return parsed.kind === "account"
      ? this.accountHandlers.handleSignedIn(parsed.route, account, session)
      : this.worldHandlers.handle(parsed.route, account, request);
  }
}
