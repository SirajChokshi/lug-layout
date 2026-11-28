import type { Issue } from "@brr/schema/decode";
import {
  CreateShareLinkRequest,
  CreateWorldRequest,
  MAX_IMPORT_BYTES,
  MAX_SHARD_BYTES,
  ReplyRequest,
  ResolutionRequest,
  SaveVersionRequest,
  StartThreadRequest,
  WORLD_ROLES,
  pinsPlacement,
  type MissingFilesResponse,
  type RecordId,
  type SaveVersionResponse,
  type Sha256,
  type ShareLinkListResponse,
  type ShareLinkResponse,
  type StoredFileResponse,
  type ThreadListResponse,
  type ThreadResponse,
  type VersionListResponse,
  type VersionPageParams,
  type VersionResponse,
  type WorldListResponse,
  type WorldResponse,
  type WorldRole,
} from "@brr/schema/layout-api";
import { shardName, superChunkOf } from "@brr/schema/world";
import type * as v from "valibot";
import type { AccountRecord } from "./accounts.ts";
import { shareLinkBody, threadBody, versionBody, worldBody } from "./bodies.ts";
import { COMMENT_LIMIT, type IComments, type ThreadRecord } from "./comments.ts";
import {
  IMMUTABLE_PRIVATE,
  contentAddressed,
  issuesProblem,
  json,
  matchesEtag,
  noContent,
  notModified,
  problem,
  signInFirst,
  unauthorized,
  versionEtag,
} from "./http.ts";
import { readBytes, readJson } from "./request-body.ts";
import { versionListHref, type WorldRoute } from "./routes.ts";
import { SHARE_LINK_LIMIT, type IShareLinks, type ShareLinkRecord } from "./share-links.ts";
import { WORLD_LIMIT, type IWorldDirectory } from "./world-directory.ts";
import {
  FILE_CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  STORAGE_QUOTA_BYTES,
  type IWorldFiles,
  type PutFileOutcome,
} from "./world-files.ts";
import type { IWorldHistory } from "./world-history.ts";
import type { WorldRecord } from "./world-record.ts";

export interface Caller {
  readonly account: AccountRecord | undefined;
  readonly link: ShareLinkRecord | undefined;
}

type RouteInWorld = Exclude<WorldRoute, { kind: "world-list" } | { kind: "world-create" }>;
type ReadRoute = Extract<
  RouteInWorld,
  { kind: "world" | "shard" | "import" | "version-list" | "version" | "thread-list" }
>;
type SignedInWorldRoute = Exclude<RouteInWorld, ReadRoute>;

const NEEDED_ROLE: Readonly<Record<SignedInWorldRoute["kind"], WorldRole>> = {
  "world-delete": "owner",
  "shard-put": "editor",
  "import-put": "editor",
  "version-save": "editor",
  "share-link-list": "owner",
  "share-link-create": "owner",
  "share-link-revoke": "owner",
  "thread-start": "commenter",
  "thread-reply": "commenter",
  "thread-resolve": "commenter",
};

function roleIn(world: WorldRecord, caller: Caller): WorldRole | undefined {
  if (caller.account?.id === world.ownerId) return "owner";
  return caller.link?.worldId === world.id ? caller.link.role : undefined;
}

function grants(role: WorldRole, needed: WorldRole): boolean {
  return WORLD_ROLES.indexOf(role) >= WORLD_ROLES.indexOf(needed);
}

function overQuota(usage: number): Response {
  return problem(
    507,
    `this would take the account past its storage quota of ${STORAGE_QUOTA_BYTES} bytes (${usage} used)`,
  );
}

function commentLimitReached(): Response {
  return problem(507, `this world already has its limit of ${COMMENT_LIMIT} comments`);
}

function noThread(world: WorldRecord, thread: RecordId): Response {
  return problem(404, `world ${world.id} has no comment thread ${thread}`);
}

function threadJson(thread: ThreadRecord, status: number): Response {
  const body: v.InferInput<typeof ThreadResponse> = { thread: threadBody(thread) };
  return json(body, status);
}

