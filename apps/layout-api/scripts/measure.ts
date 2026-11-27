import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import {
  MissingFilesResponse,
  SIGN_IN_FRAGMENT_KEY,
  SNAPSHOT_FORMAT,
  SNAPSHOT_SCHEMA_VERSION,
  SaveVersionResponse,
  SessionResponse,
  SignInLinkResponse,
  StoredFileResponse,
  VersionResponse,
  WorldResponse,
  type WorldSnapshot,
} from "@brr/schema/layout-api";
import {
  IMPORT_DIRECTORY,
  MANIFEST_FILE,
  WorldManifestV1,
  WorldShardV1,
  canonicalJson,
  parseJsonText,
  shardName,
  shardPath,
} from "@brr/schema/world";
import * as v from "valibot";

interface LocalWorld {
  readonly directory: string;
  readonly snapshot: WorldSnapshot;
  readonly shards: ReadonlyMap<string, string>;
  readonly imports: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
}

interface SaveSample {
  readonly world: string;
  readonly version: number;
  readonly snapshot: string;
  readonly shards: number;
  readonly shardsUploaded: number;
  readonly imports: number;
  readonly importsUploaded: number;
  readonly bytesUploaded: number;
  readonly uploadMs: number;
  readonly saveMs: number;
}

interface ReadSample {
  readonly version: number;
  readonly files: number;
  readonly bytes: number;
  readonly identical: boolean;
  readonly readMs: number;
}

const SentMails = v.object({
  result: v.array(v.object({ messageId: v.string(), to: v.array(v.string()) })),
});
const SentMail = v.object({ result: v.object({ text: v.string() }) });
const utf8 = new TextEncoder();

function sha256(body: string | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

async function readJsonFile<const TSchema extends v.GenericSchema>(
  path: string,
  schema: TSchema,
): Promise<v.InferOutput<TSchema>> {
  const json = parseJsonText(await readFile(path, "utf8"), path);
  return decodedOrThrow(json.ok ? decode(schema, json.value, path) : json, path);
}

async function importFiles(directory: string): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  const root = join(directory, IMPORT_DIRECTORY);
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const hashes = await readdir(root).catch(() => []);
  for (const hash of hashes) {
    for (const name of await readdir(join(root, hash))) {
      const bytes = new Uint8Array(await readFile(join(root, hash, name)));
      if (sha256(bytes) !== hash)
        throw new Error(`${join(root, hash, name)} doesn't hash to ${hash}`);
      files.set(name, bytes);
    }
  }
  return files;
}

async function readLocalWorld(directory: string): Promise<LocalWorld> {
  const manifest = await readJsonFile(join(directory, MANIFEST_FILE), WorldManifestV1);
  const entries = await Promise.all(
    manifest.shards.map(async (entry) => {
      const shard = await readJsonFile(join(directory, shardPath(entry.superChunk)), WorldShardV1);
      const text = canonicalJson(shard);
      return { name: shardName(entry.superChunk), sha256: sha256(text), text };
    }),
  );
  const shards = new Map(entries.map((entry) => [entry.sha256, entry.text] as const));
  const named = await importFiles(directory);
  const imports = new Map([...named.values()].map((bytes) => [sha256(bytes), bytes] as const));
  const snapshot: WorldSnapshot = {
    format: SNAPSHOT_FORMAT,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    manifest,
    shards: Object.fromEntries(entries.map((entry) => [entry.name, entry.sha256])),
    imports: [...named]
      .map(([name, bytes]) => ({ sha256: sha256(bytes), name }))
      .toSorted((a, b) => (a.sha256 < b.sha256 ? -1 : 1)),
  };
  return { directory, snapshot, shards, imports };
}

class LayoutApiClient {
  private readonly api: string;
  private session = "";

  constructor(api: string) {
    this.api = api;
  }

