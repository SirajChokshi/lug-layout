import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { decode, issueText } from "@brr/schema/decode";
import {
  LdrawLibraryIndex,
  type GithubArchive,
  type GithubMirror,
  type LdrawLibraryIndex as LibraryIndex,
} from "@brr/schema/bundle";
import { readTarGz } from "../catalog/tar.ts";
import type { InputLock } from "../fetch-ldraw.ts";
import { fetchWithRetry } from "../fetch-retry.ts";
import { parseLdraw } from "../ldraw/parse.ts";
import { publicBucketNetwork } from "../publication/public-bucket-reads.ts";
import { encodeObjectPath, sha256Hex, type ObjectStore } from "../r2.ts";

const LIBRARY_DIRECTORIES = ["parts/", "p/"] as const;
const LDRAW_EXTENSIONS: ReadonlySet<string> = new Set([".dat", ".ldr", ".mpd"]);
const ROOT_TEXT_EXTENSION = ".txt";
const UNOFFICIAL_PREFIX = "Unofficial_";
const INDEX_FORMAT = 1;
const INDEX_PREFIX = "index";
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
const JSON_CONTENT_TYPE = "application/json";
const IMMUTABLE = "public, max-age=31536000, immutable";
const UPLOAD_CONCURRENCY = 32;
const READ_CONCURRENCY = 32;
const HTTP_NOT_FOUND = 404;

export interface PinnedArchive {
  readonly name: string;
  readonly file: string;
  readonly sha256: string;
  readonly location: GithubArchive;
  readonly mirror: GithubMirror;
}

export interface ExtractedLibrary {
  readonly index: LibraryIndex;
  readonly problems: ReadonlyArray<string>;
}

export interface UploadResult {
  readonly uploaded: number;
  readonly present: number;
}

export type ObjectReader = (key: string) => Promise<Uint8Array | undefined>;

export type VerifyScope = "pinned" | "all";

function joined(segments: ReadonlyArray<string>): string {
  return segments.filter((segment) => segment !== "").join("/");
}

export function libraryObjectKey(source: GithubMirror, path: string): string {
  return joined([source.repo, source.commit, source.root, path]);
}

export function libraryIndexKey(source: GithubMirror): string {
  return `${joined([INDEX_PREFIX, source.repo, source.commit, source.root])}.v${INDEX_FORMAT}.json`;
}

function isPublishedPath(path: string): boolean {
  const extension = extname(path).toLowerCase();
  if (!path.includes("/")) return extension === ROOT_TEXT_EXTENSION;
  return (
    LIBRARY_DIRECTORIES.some((directory) => path.startsWith(directory)) &&
    LDRAW_EXTENSIONS.has(extension)
  );
}

export function pinnedArchive(lock: InputLock): PinnedArchive {
  const { repo, commit, root } = lock.source;
  const matches = Object.entries(lock.catalog ?? {}).flatMap(([name, entry]) => {
    const { source } = entry;
    if (source.kind !== "github-archive") return [];
    if (source.repo !== repo || source.commit !== commit || source.root !== root) return [];
    return Object.entries(entry.files).map(([file, sha256]) => ({ name, file, sha256, source }));
  });
  const [match, ...others] = matches;
  if (match === undefined || others.length > 0) {
    throw new Error(
      `ldraw.lock.json must pin exactly one archive of ${repo}@${commit} (${root}); it pins ${matches.length}. Run fetch-ldraw`,
    );
  }
  return {
    name: match.name,
    file: match.file,
    sha256: match.sha256,
    location: match.source,
    mirror: { kind: "github-mirror", repo, commit, root },
  };
}

