import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  modelPartReferences,
  parseLdraw,
  splitMultiPart,
  subfileReferences,
} from "./ldraw/parse.ts";
import type { Palette } from "./palette.ts";

export interface AuditLock {
  readonly files: Readonly<Record<string, string>>;
  readonly absentParts: ReadonlyArray<string>;
  readonly connectivity: {
    readonly source: Palette["source"];
    readonly files: Readonly<Record<string, string>>;
  };
}

export interface InputLock {
  readonly source: Palette["source"];
  readonly files: Readonly<Record<string, string>>;
  readonly audit?: AuditLock;
}

type Source = Palette["source"];

const SEARCH_DIRECTORIES = ["parts/", "p/"] as const;
const LOW_RESOLUTION_DIRECTORY = "p/8/";
const CONNECTIVITY_LICENSE = "LICENSE.md";
const RESTORE_CONCURRENCY = 16;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function download(source: Source, path: string): Promise<Uint8Array | undefined> {
  const { repo, commit, root } = source;
  const url = ["https://raw.githubusercontent.com", repo, commit, root, path]
    .filter((segment) => segment !== "")
    .join("/");
  const response = await fetch(url);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function resolveReference(
  source: Source,
  reference: string,
): Promise<{ path: string; bytes: Uint8Array } | undefined> {
  for (const directory of SEARCH_DIRECTORIES) {
    const path = directory + reference;
    const bytes = await download(source, path);
    if (bytes) return { path, bytes };
  }
  return undefined;
}

export async function fetchClosure(
  palette: Palette,
  outDirectory: string,
  modelSources: ReadonlyArray<string>,
): Promise<InputLock> {
  const files: Record<string, string> = {};
  const queue: string[] = [
    ...new Set([
      ...palette.parts.map((part) => `${part.id}.dat`),
      ...palette.studPrimitives,
      ...modelSources.flatMap(modelPartReferences),
    ]),
  ];
  const seen = new Set<string>(queue);

  async function store(path: string, bytes: Uint8Array): Promise<void> {
    const target = join(outDirectory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    files[path] = sha256(bytes);
  }

  for (const configFile of palette.config) {
    const bytes = await download(palette.source, configFile);
    if (!bytes) throw new Error(`missing config file ${configFile}`);
    await store(configFile, bytes);
  }

  while (queue.length > 0) {
    const reference = queue.shift();
    if (reference === undefined) break;
    const resolved = await resolveReference(palette.source, reference);
    if (!resolved) throw new Error(`unresolved LDraw reference ${reference}`);
    await store(resolved.path, resolved.bytes);
    const children = subfileReferences(parseLdraw(new TextDecoder().decode(resolved.bytes)));
    if (resolved.path.startsWith("p/") && !resolved.path.startsWith(LOW_RESOLUTION_DIRECTORY)) {
      const lowResolution = await download(palette.source, LOW_RESOLUTION_DIRECTORY + reference);
      if (lowResolution) {
        await store(LOW_RESOLUTION_DIRECTORY + reference, lowResolution);
        children.push(...subfileReferences(parseLdraw(new TextDecoder().decode(lowResolution))));
      }
    }
    for (const child of children) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }

  const sorted = Object.fromEntries(
    Object.entries(files).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  return { source: palette.source, files: sorted };
}

function sortedRecord(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).toSorted(([a], [b]) => a.localeCompare(b)));
}

async function storeInto(
  directory: string,
  files: Record<string, string>,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const target = join(directory, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  files[path] = sha256(bytes);
}

export async function fetchAuditInputs(
  palette: Palette,
  auditDirectory: string,
  connectivityDirectory: string,
): Promise<AuditLock> {
  const files: Record<string, string> = {};
  const absentParts: string[] = [];
  const seeds = palette.audit.flatMap((group) => group.parts.map((part) => `${part}.dat`));
  const seen = new Set<string>(seeds);
  const queue = [...seeds];
  for (let reference = queue.shift(); reference !== undefined; reference = queue.shift()) {
    const resolved = await resolveReference(palette.source, reference);
    if (!resolved) {
      if (!seeds.includes(reference)) throw new Error(`unresolved LDraw reference ${reference}`);
      absentParts.push(reference.replace(/\.dat$/u, ""));
      continue;
    }
    await storeInto(auditDirectory, files, resolved.path, resolved.bytes);
    for (const child of subfileReferences(parseLdraw(new TextDecoder().decode(resolved.bytes)))) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  const connectivity: Record<string, string> = {};
  for (const path of [CONNECTIVITY_LICENSE, ...Object.keys(files)]) {
    const bytes = await download(palette.connectivitySource, path);
    if (bytes) await storeInto(connectivityDirectory, connectivity, path, bytes);
  }
  return {
    files: sortedRecord(files),
    absentParts: absentParts.toSorted(),
    connectivity: { source: palette.connectivitySource, files: sortedRecord(connectivity) },
  };
}

async function hashProblems(
  files: Readonly<Record<string, string>>,
  directory: string,
): Promise<string[]> {
  const problems: string[] = [];
  for (const [path, expected] of Object.entries(files)) {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(join(directory, path));
    } catch {
      problems.push(`missing ${join(directory, path)}`);
      continue;
    }
    if (sha256(bytes) !== expected) problems.push(`hash mismatch ${join(directory, path)}`);
  }
  return problems;
}

export interface RestoreResult {
  readonly present: number;
  readonly downloaded: number;
}

async function hasPinnedBytes(path: string, expected: string): Promise<boolean> {
  try {
    return sha256(await readFile(path)) === expected;
  } catch {
    return false;
  }
}

export async function restoreFiles(
  source: Source,
  files: Readonly<Record<string, string>>,
  directory: string,
): Promise<RestoreResult> {
  const pending = Object.entries(files);
  let present = 0;
  let downloaded = 0;
  const worker = async (): Promise<void> => {
    for (let entry = pending.shift(); entry !== undefined; entry = pending.shift()) {
      const [path, expected] = entry;
      const target = join(directory, path);
      if (await hasPinnedBytes(target, expected)) {
        present += 1;
        continue;
      }
      const bytes = await download(source, path);
      if (!bytes)
        throw new Error(`pinned file ${path} is missing from ${source.repo}@${source.commit}`);
      if (sha256(bytes) !== expected) throw new Error(`hash mismatch ${path} from ${source.repo}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      downloaded += 1;
    }
  };
  await Promise.all(Array.from({ length: RESTORE_CONCURRENCY }, worker));
  return { present, downloaded };
}

export async function verifyAuditInputs(
  audit: AuditLock,
  auditDirectory: string,
  connectivityDirectory: string,
): Promise<string[]> {
  return [
    ...(await hashProblems(audit.files, auditDirectory)),
    ...(await hashProblems(audit.connectivity.files, connectivityDirectory)),
  ];
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
}

export async function verifyClosure(lock: InputLock, directory: string): Promise<string[]> {
  const problems: string[] = [];
  const present = new Set(await listFiles(directory));
  for (const [path, expected] of Object.entries(lock.files)) {
    if (!present.has(path)) {
      problems.push(`missing ${path}`);
      continue;
    }
    const actual = sha256(await readFile(join(directory, path)));
    if (actual !== expected) problems.push(`hash mismatch ${path}`);
    present.delete(path);
  }
  for (const extra of present) problems.push(`unpinned file ${extra}`);
  return problems;
}

export async function verifyModels(palette: Palette, fixturesRoot: string): Promise<string[]> {
  const problems: string[] = [];
  for (const model of palette.models) {
    const actual = sha256(await readFile(join(fixturesRoot, model.file)));
    if (actual !== model.sha256) problems.push(`hash mismatch ${model.file}`);
  }
  return problems;
}

export async function renderModelAttribution(
  palette: Palette,
  fixturesRoot: string,
): Promise<string> {
  const rows: string[] = [];
  for (const model of palette.models) {
    for (const section of splitMultiPart(await readFile(join(fixturesRoot, model.file), "utf8"))) {
      const { header } = parseLdraw(section.source);
      rows.push(
        `| \`${model.file}\` | ${header.name} | ${header.author} | ${header.license} | ${model.source} (retrieved ${model.retrieved}) |`,
      );
    }
  }
  return [
    "## Models",
    "",
    "Model files pinned by SHA-256 in `tools/asset-pipeline/palette.json`. OMR files are unmodified downloads; the Source column says where each model came from.",
    "",
    "| File | Sub-file | Author | License | Source |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

export async function renderAttribution(lock: InputLock, directory: string): Promise<string> {
  const rows: string[] = [];
  for (const path of Object.keys(lock.files)) {
    const { header } = parseLdraw(await readFile(join(directory, path), "utf8"));
    const license = header.license === "" ? "(no !LICENSE line)" : header.license;
    rows.push(`| \`${path}\` | ${header.title} | ${header.author} | ${license} |`);
  }
  const { repo, commit, root } = lock.source;
  return [
    "# Test fixture attribution",
    "",
    "The LDraw files listed below are unmodified copies from the LDraw parts library, fetched from the",
    `GitHub mirror \`${repo}\` at commit \`${commit}\` (\`${root}\`) and pinned by SHA-256 in`,
    "`tools/asset-pipeline/ldraw.lock.json`. They aren't committed: `pnpm --filter @brr/asset-pipeline",
    "restore-ldraw` downloads them into `.cache/ldraw` and checks every hash. LDraw parts are © their",
    "authors and redistributed under the license named in each file's `!LICENSE` header. See",
    "https://www.ldraw.org/ for the library.",
    "",
    "LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize or endorse this project.",
    "",
    "| File | Title | Author | License |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}
