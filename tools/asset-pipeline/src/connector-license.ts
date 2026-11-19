import {
  CONNECTIVITY_LICENSE,
  CONNECTIVITY_SOURCES,
  type ConnectorIndexFile,
  type ConnectorPackage,
  type ConnectorRecordFile,
} from "@brr/schema/bundle";
import { isCaLicense } from "./verify/license-audit.ts";

function isConnectivity(source: number): boolean {
  return CONNECTIVITY_SOURCES.includes(source);
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

function recordIssues(
  expected: ConnectorPackage,
  index: ConnectorIndexFile,
  partId: string,
  record: ConnectorRecordFile,
): string[] {
  const issues: string[] = [];
  if (record.part !== partId)
    issues.push(`the ${expected} index files ${record.part} under ${partId}`);
  if (!index.licenses.includes(record.license)) {
    issues.push(
      `${partId}'s ${expected} record is licensed ${record.license}, which its index does not declare`,
    );
  }
  const misplaced = record.faces.source.filter((source) =>
    expected === "connectivity" ? !isConnectivity(source) : isConnectivity(source),
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

export function connectorPackageIssues(
  expected: ConnectorPackage,
  index: ConnectorIndexFile,
  records: ReadonlyMap<string, ConnectorRecordFile>,
): string[] {
  const issues =
    index.package === expected ? [] : [`the ${expected} index declares package ${index.package}`];
  issues.push(...packageLicenseIssues(expected, index));
  for (const [partId, record] of records)
    issues.push(...recordIssues(expected, index, partId, record));
  return issues;
}