function pinnedFiles(lock: InputLock): ReadonlyMap<string, string> {
  return new Map([...Object.entries(lock.files), ...Object.entries(lock.audit?.files ?? {})]);
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function libraryPath(entryPath: string, root: string): string | undefined {
  const slash = entryPath.indexOf("/");
  if (slash < 0) return undefined;
  const inRepository = entryPath.slice(slash + 1);
  if (root === "") return inRepository;
  const prefix = `${root}/`;
  return inRepository.startsWith(prefix) ? inRepository.slice(prefix.length) : undefined;
}

function unofficialProblem(path: string, bytes: Buffer): string | undefined {
  if (!LDRAW_EXTENSIONS.has(extname(path).toLowerCase())) return undefined;
  const { header } = parseLdraw(bytes.toString("utf8"));
  return header.ldrawOrg.startsWith(UNOFFICIAL_PREFIX) ? `unofficial file ${path}` : undefined;
}

export async function extractLibrary(
  archivePath: string,
  lock: InputLock,
  directory: string,
): Promise<ExtractedLibrary> {
  const archive = pinnedArchive(lock);
  const actual = await fileSha256(archivePath);
  if (actual !== archive.sha256) {
    return {
      index: emptyIndex(archive),
      problems: [`${archivePath} has SHA-256 ${actual}, ldraw.lock.json pins ${archive.sha256}`],
    };
  }
  await rm(directory, { recursive: true, force: true });
  const hashes = new Map<string, string>();
  const published: Record<string, string> = {};
  const problems: string[] = [];
  const { root } = archive.mirror;
  await readTarGz(
    archivePath,
    (entryPath) => libraryPath(entryPath, root) !== undefined,
    (entryPath, bytes) => {
      const path = libraryPath(entryPath, root);
      if (path === undefined) return;
      const sha256 = sha256Hex(bytes);
      hashes.set(path, sha256);
      if (!isPublishedPath(path)) return;
      const problem = unofficialProblem(path, bytes);
      if (problem !== undefined) problems.push(problem);
      published[path] = sha256;
      const target = join(directory, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    },
  );
  for (const [path, expected] of pinnedFiles(lock)) {
    const found = hashes.get(path);
    if (found === undefined) problems.push(`ldraw.lock.json pins ${path}, the archive lacks it`);
    else if (found !== expected) problems.push(`${path} differs from ldraw.lock.json`);
  }
  if (Object.keys(published).length === 0) {
    problems.push(`the archive has no library files under ${root}/`);
  }
  return {
    index: {
      ...emptyIndex(archive),
      files: Object.fromEntries(
        Object.entries(published).toSorted(([a], [b]) => a.localeCompare(b)),
      ),
    },
    problems,
  };
}

function emptyIndex(archive: PinnedArchive): LibraryIndex {
  return {
    format: INDEX_FORMAT,
    source: archive.mirror,
    archive: { file: archive.file, sha256: archive.sha256 },
    files: {},
  };
}

async function putIfAbsent(
  store: ObjectStore,
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<boolean> {
  if (await store.has(key)) return false;
  await store.put(key, body, { "Content-Type": contentType, "Cache-Control": IMMUTABLE });
  return true;
}

export async function uploadLibrary(
  store: ObjectStore,
  index: LibraryIndex,
  directory: string,
): Promise<UploadResult> {
  let uploaded = 0;
  let present = 0;
  const pending = Object.entries(index.files);
  const worker = async (): Promise<void> => {
    for (let entry = pending.shift(); entry !== undefined; entry = pending.shift()) {
      const [path, sha256] = entry;
      const bytes = await readFile(join(directory, path));
      if (sha256Hex(bytes) !== sha256) {
        throw new Error(`${join(directory, path)} changed since it was extracted`);
      }
      const key = libraryObjectKey(index.source, path);
      if (await putIfAbsent(store, key, bytes, TEXT_CONTENT_TYPE)) uploaded += 1;
      else present += 1;
    }
  };
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
  const indexBytes = new TextEncoder().encode(`${JSON.stringify(index)}\n`);
  if (await putIfAbsent(store, libraryIndexKey(index.source), indexBytes, JSON_CONTENT_TYPE)) {
    uploaded += 1;
  } else {
    present += 1;
  }
  return { uploaded, present };
}

export function isLibraryPublished(store: ObjectStore, source: GithubMirror): Promise<boolean> {
  return store.has(libraryIndexKey(source));
}

export function publicObjectUrl(baseUrl: string, key: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(encodeObjectPath(key), base).href;
}

export function httpReader(baseUrl: string): ObjectReader {
  const network = publicBucketNetwork();
  return async (key) => {
    const url = publicObjectUrl(baseUrl, key);
    const { status, bytes } = await fetchWithRetry(url, network);
    if (status === HTTP_NOT_FOUND) return undefined;
    if (bytes === null) throw new Error(`GET ${url} failed with ${status}`);
    return bytes;
  };
}

type IndexRead =
  | { readonly kind: "found"; readonly index: LibraryIndex }
  | { readonly kind: "unusable"; readonly problem: string };

async function readIndex(read: ObjectReader, source: GithubMirror): Promise<IndexRead> {
  const key = libraryIndexKey(source);
  const bytes = await read(key);
  if (bytes === undefined) return { kind: "unusable", problem: `${key} is not published` };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { kind: "unusable", problem: `${key} is not JSON` };
  }
  const decoded = decode(LdrawLibraryIndex, json, key);
  return decoded.ok
    ? { kind: "found", index: decoded.value }
    : { kind: "unusable", problem: issueText(decoded.issues) };
}

function sameMirror(a: GithubMirror, b: GithubMirror): boolean {
  return a.repo === b.repo && a.commit === b.commit && a.root === b.root;
}

export async function verifyServedLibrary(
  read: ObjectReader,
  lock: InputLock,
  scope: VerifyScope,
): Promise<string[]> {
  const archive = pinnedArchive(lock);
  const found = await readIndex(read, archive.mirror);
  if (found.kind === "unusable") return [found.problem];
  const { index } = found;
  const problems: string[] = [];
  if (!sameMirror(index.source, archive.mirror)) {
    problems.push(
      `index describes ${index.source.repo}@${index.source.commit}, not the pinned mirror`,
    );
  }
  if (index.archive.sha256 !== archive.sha256) {
    problems.push(
      `index names archive ${index.archive.sha256}, ldraw.lock.json pins ${archive.sha256}`,
    );
  }
  const pinned = [...pinnedFiles(lock)].filter(([path]) => isPublishedPath(path));
  for (const [path, expected] of pinned) {
    if (index.files[path] !== expected)
      problems.push(`index entry for ${path} differs from ldraw.lock.json`);
  }
  const checked = scope === "all" ? Object.entries(index.files) : pinned;
  const pending = [...checked];
  const worker = async (): Promise<void> => {
    for (let entry = pending.shift(); entry !== undefined; entry = pending.shift()) {
      const [path, expected] = entry;
      const key = libraryObjectKey(index.source, path);
      const bytes = await read(key);
      if (bytes === undefined) problems.push(`${key} is not served`);
      else if (sha256Hex(bytes) !== expected)
        problems.push(`${key} differs from its pinned SHA-256`);
    }
  };
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
  return problems.toSorted();
}
