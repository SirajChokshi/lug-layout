import { decode, decodedOrThrow, type Decoded } from "@brr/schema/decode";
import {
  CloudWorldLink,
  MissingFilesResponse,
  SNAPSHOT_FORMAT,
  SNAPSHOT_SCHEMA_VERSION,
  SaveVersionResponse,
  VersionListResponse,
  VersionResponse,
  WorldListResponse,
  WorldResponse,
  type WorldSnapshot,
} from "@brr/schema/layout-api";
import {
  WorldShardV1,
  canonicalJson,
  parseJsonText,
  referencedImports,
  shardName,
  worldHeader,
  type WorldHeader,
  type WorldIndexEntry,
  type WorldManifestV1,
} from "@brr/schema/world";
import { inject, injectable } from "inversify";
import {
  CloudAccount,
  CloudUnreachableError,
  answer,
  ensureOk,
  errorText,
  type CloudAccountView,
  type LayoutRequest,
} from "./cloud-account.ts";
import { inStore } from "./indexed-db.ts";
import type { PersistentStorage } from "./persistent-storage.ts";
import { INDEXED_DB, LAYOUT_API_BASE_URL, PERSISTENT_STORAGE } from "./tokens.ts";
import {
  IndexedDbWorldRepository,
  contentSha256,
  type IWorldRepository,
  type StoredWorld,
  type WorldChange,
} from "./world-repository.ts";

const LINK_DATABASE = "brr-cloud-links";
const LINK_STORE = { name: "links", keyPath: "id" };
const SYNC_LOCK = "brr-cloud-sync";
const SYNC_DELAY_MS = 10_000;

export type CloudSyncState = "idle" | "syncing" | "offline" | "failed";

export interface AccountWorld {
  readonly id: string;
  readonly name: string;
  readonly savedAt: number;
}

export interface WorldVersion {
  readonly version: number;
  readonly name: string;
  readonly placements: number;
  readonly track: number;
  readonly savedAt: number;
  readonly onThisDevice: boolean;
}

export interface CloudView extends CloudAccountView {
  readonly sync: CloudSyncState;
  readonly syncError: string | null;
  readonly waiting: number;
  readonly accountWorlds: ReadonlyArray<AccountWorld>;
  readonly notice: string | null;
}

export interface ICloudWorlds extends IWorldRepository {
  view(): CloudView;
  subscribe(listener: () => void): () => void;
  start(fragment: string): Promise<boolean>;
  sendSignInLink(email: string): Promise<void>;
  signOut(): Promise<void>;
  syncNow(): Promise<void>;
  versions(id: string): Promise<ReadonlyArray<WorldVersion>>;
  deleteAccountWorld(id: string): Promise<void>;
}

interface SnapshotFiles {
  readonly snapshot: WorldSnapshot;
  readonly shards: ReadonlyMap<string, string>;
  readonly content: string;
}

interface DownloadedVersion {
  readonly manifest: WorldManifestV1;
  readonly shards: ReadonlyArray<WorldShardV1>;
  readonly content: string;
}

const utf8 = new TextEncoder();

function textSha256(text: string): Promise<string> {
  return contentSha256(utf8.encode(text));
}

function contentKey(snapshot: WorldSnapshot): Promise<string> {
  return textSha256(canonicalJson({ ...snapshot, manifest: { ...snapshot.manifest, view: null } }));
}

function withSyncLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request(SYNC_LOCK, task) : task();
}

function conflictNotice(name: string, parent: number | null, head: number, saved: number): string {
  const synced = parent === null ? "" : ` since this device synced version ${parent}`;
  return `"${name}" was saved on another device (version ${head})${synced}, so this device's edits became version ${saved}. Both stay in Versions.`;
}

