import {
  CONNECTIVITY_LICENSE,
  SECTION_SHAPE_CODES,
  type ConnectorIndexFile,
  type ConnectorPackage,
  type ConnectorRecordFile,
  type SectionVocabularyFile,
} from "@brr/schema/bundle";
import { connectorRecordIssues, connectorVocabularyIssues } from "@brr/catalog/connector-license";
import { isCaLicense } from "./verify/license-audit.ts";

const SECTION_SHAPES: ReadonlySet<unknown> = new Set(SECTION_SHAPE_CODES);
const SECTION_GENDERS: ReadonlySet<unknown> = new Set(["M", "F"]);
const SIZE_ENTRY_KEYS = ["gender", "shape", "size"] as const;
const LENGTH_ENTRY_KEYS = ["shape", "length"] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactly(
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlyArray<string>,
): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isSectionVocabularyEntry(value: Readonly<Record<string, unknown>>): boolean {
  if (hasExactly(value, SIZE_ENTRY_KEYS)) {
    return (
      SECTION_GENDERS.has(value["gender"]) &&
      SECTION_SHAPES.has(value["shape"]) &&
      typeof value["size"] === "number"
    );
  }
  return (
    hasExactly(value, LENGTH_ENTRY_KEYS) &&
    SECTION_SHAPES.has(value["shape"]) &&
    typeof value["length"] === "number"
  );
}

function collectVocabularyEntries(raw: unknown, path: string, found: string[]): void {
  if (Array.isArray(raw)) {
    raw.forEach((item: unknown, index) => {
      if (typeof item === "object" && item !== null) {
        collectVocabularyEntries(item, `${path}[${index}]`, found);
      }
    });
    return;
  }
  if (!isRecord(raw)) return;
  if (isSectionVocabularyEntry(raw)) {
    found.push(path);
    return;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "object" && value !== null) {
      collectVocabularyEntries(value, `${path}.${key}`, found);
    }
  }
}

export function sectionVocabularyValues(raw: unknown): ReadonlyArray<string> {
  const found: string[] = [];
  collectVocabularyEntries(raw, "$", found);
  return found;
}

export function sectionVocabularyIssues(
  vocabulary: SectionVocabularyFile,
  connectivity: ConnectorIndexFile,
): string[] {
  const issues: string[] = [];
  if (vocabulary.license !== CONNECTIVITY_LICENSE) {
    issues.push(
      `the section vocabulary is licensed ${vocabulary.license}, not ${CONNECTIVITY_LICENSE}`,
    );
  }
  if (vocabulary.attribution.length === 0)
    issues.push("the section vocabulary names no attribution");
  const derivedFrom = `${vocabulary.source.repo}@${vocabulary.source.commit}`;
  const shadow = `${connectivity.source.repo}@${connectivity.source.commit}`;
  if (derivedFrom !== shadow) {
    issues.push(
      `the section vocabulary is derived from ${derivedFrom}, but the connectivity package from ${shadow}`,
    );
  }
  return issues;
}

function packageLicenseIssues(expected: ConnectorPackage, index: ConnectorIndexFile): string[] {
  if (expected === "connectivity") {
    const issues: string[] = [];
    if (index.licenses.length !== 1 || index.licenses[0] !== CONNECTIVITY_LICENSE) {
      issues.push(
        `the connectivity package declares ${JSON.stringify(index.licenses)}, not only ${CONNECTIVITY_LICENSE}`,
      );
    }
    if (index.attribution.length === 0)
      issues.push("the connectivity package names no attribution");
    return issues;
  }
  return index.licenses
    .filter((license) => !isCaLicense(license))
    .map(
      (license) => `the connectors package declares ${license}, which is not an LDraw CA licence`,
    );
}

export function connectorPackageIssues(
  expected: ConnectorPackage,
  index: ConnectorIndexFile,
  records: ReadonlyMap<string, ConnectorRecordFile>,
  sectionVocabulary: string | null,
): string[] {
  const issues =
    index.package === expected ? [] : [`the ${expected} index declares package ${index.package}`];
  issues.push(...packageLicenseIssues(expected, index));
  issues.push(
    ...connectorVocabularyIssues(
      expected,
      `the ${expected} index`,
      index.sectionVocabulary,
      sectionVocabulary,
    ),
  );
  for (const [partId, record] of records)
    issues.push(
      ...connectorRecordIssues(expected, index.licenses, partId, record, sectionVocabulary),
    );
  return issues;
}
