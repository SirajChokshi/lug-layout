import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ThirdPartySourceId } from "@brr/schema/bundle";
import * as v from "valibot";
import { fetchWithRetry, NETWORK, type RetryingFetch } from "../fetch-retry.ts";
import { restoreFiles, type RestoreResult } from "../fetch-ldraw.ts";
import { LdrawLibrary } from "../ldraw/library.ts";
import type { MeasuredCurveSource } from "../track/track-catalog.ts";

const Sha256 = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));
const Namespace = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9]*$/u));

const GithubMirror = v.strictObject({
  kind: v.literal("github-mirror"),
  repo: v.string(),
  commit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u)),
  root: v.string(),
});

export const ThirdPartySource = v.strictObject({
  id: ThirdPartySourceId,
  namespace: Namespace,
  vendor: v.string(),
  source: GithubMirror,
  track: v.pipe(v.array(v.string()), v.minLength(1)),
  files: v.record(v.string(), Sha256),
});
export type ThirdPartySource = v.InferOutput<typeof ThirdPartySource>;

export const ThirdPartyTrackFile = v.strictObject({
  sources: v.array(ThirdPartySource),
});
export type ThirdPartyTrackFile = v.InferOutput<typeof ThirdPartyTrackFile>;

export const THIRD_PARTY_CACHE_DIRECTORY = join(".cache", "third-party");
const SUBFILE_FIELDS_BEFORE_NAME = 14;
const LDRAW_NAMESPACE = "ldraw";
const LIBRARY_FOLDER = "parts";
const NOT_FOUND = 404;

export async function readThirdPartyTrack(path: string): Promise<ThirdPartyTrackFile> {
  return v.parse(ThirdPartyTrackFile, JSON.parse(await readFile(path, "utf8")));
}

export function thirdPartyRoot(cacheRoot: string, source: ThirdPartySource): string {
  return join(cacheRoot, source.namespace);
}

export function thirdPartyLibrary(cacheRoot: string, source: ThirdPartySource): LdrawLibrary {
  return new LdrawLibrary([thirdPartyRoot(cacheRoot, source)]);
}

export function measuredCurveSources(
  file: ThirdPartyTrackFile,
  cacheRoot: string,
): ReadonlyArray<MeasuredCurveSource> {
  return file.sources.map((source) => ({
    id: source.id,
    namespace: source.namespace,
    vendor: source.vendor,
    library: thirdPartyLibrary(cacheRoot, source),
    parts: source.track,
  }));
}

export interface PartLibraries {
  readonly library: (partId: string) => LdrawLibrary;
  readonly file: (partId: string) => string;
}

function splitPartId(partId: string): readonly [string, string] {
  const colon = partId.indexOf(":");
  return colon < 0 ? [LDRAW_NAMESPACE, partId] : [partId.slice(0, colon), partId.slice(colon + 1)];
}

export function partLibraries(
  ldraw: LdrawLibrary,
  file: ThirdPartyTrackFile,
  cacheRoot: string,
): PartLibraries {
  const byNamespace = new Map(
    file.sources.map((source) => [source.namespace, thirdPartyLibrary(cacheRoot, source)]),
  );
  return {
    library: (partId) => {
      const [namespace] = splitPartId(partId);
      if (namespace === LDRAW_NAMESPACE) return ldraw;
      const vendor = byNamespace.get(namespace);
      if (vendor === undefined) throw new Error(`${partId} names no pinned part source`);
      return vendor;
    },
    file: (partId) => `${splitPartId(partId)[1]}.dat`,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function rawUrl(source: ThirdPartySource, path: string): string {
  const { repo, commit, root } = source.source;
  return ["https://raw.githubusercontent.com", repo, commit, root, path]
    .filter((segment) => segment !== "")
    .join("/");
}

function referencedFiles(text: string): ReadonlyArray<string> {
  return text.split(/\r?\n/u).flatMap((line) => {
    const tokens = line.trim().split(/\s+/u);
    return tokens[0] === "1" && tokens.length > SUBFILE_FIELDS_BEFORE_NAME
      ? [tokens.slice(SUBFILE_FIELDS_BEFORE_NAME).join(" ").replaceAll("\\", "/")]
      : [];
  });
}

export async function pinThirdPartyFiles(
  source: ThirdPartySource,
  network: RetryingFetch = NETWORK,
): Promise<Readonly<Record<string, string>>> {
  const files: Record<string, string> = {};
  const pending = source.track.map((part) => `${part}.dat`);
  for (let path = pending.shift(); path !== undefined; path = pending.shift()) {
    if (path in files) continue;
    const url = rawUrl(source, path);
    const { status, bytes } = await fetchWithRetry(url, network);
    if (status === NOT_FOUND || bytes === null) {
      throw new Error(
        `${source.id}: ${path} is not in ${source.source.repo}@${source.source.commit}`,
      );
    }
    files[path] = sha256(bytes);
    pending.push(...referencedFiles(new TextDecoder().decode(bytes)));
  }
  return Object.fromEntries(Object.entries(files).toSorted(([a], [b]) => a.localeCompare(b)));
}

export async function restoreThirdParty(
  cacheRoot: string,
  source: ThirdPartySource,
  network: RetryingFetch = NETWORK,
): Promise<RestoreResult> {
  return restoreFiles(
    source.source,
    source.files,
    join(thirdPartyRoot(cacheRoot, source), LIBRARY_FOLDER),
    network,
  );
}

export async function verifyThirdParty(
  cacheRoot: string,
  source: ThirdPartySource,
): Promise<ReadonlyArray<string>> {
  const directory = join(thirdPartyRoot(cacheRoot, source), LIBRARY_FOLDER);
  const problems: string[] = [];
  if (Object.keys(source.files).length === 0) problems.push(`${source.id}: pins no files`);
  for (const [path, expected] of Object.entries(source.files)) {
    const bytes = await readFile(join(directory, path)).catch(() => null);
    if (bytes === null) problems.push(`${source.id}: missing ${path}`);
    else if (sha256(bytes) !== expected) problems.push(`${source.id}: hash mismatch ${path}`);
  }
  return problems;
}

export async function restoreAllThirdParty(
  file: ThirdPartyTrackFile,
  cacheRoot: string,
): Promise<void> {
  for (const source of file.sources) {
    const { present, downloaded, pruned } = await restoreThirdParty(cacheRoot, source);
    process.stdout.write(
      `${source.id}: ${present} present, ${downloaded} downloaded, ${pruned} pruned\n`,
    );
  }
}

export async function verifyAllThirdParty(
  file: ThirdPartyTrackFile,
  cacheRoot: string,
): Promise<ReadonlyArray<string>> {
  const problems: string[] = [];
  for (const source of file.sources) problems.push(...(await verifyThirdParty(cacheRoot, source)));
  return problems;
}