@injectable()
export class CloudWorldRepository extends IndexedDbWorldRepository implements ICloudWorlds {
  private readonly account: CloudAccount;
  private readonly listeners = new Set<() => void>();
  private readonly waiting = new Set<string>();
  private state: CloudView = {
    signIn: "signed-out",
    email: null,
    error: null,
    sync: "idle",
    syncError: null,
    waiting: 0,
    accountWorlds: [],
    notice: null,
  };
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    @inject(INDEXED_DB) private readonly databases: IDBFactory,
    @inject(PERSISTENT_STORAGE) storage: PersistentStorage | null,
    @inject(LAYOUT_API_BASE_URL) baseUrl: string,
  ) {
    super(databases, storage);
    this.account = new CloudAccount(databases, baseUrl, (view) => this.update(view));
  }

  view(): CloudView {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<CloudView>): void {
    this.state = { ...this.state, ...patch, waiting: this.waiting.size };
    for (const listener of this.listeners) listener();
  }

  async start(fragment: string): Promise<boolean> {
    const consumed = await this.account.start(fragment);
    globalThis.addEventListener?.("online", () => void this.syncNow());
    globalThis.addEventListener?.("focus", () => void this.adoptOtherTabSignIn());
    void this.syncNow();
    return consumed;
  }

  private async adoptOtherTabSignIn(): Promise<void> {
    if (this.account.accountId === null && (await this.account.resume(this.state.error))) {
      await this.syncNow();
    }
  }

  sendSignInLink(email: string): Promise<void> {
    return this.account.sendLink(email);
  }

  async signOut(): Promise<void> {
    await this.inQueue(() => this.account.signOut());
    this.waiting.clear();
    this.update({ accountWorlds: [], notice: null, sync: "idle", syncError: null });
  }

  syncNow(): Promise<void> {
    return this.track(async (accountId) => {
      for (const entry of await this.list()) this.waiting.add(entry.id);
      await this.pushWaiting(accountId);
      await this.refreshAccountWorlds(accountId);
    });
  }

  async versions(id: string): Promise<ReadonlyArray<WorldVersion>> {
    const link = await this.currentLink(id);
    if (link === null) return [];
    const listed = await answer(await this.send(`/v1/worlds/${link.world}/versions`), (json) =>
      decode(VersionListResponse, json),
    );
    return listed.versions.map((summary) => ({
      version: summary.version,
      name: summary.name,
      placements: summary.placements,
      track: summary.track,
      savedAt: Date.parse(summary.savedAt),
      onThisDevice: summary.version === link.version,
    }));
  }

  deleteAccountWorld(id: string): Promise<void> {
    return this.track(async (accountId) => {
      await ensureOk(await this.send(`/v1/worlds/${id}`, { method: "DELETE" }));
      await this.refreshAccountWorlds(accountId);
    });
  }

  override async create(
    header: WorldHeader,
    shards: ReadonlyArray<WorldShardV1>,
  ): Promise<WorldIndexEntry> {
    const entry = await super.create(header, shards);
    this.schedule(entry.id);
    return entry;
  }

  override async save(id: string, change: WorldChange): Promise<WorldIndexEntry> {
    const entry = await super.save(id, change);
    this.schedule(id);
    return entry;
  }

  override async read(id: string): Promise<Decoded<StoredWorld>> {
    await this.track((accountId) => this.pull(id, accountId));
    return super.read(id);
  }

  override async restoreVersion(id: string, version: number): Promise<void> {
    const link = await this.currentLink(id);
    if (link === null) return super.restoreVersion(id, version);
    await this.inQueue(async () => {
      await this.push(id, link.account);
      await this.replace(id, await this.download(link.world, version));
      await this.push(id, link.account);
    });
  }

  override async remove(id: string): Promise<void> {
    await super.remove(id);
    this.waiting.delete(id);
    await this.inQueue(() => this.inLinks("readwrite", (store) => store.delete(id)));
    void this.track((accountId) => this.refreshAccountWorlds(accountId));
  }

  private send(path: string, request?: LayoutRequest): Promise<Response> {
    return this.account.send(path, request);
  }

  private inQueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => withSyncLock(task));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private track(task: (accountId: string) => Promise<void>): Promise<void> {
    return this.inQueue(async () => {
      const accountId = this.account.accountId;
      if (accountId === null) return;
      this.update({ sync: "syncing" });
      try {
        await task(accountId);
        this.update({ sync: "idle", syncError: null });
      } catch (error) {
        const offline = error instanceof CloudUnreachableError;
        this.update({ sync: offline ? "offline" : "failed", syncError: errorText(error) });
      }
    });
  }

  private schedule(id: string): void {
    if (this.account.accountId === null) return;
    this.waiting.add(id);
    this.update({});
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.track((accountId) => this.pushWaiting(accountId));
    }, SYNC_DELAY_MS);
  }

  private async pushWaiting(accountId: string): Promise<void> {
    const failures: unknown[] = [];
    for (const id of Array.from(this.waiting)) {
      this.waiting.delete(id);
      try {
        await this.push(id, accountId);
      } catch (error) {
        this.waiting.add(id);
        failures.push(error);
      }
      this.update({});
    }
    if (failures.length > 0) throw failures[0];
  }

  private async push(id: string, accountId: string): Promise<void> {
    const stored = await super.read(id);
    if (!stored.ok) return;
    const files = await this.snapshotFiles(stored.value);
    const link = await this.link(id, accountId);
    if (link?.content === files.content) return;
    const world =
      link?.world ?? (await this.createAccountWorld(id, accountId, stored.value.manifest.name));
    const parent = link?.version ?? null;
    const response = await this.postVersion(world, parent, files);
    if (response.status === 404 && link !== null) {
      await this.inLinks("readwrite", (store) => store.delete(id));
      await this.push(id, accountId);
      return;
    }
    const saved = await answer(response, (json) => decode(SaveVersionResponse, json));
    const { previousHead } = saved;
    if (previousHead !== null && previousHead !== parent) {
      const name = stored.value.manifest.name;
      this.update({ notice: conflictNotice(name, parent, previousHead, saved.version.version) });
    }
    await this.putLink({
      id,
      account: accountId,
      world,
      version: saved.version.version,
      content: files.content,
    });
  }

  private async createAccountWorld(id: string, accountId: string, name: string): Promise<string> {
    const { world } = await answer(
      await this.send("/v1/worlds", { method: "POST", json: { name } }),
      (json) => decode(WorldResponse, json),
    );
    await this.putLink({ id, account: accountId, world: world.id, version: null, content: null });
    return world.id;
  }

  private async postVersion(
    world: string,
    parent: number | null,
    files: SnapshotFiles,
  ): Promise<Response> {
    const path = `/v1/worlds/${world}/versions`;
    const request = { method: "POST", json: { parent, snapshot: files.snapshot } } as const;
    const first = await this.send(path, request);
    if (first.status !== 409) return first;
    const { missing } = decodedOrThrow(
      decode(MissingFilesResponse, JSON.parse(await first.text())),
      "the layout API's missing-file list",
    );
    for (const sha256 of missing.shards) {
      const text = files.shards.get(sha256);
      if (text === undefined)
        throw new Error(`the layout API asked for an unknown shard ${sha256}`);
      await this.upload(world, "shards", sha256, text);
    }
    for (const sha256 of missing.imports) {
      const file = await super.importedFile(sha256);
      if (file === undefined) throw new Error(`model file ${sha256} isn't stored on this device`);
      await this.upload(world, "imports", sha256, file.bytes.slice());
    }
    return this.send(path, request);
  }

  private async upload(
    world: string,
    kind: "shards" | "imports",
    sha256: string,
    body: Uint8Array<ArrayBuffer> | string,
  ): Promise<void> {
    await ensureOk(
      await this.send(`/v1/worlds/${world}/${kind}/${sha256}`, { method: "PUT", body }),
    );
  }

  private async snapshotFiles({ manifest, shards }: StoredWorld): Promise<SnapshotFiles> {
    const texts = new Map<string, string>();
    const named: Record<string, string> = {};
    for (const shard of shards) {
      const text = canonicalJson(shard);
      const sha256 = await textSha256(text);
      texts.set(sha256, text);
      named[shardName(shard.superChunk)] = sha256;
    }
    const imports: Array<{ sha256: string; name: string }> = [];
    for (const sha256 of [...referencedImports(shards, manifest.consists ?? [])].toSorted()) {
      const file = await super.importedFile(sha256);
      if (file === undefined) {
        throw new Error(`"${manifest.name}" places model file ${sha256}, which isn't stored here`);
      }
      imports.push({ sha256, name: file.name });
    }
    const snapshot: WorldSnapshot = {
      format: SNAPSHOT_FORMAT,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      manifest,
      shards: named,
      imports,
    };
    return { snapshot, shards: texts, content: await contentKey(snapshot) };
  }

  private async pull(id: string, accountId: string): Promise<void> {
    const link = await this.link(id, accountId);
    const world = link?.world ?? this.state.accountWorlds.find((item) => item.id === id)?.id;
    if (world === undefined) return;
    const { world: summary } = await answer(await this.send(`/v1/worlds/${world}`), (json) =>
      decode(WorldResponse, json),
    );
    if (summary.head === null || summary.head === link?.version) return;
    const local = await super.read(id);
    if (link !== null && local.ok) {
      if ((await this.snapshotFiles(local.value)).content !== link.content) return;
    }
    const pulled = await this.download(world, summary.head);
    await this.replace(id, pulled);
    await this.putLink({
      id,
      account: accountId,
      world,
      version: summary.head,
      content: pulled.content,
    });
    this.update({ accountWorlds: this.state.accountWorlds.filter((item) => item.id !== world) });
  }

  private async replace(id: string, version: DownloadedVersion): Promise<void> {
    const local = await super.read(id);
    const kept = new Set(version.shards.map((shard) => shardName(shard.superChunk)));
    const stale = local.ok ? local.value.manifest.shards.map((entry) => entry.superChunk) : [];
    await super.save(id, {
      header: worldHeader(version.manifest),
      put: version.shards,
      drop: stale.filter((superChunk) => !kept.has(shardName(superChunk))),
    });
  }

  private async download(world: string, version: number): Promise<DownloadedVersion> {
    const { snapshot } = await answer(
      await this.send(`/v1/worlds/${world}/versions/${version}`),
      (json) => decode(VersionResponse, json),
    );
    const shards: WorldShardV1[] = [];
    for (const entry of snapshot.manifest.shards) {
      const name = shardName(entry.superChunk);
      const sha256 = snapshot.shards[name] ?? "";
      const text = await ensureOk(await this.send(`/v1/worlds/${world}/shards/${sha256}`));
      if ((await textSha256(text)) !== sha256) throw new Error(`shard ${name} isn't ${sha256}`);
      const json = parseJsonText(text, `shard ${name}`);
      const shard = json.ok ? decode(WorldShardV1, json.value, `shard ${name}`) : json;
      shards.push(decodedOrThrow(shard, `version ${version} can't be read`));
    }
    for (const { sha256, name } of snapshot.imports) {
      if ((await super.importedFile(sha256)) !== undefined) continue;
      const response = await this.send(`/v1/worlds/${world}/imports/${sha256}`);
      if (!response.ok) await ensureOk(response);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if ((await contentSha256(bytes)) !== sha256) throw new Error(`${name} isn't ${sha256}`);
      await super.putImportedFile({ sha256, name, bytes });
    }
    return { manifest: snapshot.manifest, shards, content: await contentKey(snapshot) };
  }

  private async refreshAccountWorlds(accountId: string): Promise<void> {
    const { worlds } = await answer(await this.send("/v1/worlds"), (json) =>
      decode(WorldListResponse, json),
    );
    const links = await this.inLinks("readonly", (store) => store.getAll());
    const linked = new Set(
      links.flatMap((value: unknown) => {
        const link = decode(CloudWorldLink, value);
        return link.ok && link.value.account === accountId ? [link.value.world] : [];
      }),
    );
    this.update({
      accountWorlds: worlds
        .filter((world) => world.head !== null && !linked.has(world.id))
        .map((world) => ({ id: world.id, name: world.name, savedAt: Date.parse(world.updatedAt) })),
    });
  }

  private currentLink(id: string): Promise<CloudWorldLink | null> {
    const accountId = this.account.accountId;
    return accountId === null ? Promise.resolve(null) : this.link(id, accountId);
  }

  private async link(id: string, accountId: string): Promise<CloudWorldLink | null> {
    const value: unknown = await this.inLinks("readonly", (store) => store.get(id));
    const link = decode(CloudWorldLink, value);
    return link.ok && link.value.account === accountId ? link.value : null;
  }

  private async putLink(link: CloudWorldLink): Promise<void> {
    await this.inLinks("readwrite", (store) => store.put(link));
  }

  private inLinks<T>(
    mode: IDBTransactionMode,
    use: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return inStore(this.databases, LINK_DATABASE, LINK_STORE, mode, use);
  }
}
