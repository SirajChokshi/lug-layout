export interface MirrorSource {
  readonly repo: string;
  readonly commit: string;
  readonly root: string;
}

export type FetchFunction = (url: string) => Promise<Response>;

export function sameSource(a: MirrorSource, b: MirrorSource): boolean {
  return a.repo === b.repo && a.commit === b.commit && a.root === b.root;
}

export interface MirrorStats {
  readonly requests: number;
  readonly found: number;
  readonly notFound: number;
  readonly bytes: number;
}

const GITHUB_RAW_BASE_URL = "https://raw.githubusercontent.com";
const HTTP_NOT_FOUND = 404;
const TRAILING_SLASHES = /\/+$/u;
const SEARCH_PREFIXES = ["p/8/", "parts/", "p/"] as const;
const UNPREFIXED_RANK = SEARCH_PREFIXES.length;

function searchRank(path: string): number {
  const rank = SEARCH_PREFIXES.findIndex((prefix) => path.startsWith(prefix));
  return rank < 0 ? UNPREFIXED_RANK : rank;
}

function referenceOf(path: string): string {
  const prefix = SEARCH_PREFIXES.find((candidate) => path.startsWith(candidate));
  return prefix ? path.slice(prefix.length) : path;
}

export interface Probe {
  readonly found: ReadonlyMap<string, string>;
  readonly absent: ReadonlyArray<string>;
}

export class LdrawMirror {
  private requests = 0;
  private found = 0;
  private notFound = 0;
  private bytes = 0;
  readonly baseUrl: string;

  constructor(
    readonly source: MirrorSource,
    private readonly fetchUrl: FetchFunction,
    baseUrl: string = GITHUB_RAW_BASE_URL,
  ) {
    this.baseUrl = baseUrl.replace(TRAILING_SLASHES, "");
  }

  url(path: string): string {
    const key = [this.source.repo, this.source.commit, this.source.root, path]
      .filter((segment) => segment !== "")
      .join("/");
    return `${this.baseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async file(path: string): Promise<string | undefined> {
    const url = this.url(path);
    this.requests++;
    const response = await this.fetchUrl(url);
    if (response.status === HTTP_NOT_FOUND) {
      this.notFound++;
      return undefined;
    }
    if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
    const text = await response.text();
    this.found++;
    this.bytes += text.length;
    return text;
  }

  async probe(paths: ReadonlyArray<string>, concurrency: number): Promise<Probe> {
    const groups = new Map<string, string[]>();
    for (const path of paths) {
      const key = referenceOf(path);
      groups.set(key, [...(groups.get(key) ?? []), path]);
    }
    const found = new Map<string, string>();
    const absent: string[] = [];
    const queue = [...groups.values()].map((group) =>
      group.toSorted((a, b) => searchRank(a) - searchRank(b)),
    );
    const worker = async (): Promise<void> => {
      for (let group = queue.shift(); group; group = queue.shift()) {
        for (const path of group) {
          const text = await this.file(path);
          if (text === undefined) {
            absent.push(path);
            continue;
          }
          found.set(path, text);
          break;
        }
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
