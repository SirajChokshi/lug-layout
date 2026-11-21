import {
  CONNECTIVITY_LICENSE,
  CONNECTIVITY_SOURCES,
  type ConnectorPackage,
  type ConnectorRecordFile,
} from "@brr/schema/bundle";

function isConnectivitySource(source: number): boolean {
  return CONNECTIVITY_SOURCES.includes(source);
}

export function connectorVocabularyIssues(
  expected: ConnectorPackage,
  label: string,
  found: string | undefined,
  sectionVocabulary: string | null,
): string[] {
  if (expected === "connectivity") {
    return found === undefined
      ? []
      : [`${label} names a section vocabulary, but tier 1 is not inferred`];
  }
  if (sectionVocabulary === null || found === sectionVocabulary) return [];
  return [
    `${label} was inferred with section vocabulary ${found ?? "(none)"}, not the manifest's ${sectionVocabulary}`,
  ];
}

export function connectorRecordIssues(
  expected: ConnectorPackage,
  licenses: ReadonlyArray<string>,
  partId: string,
  record: ConnectorRecordFile,
  sectionVocabulary: string | null,
): string[] {
  const issues = connectorVocabularyIssues(
    expected,
    `${partId}'s ${expected} record`,
    record.sectionVocabulary,
    sectionVocabulary,
  );
  if (record.part !== partId)
    issues.push(`the ${expected} index files ${record.part} under ${partId}`);
  if (!licenses.includes(record.license)) {
    issues.push(
      `${partId}'s ${expected} record is licensed ${record.license}, which its index does not declare`,
    );
  }
  const misplaced = record.faces.source.filter((source) =>
    expected === "connectivity" ? !isConnectivitySource(source) : isConnectivitySource(source),
  ).length;
  if (misplaced > 0) {
    issues.push(
      expected === "connectivity"
        ? `${partId}'s connectivity record carries ${misplaced} faces from outside tier 1`
        : `${partId}'s connector record carries ${misplaced} tier 1 faces, which belong only in the ${CONNECTIVITY_LICENSE} connectivity package`,
    );
  }
  return issues;
}
