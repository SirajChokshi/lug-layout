import { decode, issueText } from "@brr/schema/decode";
import {
  RECORD_ID_PATTERN,
  SHA256_PATTERN,
  VersionPageParams,
  type RecordId,
  type Sha256,
} from "@brr/schema/layout-api";

export type PublicRoute = { readonly kind: "sign-in-link" } | { readonly kind: "session-start" };

export type AccountRoute =
  | { readonly kind: "session-end" }
  | { readonly kind: "account" }
  | { readonly kind: "account-delete" };

export type WorldRoute =
  | { readonly kind: "world-list" }
  | { readonly kind: "world-create" }
  | { readonly kind: "world"; readonly world: RecordId }
  | { readonly kind: "world-delete"; readonly world: RecordId }
  | { readonly kind: "shard-put"; readonly world: RecordId; readonly sha256: Sha256 }
  | { readonly kind: "shard"; readonly world: RecordId; readonly sha256: Sha256 }
  | { readonly kind: "import-put"; readonly world: RecordId; readonly sha256: Sha256 }
  | { readonly kind: "import"; readonly world: RecordId; readonly sha256: Sha256 }
  | { readonly kind: "version-save"; readonly world: RecordId }
  | { readonly kind: "version-list"; readonly world: RecordId; readonly page: VersionPageParams }
  | { readonly kind: "version"; readonly world: RecordId; readonly version: number }
  | { readonly kind: "share-link-list"; readonly world: RecordId }
  | { readonly kind: "share-link-create"; readonly world: RecordId }
  | { readonly kind: "share-link-revoke"; readonly world: RecordId; readonly link: RecordId }
  | { readonly kind: "thread-list"; readonly world: RecordId }
  | { readonly kind: "thread-start"; readonly world: RecordId }
  | { readonly kind: "thread-reply"; readonly world: RecordId; readonly thread: RecordId }
  | { readonly kind: "thread-resolve"; readonly world: RecordId; readonly thread: RecordId };

export type RouteResult =
  | { readonly kind: "public"; readonly route: PublicRoute }
  | { readonly kind: "account"; readonly route: AccountRoute }
  | { readonly kind: "world"; readonly route: WorldRoute }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "method-not-allowed"; readonly allow: string };

type Method = "GET" | "POST" | "PUT" | "DELETE";
type Builder = (groups: ReadonlyArray<string>, url: URL) => RouteResult;

interface PathRule {
  readonly path: RegExp;
  readonly methods: Partial<Record<Method, Builder>>;
}

const METHODS: ReadonlyArray<Method> = ["GET", "POST", "PUT", "DELETE"];
const ID = `(${RECORD_ID_PATTERN})`;
const SHA = `(${SHA256_PATTERN})`;
const VERSION = "([1-9][0-9]{0,14})";

function isMethod(method: string): method is Method {
  return METHODS.some((known) => known === method);
}

function captured(groups: ReadonlyArray<string>, index: number): string {
  const value = groups[index];
  if (value === undefined) throw new Error(`route pattern has no group ${index}`);
  return value;
}

const path = (pattern: string): RegExp => new RegExp(`^${pattern}$`, "u");

const publicRoute =
  (route: PublicRoute): Builder =>
  () => ({ kind: "public", route });

const accountRoute =
  (route: AccountRoute): Builder =>
  () => ({ kind: "account", route });

const worldRoute =
  (build: (groups: ReadonlyArray<string>) => WorldRoute): Builder =>
  (groups) => ({ kind: "world", route: build(groups) });

const inWorld = (groups: ReadonlyArray<string>) => ({ world: captured(groups, 0) });

const withFile = (groups: ReadonlyArray<string>) => ({
  world: captured(groups, 0),
  sha256: captured(groups, 1),
});

const inThread = (groups: ReadonlyArray<string>) => ({
  world: captured(groups, 0),
  thread: captured(groups, 1),
});

function versionList(groups: ReadonlyArray<string>, url: URL): RouteResult {
  const page = decode(VersionPageParams, Object.fromEntries(url.searchParams), "query");
  if (!page.ok) return { kind: "invalid", message: issueText(page.issues) };
  return {
    kind: "world",
    route: { kind: "version-list", ...inWorld(groups), page: page.value },
  };
}

