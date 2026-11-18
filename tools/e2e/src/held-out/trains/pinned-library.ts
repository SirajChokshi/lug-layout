import type { FetchFunction, MirrorSource } from "@brr/import";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOCK_FILE = "tools/asset-pipeline/ldraw.lock.json";
const CATALOG_ROOT = ".cache/catalog";
const EXTRACTED_MARKER = ".extracted";
const HTTP_NOT_FOUND = 404;
const LIBRARY_DIRECTORIES = ["parts", "p"] as const;
const PART_DIRECTORY = "parts";
const PRIMITIVE_DIRECTORIES = ["p", "p/48"] as const;
const LDRAW_EXTENSION = ".dat";
const FIELDS = /\s+/u;
const REFERENCE_FIELD = 14;
const ORGANISATION = /^0 !LDRAW_ORG (\S+)/mu;
const OFFICIAL_PART_TYPES = new Set(["Part", "Shortcut"]);
const THIRD_PARTY_MARKER = /^0 \|/u;
const SEARCH_PREFIXES = ["parts/", "p/"] as const;

interface ArchivePin {
  readonly source: MirrorSource;
  readonly file: string;
  readonly sha256: string;
  readonly directory: string;
}

interface LockFile {
  readonly source: MirrorSource;
  readonly catalog: Readonly<
    Record<
      string,
      {
        readonly source: MirrorSource & { readonly kind: string };
        readonly files: Readonly<Record<string, string>>;
      }
    >
  >;
}

export interface LibraryFiles {
  readonly files: Readonly<Record<string, string>>;
  readonly absent: ReadonlyArray<string>;
}

export interface LibraryPart {
  readonly reference: string;
  readonly partReferences: ReadonlyArray<string>;
}

async function archivePin(repoRoot: string): Promise<ArchivePin> {
  const lock = JSON.parse(await readFile(join(repoRoot, LOCK_FILE), "utf8")) as LockFile;
  const { repo, commit, root } = lock.source;
  const pins = Object.entries(lock.catalog).flatMap(([name, entry]) =>
    entry.source.repo === repo && entry.source.commit === commit && entry.source.root === root
      ? Object.entries(entry.files).map(([file, sha256]) => ({ name, file, sha256 }))
      : [],
  );
  const [pin, ...others] = pins;
  if (!pin || others.length > 0) throw new Error(`${LOCK_FILE} must pin one archive of ${repo}`);
  return {
    source: lock.source,
    file: join(repoRoot, CATALOG_ROOT, pin.name, pin.file),
    sha256: pin.sha256,
    directory: join(repoRoot, CATALOG_ROOT, pin.name),
  };
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface SubfileLine {
  readonly reference: string;
  readonly localY: readonly [number, number, number];
}

export function subfileLines(text: string): ReadonlyArray<SubfileLine> {
  const out: SubfileLine[] = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(FIELDS);
    if (fields[0] !== "1" || fields.length <= REFERENCE_FIELD) continue;
    const numbers = fields.slice(1, REFERENCE_FIELD).map(Number);
    out.push({
      reference: fields.slice(REFERENCE_FIELD).join(" ").replaceAll("\\", "/").toLowerCase(),
      localY: [numbers[5] ?? 0, numbers[8] ?? 0, numbers[11] ?? 0],
    });
  }
  return out;
}

function references(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(FIELDS);
    if (fields[0] !== "1" || fields.length <= REFERENCE_FIELD) continue;
    out.push(fields.slice(REFERENCE_FIELD).join(" ").replaceAll("\\", "/").toLowerCase());
  }
  return out;
}

function hasOwnGeometry(text: string): boolean {
  return text.split("\n").some((line) => /^\s*[2-5]\s/u.test(line));
}

export class PinnedLibrary {
  private readonly texts = new Map<string, string | null>();
  private readonly closures = new Map<string, ReadonlySet<string>>();

  private constructor(
    readonly source: MirrorSource,
    private readonly root: string,
  ) {}