export class WorldHandlers {
  constructor(
    private readonly directory: IWorldDirectory,
    private readonly files: IWorldFiles,
    private readonly history: IWorldHistory,
    private readonly shareLinks: IShareLinks,
    private readonly comments: IComments,
  ) {}

  async handle(route: WorldRoute, caller: Caller, request: Request): Promise<Response> {
    switch (route.kind) {
      case "world-list":
        return caller.account === undefined ? signInFirst() : this.list(caller.account);
      case "world-create":
        return caller.account === undefined ? signInFirst() : this.create(caller.account, request);
      default: {
        const world = await this.directory.find(route.world);
        const role = world === undefined ? undefined : roleIn(world, caller);
        if (world === undefined || role === undefined) {
          return problem(404, `no world ${route.world} is open to you`);
        }
        return this.handleInWorld(route, world, role, caller.account, request);
      }
    }
  }

  private handleInWorld(
    route: RouteInWorld,
    world: WorldRecord,
    role: WorldRole,
    account: AccountRecord | undefined,
    request: Request,
  ): Promise<Response> {
    switch (route.kind) {
      case "world":
        return Promise.resolve(this.describe(world, role));
      case "shard":
        return this.readFile(request, route.sha256, JSON_CONTENT_TYPE, () =>
          this.files.readShard(world.id, route.sha256),
        );
      case "import":
        return this.readFile(request, route.sha256, FILE_CONTENT_TYPE, () =>
          this.files.readImport(world.id, route.sha256),
        );
      case "version-list":
        return this.listVersions(world, route.page, request);
      case "version":
        return this.readVersion(world, route.version);
      case "thread-list":
        return this.listThreads(world);
      default: {
        const needed = NEEDED_ROLE[route.kind];
        if (!grants(role, needed)) {
          return Promise.resolve(
            problem(403, `this world is shared with you as ${role}; this needs ${needed}`),
          );
        }
        if (account === undefined) {
          return Promise.resolve(
            unauthorized("sign in first: without signing in, a share link only lets you view"),
          );
        }
        return this.handleSignedIn(route, world, account, request);
      }
    }
  }

  private handleSignedIn(
    route: SignedInWorldRoute,
    world: WorldRecord,
    account: AccountRecord,
    request: Request,
  ): Promise<Response> {
    switch (route.kind) {
      case "world-delete":
        return this.remove(world);
      case "shard-put":
        return this.putFile(request, route.sha256, MAX_SHARD_BYTES, (body) =>
          this.files.putShard(world, route.sha256, body),
        );
      case "import-put":
        return this.putFile(request, route.sha256, MAX_IMPORT_BYTES, (body) =>
          this.files.putImport(world, route.sha256, body),
        );
      case "version-save":
        return this.save(world, account, request);
      case "share-link-list":
        return this.listShareLinks(world);
      case "share-link-create":
        return this.createShareLink(world, request);
      case "share-link-revoke":
        return this.revokeShareLink(world, route.link);
      case "thread-start":
        return this.startThread(world, account, request);
      case "thread-reply":
        return this.reply(world, route.thread, account, request);
      case "thread-resolve":
        return this.resolveThread(world, route.thread, account, request);
      default: {
        const exhaustive: never = route;
        throw new Error(`unhandled world route ${String(exhaustive)}`);
      }
    }
  }

  private async list(account: AccountRecord): Promise<Response> {
    const worlds = await this.directory.list(account.id);
    const body: v.InferInput<typeof WorldListResponse> = { worlds: worlds.map(worldBody) };
    return json(body, 200);
  }

