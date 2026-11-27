import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import {
  AccountResponse,
  ErrorResponse,
  MAX_SHARD_BYTES,
  MissingFilesResponse,
  SIGN_IN_FRAGMENT_KEY,
  SNAPSHOT_FORMAT,
  SNAPSHOT_SCHEMA_VERSION,
  SaveVersionResponse,
  SessionResponse,
  SignInLinkResponse,
  StoredFileResponse,
  VersionListResponse,
  VersionResponse,
  WorldListResponse,
  WorldResponse,
  type WorldSnapshot,
} from "@brr/schema/layout-api";
import {
  MANIFEST_FILE,
  canonicalJson,
  importRef,
  readWorldFiles,
  shardEntry,
  shardName,
  shardPath,
  worldManifest,
  worldShards,
  type PlacementRecordV1,
  type TrackRecordV1,
  type WorldHeader,
} from "@brr/schema/world";
import * as v from "valibot";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "wrangler";
import {
  Accounts,
  OUTSTANDING_LINKS_PER_ADDRESS,
  SESSION_LIFETIME_MS,
  SIGN_IN_LINK_LIFETIME_MS,
} from "./accounts.ts";
import type { IClock } from "./clock.ts";
import type { IMailer, SignInMail } from "./mailer.ts";
import { LAYOUT_MIGRATIONS } from "./migrations.ts";
import type { IRandomSource } from "./random.ts";
import { SchemaMigrations } from "./schema-migrations.ts";
import type { SqlDatabase } from "./sql-database.ts";

interface TestEnv {
  readonly LAYOUT_DB: SqlDatabase;
  readonly LAYOUT_FILES: {
    list(options: {
      readonly prefix: string;
    }): Promise<{ readonly objects: ReadonlyArray<{ readonly key: string }> }>;
  };
}

interface CallOptions {
  readonly method?: string;
  readonly session?: string;
  readonly client?: string;
  readonly json?: unknown;
  readonly body?: string | Uint8Array<ArrayBuffer>;
  readonly headers?: Readonly<Record<string, string>>;
}

interface SignedIn {
  readonly session: string;
  readonly accountId: string;
}

