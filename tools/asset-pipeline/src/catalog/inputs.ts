import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { catalogSourceDirectory, type CatalogLock } from "../fetch-ldraw.ts";
import { normalizeReference } from "../ldraw/parse.ts";
import { readGzipCsv } from "./csv.ts";
import { readTarGz } from "./tar.ts";
import type {
  ApiColor,
  ApiPart,
  CrosswalkInputs,
  CrosswalkSourcePin,
  LdrawComponent,
  LdrawPartFacts,
} from "./crosswalk.ts";

const LDCONFIG = "LDConfig.ldr";
const LDRAW_ARCHIVE_SOURCE = "ldraw-library";
const SUBFILE_REFERENCE_TOKEN = 14;
const PART_REFERENCE = /^([^/]+)\.dat$/u;

export interface LdrawPin {
  readonly repo: string;
  readonly commit: string;
  readonly root: string;
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

interface ScannedPart {
  readonly title: string;
  readonly keywords: ReadonlyArray<string>;
  readonly ldrawOrg: string;
  readonly references: ReadonlyArray<LdrawComponent>;
}

function scanPart(text: string): ScannedPart {
  let title: string | undefined;
  let ldrawOrg = "";
  const keywords: string[] = [];
  const references: LdrawComponent[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "") continue;
    const tokens = line.split(/\s+/u);
    if (tokens[0] === "0") {
      if (title === undefined) title = tokens.slice(1).join(" ");
      else if (tokens[1] === "!LDRAW_ORG") ldrawOrg = tokens.slice(2).join(" ");
      else if (tokens[1] === "!KEYWORDS") {
        keywords.push(
          ...tokens
            .slice(2)
            .join(" ")
            .split(",")
            .map((keyword) => keyword.trim())
            .filter((keyword) => keyword !== ""),
        );
      }
    } else if (tokens[0] === "1" && tokens.length > SUBFILE_REFERENCE_TOKEN) {
      const reference = normalizeReference(tokens.slice(SUBFILE_REFERENCE_TOKEN).join(" "));
      const id = PART_REFERENCE.exec(reference)?.[1];
      if (id !== undefined) references.push({ id, color: Number(tokens[1]) });
    }
  }
  return { title: title ?? "", keywords, ldrawOrg, references };
}

async function ldrawPartFacts(
  archive: string,
  pin: LdrawPin,
): Promise<Map<string, LdrawPartFacts>> {
  const topLevelPart = new RegExp(`^[^/]+/${pin.root}/parts/([^/]+)\\.dat$`, "u");
  const scanned = new Map<string, ScannedPart>();
  await readTarGz(
    archive,
    (path) => topLevelPart.test(path),
    (path, bytes) => {
      const id = topLevelPart.exec(path)?.[1];
      if (id !== undefined) scanned.set(id.toLowerCase(), scanPart(bytes.toString("utf8")));
    },
  );
  return new Map(
    [...scanned].map(([id, part]) => [
      id,
      {
        title: part.title,
        keywords: part.keywords,
        ldrawOrg: part.ldrawOrg,
        components: part.references.filter((reference) => scanned.has(reference.id)),
      },
    ]),
  );
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
  pin: LdrawPin,
  ldrawDirectory: string,
): Promise<CrosswalkInputs> {
  const archive = lock[LDRAW_ARCHIVE_SOURCE];
  if (archive?.source.repo !== pin.repo || archive.source.commit !== pin.commit) {
    throw new Error(
      `catalog ${LDRAW_ARCHIVE_SOURCE} must be the LDraw pin ${pin.repo}@${pin.commit}`,
    );
  }
  const [archiveFile] = Object.keys(archive.files);
  if (archiveFile === undefined) throw new Error(`catalog ${LDRAW_ARCHIVE_SOURCE} pins no file`);
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
  return {
    apiParts,
    apiColors,
    rebrickableParts: new Set(parts.map((part) => part["part_num"] ?? "")),
    ldrawParts: await ldrawPartFacts(
      sourceFile(lock, catalogRoot, LDRAW_ARCHIVE_SOURCE, archiveFile),
      pin,
    ),
    ldrawColors: ldconfigColors(await readFile(join(ldrawDirectory, LDCONFIG), "utf8")),
  };
}
