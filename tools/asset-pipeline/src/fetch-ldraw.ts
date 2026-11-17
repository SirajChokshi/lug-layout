import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { modelStructure, parseLdraw, splitMultiPart, subfileReferences } from "./ldraw/parse.ts";
import type {
  CatalogLocation,
  CatalogSource,
  CatalogSourceUse,
  Palette,
  PaletteModel,
} from "@brr/schema/bundle";

export interface AuditLock {
  readonly files: Readonly<Record<string, string>>;
  readonly absentParts: ReadonlyArray<string>;
  readonly connectivity: {
    readonly source: Palette["source"];
    readonly files: Readonly<Record<string, string>>;
  };
}

export interface CatalogSourceLock {
  readonly use: CatalogSourceUse;
  readonly source: CatalogLocation;
  readonly files: Readonly<Record<string, string>>;
}

export type CatalogLock = Readonly<Record<string, CatalogSourceLock>>;

export interface InputLock {
  readonly source: Palette["source"];
  readonly files: Readonly<Record<string, string>>;
  readonly audit?: AuditLock;
  readonly catalog?: CatalogLock;
}

type Source = Palette["source"];

const SEARCH_DIRECTORIES = ["parts/", "p/"] as const;
const LOW_RESOLUTION_DIRECTORY = "p/8/";
const CONNECTIVITY_LICENSE = "LICENSE.md";
const RESTORE_CONCURRENCY = 16;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function downloadUrl(source: CatalogLocation, path: string): string {
  const { repo, commit, root } = source;
  if (source.kind === "github-archive")
    return `https://codeload.github.com/${repo}/tar.gz/${commit}`;
  return ["https://raw.githubusercontent.com", repo, commit, root, path]
    .filter((segment) => segment !== "")
    .join("/");
}

async function download(source: CatalogLocation, path: string): Promise<Uint8Array | undefined> {
  const url = downloadUrl(source, path);
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
      ...modelSources.flatMap((source) => {
        const structure = modelStructure(source);
        return [...structure.parts, ...structure.inlinePartReferences];
      }),
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

export async function fetchCatalogSources(
  sources: ReadonlyArray<CatalogSource>,
  catalogDirectory: string,
): Promise<CatalogLock> {
  const lock: Record<string, CatalogSourceLock> = {};
  for (const { name, use, source, files } of sources) {
    const pinned: Record<string, string> = {};
    for (const path of files) {
      const bytes = await download(source, path);
      if (!bytes) throw new Error(`catalog source ${name}: ${path} is missing from ${source.repo}`);
      await storeInto(catalogSourceDirectory(catalogDirectory, name), pinned, path, bytes);
    }
    lock[name] = { use, source, files: sortedRecord(pinned) };
  }
  return lock;
}

export function catalogSourceDirectory(catalogDirectory: string, name: string): string {
  return join(catalogDirectory, name);
}

export async function verifyCatalogSources(
  catalog: CatalogLock,
  catalogDirectory: string,
  use: CatalogSourceUse,
): Promise<string[]> {
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(catalog)) {
    if (entry.use !== use) continue;
    problems.push(
      ...(await hashProblems(entry.files, catalogSourceDirectory(catalogDirectory, name))),
    );
  }
  return problems;
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
  readonly pruned: number;
}

async function hasPinnedBytes(path: string, expected: string): Promise<boolean> {
  try {
    return sha256(await readFile(path)) === expected;
  } catch {
    return false;
  }
}

export async function restoreFiles(
  source: CatalogLocation,
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
  const unpinned = (await listFiles(directory)).filter((path) => !(path in files));
  await Promise.all(unpinned.map((path) => rm(join(directory, path))));
  return { present, downloaded, pruned: unpinned.length };
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

export interface ModelRoots {
  readonly omr: string;
  readonly generated: string;
}

export function modelPath(model: PaletteModel, roots: ModelRoots): string {
  switch (model.origin) {
    case "omr":
      return join(roots.omr, model.file);
    case "generated":
      return join(roots.generated, model.file);
    default: {
      const unknown: never = model.origin;
      throw new Error(`unknown model origin ${String(unknown)}`);
    }
  }
}

export function omrFiles(palette: Palette): Record<string, string> {
  return Object.fromEntries(
    palette.models.filter((model) => model.origin === "omr").map((m) => [m.file, m.sha256]),
  );
}

export async function verifyModels(palette: Palette, roots: ModelRoots): Promise<string[]> {
  const problems: string[] = [];
  for (const model of palette.models) {
    const path = modelPath(model, roots);
    const actual = await readFile(path).then(sha256, () => undefined);
    if (actual === undefined) problems.push(`missing ${path}`);
    else if (actual !== model.sha256) problems.push(`hash mismatch ${path}`);
  }
  return problems;
}

function distinct(values: ReadonlyArray<string>): string {
  return [...new Set(values.filter((value) => value !== ""))].toSorted().join("; ");
}

export async function renderModelAttribution(palette: Palette, roots: ModelRoots): Promise<string> {
  const rows: string[] = [];
  for (const model of palette.models) {
    const headers = modelStructure(await readFile(modelPath(model, roots), "utf8")).modelSections;
    rows.push(
      `| ${model.name} | ${headers.length} | ${distinct(headers.map((h) => h.author))} | ${distinct(headers.map((h) => h.license))} | ${model.source} (retrieved ${model.retrieved}) |`,
    );
  }
  return [
    "## Models",
    "",
    "Model files pinned by SHA-256 in `tools/asset-pipeline/palette.json`. OMR models are unmodified files from the LDraw Official Model Repository, restored into `.cache/omr` by `restore-ldraw`; the generated scenes are committed under `docs/verified-facts/scenes`. Authors and licenses are collected from every submodel the model reaches.",
    "",
    "| Model | Sections | Authors | Licenses | Source |",
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

const HISTORY_META = "!HISTORY";
const TEST_DATA_EXTENSIONS = [".mpd", ".ldr"];

export async function renderTestDataAttribution(
  repoRoot: string,
  directories: ReadonlyArray<string>,
): Promise<string> {
  const rows: string[] = [];
  for (const directory of directories) {
    const names = (await readdir(join(repoRoot, directory))).filter((name) =>
      TEST_DATA_EXTENSIONS.some((extension) => name.endsWith(extension)),
    );
    for (const name of names.toSorted()) {
      const path = join(directory, name);
      for (const section of splitMultiPart(await readFile(join(repoRoot, path), "utf8"))) {
        const { header, lines } = parseLdraw(section.source);
        const history = lines.flatMap((line) =>
          line.kind === "meta" && line.tokens[0] === HISTORY_META
            ? [line.tokens.slice(1).join(" ")]
            : [],
        );
        const license = header.license === "" ? "(no !LICENSE line)" : header.license;
        rows.push(
          `| \`${path}\` | \`${section.name}\` | ${header.author} | ${license} | ${history.join("; ")} |`,
        );
      }
    }
  }
  return [
    "## Test data",
    "",
    "Committed LDraw test inputs, one row per section. Sections modified from LDraw library parts keep the part's author and license and say what changed in `!HISTORY`.",
    "",
    "| File | Section | Author | License | History |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}
