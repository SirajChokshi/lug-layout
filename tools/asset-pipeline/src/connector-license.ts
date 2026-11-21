import {
  CONNECTIVITY_LICENSE,
  type ConnectorIndexFile,
  type ConnectorPackage,
  type ConnectorRecordFile,
  type SectionVocabularyFile,
} from "@brr/schema/bundle";
import { connectorRecordIssues, connectorVocabularyIssues } from "@brr/catalog/connector-license";

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
  if (expected !== "connectivity") return [];
  const issues: string[] = [];
  if (index.licenses.length !== 1 || index.licenses[0] !== CONNECTIVITY_LICENSE) {
    issues.push(
      `the connectivity package declares ${JSON.stringify(index.licenses)}, not only ${CONNECTIVITY_LICENSE}`,
    );
  }
  if (index.attribution.length === 0) issues.push("the connectivity package names no attribution");
  return issues;
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
