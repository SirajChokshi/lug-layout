import { parseGlb } from "@brr/catalog/glb";
import {
  LIBRARY_BAKE_BUCKETS,
  LIBRARY_BAKE_FORMAT,
  libraryBakeBucket,
  ROLLING_STEPS_PER_LDU,
  rollingDiagnosticsFit,
  UnreadBandDiagnostic,
  type GithubMirror,
  type LibraryBakeBucket,
  type LibraryBakeIndex,
  type LibraryBakeOptions,
  type LibraryBakePart,
  type LibraryBakePin,
  type RollingDiagnosticsFile,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { contentAddressedName } from "../publish.ts";
import { isCaLicense } from "../verify/license-audit.ts";

export const LIBRARY_BAKE_INDEX = "library-bake.json";
export const LIBRARY_BAKE_PIN = "tools/asset-pipeline/library-bake.json";
const LISTING = /^shard-\d+-of-\d+\.json$/u;
const BUCKET_FOLDER = "buckets";
const DIAGNOSTICS_FOLDER = "rolling-diagnostics";
const BUCKET_DIGITS = 3;

const CompiledListing = v.strictObject({
  id: v.string(),
  part: v.string(),
  record: v.string(),
  glb: v.string(),
  licenses: v.array(v.string()),
  rollingDiagnostics: v.optional(v.pipe(v.array(UnreadBandDiagnostic), v.minLength(1))),
});
const FailedListing = v.strictObject({ id: v.string(), part: v.string(), failed: v.string() });
const ShardListing = v.array(v.union([CompiledListing, FailedListing]));
type PartListing = v.InferOutput<typeof ShardListing>[number];

export interface LibraryBakeInputs {
  readonly build: string;
  readonly out: string;
  readonly source: GithubMirror;
  readonly options: LibraryBakeOptions;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listings(build: string): Promise<PartListing[]> {
  const files = (await readdir(build)).filter((name) => LISTING.test(name)).toSorted();
  if (files.length === 0) throw new Error(`${build} has no shard listings`);
  const parts: PartListing[] = [];
  for (const file of files) {
    const raw: unknown = JSON.parse(await readFile(join(build, file), "utf8"));
    parts.push(...decodedOrThrow(decode(ShardListing, raw), file));
  }
  const seen = new Set<string>();
  for (const { id } of parts) {
    if (seen.has(id)) throw new Error(`${id} is listed by more than one shard`);
    seen.add(id);
  }
  return parts.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

async function moveAddressed(build: string, out: string, file: string): Promise<string> {
  const bytes = await readFile(join(build, file));
  const name = contentAddressedName(file, sha256(bytes));
  await mkdir(dirname(join(out, name)), { recursive: true });
  await rename(join(build, file), join(out, name));
  return name;
}

async function writeAddressed(out: string, file: string, text: string): Promise<string> {
  const name = contentAddressedName(file, sha256(text));
  await writeFile(join(out, name), text);
  return name;
}

type DiagnosticsRows = RollingDiagnosticsFile["parts"];

async function servedRowsFit(
  out: string,
  glb: string,
  rows: DiagnosticsRows[string] | undefined,
): Promise<boolean> {
  const bytes = await readFile(join(out, glb));
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const bands = parseGlb(buffer, glb).document.extras.rolling?.unread ?? [];
  return rows === undefined ? bands.length === 0 : rollingDiagnosticsFit(bands, rows);
}

async function writeBuckets(
  out: string,
  parts: Readonly<Record<string, LibraryBakePart>>,
  diagnostics: Readonly<DiagnosticsRows>,
): Promise<string[]> {
  const buckets: Array<Record<string, LibraryBakePart>> = Array.from(
    { length: LIBRARY_BAKE_BUCKETS },
    () => ({}),
  );
  for (const [id, part] of Object.entries(parts)) {
    const bucket = buckets[libraryBakeBucket(id)];
    if (bucket !== undefined) bucket[id] = part;
  }
  await mkdir(join(out, BUCKET_FOLDER), { recursive: true });
  await mkdir(join(out, DIAGNOSTICS_FOLDER), { recursive: true });
  const files: string[] = [];
  for (const [bucket, bucketParts] of buckets.entries()) {
    const stem = String(bucket).padStart(BUCKET_DIGITS, "0");
    const rows: DiagnosticsRows = {};
    for (const id of Object.keys(bucketParts)) {
      const partRows = diagnostics[id];
      if (partRows !== undefined) rows[id] = partRows;
    }
    const value: LibraryBakeBucket = { bucket, parts: bucketParts };
    if (Object.keys(rows).length > 0) {
      const file: RollingDiagnosticsFile = { stepsPerLdu: ROLLING_STEPS_PER_LDU, parts: rows };
      const text = JSON.stringify(file);
      value.rollingDiagnostics = {
        file: await writeAddressed(out, `${DIAGNOSTICS_FOLDER}/${stem}.json`, text),
        sha256: sha256(text),
      };
    }
    files.push(await writeAddressed(out, `${BUCKET_FOLDER}/${stem}.json`, JSON.stringify(value)));
  }
  return files;
}

export async function assembleLibraryBake(inputs: LibraryBakeInputs): Promise<LibraryBakePin> {
  const { build, out, source, options } = inputs;
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const parts: Record<string, LibraryBakePart> = {};
  const diagnostics: DiagnosticsRows = {};
  const failed: Record<string, string> = {};
  const refused: Array<{ part: string; licenses: ReadonlyArray<string> }> = [];
  const licenses = new Set<string>();
  const listed = await listings(build);
  for (const listing of listed) {
    if ("failed" in listing) {
      failed[listing.id] = listing.failed;
      continue;
    }
    if (!listing.licenses.every(isCaLicense)) {
      refused.push({ part: listing.id, licenses: listing.licenses });
      continue;
    }
    for (const license of listing.licenses) licenses.add(license);
    const part = {
      record: await moveAddressed(build, out, listing.record),
      glb: await moveAddressed(build, out, listing.glb),
    };
    if (!(await servedRowsFit(out, part.glb, listing.rollingDiagnostics))) {
      throw new Error(
        `${listing.id}: its rolling diagnostics rows don't match its GLB's unread bands index by index`,
      );
    }
    parts[listing.id] = part;
    if (listing.rollingDiagnostics !== undefined)
      diagnostics[listing.id] = listing.rollingDiagnostics;
  }
  const index: LibraryBakeIndex = {
    format: LIBRARY_BAKE_FORMAT,
    source,
    options,
    licenses: [...licenses].toSorted(),
    buckets: await writeBuckets(out, parts, diagnostics),
    failed,
  };
  const text = JSON.stringify(index);
  await writeFile(join(out, LIBRARY_BAKE_INDEX), text);
  await writeFile(join(out, contentAddressedName(LIBRARY_BAKE_INDEX, sha256(text))), text);
  return {
    index: { file: LIBRARY_BAKE_INDEX, sha256: sha256(text) },
    parts: listed.length,
    records: Object.keys(parts).length,
    failed: Object.keys(failed).length,
    refused,
  };
}