  private async create(account: AccountRecord, request: Request): Promise<Response> {
    const body = await readJson(request, CreateWorldRequest);
    if (!body.ok) return body.response;
    const outcome = await this.directory.create(account.id, body.value.name);
    switch (outcome.kind) {
      case "created": {
        const created: v.InferInput<typeof WorldResponse> = {
          world: worldBody(outcome.world),
          role: "owner",
        };
        return json(created, 201, {
          location: `${new URL(request.url).origin}/v1/worlds/${outcome.world.id}`,
        });
      }
      case "limit-reached":
        return problem(507, `this account already has its limit of ${WORLD_LIMIT} worlds`);
      default: {
        const exhaustive: never = outcome;
        throw new Error(`unhandled create outcome ${String(exhaustive)}`);
      }
    }
  }

  private describe(world: WorldRecord, role: WorldRole): Response {
    const body: v.InferInput<typeof WorldResponse> = { world: worldBody(world), role };
    return json(body, 200);
  }

  private async remove(world: WorldRecord): Promise<Response> {
    await this.directory.remove(world);
    return noContent();
  }

  private async putFile(
    request: Request,
    sha256: Sha256,
    maxBytes: number,
    put: (body: Uint8Array<ArrayBuffer>) => Promise<PutFileOutcome>,
  ): Promise<Response> {
    const body = await readBytes(request, maxBytes);
    if (!body.ok) return body.response;
    const outcome = await put(body.value);
    switch (outcome.kind) {
      case "stored": {
        const stored: v.InferInput<typeof StoredFileResponse> = { sha256, bytes: outcome.bytes };
        return json(stored, outcome.created ? 201 : 200);
      }
      case "invalid":
        return issuesProblem(400, outcome.issues);
      case "over-quota":
        return overQuota(outcome.usage);
      default: {
        const exhaustive: never = outcome;
        throw new Error(`unhandled upload outcome ${String(exhaustive)}`);
      }
    }
  }

  private async readFile(
    request: Request,
    sha256: Sha256,
    contentType: string,
    read: () => Promise<R2ObjectBody | null>,
  ): Promise<Response> {
    if (matchesEtag(request, versionEtag(sha256))) return notModified(sha256);
    const object = await read();
    if (object === null) return problem(404, `this world has no file ${sha256}`);
    return contentAddressed(object.body, sha256, contentType, object.size);
  }

  private async save(
    world: WorldRecord,
    account: AccountRecord,
    request: Request,
  ): Promise<Response> {
    const body = await readJson(request, SaveVersionRequest);
    if (!body.ok) return body.response;
    const outcome = await this.history.save(world, account.id, body.value);
    switch (outcome.kind) {
      case "saved": {
        const saved: v.InferInput<typeof SaveVersionResponse> = {
          version: versionBody(outcome.version),
          previousHead: outcome.previousHead,
        };
        return json(saved, 201, {
          location: `${new URL(request.url).origin}/v1/worlds/${world.id}/versions/${outcome.version.version}`,
        });
      }
      case "missing": {
        const missing: v.InferInput<typeof MissingFilesResponse> = {
          error: "upload the missing files to this world, then save again",
          missing: { shards: [...outcome.shards], imports: [...outcome.imports] },
        };
        return json(missing, 409);
      }
      case "invalid":
        return issuesProblem(422, outcome.issues);
      case "over-quota":
        return overQuota(outcome.usage);
      default: {
        const exhaustive: never = outcome;
        throw new Error(`unhandled save outcome ${String(exhaustive)}`);
      }
    }
  }

  private async listVersions(
    world: WorldRecord,
    page: VersionPageParams,
    request: Request,
  ): Promise<Response> {
    const listed = await this.history.list(world.id, page);
    const last = listed.versions.at(-1);
    const body: v.InferInput<typeof VersionListResponse> = {
      versions: listed.versions.map(versionBody),
      next:
        listed.more && last !== undefined
          ? versionListHref(new URL(request.url).origin, world.id, last.version, page.limit)
          : null,
    };
    return json(body, 200);
  }

  private async readVersion(world: WorldRecord, version: number): Promise<Response> {
    const read = await this.history.read(world.id, version);
    if (read === undefined) return problem(404, `world ${world.id} has no version ${version}`);
    const body: v.InferInput<typeof VersionResponse> = {
      version: versionBody(read.record),
      snapshot: read.snapshot,
    };
    return json(body, 200, { "cache-control": IMMUTABLE_PRIVATE });
  }

