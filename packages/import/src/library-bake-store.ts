import {
  contentAddressedFile,
  contentDigestOf,
  LIBRARY_BAKE_INDEX_FILE,
  LibraryBakeBucket,
  LibraryBakeIndex,
  libraryBakeBucket,
  RollingDiagnosticsFile,
  type LibraryBakePart,
  type PrimitiveConnectorTable,
  type RollingDiagnosticsRef,
  type UnreadBandDiagnostic,
} from "@brr/schema/bundle";
import { decode } from "@brr/schema/decode";
import type { FetchFunction, MirrorSource } from "./ldraw-mirror.ts";

const TRAILING_SLASHES = /\/+$/u;
const HEX_RADIX = 16;
const HEX_PAIR = 2;

export interface IByteCache {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

export interface PinnedRecords {
  readonly file: string;
  readonly sha256: string;
}

export interface RecordOptions {
  readonly source: MirrorSource;
  readonly studPrimitives: ReadonlyArray<string>;
  readonly unofficialAllowlist: ReadonlyArray<string>;
  readonly primitives: PrimitiveConnectorTable | null;
}

export interface RecordStats {
  readonly fetched: number;
  readonly cached: number;
  readonly bytes: number;
}

export interface IPartRecords {
  readonly key: string;
  lookup(
    partIds: ReadonlyArray<string>,
    options: RecordOptions,
  ): Promise<ReadonlyMap<string, LibraryBakePart>>;
  bytes(file: string): Promise<Uint8Array>;
  rollingDiagnostics(
    partIds: ReadonlyArray<string>,
  ): Promise<ReadonlyMap<string, ReadonlyArray<UnreadBandDiagnostic>>>;
  stats(): RecordStats;
}

interface ListedBucket {
  readonly parts: ReadonlyMap<string, LibraryBakePart>;
  readonly rollingDiagnostics: RollingDiagnosticsRef | null;
}

const EMPTY_BUCKET: ListedBucket = { parts: new Map(), rollingDiagnostics: null };

export const NO_BYTE_CACHE: IByteCache = {
  get: async () => undefined,
  put: async () => undefined,
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
  return [...digest].map((byte) => byte.toString(HEX_RADIX).padStart(HEX_PAIR, "0")).join("");
}

function json(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

function sameList(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key) => Object.hasOwn(b, key) && sameValue(Reflect.get(a, key), Reflect.get(b, key)),
    )
  );
}

function sameSource(a: MirrorSource, b: MirrorSource): boolean {
  return a.repo === b.repo && a.commit === b.commit && a.root === b.root;
}

export class LibraryBakeStore implements IPartRecords {
  readonly key: string;
  private readonly baseUrl: string;
  private index: Promise<LibraryBakeIndex | null> | null = null;
  private readonly buckets = new Map<number, Promise<ListedBucket>>();
  private fetched = 0;
  private cached = 0;
  private bytesRead = 0;

  constructor(
    baseUrl: string,
    private readonly pinned: PinnedRecords,
    private readonly fetchUrl: FetchFunction,
    private readonly cache: IByteCache,
  ) {
    this.key = pinned.sha256;
    this.baseUrl = baseUrl.replace(TRAILING_SLASHES, "");
  }

  async lookup(
    partIds: ReadonlyArray<string>,
    options: RecordOptions,
  ): Promise<ReadonlyMap<string, LibraryBakePart>> {
    const index = await this.loadIndex();
    if (
      index === null ||
      !sameSource(index.source, options.source) ||
      !sameList(index.options.studPrimitives, options.studPrimitives) ||
      !sameList(index.options.unofficialAllowlist, options.unofficialAllowlist) ||
      !sameValue(index.options.primitives, options.primitives)
    ) {
      return new Map();
    }
    const wanted = new Set(partIds);
    const buckets = [...new Set([...wanted].map(libraryBakeBucket))];
    const listed = await Promise.all(buckets.map((bucket) => this.bucket(index, bucket)));
    const found = new Map<string, LibraryBakePart>();
    for (const { parts } of listed) {
      for (const [id, part] of parts) if (wanted.has(id)) found.set(id, part);
    }
    return found;
  }

