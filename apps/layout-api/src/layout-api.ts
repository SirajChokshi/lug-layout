import { decode } from "@brr/schema/decode";
import { SHARE_TOKEN_HEADER, Token } from "@brr/schema/layout-api";
import type { AccountHandlers } from "./account-handlers.ts";
import type { AccountRecord, IAccounts } from "./accounts.ts";
import {
  RATE_LIMIT_RETRY_SECONDS,
  preflight,
  problem,
  signInFirst,
  tooManyRequests,
  unauthorized,
  withoutBody,
} from "./http.ts";
import type { IRequestLimits } from "./request-limits.ts";
import { parseRoute, type AccountRoute, type WorldRoute } from "./routes.ts";
import type { ISchemaMigrations } from "./schema-migrations.ts";
import type { IShareLinks } from "./share-links.ts";
import type { WorldHandlers } from "./world-handlers.ts";

const BEARER = /^Bearer (\S+)$/u;

function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

function bearerToken(request: Request): Token | undefined {
  const credentials = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
  const token = decode(Token, credentials);
  return token.ok ? token.value : undefined;
}

function shareToken(request: Request): Token | undefined {
  const token = decode(Token, request.headers.get(SHARE_TOKEN_HEADER));
  return token.ok ? token.value : undefined;
}

function throttledSignIn(): Response {
  return tooManyRequests(
    "too many sign-in attempts from this address; wait a minute",
    RATE_LIMIT_RETRY_SECONDS,
  );
}

function throttled(who: string): Response {
  return tooManyRequests(`too many requests ${who}; wait a minute`, RATE_LIMIT_RETRY_SECONDS);
}

export class LayoutApi {
  constructor(
    private readonly schema: ISchemaMigrations,
    private readonly accounts: IAccounts,
    private readonly shareLinks: IShareLinks,
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
        return this.respondToAccount(parsed.route, request);
      case "world":
        return this.respondToWorld(parsed.route, request);
      default: {
        const exhaustive: never = parsed;
        throw new Error(`unhandled route result ${String(exhaustive)}`);
      }
    }
  }

  private async respondToAccount(route: AccountRoute, request: Request): Promise<Response> {
    const session = bearerToken(request);
    if (session === undefined) return signInFirst();
    await this.schema.ready();
    const account = await this.signedIn(session, request);
    if (account instanceof Response) return account;
    return this.accountHandlers.handleSignedIn(route, account, session);
  }

  private async respondToWorld(route: WorldRoute, request: Request): Promise<Response> {
    const session = bearerToken(request);
    const share = shareToken(request);
    if (session === undefined && share === undefined) return signInFirst();
    await this.schema.ready();
    const account = session === undefined ? undefined : await this.signedIn(session, request);
    if (account instanceof Response) return account;
    const link = share === undefined ? undefined : await this.shareLinks.find(share);
    if (share !== undefined && link === undefined) {
      return this.refused(request, "this share link was revoked or never existed");
    }
    if (account === undefined && !(await this.limits.allowAnonymous(clientAddress(request)))) {
      return throttled("from this address");
    }
    return this.worldHandlers.handle(route, { account, link }, request);
  }

  private async signedIn(session: Token, request: Request): Promise<AccountRecord | Response> {
    const account = await this.accounts.authenticate(session);
    if (account === undefined) {
      return this.refused(request, "this session has ended or never existed; sign in again");
    }
    if (!(await this.limits.allowAccount(account.id))) return throttled("for this account");
    return account;
  }

  private async refused(request: Request, message: string): Promise<Response> {
    if (!(await this.limits.allowSignIn(clientAddress(request)))) return throttledSignIn();
    return unauthorized(message);
  }
}