  private async listShareLinks(world: WorldRecord): Promise<Response> {
    const links = await this.shareLinks.list(world.id);
    const body: v.InferInput<typeof ShareLinkListResponse> = {
      shareLinks: links.map(shareLinkBody),
    };
    return json(body, 200);
  }

  private async createShareLink(world: WorldRecord, request: Request): Promise<Response> {
    const body = await readJson(request, CreateShareLinkRequest);
    if (!body.ok) return body.response;
    const outcome = await this.shareLinks.create(world.id, body.value.role);
    switch (outcome.kind) {
      case "created": {
        const created: v.InferInput<typeof ShareLinkResponse> = {
          shareLink: shareLinkBody(outcome.link),
          url: outcome.url,
        };
        return json(created, 201);
      }
      case "limit-reached":
        return problem(507, `this world already has its limit of ${SHARE_LINK_LIMIT} share links`);
      default: {
        const exhaustive: never = outcome;
        throw new Error(`unhandled share link outcome ${String(exhaustive)}`);
      }
    }
  }

  private async revokeShareLink(world: WorldRecord, link: RecordId): Promise<Response> {
    if (!(await this.shareLinks.revoke(world.id, link))) {
      return problem(404, `world ${world.id} has no share link ${link}`);
    }
    return noContent();
  }

  private async listThreads(world: WorldRecord): Promise<Response> {
    const threads = await this.comments.list(world.id);
    const body: v.InferInput<typeof ThreadListResponse> = { threads: threads.map(threadBody) };
    return json(body, 200);
  }

  private async startThread(
    world: WorldRecord,
    account: AccountRecord,
    request: Request,
  ): Promise<Response> {
    const body = await readJson(request, StartThreadRequest);
    if (!body.ok) return body.response;
    const issues = await this.pinIssues(world, body.value);
    if (issues.length > 0) return issuesProblem(422, issues);
    const thread = await this.comments.start(world.id, account.id, body.value);
    return thread === undefined ? commentLimitReached() : threadJson(thread, 201);
  }

  private async pinIssues(
    world: WorldRecord,
    { version, pin }: StartThreadRequest,
  ): Promise<ReadonlyArray<Issue>> {
    const read = await this.history.read(world.id, version);
    if (read === undefined) {
      return [{ path: "version", message: `is version ${version}, which this world doesn't have` }];
    }
    if (pin.on === "point") return [];
    const sha256 = read.snapshot.shards[shardName(superChunkOf(pin.x, pin.z))];
    const shard =
      sha256 === undefined ? undefined : await this.files.readStoredShard(world.id, sha256);
    if (shard?.placements.some((placement) => pinsPlacement(pin, placement))) return [];
    return [{ path: "pin", message: `names no placement of version ${version}` }];
  }

  private async reply(
    world: WorldRecord,
    thread: RecordId,
    account: AccountRecord,
    request: Request,
  ): Promise<Response> {
    const body = await readJson(request, ReplyRequest);
    if (!body.ok) return body.response;
    const outcome = await this.comments.reply(world.id, thread, account.id, body.value.text);
    switch (outcome.kind) {
      case "replied":
        return threadJson(outcome.thread, 201);
      case "no-thread":
        return noThread(world, thread);
      case "limit-reached":
        return commentLimitReached();
      default: {
        const exhaustive: never = outcome;
        throw new Error(`unhandled reply outcome ${String(exhaustive)}`);
      }
    }
  }

  private async resolveThread(
    world: WorldRecord,
    thread: RecordId,
    account: AccountRecord,
    request: Request,
  ): Promise<Response> {
    const body = await readJson(request, ResolutionRequest);
    if (!body.ok) return body.response;
    const resolved = await this.comments.resolve(
      world.id,
      thread,
      body.value.resolved ? account.id : null,
    );
    return resolved === undefined ? noThread(world, thread) : threadJson(resolved, 200);
  }
}