  async rollingDiagnostics(
    partIds: ReadonlyArray<string>,
  ): Promise<ReadonlyMap<string, ReadonlyArray<UnreadBandDiagnostic>>> {
    const index = await this.loadIndex();
    const found = new Map<string, ReadonlyArray<UnreadBandDiagnostic>>();
    if (index === null) return found;
    const wanted = new Set(partIds);
    for (const bucket of new Set([...wanted].map(libraryBakeBucket))) {
      const { rollingDiagnostics } = await this.bucket(index, bucket);
      if (rollingDiagnostics === null) continue;
      const bytes = await this.bytes(rollingDiagnostics.file);
      if ((await sha256Hex(bytes)) !== rollingDiagnostics.sha256) {
        throw new Error(`${rollingDiagnostics.file} differs from the SHA-256 its bucket names`);
      }
      const decoded = decode(RollingDiagnosticsFile, json(bytes));
      if (!decoded.ok)
        throw new Error(`${rollingDiagnostics.file} is not a rolling diagnostics file`);
      for (const [id, rows] of Object.entries(decoded.value.parts)) {
        if (wanted.has(id) && libraryBakeBucket(id) === bucket) found.set(id, rows);
      }
    }
    return found;
  }

  async bytes(file: string): Promise<Uint8Array> {
    const digest = contentDigestOf(file);
    if (digest === null) throw new Error(`${file} is not content-addressed`);
    const hit = await this.cache.get(file);
    if (hit !== undefined && (await sha256Hex(hit)).startsWith(digest)) {
      this.cached++;
      return hit;
    }
    const bytes = await this.download(file);
    if (!(await sha256Hex(bytes)).startsWith(digest)) {
      throw new Error(`${file} differs from its content address`);
    }
    await this.cache.put(file, bytes);
    return bytes;
  }

  stats(): RecordStats {
    return { fetched: this.fetched, cached: this.cached, bytes: this.bytesRead };
  }

  private async download(file: string): Promise<Uint8Array> {
    const url = `${this.baseUrl}/${file}`;
    const response = await this.fetchUrl(url);
    if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.fetched++;
    this.bytesRead += bytes.length;
    return bytes;
  }

  private async loadIndex(): Promise<LibraryBakeIndex | null> {
    const loading = (this.index ??= this.readIndex().catch(() => null));
    const index = await loading;
    if (index === null && this.index === loading) this.index = null;
    return index;
  }

  private async pinnedIndexBytes(file: string): Promise<Uint8Array | null> {
    const cached = await this.cache.get(file);
    if (cached !== undefined && (await sha256Hex(cached)) === this.pinned.sha256) {
      this.cached++;
      return cached;
    }
    const bytes = await this.download(file);
    if ((await sha256Hex(bytes)) !== this.pinned.sha256) return null;
    await this.cache.put(file, bytes);
    return bytes;
  }

  private async readIndex(): Promise<LibraryBakeIndex | null> {
    if (this.pinned.file !== LIBRARY_BAKE_INDEX_FILE) return null;
    const bytes = await this.pinnedIndexBytes(
      contentAddressedFile(this.pinned.file, this.pinned.sha256),
    );
    if (bytes === null) return null;
    const decoded = decode(LibraryBakeIndex, json(bytes));
    return decoded.ok ? decoded.value : null;
  }

  private bucket(index: LibraryBakeIndex, bucket: number): Promise<ListedBucket> {
    let loading = this.buckets.get(bucket);
    if (loading === undefined) {
      loading = this.readBucket(index, bucket).catch(() => {
        this.buckets.delete(bucket);
        return EMPTY_BUCKET;
      });
      this.buckets.set(bucket, loading);
    }
    return loading;
  }

  private async readBucket(index: LibraryBakeIndex, bucket: number): Promise<ListedBucket> {
    const file = index.buckets[bucket];
    if (file === undefined) return EMPTY_BUCKET;
    const decoded = decode(LibraryBakeBucket, json(await this.bytes(file)));
    if (!decoded.ok || decoded.value.bucket !== bucket) return EMPTY_BUCKET;
    return {
      parts: new Map(
        Object.entries(decoded.value.parts).filter(([id]) => libraryBakeBucket(id) === bucket),
      ),
      rollingDiagnostics: decoded.value.rollingDiagnostics ?? null,
    };
  }
}
