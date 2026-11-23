import type { BrowserContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { readZip } from "@brr/storage/zip";

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04] as const;
const STUDIO_CUSTOM_PARTS = "customparts/";
const STUDIO_PART_FOLDERS = ["parts/", "p/"] as const;
const PART_FILE = ".dat";
const FILE_META = "FILE";
const utf8 = new TextDecoder();

function normalizedReference(reference: string): string {
  return reference.trim().replaceAll("\\", "/").toLowerCase();
}

function mpdFileNames(text: string): ReadonlyArray<string> {
  return text.split(/\r?\n/u).flatMap((line) => {
    const [kind, meta, ...name] = line.trim().split(/\s+/u);
    return kind === "0" && meta?.toUpperCase() === FILE_META && name.length > 0
      ? [normalizedReference(name.join(" "))]
      : [];
  });
}

function studioCustomPart(entry: string): string | null {
  const name = entry.toLowerCase();
  if (!name.startsWith(STUDIO_CUSTOM_PARTS) || !name.endsWith(PART_FILE)) return null;
  const file = name.slice(STUDIO_CUSTOM_PARTS.length);
  const folder = STUDIO_PART_FOLDERS.find((candidate) => file.startsWith(candidate));
  return folder === undefined ? file : file.slice(folder.length);
}

function isZip(bytes: Uint8Array): boolean {
  return ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

async function definedParts(bytes: Uint8Array): Promise<ReadonlyArray<string>> {
  if (!isZip(bytes)) return mpdFileNames(utf8.decode(bytes));
  const archive = await readZip(bytes);
  if (!archive.ok) return [];
  const entries = await Promise.all(
    [...archive.value].map(async ([entry, content]) => {
      const custom = studioCustomPart(entry);
      return custom === null ? definedParts(content) : [custom];
    }),
  );
  return entries.flat();
}

export class UsersOwnParts {
  private readonly names = new Set<string>();

  static of(context: BrowserContext): UsersOwnParts {
    const known = learned.get(context);
    if (known) return known;
    const parts = new UsersOwnParts();
    learned.set(context, parts);
    return parts;
  }

  async learn(file: string): Promise<void> {
    for (const name of await definedParts(new Uint8Array(await readFile(file)))) {
      this.names.add(name);
    }
  }

  has(reference: string): boolean {
    return this.names.has(normalizedReference(reference));
  }
}

const learned = new WeakMap<BrowserContext, UsersOwnParts>();
