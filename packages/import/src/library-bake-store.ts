import {
  LIBRARY_BAKE_INDEX_FILE,
  LibraryBakeBucket,
  LibraryBakeIndex,
  libraryBakeBucket,
  type LibraryBakePart,
  type PrimitiveConnectorTable,
} from "@brr/schema/bundle";
import { decode } from "@brr/schema/decode";
import { sameSource, type FetchFunction, type MirrorSource } from "./ldraw-mirror.ts";
import { VerifiedFiles, type IByteCache, type RecordStats } from "./verified-files.ts";

export { NO_BYTE_CACHE, type IByteCache, type RecordStats } from "./verified-files.ts";

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

export interface IPartRecords {
  readonly key: string;
  lookup(
    partIds: ReadonlyArray<string>,
    options: RecordOptions,
  ): Promise<ReadonlyMap<string, LibraryBakePart>>;
  bytes(file: string): Promise<Uint8Array>;
  stats(): RecordStats;
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

export class LibraryBakeStore implements IPartRecords {
  readonly key: string;
  private readonly files: VerifiedFiles;
  private index: Promise<LibraryBakeIndex | null> | null = null;
  private readonly buckets = new Map<number, Promise<ReadonlyMap<string, LibraryBakePart>>>();

  constructor(
    baseUrl: string,
    private readonly pinned: PinnedRecords,
    fetchUrl: FetchFunction,
    cache: IByteCache,
  ) {
    this.key = pinned.sha256;
    this.files = new VerifiedFiles(baseUrl, fetchUrl, cache);
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
    for (const parts of listed) {
      for (const [id, part] of parts) if (wanted.has(id)) found.set(id, part);
    }
    return found;
  }

  bytes(file: string): Promise<Uint8Array> {
    return this.files.addressed(file);
  }

  stats(): RecordStats {
    return this.files.stats();
  }

  private async loadIndex(): Promise<LibraryBakeIndex | null> {
    const loading = (this.index ??= this.readIndex().catch(() => null));
    const index = await loading;
    if (index === null && this.index === loading) this.index = null;
    return index;
  }

  private async readIndex(): Promise<LibraryBakeIndex | null> {
    if (this.pinned.file !== LIBRARY_BAKE_INDEX_FILE) return null;
    const bytes = await this.files.pinned(this.pinned.file, this.pinned.sha256);
    if (bytes === null) return null;
    const decoded = decode(LibraryBakeIndex, json(bytes));
    return decoded.ok ? decoded.value : null;
  }

  private bucket(
    index: LibraryBakeIndex,
    bucket: number,
  ): Promise<ReadonlyMap<string, LibraryBakePart>> {
    let loading = this.buckets.get(bucket);
    if (loading === undefined) {
      loading = this.readBucket(index, bucket).catch(() => {
        this.buckets.delete(bucket);
        return new Map();
      });
      this.buckets.set(bucket, loading);
    }
    return loading;
  }

  private async readBucket(
    index: LibraryBakeIndex,
    bucket: number,
  ): Promise<ReadonlyMap<string, LibraryBakePart>> {
    const file = index.buckets[bucket];
    if (file === undefined) return new Map();
    const decoded = decode(LibraryBakeBucket, json(await this.bytes(file)));
    if (!decoded.ok || decoded.value.bucket !== bucket) return new Map();
    return new Map(
      Object.entries(decoded.value.parts).filter(([id]) => libraryBakeBucket(id) === bucket),
    );
  }
}