  async signIn(email: string): Promise<void> {
    const before = await this.mailIds(email);
    await this.json("/v1/sign-in-links", 202, SignInLinkResponse, {
      method: "POST",
      body: { email },
    });
    const fresh = (await this.mailIds(email)).find((id) => !before.includes(id));
    if (fresh === undefined) throw new Error(`no sign-in mail reached ${email}`);
    const mail = await this.local(SentMail, new URLSearchParams({ email_id: fresh }));
    const link = /https?:\/\/\S+/u.exec(mail.result.text)?.[0] ?? "";
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get(SIGN_IN_FRAGMENT_KEY);
    const started = await this.json("/v1/sessions", 201, SessionResponse, {
      method: "POST",
      body: { token },
    });
    this.session = started.session.token;
  }

  async json<const TSchema extends v.GenericSchema>(
    path: string,
    status: number,
    schema: TSchema,
    init: { readonly method?: string; readonly body?: unknown } = {},
  ): Promise<v.InferOutput<TSchema>> {
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const response = await this.send(path, method, body);
    const text = await response.text();
    if (response.status !== status) {
      throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
    }
    return decodedOrThrow(decode(schema, JSON.parse(text)), path);
  }

  send(path: string, method: string, body?: string | Uint8Array<ArrayBuffer>): Promise<Response> {
    const headers: Record<string, string> =
      this.session === "" ? {} : { authorization: `Bearer ${this.session}` };
    return fetch(`${this.api}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
  }

  private async mailIds(address: string): Promise<string[]> {
    const mails = await this.local(SentMails, new URLSearchParams({ per_page: "100" }));
    return mails.result.filter((mail) => mail.to.includes(address)).map((mail) => mail.messageId);
  }

  private async local<const TSchema extends v.GenericSchema>(
    schema: TSchema,
    params: URLSearchParams,
  ): Promise<v.InferOutput<TSchema>> {
    const response = await fetch(
      `${this.api}/cdn-cgi/local/explorer/api/local/email/sending?${params.toString()}`,
    );
    return decodedOrThrow(decode(schema, await response.json()), "local email store");
  }
}

async function uploadMissing(
  client: LayoutApiClient,
  worldId: string,
  world: LocalWorld,
  missing: { readonly shards: ReadonlyArray<string>; readonly imports: ReadonlyArray<string> },
): Promise<number> {
  let bytesUploaded = 0;
  for (const [kind, hashes, files] of [
    ["shards", missing.shards, world.shards],
    ["imports", missing.imports, world.imports],
  ] as const) {
    for (const hash of hashes) {
      const file = files.get(hash);
      if (file === undefined) {
        throw new Error(`the server asked for ${hash}, which ${world.directory} lacks`);
      }
      const stored = await client.send(`/v1/worlds/${worldId}/${kind}/${hash}`, "PUT", file);
      bytesUploaded += decodedOrThrow(decode(StoredFileResponse, await stored.json()), hash).bytes;
    }
  }
  return bytesUploaded;
}

async function saveVersion(
  client: LayoutApiClient,
  worldId: string,
  parent: number | null,
  world: LocalWorld,
): Promise<SaveSample> {
  const body = { parent, snapshot: world.snapshot };
  const path = `/v1/worlds/${worldId}/versions`;
  const firstStart = performance.now();
  const first = await client.send(path, "POST", JSON.stringify(body));
  const firstText = await first.text();
  const firstMs = performance.now() - firstStart;
  const sample = (
    saved: v.InferOutput<typeof SaveVersionResponse>,
    missing: { readonly shards: ReadonlyArray<string>; readonly imports: ReadonlyArray<string> },
    bytesUploaded: number,
    uploadMs: number,
    saveMs: number,
  ): SaveSample => ({
    world: world.directory,
    version: saved.version.version,
    snapshot: saved.version.snapshot,
    shards: world.shards.size,
    shardsUploaded: missing.shards.length,
    imports: world.imports.size,
    importsUploaded: missing.imports.length,
    bytesUploaded,
    uploadMs,
    saveMs,
  });
  if (first.status === 201) {
    const saved = decodedOrThrow(decode(SaveVersionResponse, JSON.parse(firstText)), path);
    return sample(saved, { shards: [], imports: [] }, 0, 0, firstMs);
  }
  if (first.status !== 409) throw new Error(`POST ${path} answered ${first.status}: ${firstText}`);
  const { missing } = decodedOrThrow(decode(MissingFilesResponse, JSON.parse(firstText)), path);
  const uploadStart = performance.now();
  const bytesUploaded = await uploadMissing(client, worldId, world, missing);
  const uploadMs = performance.now() - uploadStart;
  const saveStart = performance.now();
  const saved = await client.json(path, 201, SaveVersionResponse, { method: "POST", body });
  return sample(saved, missing, bytesUploaded, uploadMs, firstMs + performance.now() - saveStart);
}

async function readBack(
  client: LayoutApiClient,
  worldId: string,
  version: number,
  world: LocalWorld,
): Promise<ReadSample> {
  const start = performance.now();
  const read = await client.json(`/v1/worlds/${worldId}/versions/${version}`, 200, VersionResponse);
  let identical = canonicalJson(read.snapshot) === canonicalJson(world.snapshot);
  let bytes = 0;
  const files = [
    ...Object.values(read.snapshot.shards).map((hash) => ["shards", hash] as const),
    ...read.snapshot.imports.map((entry) => ["imports", entry.sha256] as const),
  ];
  for (const [kind, hash] of files) {
    const body = new Uint8Array(
      await (await client.send(`/v1/worlds/${worldId}/${kind}/${hash}`, "GET")).arrayBuffer(),
    );
    const local =
      kind === "shards" ? utf8.encode(world.shards.get(hash) ?? "") : world.imports.get(hash);
    identical &&= local !== undefined && Buffer.compare(body, local) === 0 && sha256(body) === hash;
    bytes += body.byteLength;
  }
  return { version, files: files.length, bytes, identical, readMs: performance.now() - start };
}

function ms(value: number): string {
  return value.toFixed(1);
}

function table(
  headings: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string {
  return [
    `| ${headings.join(" | ")} |`,
    `|${headings.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      api: { type: "string", default: "http://127.0.0.1:8787" },
      email: { type: "string", default: "measure@layouts.example.test" },
    },
  });
  if (positionals.length === 0) {
    throw new Error("usage: measure.ts [--api <url>] [--email <address>] <world directory>...");
  }
  const worlds = await Promise.all(
    positionals.map((directory) => readLocalWorld(resolve(directory))),
  );
  const client = new LayoutApiClient(values.api);
  await client.signIn(values.email);
  const first = worlds[0];
  if (first === undefined) throw new Error("no world to save");
  const created = await client.json("/v1/worlds", 201, WorldResponse, {
    method: "POST",
    body: { name: first.snapshot.manifest.name },
  });
  const saves: SaveSample[] = [];
  for (const world of worlds) {
    saves.push(await saveVersion(client, created.world.id, saves.at(-1)?.version ?? null, world));
  }
  const reads: ReadSample[] = [];
  for (const [index, save] of saves.entries()) {
    const world = worlds[index];
    if (world !== undefined)
      reads.push(await readBack(client, created.world.id, save.version, world));
  }
  process.stdout.write(
    [
      `World ${created.world.id} on ${values.api}`,
      "",
      table(
        [
          "version",
          "from",
          "snapshot",
          "shards sent / total",
          "models sent / total",
          "bytes sent",
          "upload ms",
          "save ms",
        ],
        saves.map((save) => [
          String(save.version),
          save.world,
          `${save.snapshot.slice(0, 12)}…`,
          `${save.shardsUploaded} / ${save.shards}`,
          `${save.importsUploaded} / ${save.imports}`,
          String(save.bytesUploaded),
          ms(save.uploadMs),
          ms(save.saveMs),
        ]),
      ),
      table(
        ["version", "files read", "bytes read", "byte-identical", "read ms"],
        reads.map((read) => [
          String(read.version),
          String(read.files),
          String(read.bytes),
          read.identical ? "yes" : "NO",
          ms(read.readMs),
        ]),
      ),
    ].join("\n"),
  );
  if (reads.some((read) => !read.identical)) process.exitCode = 1;
}

await main();
