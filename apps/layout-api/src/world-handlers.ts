import {
  CreateWorldRequest,
  MAX_IMPORT_BYTES,
  MAX_SHARD_BYTES,
  SaveVersionRequest,
  type MissingFilesResponse,
  type SaveVersionResponse,
  type Sha256,
  type StoredFileResponse,
  type VersionListResponse,
  type VersionPageParams,
  type VersionResponse,
  type WorldListResponse,
  type WorldResponse,
} from "@brr/schema/layout-api";
import type * as v from "valibot";
import type { AccountRecord } from "./accounts.ts";
import { versionBody, worldBody } from "./bodies.ts";
import {
  IMMUTABLE_PRIVATE,
  contentAddressed,
  issuesProblem,
  json,
  matchesEtag,
  noContent,
  notModified,
  problem,
  versionEtag,
} from "./http.ts";
import { readBytes, readJson } from "./request-body.ts";
import { versionListHref, type WorldRoute } from "./routes.ts";
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

type RouteInWorld = Exclude<WorldRoute, { kind: "world-list" } | { kind: "world-create" }>;

function overQuota(usage: number): Response {
  return problem(
    507,
    `this would take the account past its storage quota of ${STORAGE_QUOTA_BYTES} bytes (${usage} used)`,
  );
}

export class WorldHandlers {
  constructor(
    private readonly directory: IWorldDirectory,
    private readonly files: IWorldFiles,
    private readonly history: IWorldHistory,
  ) {}

  async handle(route: WorldRoute, account: AccountRecord, request: Request): Promise<Response> {
    switch (route.kind) {
      case "world-list":
        return this.list(account);
      case "world-create":
        return this.create(account, request);
      default: {
        const world = await this.directory.find(account.id, route.world);
        if (world === undefined) return problem(404, `this account has no world ${route.world}`);
        return this.handleInWorld(route, world, account, request);
      }
    }
  }

  private handleInWorld(
    route: RouteInWorld,
    world: WorldRecord,
    account: AccountRecord,
    request: Request,
  ): Promise<Response> {
    switch (route.kind) {
      case "world":
        return Promise.resolve(this.describe(world));
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
      case "shard":
        return this.readFile(request, route.sha256, JSON_CONTENT_TYPE, () =>
          this.files.readShard(world.id, route.sha256),
        );
      case "import":
        return this.readFile(request, route.sha256, FILE_CONTENT_TYPE, () =>
          this.files.readImport(world.id, route.sha256),
        );
      case "version-save":
        return this.save(world, account, request);
      case "version-list":
        return this.listVersions(world, route.page, request);
      case "version":
        return this.readVersion(world, route.version);
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
        const created: v.InferInput<typeof WorldResponse> = { world: worldBody(outcome.world) };
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

  private describe(world: WorldRecord): Response {
    const body: v.InferInput<typeof WorldResponse> = { world: worldBody(world) };
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
}
