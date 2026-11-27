import {
  SessionRequest,
  SignInLinkRequest,
  type AccountResponse,
  type SessionResponse,
  type SignInLinkResponse,
  type Token,
} from "@brr/schema/layout-api";
import type * as v from "valibot";
import { OUTSTANDING_LINKS_PER_ADDRESS, type AccountRecord, type IAccounts } from "./accounts.ts";
import { accountBody } from "./bodies.ts";
import type { IClock } from "./clock.ts";
import {
  isoTime,
  json,
  noContent,
  problem,
  retryAfterSeconds,
  tooManyRequests,
  unauthorized,
} from "./http.ts";
import { readJson } from "./request-body.ts";
import type { AccountRoute, PublicRoute } from "./routes.ts";
import { WORLD_LIMIT, type IWorldDirectory } from "./world-directory.ts";
import { STORAGE_QUOTA_BYTES, type IWorldFiles } from "./world-files.ts";

export class AccountHandlers {
  constructor(
    private readonly accounts: IAccounts,
    private readonly worlds: IWorldDirectory,
    private readonly files: IWorldFiles,
    private readonly clock: IClock,
  ) {}

  handlePublic(route: PublicRoute, request: Request): Promise<Response> {
    switch (route.kind) {
      case "sign-in-link":
        return this.requestSignInLink(request);
      case "session-start":
        return this.startSession(request);
      default: {
        const exhaustive: never = route;
        throw new Error(`unhandled public route ${String(exhaustive)}`);
      }
    }
  }

  handleSignedIn(route: AccountRoute, account: AccountRecord, session: Token): Promise<Response> {
    switch (route.kind) {
      case "session-end":
        return this.endSession(session);
      case "account":
        return this.describe(account);
      case "account-delete":
        return this.remove(account);
      default: {
        const exhaustive: never = route;
        throw new Error(`unhandled account route ${String(exhaustive)}`);
      }
    }
  }

  private async requestSignInLink(request: Request): Promise<Response> {
    const body = await readJson(request, SignInLinkRequest);
    if (!body.ok) return body.response;
    const outcome = await this.accounts.requestSignInLink(body.value.email);
    switch (outcome.kind) {
      case "sent": {
        const sent: v.InferInput<typeof SignInLinkResponse> = {
          expiresAt: isoTime(outcome.expiresAt),
        };
        return json(sent, 202);
      }
      case "throttled":
        return tooManyRequests(
          `${OUTSTANDING_LINKS_PER_ADDRESS} sign-in links for this address are still open; use one of them or wait until the oldest expires`,
          retryAfterSeconds(outcome.retryAt, this.clock.now()),
        );
      case "undeliverable":
        return problem(502, `the sign-in mail could not be sent: ${outcome.reason}`);
      default: {
        const exhaustive: never = outcome;
        throw new Error(`unhandled sign-in link outcome ${String(exhaustive)}`);
      }
    }
  }

  private async startSession(request: Request): Promise<Response> {
    const body = await readJson(request, SessionRequest);
    if (!body.ok) return body.response;
    const outcome = await this.accounts.startSession(body.value.token);
    switch (outcome.kind) {
      case "started": {
        const started: v.InferInput<typeof SessionResponse> = {
          session: { token: outcome.token, expiresAt: isoTime(outcome.expiresAt) },
          account: accountBody(outcome.account),
        };
        return json(started, 201);
      }
      case "refused":
        return unauthorized(
          "this sign-in link has expired, was used already or never existed; ask for a new one",
        );
      default: {
        const exhaustive: never = outcome;
        throw new Error(`unhandled session outcome ${String(exhaustive)}`);
      }
    }
  }

  private async endSession(session: Token): Promise<Response> {
    await this.accounts.endSession(session);
    return noContent();
  }

  private async describe(account: AccountRecord): Promise<Response> {
    const [bytes, worlds] = await Promise.all([
      this.files.usage(account.id),
      this.worlds.list(account.id),
    ]);
    const body: v.InferInput<typeof AccountResponse> = {
      account: accountBody(account),
      usage: {
        bytes,
        quotaBytes: STORAGE_QUOTA_BYTES,
        worlds: worlds.length,
        worldLimit: WORLD_LIMIT,
      },
    };
    return json(body, 200);
  }

  private async remove(account: AccountRecord): Promise<Response> {
    await this.worlds.removeOwnedBy(account.id);
    await this.accounts.remove(account);
    return noContent();
  }
}
