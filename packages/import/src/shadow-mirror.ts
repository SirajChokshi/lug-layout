import {
  SHADOW_LIBRARY_INDEX_FILE,
  SHADOW_NAMESPACE,
  SHADOW_PATCH_NAMESPACE,
  ShadowLibraryIndex,
  ShadowPatchManifest,
  type ShadowLibraryIndexRef,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import type { FetchFunction, Probe } from "./ldraw-mirror.ts";
import { VerifiedFiles, type IByteCache, type RecordStats } from "./verified-files.ts";

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function retriedOnFailure<T>(
  loading: Promise<T>,
  forget: (failed: Promise<T>) => void,
): Promise<T> {
  return loading.catch((error: unknown) => {
    forget(loading);
    throw error;
  });
}

export function isShadowLibraryPath(path: string): boolean {
  return path.startsWith(SHADOW_NAMESPACE) || path.startsWith(SHADOW_PATCH_NAMESPACE);
}

export interface IShadowLibrary {
  manifest(): Promise<ShadowPatchManifest>;
  probe(paths: ReadonlyArray<string>, concurrency: number): Promise<Probe>;
  stats(): RecordStats;
}

export class ShadowMirror implements IShadowLibrary {
  private readonly files: VerifiedFiles;
  private index: Promise<ShadowLibraryIndex> | null = null;
  private patchManifest: Promise<ShadowPatchManifest> | null = null;

  constructor(
    baseUrl: string,
    private readonly pin: ShadowLibraryIndexRef,
    fetchUrl: FetchFunction,
    cache: IByteCache,
  ) {
    this.files = new VerifiedFiles(baseUrl, fetchUrl, cache);
  }

  manifest(): Promise<ShadowPatchManifest> {
    this.patchManifest ??= this.readManifest();
    return retriedOnFailure(this.patchManifest, (failed) => {
      if (this.patchManifest === failed) this.patchManifest = null;
    });
  }

  async probe(paths: ReadonlyArray<string>, concurrency: number): Promise<Probe> {
    const found = new Map<string, string>();
    const absent: string[] = [];
    const queue = [...paths];
    const worker = async (): Promise<void> => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        const file = await this.listed(path);
        if (file === undefined) absent.push(path);
        else found.set(path, text(await this.files.addressed(file)));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return { found, absent };
  }

  stats(): RecordStats {
    return this.files.stats();
  }

  private loadIndex(): Promise<ShadowLibraryIndex> {
    this.index ??= this.readIndex();
    return retriedOnFailure(this.index, (failed) => {
      if (this.index === failed) this.index = null;
    });
  }

  private async readIndex(): Promise<ShadowLibraryIndex> {
    if (this.pin.file !== SHADOW_LIBRARY_INDEX_FILE) {
      throw new Error(`the shadow library pin names ${this.pin.file}`);
    }
    const bytes = await this.files.pinned(this.pin.file, this.pin.sha256);
    if (bytes === null) {
      throw new Error(`the served shadow library index differs from its pinned ${this.pin.sha256}`);
    }
    return decodedOrThrow(decode(ShadowLibraryIndex, JSON.parse(text(bytes))), this.pin.file);
  }

  private async readManifest(): Promise<ShadowPatchManifest> {
    const { patchManifest } = await this.loadIndex();
    const bytes = await this.files.addressed(patchManifest.file);
    return decodedOrThrow(decode(ShadowPatchManifest, JSON.parse(text(bytes))), patchManifest.file);
  }

  private async listed(path: string): Promise<string | undefined> {
    const index = await this.loadIndex();
    if (path.startsWith(SHADOW_NAMESPACE)) {
      return index.shadow[path.slice(SHADOW_NAMESPACE.length)];
    }
    if (path.startsWith(SHADOW_PATCH_NAMESPACE)) {
      return index.patches[path.slice(SHADOW_PATCH_NAMESPACE.length)];
    }
    throw new Error(`${path} is not a shadow library path`);
  }
}
