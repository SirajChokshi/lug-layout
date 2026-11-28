import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  OMR_SETS_FORMAT,
  type BundleSource,
  type CrosswalkSourcePin,
  type OmrLibraryPin,
  type OmrSetsFile,
  type PaletteModel,
} from "@brr/schema/bundle";
import * as v from "valibot";
import { fetchWithRetry, NETWORK, type RetryingFetch } from "../fetch-retry.ts";
import { csvRecords, themePath, themeTable } from "./rebrickable-sets.ts";

const MODEL_FILE = /^(\d+-\d+)(?:[_.][^/]+)?\.mpd$/u;
const FETCH_CONCURRENCY = 16;

const MirrorTree = v.object({
  truncated: v.boolean(),
  tree: v.array(v.object({ path: v.string(), type: v.string(), sha: v.string() })),
});

export interface OmrSetsInputs {
  readonly pin: OmrLibraryPin;
  readonly setsCsv: string;
  readonly themesCsv: string;
}

export interface DerivedOmrSets {
  readonly file: OmrSetsFile;
  readonly report: {
    readonly sets: number;
    readonly modelledSets: number;
    readonly models: number;
  };
}

export function omrModelSet(file: string): string | null {
  return MODEL_FILE.exec(file)?.[1] ?? null;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlobSha1(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function rawUrl({ repo, commit, root }: BundleSource, file: string): string {
  return `https://raw.githubusercontent.com/${repo}/${commit}/${root}/${file}`;
}

function sameMirror(a: BundleSource, b: BundleSource): boolean {
  return a.repo === b.repo && a.commit === b.commit && a.root === b.root;
}

function byName<T>([a]: readonly [string, T], [b]: readonly [string, T]): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function download(url: string, network: RetryingFetch): Promise<Uint8Array> {
  const { status, bytes } = await fetchWithRetry(url, network);
  if (bytes === null) throw new Error(`GET ${url} failed with ${status}`);
  return bytes;
}

export async function fetchOmrLibrary(
  source: BundleSource,
  directory: string,
  network: RetryingFetch = NETWORK,
): Promise<OmrLibraryPin> {
  const treeUrl = `https://api.github.com/repos/${source.repo}/git/trees/${source.commit}?recursive=1`;
  const tree = v.parse(
    MirrorTree,
    JSON.parse(new TextDecoder().decode(await download(treeUrl, network))),
  );
  if (tree.truncated) throw new Error(`${treeUrl} lists a truncated tree`);
  const prefix = `${source.root}/`;
  const pending = tree.tree.filter(
    ({ path, type }) =>
      type === "blob" && path.startsWith(prefix) && omrModelSet(path.slice(prefix.length)) !== null,
  );
  const files: Array<[string, OmrLibraryPin["files"][string]]> = [];
  await mkdir(directory, { recursive: true });
  const worker = async (): Promise<void> => {
    for (let entry = pending.shift(); entry !== undefined; entry = pending.shift()) {
      const file = entry.path.slice(prefix.length);
      const url = rawUrl(source, file);
      const bytes = await download(url, network);
      if (gitBlobSha1(bytes) !== entry.sha) {
        throw new Error(`${url} isn't the blob ${entry.sha} that ${source.commit} names`);
      }
      await writeFile(join(directory, file), bytes);
      files.push([file, { sha256: sha256(bytes), bytes: bytes.length }]);
    }
  };
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
  return { source, files: Object.fromEntries(files.toSorted(byName)) };
}

export function omrLibraryProblems(
  pin: OmrLibraryPin,
  omrSource: BundleSource,
  models: ReadonlyArray<PaletteModel>,
): string[] {
  const problems: string[] = [];
  if (!sameMirror(pin.source, omrSource)) {
    problems.push(
      `omr-library.json pins ${pin.source.repo}@${pin.source.commit}/${pin.source.root}, not the palette's OMR source ${omrSource.repo}@${omrSource.commit}/${omrSource.root}`,
    );
  }
  for (const file of Object.keys(pin.files)) {
    if (omrModelSet(file) === null)
      problems.push(`omr-library.json lists ${file}, which names no set`);
  }
  for (const model of models) {
    if (model.origin !== "omr") continue;
    const pinned = pin.files[model.file];
    if (pinned === undefined) problems.push(`omr-library.json doesn't list ${model.file}`);
    else if (pinned.sha256 !== model.sha256) {
      problems.push(`omr-library.json pins ${model.file} at ${pinned.sha256}, not ${model.sha256}`);
    }
  }
  return problems;
}

export function deriveOmrSets(
  { pin, setsCsv, themesCsv }: OmrSetsInputs,
  sources: Readonly<Record<string, CrosswalkSourcePin>>,
): DerivedOmrSets {
  const themes = themeTable(themesCsv);
  const models = Object.entries(pin.files).toSorted(byName);
  const modelled = new Set(models.map(([file]) => omrModelSet(file)));
  const listed = csvRecords(setsCsv).filter(
    (row) => Number(row["num_parts"]) > 0 || modelled.has(row["set_num"] ?? ""),
  );
  const setIndex = new Map(listed.map((row, index) => [row["set_num"] ?? "", index]));
  const themeIndex = new Map<string, number>();
  const themePaths: string[][] = [];
  const themeOf = (id: string): number => {
    const known = themeIndex.get(id);
    if (known !== undefined) return known;
    themeIndex.set(id, themePaths.length);
    themePaths.push([...themePath(themes, id)]);
    return themePaths.length - 1;
  };
  const setOf = (file: string): number => {
    const number = omrModelSet(file) ?? "";
    const index = setIndex.get(number);
    if (index === undefined)
      throw new Error(`${file} names set ${number}, which sets.csv.gz lacks`);
    return index;
  };
  return {
    file: {
      format: OMR_SETS_FORMAT,
      mirror: pin.source,
      sources: { ...sources },
      themes: themePaths,
      sets: {
        number: listed.map((row) => row["set_num"] ?? ""),
        name: listed.map((row) => row["name"] ?? ""),
        year: listed.map((row) => Number(row["year"])),
        theme: listed.map((row) => themeOf(row["theme_id"] ?? "")),
        parts: listed.map((row) => Number(row["num_parts"])),
      },
      models: {
        file: models.map(([file]) => file),
        sha256: models.map(([, pinned]) => pinned.sha256),
        bytes: models.map(([, pinned]) => pinned.bytes),
        set: models.map(([file]) => setOf(file)),
      },
    },
    report: { sets: listed.length, modelledSets: modelled.size, models: models.length },
  };
}
