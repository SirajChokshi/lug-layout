import {
  CONNECTIVITY_LICENSE,
  SectionVocabulary,
  SectionVocabularyFile,
  type CatalogSourceUse,
  type GithubArchive,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { readTarGz } from "./catalog/tar.ts";
import type { CatalogLock } from "./fetch-ldraw.ts";

export const CONNECTOR_SOURCE_USE: CatalogSourceUse = "connectors";
const SHADOW_EXTENSION = ".dat";
const SHADOW_AUTHORS = "Roland Melkert and the LDCad Shadow Library contributors";

export interface PinnedShadowArchive {
  readonly name: string;
  readonly file: string;
  readonly sha256: string;
  readonly source: GithubArchive;
}

export function pinnedShadowArchive(catalog: CatalogLock): PinnedShadowArchive {
  const archives = Object.entries(catalog).flatMap(([name, entry]) => {
    const { source } = entry;
    if (entry.use !== CONNECTOR_SOURCE_USE || source.kind !== "github-archive") return [];
    return Object.entries(entry.files).map(([file, sha256]) => ({ name, file, sha256, source }));
  });
  const [archive, ...others] = archives;
  if (archive === undefined || others.length > 0) {
    throw new Error(
      `ldraw.lock.json must pin exactly one ${CONNECTOR_SOURCE_USE} archive; it pins ${archives.length}. Run fetch-ldraw`,
    );
  }
  return archive;
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function repositoryPath(entryPath: string): string | undefined {
  const slash = entryPath.indexOf("/");
  return slash < 0 ? undefined : entryPath.slice(slash + 1);
}

export async function extractShadowArchive(
  archivePath: string,
  sha256: string,
  directory: string,
): Promise<number> {
  const actual = await fileSha256(archivePath);
  if (actual !== sha256) {
    throw new Error(`${archivePath} has SHA-256 ${actual}, ldraw.lock.json pins ${sha256}`);
  }
  await rm(directory, { recursive: true, force: true });
  let files = 0;
  await readTarGz(
    archivePath,
    (entryPath) => extname(entryPath).toLowerCase() === SHADOW_EXTENSION,
    (entryPath, bytes) => {
      const path = repositoryPath(entryPath);
      if (path === undefined) return;
      const target = join(directory, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      files++;
    },
  );
  if (files === 0) throw new Error(`${archivePath} holds no shadow files`);
  return files;
}

export function shadowVocabularyAttribution(source: GithubArchive): string {
  return `Section sizes and lengths derived from the LDCad Shadow Library by ${SHADOW_AUTHORS}, github.com/${source.repo} at ${source.commit}, ${CONNECTIVITY_LICENSE}`;
}

export function sectionVocabularyFile(
  archive: PinnedShadowArchive,
  derived: unknown,
): SectionVocabularyFile {
  const vocabulary = decodedOrThrow(decode(SectionVocabulary, derived), "derived vocabulary");
  return decodedOrThrow(
    decode(SectionVocabularyFile, {
      source: archive.source,
      archive: { file: archive.file, sha256: archive.sha256 },
      license: CONNECTIVITY_LICENSE,
      attribution: [shadowVocabularyAttribution(archive.source)],
      ...vocabulary,
    }),
    "section vocabulary",
  );
}
