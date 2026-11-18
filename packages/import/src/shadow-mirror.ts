import {
  SHADOW_NAMESPACE,
  SHADOW_PATCH_NAMESPACE,
  ShadowLibraryIndex,
  ShadowPatchManifest,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import type { FetchFunction, MirrorStats, Probe } from "./ldraw-mirror.ts";

export interface ShadowLibraryLocation {
  readonly indexUrl: string;
  readonly sha256: string;
}

const CONTENT_ADDRESS = /\.([0-9a-f]{16})\.[^./]+$/u;

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class ShadowMirror {
  private index: Promise<ShadowLibraryIndex> | null = null;
  private patchManifest: Promise<ShadowPatchManifest> | null = null;
  private requests = 0;
  private found = 0;
  private notFound = 0;
  private bytes = 0;

  constructor(
    readonly location: ShadowLibraryLocation,
    private readonly fetchUrl: FetchFunction,
  ) {}

  private async fetchBytes(file: string): Promise<Uint8Array<ArrayBuffer>> {
    const url = new URL(file, this.location.indexUrl).href;
    this.requests++;
    const response = await this.fetchUrl(url);
    if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.found++;
    this.bytes += bytes.byteLength;
    return bytes;
  }

  private async addressed(file: string): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = await this.fetchBytes(file);
    const named = CONTENT_ADDRESS.exec(file)?.[1];
    const actual = await sha256Hex(bytes);
    if (named === undefined || !actual.startsWith(named)) {
      throw new Error(`${file} is not named by its content hash ${actual}`);
    }
    return bytes;
  }

  private loadIndex(): Promise<ShadowLibraryIndex> {
    this.index ??= (async () => {
      const bytes = await this.fetchBytes(this.location.indexUrl);
      const actual = await sha256Hex(bytes);
      if (actual !== this.location.sha256) {
        throw new Error(
          `${this.location.indexUrl} has SHA-256 ${actual}, not the pinned ${this.location.sha256}`,
        );
      }
      const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return decodedOrThrow(decode(ShadowLibraryIndex, raw), this.location.indexUrl);
    })();
    return this.index;
  }

  manifest(): Promise<ShadowPatchManifest> {
    this.patchManifest ??= (async () => {
      const { patchManifest } = await this.loadIndex();
      const raw: unknown = JSON.parse(
        new TextDecoder().decode(await this.addressed(patchManifest.file)),
      );
      return decodedOrThrow(decode(ShadowPatchManifest, raw), patchManifest.file);
    })();
    return this.patchManifest;
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

  async probe(paths: ReadonlyArray<string>, concurrency: number): Promise<Probe> {
    const found = new Map<string, string>();
    const absent: string[] = [];
    const queue = [...paths];
    const worker = async (): Promise<void> => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        const file = await this.listed(path);
        if (file === undefined) {
          this.notFound++;
          absent.push(path);
          continue;
        }
        found.set(path, new TextDecoder().decode(await this.addressed(file)));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return { found, absent };
  }

  stats(): MirrorStats {
    return {
      requests: this.requests,
      found: this.found,
      notFound: this.notFound,
      bytes: this.bytes,
    };
  }
}

export function isShadowLibraryPath(path: string): boolean {
  return path.startsWith(SHADOW_NAMESPACE) || path.startsWith(SHADOW_PATCH_NAMESPACE);
}