interface UploadFile {
  readonly sha256: string;
  readonly body: string | Uint8Array<ArrayBuffer>;
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "http://layout-api.test";
const APP_ORIGIN = "https://layouts.example.test";
const MAIL_FROM = "sign-in@layouts.example.test";
const SIGN_IN_REQUESTS_PER_MINUTE = 10;
const ZEROS = ["0", "0", "0", "0", "0", "0", "0", "0"];

let server: TestHarness;
let bindings: TestEnv;
let clients = 0;

const EmailList = v.object({
  result: v.array(v.object({ messageId: v.string(), to: v.array(v.string()) })),
  result_info: v.object({ cursor: v.optional(v.string()), has_more: v.boolean() }),
});

const EmailDetail = v.object({
  result: v.object({
    from: v.string(),
    to: v.array(v.string()),
    subject: v.string(),
    text: v.string(),
  }),
});

function sha256(body: string | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function nextClient(): string {
  clients += 1;
  return `198.51.100.${clients}`;
}

function call(path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    ...options.headers,
    "cf-connecting-ip": options.client ?? "192.0.2.1",
    ...(options.session === undefined ? {} : { authorization: `Bearer ${options.session}` }),
    ...(options.json === undefined ? {} : { "content-type": "application/json" }),
  };
  const body = options.json === undefined ? options.body : JSON.stringify(options.json);
  return server.fetch(`${API}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

async function expectJson<const TSchema extends v.GenericSchema>(
  response: Response,
  status: number,
  schema: TSchema,
): Promise<v.InferOutput<TSchema>> {
  const text = await response.text();
  expect({ status: response.status, body: response.status === status ? null : text }).toEqual({
    status,
    body: null,
  });
  return decodedOrThrow(decode(schema, JSON.parse(text)), `${response.url} answered`);
}

async function expectError(response: Response, status: number): Promise<string> {
  return (await expectJson(response, status, ErrorResponse)).error;
}

async function mailIdsTo(address: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ per_page: "100", ...(cursor ? { cursor } : {}) });
    const page = await expectJson(
      await server.fetch(`/cdn-cgi/local/explorer/api/local/email/sending?${params.toString()}`),
      200,
      EmailList,
    );
    ids.push(...page.result.filter((mail) => mail.to.includes(address)).map((m) => m.messageId));
    cursor = page.result_info.has_more ? page.result_info.cursor : undefined;
  } while (cursor !== undefined);
  return ids;
}

async function onlyNewMailTo(
  address: string,
  before: ReadonlyArray<string>,
): Promise<v.InferOutput<typeof EmailDetail>["result"]> {
  const fresh = (await mailIdsTo(address)).filter((id) => !before.includes(id));
  expect(fresh).toHaveLength(1);
  const params = new URLSearchParams({ email_id: fresh[0] ?? "" });
  const detail = await expectJson(
    await server.fetch(`/cdn-cgi/local/explorer/api/local/email/sending?${params.toString()}`),
    200,
    EmailDetail,
  );
  return detail.result;
}

function linkIn(text: string): string {
  const link = /https?:\/\/\S+/u.exec(text)?.[0];
  if (link === undefined) throw new Error(`no link in mail: ${text}`);
  return link;
}

function tokenOf(link: string): string {
  return new URLSearchParams(new URL(link).hash.slice(1)).get(SIGN_IN_FRAGMENT_KEY) ?? "";
}

interface EmailedLink {
  readonly token: string;
  readonly expiresAt: number;
}

async function requestLink(email: string, client: string): Promise<EmailedLink> {
  const address = email.trim().toLowerCase();
  const before = await mailIdsTo(address);
  const requested = await expectJson(
    await call("/v1/sign-in-links", { method: "POST", json: { email }, client }),
    202,
    SignInLinkResponse,
  );
  const link = linkIn((await onlyNewMailTo(address, before)).text);
  return { token: tokenOf(link), expiresAt: Date.parse(requested.expiresAt) };
}

function startSession(token: string, client: string): Promise<Response> {
  return call("/v1/sessions", { method: "POST", json: { token }, client });
}

async function signIn(email: string): Promise<SignedIn> {
  const client = nextClient();
  const { token } = await requestLink(email, client);
  const started = await expectJson(await startSession(token, client), 201, SessionResponse);
  return { session: started.session.token, accountId: started.account.id };
}

async function createWorld(user: SignedIn, name: string): Promise<string> {
  const created = await expectJson(
    await call("/v1/worlds", { method: "POST", json: { name }, session: user.session }),
    201,
    WorldResponse,
  );
  return created.world.id;
}

function put(
  user: SignedIn,
  world: string,
  kind: "shards" | "imports",
  file: UploadFile,
): Promise<Response> {
  return call(`/v1/worlds/${world}/${kind}/${file.sha256}`, {
    method: "PUT",
    body: file.body,
    session: user.session,
  });
}

function save(
  user: SignedIn,
  world: string,
  parent: number | null,
  snapshot: WorldSnapshot,
): Promise<Response> {
  return call(`/v1/worlds/${world}/versions`, {
    method: "POST",
    json: { parent, snapshot },
    session: user.session,
  });
}

const utf8 = new TextEncoder();
const signalBoxBytes = new Uint8Array(
  utf8.encode(
    [
      "0 Signal box",
      "0 Name: signal-box.ldr",
      "0 Author: layout-api test",
      "1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat",
      "1 15 0 -48 0 1 0 0 0 1 0 0 0 1 3003.dat",
      "",
    ].join("\r\n"),
  ),
);
const signalBox = { name: "signal-box.ldr", sha256: sha256(signalBoxBytes), body: signalBoxBytes };
const lampBytes = new Uint8Array(
  utf8.encode("0 Lamp\r\n1 0 0 -24 0 1 0 0 0 1 0 0 0 1 3062b.dat\r\n"),
);
const lamp = { name: "lamp.ldr", sha256: sha256(lampBytes), body: lampBytes };

const header: WorldHeader = {
  name: "Club show",
  bundleVersion: "e5124ec7210e6f35",
  view: { targetX: 0, targetY: 0, targetZ: 0, distance: 2600, yaw: 0.78, pitch: 0.75 },
  disclaimer: "Not affiliated with the LEGO Group.",
};

const baseplate: PlacementRecordV1 = {
  ref: "ldraw:3811",
  color: 2,
  x: 0,
  z: 0,
  yPlates: 0,
  rot: 0,
};
const signalBoxOnBaseplate: PlacementRecordV1 = {
  ref: importRef(signalBox.sha256),
  color: 16,
  x: 100,
  z: 60,
  yPlates: 1,
  rot: 1,
};
const station: PlacementRecordV1 = {
  ref: "omr:60050-1",
  color: 0,
  x: -2000,
  z: 40,
  yPlates: 0,
  rot: 0,
};
function straight(index: number, firstCoefficient: string): TrackRecordV1 {
  return {
    index,
    ref: "ldraw:74746",
    heading: 0,
    position: [firstCoefficient, ...ZEROS.slice(1)],
    yPlates: 0,
  };
}

const straights: ReadonlyArray<TrackRecordV1> = [straight(0, "0"), straight(1, "2")];

function worldFiles(
  placements: ReadonlyArray<PlacementRecordV1>,
  track: ReadonlyArray<TrackRecordV1>,
  imports: ReadonlyArray<{ readonly name: string; readonly sha256: string }>,
) {
  const shards = worldShards(placements, track).map((shard) => {
    const body = canonicalJson(shard);
    return { shard, name: shardName(shard.superChunk), body, sha256: sha256(body) };
  });
  const snapshot: WorldSnapshot = {
    format: SNAPSHOT_FORMAT,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    manifest: worldManifest(
      header,
      shards.map((file) => shardEntry(file.shard)),
    ),
    shards: Object.fromEntries(shards.map((file) => [file.name, file.sha256])),
    imports: imports
      .map((file) => ({ sha256: file.sha256, name: file.name }))
      .toSorted((a, b) => (a.sha256 < b.sha256 ? -1 : 1)),
  };
  return { shards, snapshot };
}

async function storedKeys(world: string): Promise<string[]> {
  const listed = await bindings.LAYOUT_FILES.list({ prefix: `worlds/${world}/` });
  return listed.objects.map((object) => object.key).toSorted();
}

beforeAll(async () => {
  server = createTestHarness({
    root: packageRoot,
    workers: [{ configPath: "./wrangler.json", vars: { APP_ORIGIN, MAIL_FROM } }],
  });
  await server.listen();
  bindings = await server.getWorker<TestEnv>().getEnv();
}, 60_000);

afterAll(async () => {
  await server.close();
});

describe("layout API accounts", () => {
  it("signs in with an emailed link that works once, keeping one account per address", async () => {
    const client = nextClient();
    const before = await mailIdsTo("coordinator@club.example");
    await expectJson(
      await call("/v1/sign-in-links", {
        method: "POST",
        json: { email: "  Coordinator@Club.Example " },
        client,
      }),
      202,
      SignInLinkResponse,
    );
    const mail = await onlyNewMailTo("coordinator@club.example", before);
    expect(mail.from).toBe(`"Brick Railroad" <${MAIL_FROM}>`);
    expect(mail.subject).toBe("Your Brick Railroad sign-in link");
    const link = linkIn(mail.text);
    expect(link.startsWith(`${APP_ORIGIN}/#${SIGN_IN_FRAGMENT_KEY}=`)).toBe(true);

    const started = await expectJson(
      await startSession(tokenOf(link), client),
      201,
      SessionResponse,
    );
    expect(started.account.email).toBe("coordinator@club.example");
    expect(await expectError(await startSession(tokenOf(link), client), 401)).toMatch(
      /used already/u,
    );

    const again = await signIn("coordinator@club.example");
    expect(again.accountId).toBe(started.account.id);
    const described = await expectJson(
      await call("/v1/account", { session: again.session }),
      200,
      AccountResponse,
    );
    expect(described.account).toEqual(started.account);
    expect(described.usage).toMatchObject({ bytes: 0, worlds: 0 });

    expect(await expectError(await startSession("short", client), 400)).toBe(
      "body.token: is not a token",
    );
    expect(
      await expectError(
        await call("/v1/sign-in-links", { method: "POST", json: { email: "nobody" }, client }),
        400,
      ),
    ).toBe("body.email: is not an email address");
  });

