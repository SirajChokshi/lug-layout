import { decode, type Decoded, type Issue } from "../decode/index.ts";
import { WorldDocumentIndex } from "./document.ts";
import {
  CREDITS_FILE,
  IMPORT_DIRECTORY,
  IMPORT_REF_PREFIX,
  MANIFEST_FILE,
  canonicalJson,
  compareSuperChunks,
  decodeWorldSchemaVersion,
  noteShardPath,
  parseJsonText,
  shardPath,
  unexpectedFiles,
  type ArchiveText,
  type SuperChunk,
} from "./fields.ts";
import { InventoryV2, inventoryEntry, inventoryPath, type InventoryEntryV2 } from "./inventory.ts";
import { NoteShardV2, worldNotes, type NoteShardEntryV2 } from "./notes.ts";
import { WorldManifestV1, WorldShardV1, type ConsistRecordV1, type ShardEntryV1 } from "./v1.ts";
import {
  WorldManifestV2,
  WorldShardV2,
  migrateWorldV1,
  noteShardReferenceIssues,
  shardReferenceIssues,
  worldTrack,
  type WorldContentsV2,
} from "./v2.ts";

export interface ImportedFile {
  readonly sha256: string;
  readonly name: string;
  readonly bytes: Uint8Array;
}

export type WorldFiles = WorldContentsV2 & {
  readonly imports: ReadonlyArray<ImportedFile>;
};

export type WorldArchive = WorldFiles & {
  readonly credits: string;
};

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const UNSAFE_FILE_NAME_CHARACTERS = /[^A-Za-z0-9._ -]/gu;
const IMPORT_PATH = /^imports\/(?<sha256>[0-9a-f]{64})\/(?<name>[^/]+)$/u;
const NOT_PART_OF_A_WORLD = "is not part of a world";

export function importRef(sha256: string): string {
  return `${IMPORT_REF_PREFIX}${sha256}`;
}

export function importedSha256(ref: string): string | null {
  if (!ref.startsWith(IMPORT_REF_PREFIX)) return null;
  const sha256 = ref.slice(IMPORT_REF_PREFIX.length);
  return SHA256_HEX.test(sha256) ? sha256 : null;
}

export function importPath(file: Pick<ImportedFile, "sha256" | "name">): string {
  const name = file.name.replace(UNSAFE_FILE_NAME_CHARACTERS, "_").trim() || file.sha256;
  return `${IMPORT_DIRECTORY}${file.sha256}/${name}`;
}

export function parseImportPath(path: string): Pick<ImportedFile, "sha256" | "name"> | null {
  const match = IMPORT_PATH.exec(path)?.groups;
  const sha256 = match?.["sha256"];
  const name = match?.["name"];
  return sha256 === undefined || name === undefined ? null : { sha256, name };
}

export interface PlacedRefs {
  readonly placements: ReadonlyArray<{ readonly ref: string }>;
}

export function referencedImports(
  shards: ReadonlyArray<PlacedRefs>,
  consists: ReadonlyArray<ConsistRecordV1>,
): ReadonlySet<string> {
  const referenced = new Set<string>();
  const refs = [
    ...shards.flatMap((shard) => shard.placements.map((placement) => placement.ref)),
    ...consists.flatMap((consist) => [
      consist.ref,
      ...(consist.coupled ?? []).map((vehicle) => vehicle.ref),
    ]),
  ];
  for (const ref of refs) {
    const sha256 = importedSha256(ref);
    if (sha256 !== null) referenced.add(sha256);
  }
  return referenced;
}

function bySuperChunk<T extends { readonly superChunk: SuperChunk }>(
  shards: ReadonlyArray<T>,
): T[] {
  const sorted = [...shards];
  sorted.sort((a, b) => compareSuperChunks(a.superChunk, b.superChunk));
  return sorted;
}

function byContributor(inventories: ReadonlyArray<InventoryV2>): InventoryV2[] {
  const sorted = [...inventories];
  sorted.sort((a, b) => a.contributor - b.contributor);
  return sorted;
}

export function worldArchiveFiles(archive: Omit<WorldArchive, "imports">): ArchiveText[] {
  return [
    { name: MANIFEST_FILE, text: canonicalJson(archive.manifest) },
    ...bySuperChunk(archive.shards).map((shard) => ({
      name: shardPath(shard.superChunk),
      text: canonicalJson(shard),
    })),
    ...bySuperChunk(archive.notes).map((shard) => ({
      name: noteShardPath(shard.superChunk),
      text: canonicalJson(shard),
    })),
    ...byContributor(archive.inventories).map((inventory) => ({
      name: inventoryPath(inventory.contributor),
      text: canonicalJson(inventory),
    })),
    { name: CREDITS_FILE, text: archive.credits },
  ];
}

