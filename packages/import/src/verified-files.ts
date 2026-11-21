import { contentAddressedFile, contentDigestOf } from "@brr/schema/bundle";
import type { FetchFunction } from "./ldraw-mirror.ts";

const TRAILING_SLASHES = /\/+$/u;
const HEX_RADIX = 16;
const HEX_PAIR = 2;

export interface IByteCache {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

export interface RecordStats {
  readonly fetched: number;
  readonly cached: number;
  readonly bytes: number;
}

export const NO_BYTE_CACHE: IByteCache = {
  get: async () => undefined,
  put: async () => undefined,
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
  return [...digest].map((byte) => byte.toString(HEX_RADIX).padStart(HEX_PAIR, "0")).join("");
}

export class VerifiedFiles {
  private readonly baseUrl: string;
  private fetched = 0;
  private cached = 0;
  private bytesRead = 0;

  constructor(
    baseUrl: string,
    private readonly fetchUrl: FetchFunction,
    private readonly cache: IByteCache,
  ) {
    this.baseUrl = baseUrl.replace(TRAILING_SLASHES, "");
  }

  async addressed(file: string): Promise<Uint8Array> {
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

  async referenced(file: string, sha256: string): Promise<Uint8Array> {
    const digest = contentDigestOf(file);
    if (digest === null || !sha256.startsWith(digest)) {
      throw new Error(`${file} is not content-addressed by ${sha256}`);
    }
    const hit = await this.cache.get(file);
    if (hit !== undefined && (await sha256Hex(hit)) === sha256) {
      this.cached++;
      return hit;
    }
    const bytes = await this.download(file);
    if ((await sha256Hex(bytes)) !== sha256) throw new Error(`${file} differs from its SHA-256`);
    await this.cache.put(file, bytes);
    return bytes;
  }

  async pinned(file: string, sha256: string): Promise<Uint8Array | null> {
    const addressed = contentAddressedFile(file, sha256);
    const cached = await this.cache.get(addressed);
    if (cached !== undefined && (await sha256Hex(cached)) === sha256) {
      this.cached++;
      return cached;
    }
    const bytes = await this.download(addressed);
    if ((await sha256Hex(bytes)) !== sha256) return null;
    await this.cache.put(addressed, bytes);
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
}