const RULES: ReadonlyArray<PathRule> = [
  { path: path("/v1/sign-in-links"), methods: { POST: publicRoute({ kind: "sign-in-link" }) } },
  { path: path("/v1/sessions"), methods: { POST: publicRoute({ kind: "session-start" }) } },
  {
    path: path("/v1/sessions/current"),
    methods: { DELETE: accountRoute({ kind: "session-end" }) },
  },
  {
    path: path("/v1/account"),
    methods: {
      GET: accountRoute({ kind: "account" }),
      DELETE: accountRoute({ kind: "account-delete" }),
    },
  },
  {
    path: path("/v1/worlds"),
    methods: {
      GET: worldRoute(() => ({ kind: "world-list" })),
      POST: worldRoute(() => ({ kind: "world-create" })),
    },
  },
  {
    path: path(`/v1/worlds/${ID}`),
    methods: {
      GET: worldRoute((groups) => ({ kind: "world", ...inWorld(groups) })),
      DELETE: worldRoute((groups) => ({ kind: "world-delete", ...inWorld(groups) })),
    },
  },
  {
    path: path(`/v1/worlds/${ID}/shards/${SHA}`),
    methods: {
      GET: worldRoute((groups) => ({ kind: "shard", ...withFile(groups) })),
      PUT: worldRoute((groups) => ({ kind: "shard-put", ...withFile(groups) })),
    },
  },
  {
    path: path(`/v1/worlds/${ID}/imports/${SHA}`),
    methods: {
      GET: worldRoute((groups) => ({ kind: "import", ...withFile(groups) })),
      PUT: worldRoute((groups) => ({ kind: "import-put", ...withFile(groups) })),
    },
  },
  {
    path: path(`/v1/worlds/${ID}/versions`),
    methods: {
      GET: versionList,
      POST: worldRoute((groups) => ({ kind: "version-save", ...inWorld(groups) })),
    },
  },
  {
    path: path(`/v1/worlds/${ID}/versions/${VERSION}`),
    methods: {
      GET: worldRoute((groups) => ({
        kind: "version",
        ...inWorld(groups),
        version: Number(captured(groups, 1)),
      })),
    },
  },
  {
    path: path(`/v1/worlds/${ID}/share-links`),
    methods: {
      GET: worldRoute((groups) => ({ kind: "share-link-list", ...inWorld(groups) })),
      POST: worldRoute((groups) => ({ kind: "share-link-create", ...inWorld(groups) })),
    },
  },
  {
    path: path(`/v1/worlds/${ID}/share-links/${ID}`),
    methods: {
      DELETE: worldRoute((groups) => ({
        kind: "share-link-revoke",
        ...inWorld(groups),
        link: captured(groups, 1),
      })),
    },
  },
  {
    path: path(`/v1/worlds/${ID}/threads`),
    methods: {
      GET: worldRoute((groups) => ({ kind: "thread-list", ...inWorld(groups) })),
      POST: worldRoute((groups) => ({ kind: "thread-start", ...inWorld(groups) })),
    },
  },
  {
    path: path(`/v1/worlds/${ID}/threads/${ID}/comments`),
    methods: { POST: worldRoute((groups) => ({ kind: "thread-reply", ...inThread(groups) })) },
  },
  {
    path: path(`/v1/worlds/${ID}/threads/${ID}/resolution`),
    methods: { PUT: worldRoute((groups) => ({ kind: "thread-resolve", ...inThread(groups) })) },
  },
];

function allowed(rule: PathRule): string {
  const methods = METHODS.filter((method) => rule.methods[method] !== undefined);
  return [...methods, ...(methods.includes("GET") ? ["HEAD"] : []), "OPTIONS"].join(", ");
}

export function parseRoute(method: string, url: URL): RouteResult {
  const effective = method === "HEAD" ? "GET" : method;
  for (const rule of RULES) {
    const match = rule.path.exec(url.pathname);
    if (match === null) continue;
    const build = isMethod(effective) ? rule.methods[effective] : undefined;
    if (build === undefined) return { kind: "method-not-allowed", allow: allowed(rule) };
    return build(match.slice(1), url);
  }
  return { kind: "not-found" };
}

export function versionListHref(
  origin: string,
  world: RecordId,
  before: number,
  limit: number,
): string {
  const params = new URLSearchParams({ before: String(before), limit: String(limit) });
  return `${origin}/v1/worlds/${world}/versions?${params.toString()}`;
}
