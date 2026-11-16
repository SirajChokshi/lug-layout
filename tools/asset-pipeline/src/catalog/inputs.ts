import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { catalogSourceDirectory, type CatalogLock } from "../fetch-ldraw.ts";
import { keywords, parseLdraw } from "../ldraw/parse.ts";
import { readGzipCsv } from "./csv.ts";
import type {
  ApiColor,
  ApiPart,
  CrosswalkInputs,
  CrosswalkSourcePin,
  LdrawPartFacts,
} from "./crosswalk.ts";

const TOP_LEVEL_PART = /^parts\/([^/]+)\.dat$/iu;
const LDCONFIG = "LDConfig.ldr";

export interface PinnedLdraw {
  readonly directory: string;
  readonly files: Readonly<Record<string, string>>;
}

function sourceFile(lock: CatalogLock, catalogRoot: string, name: string, file: string): string {
  const entry = lock[name];
  if (!entry || !(file in entry.files)) {
    throw new Error(`ldraw.lock.json catalog has no ${name}/${file}; run fetch-ldraw`);
  }
  return join(catalogSourceDirectory(catalogRoot, name), file);
}

export function crosswalkSources(lock: CatalogLock): Record<string, CrosswalkSourcePin> {
  return Object.fromEntries(
    Object.entries(lock)
      .filter(([, entry]) => entry.use === "crosswalk")
      .map(([name, { source, files }]) => [
        name,
        { repo: source.repo, commit: source.commit, root: source.root, files },
      ]),
  );
}

async function ldrawPartFacts(
  pinned: ReadonlyArray<PinnedLdraw>,
): Promise<Map<string, LdrawPartFacts>> {
  const facts = new Map<string, LdrawPartFacts>();
  for (const { directory, files } of pinned) {
    for (const path of Object.keys(files)) {
      const id = TOP_LEVEL_PART.exec(path)?.[1];
      if (id === undefined || facts.has(id)) continue;
      const file = parseLdraw(await readFile(join(directory, path), "utf8"));
      facts.set(id, { title: file.header.title, keywords: keywords(file) });
    }
  }
  return facts;
}

function ldconfigColors(source: string): Array<{ code: number; name: string }> {
  return source.split(/\r?\n/u).flatMap((line) => {
    const tokens = line.trim().split(/\s+/u);
    if (tokens[0] !== "0" || tokens[1] !== "!COLOUR") return [];
    const name = tokens[2];
    const code = Number(tokens[tokens.indexOf("CODE") + 1]);
    return name !== undefined && Number.isInteger(code) ? [{ code, name }] : [];
  });
}

export async function readCrosswalkInputs(
  lock: CatalogLock,
  catalogRoot: string,
  ldraw: PinnedLdraw,
  audit: PinnedLdraw | undefined,
): Promise<CrosswalkInputs> {
  const apiParts = JSON.parse(
    await readFile(sourceFile(lock, catalogRoot, "rebrickable-parts-api", "partList.json"), "utf8"),
  ) as ReadonlyArray<ApiPart>;
  const apiColors = (
    JSON.parse(
      await readFile(
        sourceFile(lock, catalogRoot, "rebrickable-colors-api", "colors.json"),
        "utf8",
      ),
    ) as { readonly results: ReadonlyArray<ApiColor> }
  ).results;
  const parts = await readGzipCsv(
    sourceFile(lock, catalogRoot, "rebrickable-dump", "parts.csv.gz"),
  );
  const elements = await readGzipCsv(
    sourceFile(lock, catalogRoot, "rebrickable-dump", "elements.csv.gz"),
  );
  const elementCounts = new Map<string, number>();
  for (const element of elements) {
    const part = element["part_num"] ?? "";
    elementCounts.set(part, (elementCounts.get(part) ?? 0) + 1);
  }
  return {
    apiParts,
    apiColors,
    rebrickableParts: new Set(parts.map((part) => part["part_num"] ?? "")),
    elementCounts,
    ldrawParts: await ldrawPartFacts(audit ? [ldraw, audit] : [ldraw]),
    ldrawColors: ldconfigColors(await readFile(join(ldraw.directory, LDCONFIG), "utf8")),
  };
}