  it("refuses requests without a live session and ends a session on sign-out", async () => {
    const unsigned = await call("/v1/worlds");
    expect(unsigned.headers.get("www-authenticate")).toBe('Bearer realm="brick-railroad"');
    expect(await expectError(unsigned, 401)).toMatch(/sign in first/u);
    const unknown = "A".repeat(43);
    expect(await expectError(await call("/v1/worlds", { session: unknown }), 401)).toMatch(
      /ended or never existed/u,
    );

    const user = await signIn("leaving@club.example");
    expect((await call("/v1/worlds", { session: user.session })).status).toBe(200);
    const ended = await call("/v1/sessions/current", { method: "DELETE", session: user.session });
    expect(ended.status).toBe(204);
    expect((await call("/v1/account", { session: user.session })).status).toBe(401);
  });

  it("caps open links per address and sign-in requests per client address", async () => {
    const client = nextClient();
    for (let link = 0; link < OUTSTANDING_LINKS_PER_ADDRESS; link += 1) {
      await requestLink("eager@club.example", client);
    }
    const capped = await call("/v1/sign-in-links", {
      method: "POST",
      json: { email: "eager@club.example" },
      client: nextClient(),
    });
    const retryAfter = Number(capped.headers.get("retry-after"));
    expect(await expectError(capped, 429)).toMatch(/still open/u);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(SIGN_IN_LINK_LIFETIME_MS / 1000);

    const burst = async (from: string) => {
      const statuses: number[] = [];
      for (let index = 0; index <= 2 * SIGN_IN_REQUESTS_PER_MINUTE; index += 1) {
        const response = await call("/v1/sign-in-links", {
          method: "POST",
          json: { email: `burst-${index}@club.example` },
          client: from,
        });
        await response.arrayBuffer();
        statuses.push(response.status);
        if (response.status === 429) break;
      }
      return statuses;
    };
    const bursts = [await burst(nextClient()), await burst(nextClient())];
    expect(bursts.map((statuses) => new Set(statuses))).toEqual([
      new Set([202, 429]),
      new Set([202, 429]),
    ]);
    const allowed = bursts.map((statuses) => statuses.indexOf(429));
    expect(Math.min(...allowed)).toBeGreaterThanOrEqual(SIGN_IN_REQUESTS_PER_MINUTE);
    expect(allowed).toContain(SIGN_IN_REQUESTS_PER_MINUTE);
  }, 60_000);