export function readWorldArchive(
  files: ReadonlyMap<string, string>,
): Decoded<Omit<WorldArchive, "imports">> {
  const credits = files.get(CREDITS_FILE);
  const world = readWorldFiles(new Map([...files].filter(([name]) => name !== CREDITS_FILE)));
  if (world.ok && credits !== undefined) return { ok: true, value: { ...world.value, credits } };
  const missingCredits: Issue[] =
    credits === undefined ? [{ path: CREDITS_FILE, message: "is missing" }] : [];
  return { ok: false, issues: [...missingCredits, ...(world.ok ? [] : world.issues)] };
}

export function manifestJson(files: ReadonlyMap<string, string>): Decoded<unknown> {
  const manifestText = files.get(MANIFEST_FILE);
  if (manifestText === undefined) {
    return { ok: false, issues: [{ path: MANIFEST_FILE, message: "is missing from the archive" }] };
  }
  return parseJsonText(manifestText, MANIFEST_FILE);
}

export interface StoredShard {
  readonly superChunk: SuperChunk;
  readonly placements: ReadonlyArray<unknown>;
  readonly track: ReadonlyArray<{ readonly index: number }>;
}

export interface ShardFiles<Shard> {
  readonly shards: ReadonlyArray<Shard>;
  readonly paths: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<Issue>;
}

export type ShardDecoder<Shard> = (value: unknown, path: string) => Decoded<Shard>;

export const decodeShardV1: ShardDecoder<WorldShardV1> = (value, path) =>
  decode(WorldShardV1, value, path);

export const decodeShardV2: ShardDecoder<WorldShardV2> = (value, path) =>
  decode(WorldShardV2, value, path);

function readJsonFile<Shard>(
  files: ReadonlyMap<string, string>,
  path: string,
  decodeShard: ShardDecoder<Shard>,
): Decoded<Shard> {
  const text = files.get(path);
  if (text === undefined) {
    return { ok: false, issues: [{ path, message: "is listed in the manifest but missing" }] };
  }
  const json = parseJsonText(text, path);
  return json.ok ? decodeShard(json.value, path) : json;
}

export function readShardFiles<Shard extends StoredShard>(
  files: ReadonlyMap<string, string>,
  entries: ReadonlyArray<ShardEntryV1>,
  decodeShard: ShardDecoder<Shard>,
): ShardFiles<Shard> {
  const issues: Issue[] = [];
  const paths: string[] = [];
  const shards: Shard[] = [];
  for (const entry of entries) {
    const path = shardPath(entry.superChunk);
    paths.push(path);
    const shard = readJsonFile(files, path, decodeShard);
    if (!shard.ok) {
      issues.push(...shard.issues);
      continue;
    }
    if (compareSuperChunks(shard.value.superChunk, entry.superChunk) !== 0) {
      issues.push({ path, message: "holds a different super-chunk than its name" });
    }
    if (shard.value.placements.length !== entry.placements) {
      issues.push({
        path,
        message: `holds ${shard.value.placements.length} placements, the manifest says ${entry.placements}`,
      });
    }
    if (shard.value.track.length !== entry.track) {
      issues.push({
        path,
        message: `holds ${shard.value.track.length} track pieces, the manifest says ${entry.track}`,
      });
    }
    shards.push(shard.value);
  }
  const everyShardRead = shards.length === entries.length;
  if (everyShardRead && worldTrack(shards).some((piece, position) => piece.index !== position)) {
    issues.push({
      path: MANIFEST_FILE,
      message: "the shards' track indices must run 0, 1, 2, … once each",
    });
  }
  return { shards, paths, issues };
}

const decodeNoteShard: ShardDecoder<NoteShardV2> = (value, path) =>
  decode(NoteShardV2, value, path);

