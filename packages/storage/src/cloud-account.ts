import { decode, decodedOrThrow, type Decoded } from "@brr/schema/decode";
import {
  ErrorResponse,
  SIGN_IN_FRAGMENT_KEY,
  SessionResponse,
  SignInLinkRequest,
  SignInLinkResponse,
} from "@brr/schema/layout-api";
import { inStore } from "./indexed-db.ts";

const SESSION_DATABASE = "brr-cloud-session";
const SESSION_STORE = { name: "session" };
const SESSION_KEY = "current";
const SESSION_ENDED = "your sign-in ended; sign in again to keep syncing";

export type CloudSignIn = "signed-out" | "sending" | "link-sent" | "signing-in" | "signed-in";

export interface CloudAccountView {
  readonly signIn: CloudSignIn;
  readonly email: string | null;
  readonly error: string | null;
}

export interface LayoutRequest {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  readonly json?: unknown;
  readonly body?: Uint8Array<ArrayBuffer> | string;
}

export class CloudUnreachableError extends Error {}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function apiError(text: string): string {
  try {
    const body = decode(ErrorResponse, JSON.parse(text));
    return body.ok ? body.value.error : text;
  } catch {
    return text;
  }
}

export async function ensureOk(response: Response): Promise<string> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`the layout API answered ${response.status}: ${apiError(text)}`);
  }
  return text;
}

export async function answer<T>(
  response: Response,
  read: (json: unknown) => Decoded<T>,
): Promise<T> {
  const text = await ensureOk(response);
  return decodedOrThrow(read(JSON.parse(text)), "the layout API's answer");
}

export class CloudAccount {
  private session: SessionResponse | null = null;

  constructor(
    private readonly factory: IDBFactory,
    private readonly baseUrl: string,
    private readonly report: (view: CloudAccountView) => void,
  ) {}

  get accountId(): string | null {
    return this.session?.account.id ?? null;
  }

  async start(fragment: string): Promise<boolean> {
    const token = new URLSearchParams(fragment.replace(/^#/u, "")).get(SIGN_IN_FRAGMENT_KEY);
    if (token === null) {
      await this.resume(null);
      return false;
    }
    this.report({ signIn: "signing-in", email: null, error: null });
    try {
      const started = await answer(
        await this.send("/v1/sessions", { method: "POST", json: { token } }),
        (json) => decode(SessionResponse, json),
      );
      await this.store(started);
      this.adopt(started, null);
    } catch (error) {
      await this.resume(
        `signing in failed: ${errorText(error)}. A link works once, for 15 minutes; send a new one.`,
      );
    }
    return true;
  }

  async resume(error: string | null): Promise<boolean> {
    const stored = await this.stored();
    if (stored === null) {
      this.report({ signIn: "signed-out", email: null, error });
      return false;
    }
    this.adopt(stored, error);
    return true;
  }

  async sendLink(email: string): Promise<void> {
    const request = decode(SignInLinkRequest, { email });
    if (!request.ok) {
      const issue = request.issues.map((item) => item.message).join("; ");
      this.report({ signIn: "signed-out", email: null, error: `that address ${issue}` });
      return;
    }
    const address = request.value.email;
    this.report({ signIn: "sending", email: address, error: null });
    try {
      await answer(
        await this.send("/v1/sign-in-links", { method: "POST", json: request.value }),
        (json) => decode(SignInLinkResponse, json),
      );
      this.report({ signIn: "link-sent", email: address, error: null });
    } catch (error) {
      this.report({
        signIn: "signed-out",
        email: null,
        error: `sending the link failed: ${errorText(error)}`,
      });
    }
  }

  async signOut(): Promise<void> {
    if (this.session === null) return;
    await this.send("/v1/sessions/current", { method: "DELETE" }).catch(() => undefined);
    await this.end(null);
  }

  async send(path: string, request: LayoutRequest = {}): Promise<Response> {
    const headers = new Headers();
    if (this.session !== null) {
      headers.set("authorization", `Bearer ${this.session.session.token}`);
    }
    if (request.json !== undefined) headers.set("content-type", "application/json");
    const body = request.json === undefined ? request.body : JSON.stringify(request.json);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/u, "")}${path}`, {
        method: request.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      throw new CloudUnreachableError(`the layout API can't be reached: ${errorText(error)}`);
    }
    if (response.status === 401 && this.session !== null) await this.end(SESSION_ENDED);
    return response;
  }

  private adopt(session: SessionResponse, error: string | null): void {
    this.session = session;
    this.report({ signIn: "signed-in", email: session.account.email, error });
  }

  private async end(error: string | null): Promise<void> {
    this.session = null;
    await this.store(null);
    this.report({ signIn: "signed-out", email: null, error });
  }

  private inStore<T>(
    mode: IDBTransactionMode,
    use: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return inStore(this.factory, SESSION_DATABASE, SESSION_STORE, mode, use);
  }

  private async stored(): Promise<SessionResponse | null> {
    const value: unknown = await this.inStore("readonly", (store) => store.get(SESSION_KEY));
    const session = decode(SessionResponse, value);
    if (!session.ok || Date.parse(session.value.session.expiresAt) <= Date.now()) return null;
    return session.value;
  }

  private async store(session: SessionResponse | null): Promise<void> {
    if (session === null) await this.inStore("readwrite", (store) => store.delete(SESSION_KEY));
    else await this.inStore("readwrite", (store) => store.put(session, SESSION_KEY));
  }
}
