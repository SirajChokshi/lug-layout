import { Sha256Hex } from "@brr/schema/bundle";
import { decodedOrThrow, decode } from "@brr/schema/decode";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";

const CorpusFile = v.object({
  url: v.pipe(v.string(), v.url()),
  sha256: Sha256Hex,
  bytes: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
export type CorpusFile = v.InferOutput<typeof CorpusFile>;

const CorpusManifest = v.object({ files: v.pipe(v.array(CorpusFile), v.minLength(1)) });

export type InputFormat = "ldraw" | "studio";

const STUDIO_EXTENSION = /\.io$/iu;

export function formatOf(file: CorpusFile): InputFormat {
  return STUDIO_EXTENSION.test(new URL(file.url).pathname) ? "studio" : "ldraw";
}

export async function readCorpus(path: string): Promise<ReadonlyArray<CorpusFile>> {
  const manifest = decodedOrThrow(
    decode(CorpusManifest, JSON.parse(await readFile(path, "utf8"))),
    path,
  );
  const hashes = new Set(manifest.files.map((file) => file.sha256));
  if (hashes.size !== manifest.files.length) throw new Error(`${path} pins one file twice`);
  return manifest.files;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pinnedOrNull(file: CorpusFile, bytes: Uint8Array): Uint8Array | null {
  return bytes.length === file.bytes && sha256(bytes) === file.sha256 ? bytes : null;
}

async function cached(path: string): Promise<Uint8Array | null> {
  return readFile(path).then(
    (buffer) => new Uint8Array(buffer),
    () => null,
  );
}

export async function fetchPinned(file: CorpusFile, cacheDirectory: string): Promise<Uint8Array> {
  const path = join(cacheDirectory, file.sha256);
  const hit = await cached(path);
  if (hit && pinnedOrNull(file, hit)) return hit;
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`GET ${file.url} failed with ${response.status}`);
  const bytes = pinnedOrNull(file, new Uint8Array(await response.arrayBuffer()));
  if (!bytes) throw new Error(`${file.url} no longer matches its pinned sha256 and size`);
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(path, bytes);
  return bytes;
}