export function readNoteShardFiles(
  files: ReadonlyMap<string, string>,
  entries: ReadonlyArray<NoteShardEntryV2>,
): ShardFiles<NoteShardV2> {
  const issues: Issue[] = [];
  const paths: string[] = [];
  const shards: NoteShardV2[] = [];
  for (const entry of entries) {
    const path = noteShardPath(entry.superChunk);
    paths.push(path);
    const shard = readJsonFile(files, path, decodeNoteShard);
    if (!shard.ok) {
      issues.push(...shard.issues);
      continue;
    }
    if (compareSuperChunks(shard.value.superChunk, entry.superChunk) !== 0) {
      issues.push({ path, message: "holds a different super-chunk than its name" });
    }
    if (shard.value.notes.length !== entry.notes) {
      issues.push({
        path,
        message: `holds ${shard.value.notes.length} notes, the manifest says ${entry.notes}`,
      });
    }
    shards.push(shard.value);
  }
  if (
    shards.length === entries.length &&
    worldNotes(shards).some((note, position) => note.index !== position)
  ) {
    issues.push({
      path: MANIFEST_FILE,
      message: "the note shards' note indices must run 0, 1, 2, … once each",
    });
  }
  return { shards, paths, issues };
}

const decodeInventory: ShardDecoder<InventoryV2> = (value, path) =>
  decode(InventoryV2, value, path);

export function inventoryIssues(
  inventory: InventoryV2,
  entry: InventoryEntryV2,
  path: string,
): Issue[] {
  const read = inventoryEntry(inventory);
  const issues: Issue[] = [];
  if (read.contributor !== entry.contributor) {
    issues.push({ path, message: `holds contributor ${read.contributor}'s inventory` });
  }
  if (read.parts !== entry.parts) {
    issues.push({ path, message: `holds ${read.parts} parts, the manifest says ${entry.parts}` });
  }
  return issues;
}

function readInventoryFiles(
  files: ReadonlyMap<string, string>,
  entries: ReadonlyArray<InventoryEntryV2>,
): ShardFiles<InventoryV2> {
  const issues: Issue[] = [];
  const paths: string[] = [];
  const shards: InventoryV2[] = [];
  for (const entry of entries) {
    const path = inventoryPath(entry.contributor);
    paths.push(path);
    const inventory = readJsonFile(files, path, decodeInventory);
    if (!inventory.ok) {
      issues.push(...inventory.issues);
      continue;
    }
    issues.push(...inventoryIssues(inventory.value, entry, path));
    shards.push(inventory.value);
  }
  return { shards, paths, issues };
}

function readWorldFilesV1(
  files: ReadonlyMap<string, string>,
  value: unknown,
): Decoded<WorldContentsV2> {
  const manifest = decode(WorldManifestV1, value, MANIFEST_FILE);
  if (!manifest.ok) return manifest;
  const read = readShardFiles(files, manifest.value.shards, decodeShardV1);
  const issues = [
    ...read.issues,
    ...unexpectedFiles(files, new Set([MANIFEST_FILE, ...read.paths]), NOT_PART_OF_A_WORLD),
  ];
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: migrateWorldV1({ manifest: manifest.value, shards: read.shards }) };
}

function readWorldFilesV2(
  files: ReadonlyMap<string, string>,
  value: unknown,
): Decoded<WorldContentsV2> {
  const manifest = decode(WorldManifestV2, value, MANIFEST_FILE);
  if (!manifest.ok) return manifest;
  const read = readShardFiles(files, manifest.value.shards, decodeShardV2);
  const notes = readNoteShardFiles(files, manifest.value.noteShards);
  const inventories = readInventoryFiles(files, manifest.value.inventories ?? []);
  const index = new WorldDocumentIndex(manifest.value);
  const issues = [
    ...read.issues,
    ...notes.issues,
    ...inventories.issues,
    ...read.shards.flatMap((shard) =>
      shardReferenceIssues(index, shard, shardPath(shard.superChunk)),
    ),
    ...notes.shards.flatMap((shard) =>
      noteShardReferenceIssues(index, shard, noteShardPath(shard.superChunk)),
    ),
    ...unexpectedFiles(
      files,
      new Set([MANIFEST_FILE, ...read.paths, ...notes.paths, ...inventories.paths]),
      NOT_PART_OF_A_WORLD,
    ),
  ];
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      manifest: manifest.value,
      shards: read.shards,
      notes: notes.shards,
      inventories: inventories.shards,
    },
  };
}

export function readWorldFiles(
  files: ReadonlyMap<string, string>,
): Decoded<Omit<WorldFiles, "imports">> {
  const json = manifestJson(files);
  if (!json.ok) return json;
  const version = decodeWorldSchemaVersion(json.value, MANIFEST_FILE);
  if (!version.ok) return version;
  switch (version.value) {
    case 1:
      return readWorldFilesV1(files, json.value);
    case 2:
      return readWorldFilesV2(files, json.value);
    default: {
      const unhandled: never = version.value;
      throw new Error(`unhandled world schema version ${String(unhandled)}`);
    }
  }
}
