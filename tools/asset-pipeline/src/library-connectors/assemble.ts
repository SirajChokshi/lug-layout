import {
  CONNECTIVITY_LICENSE,
  ConnectorRecordFile,
  LIBRARY_CONNECTORS_FORMAT,
  LIBRARY_CONNECTORS_INDEX_FILE,
  LibraryConnectorsIndex,
  type BundleSource,
  type ConnectorIndexFile,
  type ConnectorPackage,
  type GithubArchive,
  type GithubMirror,
  type LibraryConnectorsPin,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { connectorPackageIssues } from "../connector-license.ts";
import { contentAddressedName } from "../publish.ts";
import { isCaLicense } from "../verify/license-audit.ts";

export const LIBRARY_CONNECTORS_PIN = "tools/asset-pipeline/library-connectors.json";
const SHADOW_AUTHORS = "Roland Melkert and the LDCad Shadow Library contributors";
const PATCH_ATTRIBUTION =
  "Brick Railroad shadow patches (tools/asset-pipeline/shadow-patches), CC BY-SA 4.0";
const PACKAGES: ReadonlyArray<ConnectorPackage> = ["connectivity", "connectors"];
const INDEX_FILES: Readonly<Record<ConnectorPackage, string>> = {
  connectivity: "connectivity-index.json",
  connectors: "connector-index.json",
};
const LISTING = /^parts-\d+-of-\d+\.jsonl$/u;

const PartListing = v.object({
  part: v.string(),
  path: v.string(),
  license: v.string(),
  connectivity: v.nullable(v.string()),
  connectors: v.nullable(v.string()),
});
type PartListing = v.InferOutput<typeof PartListing>;

export interface LibraryConnectorsInputs {
  readonly build: string;
  readonly out: string;
  readonly ldraw: GithubMirror;
  readonly shadow: GithubArchive;
  readonly sectionVocabulary: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function shadowLibraryAttribution(shadow: GithubArchive): string {
  return `LDCad Shadow Library by ${SHADOW_AUTHORS}, github.com/${shadow.repo} at ${shadow.commit}, ${CONNECTIVITY_LICENSE}`;
}

async function listings(build: string): Promise<PartListing[]> {
  const files = (await readdir(build)).filter((name) => LISTING.test(name)).toSorted();
  if (files.length === 0) throw new Error(`${build} has no part listings`);
  const parts: PartListing[] = [];
  for (const file of files) {
    for (const line of (await readFile(join(build, file), "utf8")).split("\n")) {
      if (line === "") continue;
      parts.push(decodedOrThrow(decode(PartListing, JSON.parse(line)), file));
    }
  }
  return parts.toSorted((a, b) => a.part.localeCompare(b.part));
}

async function writeAddressed(out: string, file: string, value: unknown): Promise<string> {
  const text = JSON.stringify(value);
  const name = contentAddressedName(file, sha256(text));
  await writeFile(join(out, name), text);
  return name;
}

export async function assembleLibraryConnectors(
  inputs: LibraryConnectorsInputs,
): Promise<LibraryConnectorsPin> {
  const { build, out, ldraw, shadow, sectionVocabulary } = inputs;
  await rm(out, { recursive: true, force: true });
  for (const pkg of PACKAGES) await mkdir(join(out, pkg), { recursive: true });
  const parts = await listings(build);
  const refused: Array<{ part: string; license: string }> = [];
  const entries: Record<ConnectorPackage, Record<string, { file: string } | null>> = {
    connectivity: {},
    connectors: {},
  };
  const records: Record<ConnectorPackage, Map<string, ConnectorRecordFile>> = {
    connectivity: new Map(),
    connectors: new Map(),
  };
  const faces: Record<ConnectorPackage, number> = { connectivity: 0, connectors: 0 };
  const partLicenses = new Set<string>();
  let partsWithPieces = 0;
  for (const listing of parts) {
    if (!isCaLicense(listing.license)) {
      refused.push({ part: listing.part, license: listing.license });
      continue;
    }
    let pieced = false;
    for (const pkg of PACKAGES) {
      const file = listing[pkg];
      if (file === null) {
        entries[pkg][listing.part] = null;
        continue;
      }
      const raw: unknown = JSON.parse(await readFile(join(build, file), "utf8"));
      const written =
        pkg === "connectors" && typeof raw === "object" ? { ...raw, sectionVocabulary } : raw;
      const record = decodedOrThrow(decode(ConnectorRecordFile, written), file);
      if (pkg === "connectors") partLicenses.add(record.license);
      entries[pkg][listing.part] = { file: await writeAddressed(out, file, written) };
      records[pkg].set(listing.part, record);
      faces[pkg] += record.faces.gender.length;
      pieced ||= record.faces.piece.some((piece) => piece > 0);
    }
    if (pieced) partsWithPieces++;
  }
  const shadowSource: BundleSource = {
    kind: "github-mirror",
    repo: shadow.repo,
    commit: shadow.commit,
    root: shadow.root,
  };
  const indexes: Record<ConnectorPackage, ConnectorIndexFile> = {
    connectivity: {
      package: "connectivity",
      licenses: [CONNECTIVITY_LICENSE],
      attribution: [shadowLibraryAttribution(shadow), PATCH_ATTRIBUTION],
      source: shadowSource,
      parts: entries.connectivity,
    },
    connectors: {
      package: "connectors",
      licenses: [...partLicenses].toSorted(),
      attribution: [],
      sectionVocabulary,
      source: ldraw,
      parts: entries.connectors,
    },
  };
  const issues = PACKAGES.flatMap((pkg) =>
    connectorPackageIssues(pkg, indexes[pkg], records[pkg], sectionVocabulary),
  );
  if (issues.length > 0) throw new Error(`library connector records: ${issues.join("; ")}`);
  const index = decodedOrThrow(
    decode(LibraryConnectorsIndex, {
      format: LIBRARY_CONNECTORS_FORMAT,
      ldraw,
      shadow,
      sectionVocabulary,
      connectivity: {
        file: await writeAddressed(out, INDEX_FILES.connectivity, indexes.connectivity),
      },
      connectors: { file: await writeAddressed(out, INDEX_FILES.connectors, indexes.connectors) },
    }),
    LIBRARY_CONNECTORS_INDEX_FILE,
  );
  const text = `${JSON.stringify(index, null, 2)}\n`;
  await writeFile(join(out, LIBRARY_CONNECTORS_INDEX_FILE), text);
  await writeFile(
    join(out, contentAddressedName(LIBRARY_CONNECTORS_INDEX_FILE, sha256(text))),
    text,
  );
  return {
    index: { file: LIBRARY_CONNECTORS_INDEX_FILE, sha256: sha256(text) },
    parts: parts.length,
    refused,
    records: {
      connectivity: records.connectivity.size,
      connectors: records.connectors.size,
    },
    faces,
    partsWithPieces,
  };
}