  static async open(repoRoot: string, extractRoot: string): Promise<PinnedLibrary> {
    const pin = await archivePin(repoRoot);
    const target = join(extractRoot, pin.source.commit);
    const marker = join(target, EXTRACTED_MARKER);
    const extracted = await readFile(marker, "utf8").catch(() => null);
    if (extracted !== pin.sha256) {
      const actual = await fileSha256(pin.file).catch(() => null);
      if (actual !== pin.sha256) {
        throw new Error(`${pin.file} is missing or not the pinned archive; run restore-ldraw`);
      }
      await mkdir(target, { recursive: true });
      execFileSync("tar", [
        "-xzf",
        pin.file,
        "-C",
        target,
        "--strip-components=2",
        "--wildcards",
        ...LIBRARY_DIRECTORIES.map((directory) => `*/${pin.source.root}/${directory}/*`),
      ]);
      await writeFile(marker, pin.sha256);
    }
    return new PinnedLibrary(pin.source, target);
  }

  async text(path: string): Promise<string | null> {
    const known = this.texts.get(path);
    if (known !== undefined) return known;
    const text = await readFile(join(this.root, path), "latin1").catch(() => null);
    this.texts.set(path, text);
    return text;
  }

  readonly fetch: FetchFunction = async (url) => {
    const marker = `/${this.source.root}/`;
    const at = url.indexOf(marker);
    if (at < 0) return new Response(null, { status: HTTP_NOT_FOUND });
    const path = decodeURIComponent(url.slice(at + marker.length));
    const text = await this.text(path);
    return text === null
      ? new Response(null, { status: HTTP_NOT_FOUND })
      : new Response(Buffer.from(text, "latin1"));
  };

  async primitiveNames(pattern: RegExp): Promise<ReadonlyArray<string>> {
    const names: string[] = [];
    for (const directory of PRIMITIVE_DIRECTORIES) {
      const prefix = directory === "p" ? "" : `${directory.slice("p/".length)}/`;
      for (const file of await readdir(join(this.root, directory))) {
        const name = `${prefix}${file.toLowerCase()}`;
        if (pattern.test(name)) names.push(name);
      }
    }
    return names.toSorted();
  }

  private async resolve(reference: string): Promise<string | null> {
    for (const prefix of SEARCH_PREFIXES) {
      if ((await this.text(prefix + reference)) !== null) return prefix + reference;
    }
    return null;
  }

  async files(roots: ReadonlyArray<string>): Promise<LibraryFiles> {
    const files: Record<string, string> = {};
    const absent = new Set<string>();
    const pending = [...roots];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const reference = pending.pop();
      if (reference === undefined || seen.has(reference)) continue;
      seen.add(reference);
      for (const prefix of SEARCH_PREFIXES) {
        const text = await this.text(prefix + reference);
        if (text === null) {
          absent.add(prefix + reference);
          continue;
        }
        files[prefix + reference] = text;
        pending.push(...references(text));
        break;
      }
    }
    return { files, absent: [...absent] };
  }

  async closure(path: string, leaves: RegExp): Promise<ReadonlySet<string>> {
    const known = this.closures.get(path);
    if (known) return known;
    const found = new Set<string>();
    this.closures.set(path, found);
    for (const reference of references((await this.text(path)) ?? "")) {
      if (leaves.test(reference)) {
        found.add(reference);
        continue;
      }
      const child = await this.resolve(reference);
      if (child) for (const leaf of await this.closure(child, leaves)) found.add(leaf);
    }
    return found;
  }

  async officialParts(): Promise<ReadonlyArray<LibraryPart>> {
    const parts: LibraryPart[] = [];
    for (const file of (await readdir(join(this.root, PART_DIRECTORY))).toSorted()) {
      if (!file.toLowerCase().endsWith(LDRAW_EXTENSION)) continue;
      const text = (await this.text(`${PART_DIRECTORY}/${file}`)) ?? "";
      const type = ORGANISATION.exec(text)?.[1];
      if (type === undefined || !OFFICIAL_PART_TYPES.has(type) || THIRD_PARTY_MARKER.test(text))
        continue;
      const referenced = references(text);
      const partReferences: string[] = [];
      for (const reference of referenced) {
        if (reference.includes("/")) continue;
        if ((await this.text(`${PART_DIRECTORY}/${reference}`)) !== null) {
          partReferences.push(reference);
        }
      }
      const alias = !hasOwnGeometry(text) && referenced.length === 1 && partReferences.length === 1;
      if (alias) continue;
      parts.push({ reference: file.toLowerCase(), partReferences });
    }
    return parts;
  }
}