  it("removes expired sign-in links and sessions on its daily schedule", async () => {
    const worker = server.getWorker();
    const client = nextClient();
    const kept = await requestLink("scheduled@club.example", client);
    await worker.scheduled({ scheduledTime: new Date(kept.expiresAt - 1) });
    const session = await expectJson(await startSession(kept.token, client), 201, SessionResponse);
    const expiresAt = Date.parse(session.session.expiresAt);

    const dropped = await requestLink("scheduled@club.example", client);
    await worker.scheduled({ scheduledTime: new Date(dropped.expiresAt) });
    expect((await startSession(dropped.token, client)).status).toBe(401);

    await worker.scheduled({ scheduledTime: new Date(expiresAt - 1) });
    expect((await call("/v1/account", { session: session.session.token })).status).toBe(200);
    await worker.scheduled({ scheduledTime: new Date(expiresAt) });
    expect((await call("/v1/account", { session: session.session.token })).status).toBe(401);
  });
});

describe("layout API worlds", () => {
  it("saves a world as content-addressed shards and original model files, and reads every version back byte for byte", async () => {
    const user = await signIn("builder@club.example");
    const world = await createWorld(user, "Club show");
    const first = worldFiles([baseplate, signalBoxOnBaseplate, station], straights, [signalBox]);

    const missing = await expectJson(
      await save(user, world, null, first.snapshot),
      409,
      MissingFilesResponse,
    );
    expect(missing.missing).toEqual({
      shards: first.shards.map((file) => file.sha256).toSorted(),
      imports: [signalBox.sha256],
    });

    for (const shard of first.shards) {
      expect(
        await expectJson(await put(user, world, "shards", shard), 201, StoredFileResponse),
      ).toEqual({ sha256: shard.sha256, bytes: utf8.encode(shard.body).byteLength });
    }
    await expectJson(await put(user, world, "imports", signalBox), 201, StoredFileResponse);
    expect((await put(user, world, "imports", signalBox)).status).toBe(200);

    const saved = await expectJson(
      await save(user, world, null, first.snapshot),
      201,
      SaveVersionResponse,
    );
    expect(saved).toMatchObject({
      previousHead: null,
      version: {
        version: 1,
        parent: null,
        name: "Club show",
        placements: 3,
        track: 2,
        savedBy: user.accountId,
      },
    });

    const moved = worldFiles(
      [baseplate, signalBoxOnBaseplate, { ...station, x: -2020 }],
      straights,
      [signalBox],
    );
    const changed = moved.shards.filter(
      (shard) => !first.shards.some((before) => before.sha256 === shard.sha256),
    );
    expect(changed.map((shard) => shard.name)).toEqual(["-1_0"]);
    const onlyChanged = await expectJson(
      await save(user, world, 1, moved.snapshot),
      409,
      MissingFilesResponse,
    );
    expect(onlyChanged.missing).toEqual({ shards: changed.map((s) => s.sha256), imports: [] });
    for (const shard of changed) await put(user, world, "shards", shard);
    const second = await expectJson(
      await save(user, world, 1, moved.snapshot),
      201,
      SaveVersionResponse,
    );
    expect(second).toMatchObject({ previousHead: 1, version: { version: 2, parent: 1 } });

    const described = await expectJson(
      await call(`/v1/worlds/${world}`, { session: user.session }),
      200,
      WorldResponse,
    );
    expect(described.world).toMatchObject({ id: world, name: "Club show", head: 2 });
    const history = await expectJson(
      await call(`/v1/worlds/${world}/versions?limit=1`, { session: user.session }),
      200,
      VersionListResponse,
    );
    expect(history.versions.map((version) => version.version)).toEqual([2]);
    expect(history.next).toBe(`${API}/v1/worlds/${world}/versions?before=2&limit=1`);
    const older = await expectJson(
      await call(`/v1/worlds/${world}/versions?before=2&limit=1`, { session: user.session }),
      200,
      VersionListResponse,
    );
    expect(older).toMatchObject({ versions: [{ version: 1 }], next: null });

    for (const [version, files] of [
      [1, first],
      [2, moved],
    ] as const) {
      const read = await call(`/v1/worlds/${world}/versions/${version}`, { session: user.session });
      expect(read.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
      const body = await expectJson(read, 200, VersionResponse);
      expect(body.snapshot).toEqual(files.snapshot);
      const texts = new Map([[MANIFEST_FILE, canonicalJson(body.snapshot.manifest)]]);
      for (const entry of body.snapshot.manifest.shards) {
        const hash = body.snapshot.shards[shardName(entry.superChunk)] ?? "";
        const shard = await call(`/v1/worlds/${world}/shards/${hash}`, { session: user.session });
        expect(shard.headers.get("etag")).toBe(`"${hash}"`);
        texts.set(shardPath(entry.superChunk), await shard.text());
      }
      const reopened = readWorldFiles(texts);
      expect(reopened.ok && reopened.value.shards).toEqual(files.shards.map((file) => file.shard));
    }

    const model = await call(`/v1/worlds/${world}/imports/${signalBox.sha256}`, {
      session: user.session,
    });
    expect(model.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await model.arrayBuffer())).toEqual(signalBox.body);
    const revalidated = await call(`/v1/worlds/${world}/imports/${signalBox.sha256}`, {
      session: user.session,
      headers: { "if-none-match": `"${signalBox.sha256}"` },
    });
    expect(revalidated.status).toBe(304);
    const head = await call(`/v1/worlds/${world}/imports/${signalBox.sha256}`, {
      method: "HEAD",
      session: user.session,
    });
    expect([head.status, head.headers.get("content-length"), await head.text()]).toEqual([
      200,
      String(signalBox.body.byteLength),
      "",
    ]);

    const usage = await expectJson(
      await call("/v1/account", { session: user.session }),
      200,
      AccountResponse,
    );
    const snapshots = await storedKeys(world);
    expect(snapshots.filter((key) => key.includes("/snapshots/"))).toHaveLength(2);
    const shardBytes = [...first.shards, ...changed].reduce(
      (sum, shard) => sum + utf8.encode(shard.body).byteLength,
      0,
    );
    const snapshotBytes = [first, moved].reduce(
      (sum, files) => sum + utf8.encode(canonicalJson(files.snapshot)).byteLength,
      0,
    );
    expect(usage.usage).toMatchObject({
      worlds: 1,
      bytes: shardBytes + signalBox.body.byteLength + snapshotBytes,
    });
  });

  it("refuses files that don't hash to their name, shards that aren't canonical world shards, and oversized bodies", async () => {
    const user = await signIn("careless@club.example");
    const world = await createWorld(user, "Workbench");
    const [shard] = worldFiles([baseplate], [], []).shards;
    if (shard === undefined) throw new Error("the fixture world has no shard");

    expect(
      await expectError(await put(user, world, "shards", { ...shard, sha256: lamp.sha256 }), 400),
    ).toBe(`body: hashes to ${shard.sha256}, not ${lamp.sha256}`);
    const pretty = `${JSON.stringify(shard.shard, null, 2)}\n`;
    expect(
      await expectError(
        await put(user, world, "shards", { sha256: sha256(pretty), body: pretty }),
        400,
      ),
    ).toMatch(/canonical JSON/u);
    const manifest = canonicalJson(worldManifest(header, [shardEntry(shard.shard)]));
    expect(
      await expectError(
        await put(user, world, "shards", { sha256: sha256(manifest), body: manifest }),
        400,
      ),
    ).toMatch(/^body\.format: must be "brr\.shard"/u);
    const latin1 = new Uint8Array([0x7b, 0xe9, 0x7d]);
    expect(
      await expectError(
        await put(user, world, "shards", { sha256: sha256(latin1), body: latin1 }),
        400,
      ),
    ).toBe("body: is not UTF-8 text");
    expect(
      await expectError(
        await put(user, world, "imports", { sha256: signalBox.sha256, body: lampBytes }),
        400,
      ),
    ).toBe(`body: hashes to ${lamp.sha256}, not ${signalBox.sha256}`);

    const oversized = " ".repeat(MAX_SHARD_BYTES + 1);
    expect(
      await expectError(
        await put(user, world, "shards", { sha256: sha256(oversized), body: oversized }),
        413,
      ),
    ).toBe(`the body is ${MAX_SHARD_BYTES + 1} bytes; the limit is ${MAX_SHARD_BYTES}`);
    expect(await storedKeys(world)).toEqual([]);
  });

  it("refuses a save whose parent, shards, track numbering or model files disagree with what is stored", async () => {
    const user = await signIn("strict@club.example");
    const world = await createWorld(user, "Yard");
    const files = worldFiles([baseplate, signalBoxOnBaseplate, station], straights, [signalBox]);
    for (const shard of files.shards) await put(user, world, "shards", shard);
    await put(user, world, "imports", signalBox);
    await put(user, world, "imports", lamp);

    expect(await expectError(await save(user, world, 7, files.snapshot), 422)).toBe(
      "parent: is version 7, which this world doesn't have",
    );

    const [west, east] = files.shards;
    if (west === undefined || east === undefined) throw new Error("the fixture spans two shards");
    const swapped = {
      ...files.snapshot,
      shards: { [west.name]: east.sha256, [east.name]: west.sha256 },
    };
    expect(await expectError(await save(user, world, null, swapped), 422)).toBe(
      [
        `snapshot.shards.${west.name}: holds super-chunk ${east.name}`,
        `snapshot.shards.${west.name}: holds ${east.shard.placements.length} placements, the manifest says ${west.shard.placements.length}`,
        `snapshot.shards.${west.name}: holds ${east.shard.track.length} track pieces, the manifest says ${west.shard.track.length}`,
        `snapshot.shards.${east.name}: holds super-chunk ${west.name}`,
        `snapshot.shards.${east.name}: holds ${west.shard.placements.length} placements, the manifest says ${east.shard.placements.length}`,
        `snapshot.shards.${east.name}: holds ${west.shard.track.length} track pieces, the manifest says ${east.shard.track.length}`,
      ].join("; "),
    );

    const unlisted = { ...files.snapshot, imports: [] };
    expect(await expectError(await save(user, world, null, unlisted), 422)).toBe(
      `snapshot.imports: is missing ${signalBox.sha256}, the original file the world places as import:${signalBox.sha256}`,
    );
    const extra = worldFiles([baseplate, signalBoxOnBaseplate, station], straights, [
      signalBox,
      lamp,
    ]);
    expect(await expectError(await save(user, world, null, extra.snapshot), 422)).toBe(
      `snapshot.imports: lists ${lamp.sha256}, which nothing in the world places`,
    );
    const unordered = { ...extra.snapshot, imports: extra.snapshot.imports.toReversed() };
    expect(await expectError(await save(user, world, null, unordered), 400)).toBe(
      "body.snapshot.imports: must list each file once, in ascending SHA-256 order",
    );
    const unnamed = { ...files.snapshot, shards: { [west.name]: west.sha256 } };
    expect(await expectError(await save(user, world, null, unnamed), 400)).toBe(
      "body.snapshot.shards: must name exactly the manifest's super-chunks, each with its shard's SHA-256",
    );

    const gap = worldFiles([baseplate], [straight(0, "0"), straight(2, "2")], []);
    for (const shard of gap.shards) await put(user, world, "shards", shard);
    expect(await expectError(await save(user, world, null, gap.snapshot), 422)).toBe(
      "snapshot.shards: the shards' track indices must run 0, 1, 2, … once each",
    );

    const listed = await expectJson(
      await call(`/v1/worlds/${world}/versions`, { session: user.session }),
      200,
      VersionListResponse,
    );
    expect(listed.versions).toEqual([]);
  });

  it("keeps each account's worlds and files out of other accounts' reach", async () => {
    const owner = await signIn("owner@club.example");
    const other = await signIn("other@club.example");
    const world = await createWorld(owner, "Private yard");
    const files = worldFiles([baseplate], [], []);
    for (const shard of files.shards) await put(owner, world, "shards", shard);
    await expectJson(await save(owner, world, null, files.snapshot), 201, SaveVersionResponse);
    const [shard] = files.shards;
    if (shard === undefined) throw new Error("the fixture world has no shard");

    const listed = await expectJson(
      await call("/v1/worlds", { session: other.session }),
      200,
      WorldListResponse,
    );
    expect(listed.worlds).toEqual([]);
    for (const [path, method] of [
      [`/v1/worlds/${world}`, "GET"],
      [`/v1/worlds/${world}`, "DELETE"],
      [`/v1/worlds/${world}/versions`, "GET"],
      [`/v1/worlds/${world}/versions/1`, "GET"],
      [`/v1/worlds/${world}/shards/${shard.sha256}`, "GET"],
    ] as const) {
      expect({
        path,
        method,
        error: await expectError(await call(path, { method, session: other.session }), 404),
      }).toEqual({
        path,
        method,
        error: `this account has no world ${world}`,
      });
    }
    expect((await put(other, world, "shards", shard)).status).toBe(404);
    expect((await call(`/v1/worlds/${world}`, { session: owner.session })).status).toBe(200);
  });

  it("deletes a world with its files, and an account with every world it owns", async () => {
    const user = await signIn("tidy@club.example");
    const kept = await createWorld(user, "Kept for now");
    const dropped = await createWorld(user, "Dropped");
    for (const world of [kept, dropped]) {
      const files = worldFiles([baseplate, signalBoxOnBaseplate], [], [signalBox]);
      for (const shard of files.shards) await put(user, world, "shards", shard);
      await put(user, world, "imports", signalBox);
      await expectJson(await save(user, world, null, files.snapshot), 201, SaveVersionResponse);
      expect(await storedKeys(world)).toHaveLength(3);
    }

    expect(
      (await call(`/v1/worlds/${dropped}`, { method: "DELETE", session: user.session })).status,
    ).toBe(204);
    expect(await storedKeys(dropped)).toEqual([]);
    expect((await call(`/v1/worlds/${dropped}`, { session: user.session })).status).toBe(404);
    const listed = await expectJson(
      await call("/v1/worlds", { session: user.session }),
      200,
      WorldListResponse,
    );
    expect(listed.worlds.map((world) => world.id)).toEqual([kept]);

    expect((await call("/v1/account", { method: "DELETE", session: user.session })).status).toBe(
      204,
    );
    expect(await storedKeys(kept)).toEqual([]);
    expect((await call("/v1/account", { session: user.session })).status).toBe(401);
    const returning = await signIn("tidy@club.example");
    const fresh = await expectJson(
      await call("/v1/account", { session: returning.session }),
      200,
      AccountResponse,
    );
    expect(fresh.account.id).not.toBe(user.accountId);
    expect(fresh.usage).toMatchObject({ bytes: 0, worlds: 0 });
  });

  it("answers CORS preflights, unknown paths and unsupported methods", async () => {
    const preflight = await call("/v1/worlds", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(await expectError(await call("/v1/nothing"), 404)).toBe("no such endpoint");
    const wrong = await call("/v1/sign-in-links");
    expect(wrong.headers.get("allow")).toBe("POST, OPTIONS");
    expect(await expectError(wrong, 405)).toBe("GET isn't supported here");
  });
});

class SteppedClock implements IClock {
  constructor(private time: number) {}

  now(): number {
    return this.time;
  }

  set(time: number): void {
    this.time = time;
  }
}

class CountingRandom implements IRandomSource {
  private calls = 0;

  bytes(length: number): Uint8Array {
    this.calls += 1;
    const bytes = new Uint8Array(length);
    new DataView(bytes.buffer).setUint32(0, this.calls);
    return bytes;
  }
}

class RecordingMailer implements IMailer {
  readonly sent: SignInMail[] = [];

  sendSignIn(mail: SignInMail): Promise<void> {
    this.sent.push(mail);
    return Promise.resolve();
  }
}

describe("layout API accounts over time", () => {
  const start = Date.UTC(2026, 10, 27, 12);
  const clock = new SteppedClock(start);
  const mailer = new RecordingMailer();
  let accounts: Accounts;

  beforeAll(async () => {
    await new SchemaMigrations(bindings.LAYOUT_DB, LAYOUT_MIGRATIONS, clock).ready();
    accounts = new Accounts(bindings.LAYOUT_DB, mailer, clock, new CountingRandom(), APP_ORIGIN);
  });

  async function emailedToken(email: string): Promise<string> {
    expect(await accounts.requestSignInLink(email)).toEqual({
      kind: "sent",
      expiresAt: clock.now() + SIGN_IN_LINK_LIFETIME_MS,
    });
    const mail = mailer.sent.at(-1);
    expect(mail).toMatchObject({ to: email, lifetimeMinutes: 15 });
    return tokenOf(mail?.link ?? "");
  }

  it("honours a link until its 15 minutes are up and a session until its 30 days are up", async () => {
    clock.set(start);
    const late = await emailedToken("clockwork@club.example");
    clock.set(start + SIGN_IN_LINK_LIFETIME_MS);
    expect(await accounts.startSession(late)).toEqual({ kind: "refused" });

    const prompt = await emailedToken("clockwork@club.example");
    const issuedAt = clock.now();
    clock.set(issuedAt + SIGN_IN_LINK_LIFETIME_MS - 1);
    const started = await accounts.startSession(prompt);
    if (started.kind !== "started") throw new Error("the link was refused inside its lifetime");
    expect(started.expiresAt).toBe(clock.now() + SESSION_LIFETIME_MS);

    clock.set(started.expiresAt - 1);
    expect(await accounts.authenticate(started.token)).toEqual(started.account);
    clock.set(started.expiresAt);
    expect(await accounts.authenticate(started.token)).toBeUndefined();
  });
});
