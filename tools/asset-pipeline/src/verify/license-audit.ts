import { dependencyClosure } from "../ldraw/walk.ts";
import type { LdrawLibrary } from "../ldraw/library.ts";
import {
  isStudPrimitive,
  keywords,
  LDCAD_META,
  metaValues,
  parseLdraw,
  type LdrawFile,
} from "../ldraw/parse.ts";
import type { AuditGroup } from "../palette.ts";

export const CA_LICENSE_LINES: ReadonlyArray<string> = [
  "Licensed under CC BY 4.0 : see CAreadme.txt",
  "Licensed under CC BY 2.0 and CC BY 4.0 : see CAreadme.txt",
  "Redistributable under CCAL version 2.0 : see CAreadme.txt",
];

const UNOFFICIAL_PREFIX = "Unofficial_";
const MOVED_PREFIX = "~Moved to ";
const SNAP_PREFIX = "SNAP_";
const TRAIN_TRACK_SNAP_GROUP = "[group=traintrk]";

export type PartStatus = "officialCA" | "notShippable" | "absent";

export interface HeaderSnapshot {
  readonly title: string;
  readonly author: string;
  readonly ldrawOrg: string;
  readonly license: string;
  readonly keywords: ReadonlyArray<string>;
  readonly movedTo: string | null;
}

export interface LdcadCoverage {
  readonly patchedFiles: ReadonlyArray<string>;
  readonly trainTrackSnapLines: number;
  readonly studPrimitiveOnly: boolean;
}

export interface PartAudit {
  readonly id: string;
  readonly group: string;
  readonly status: PartStatus;
  readonly header: HeaderSnapshot | null;
  readonly dependencyFiles: number | null;
  readonly missingDependencies: ReadonlyArray<string>;
  readonly unofficialDependencies: ReadonlyArray<string>;
  readonly ldcad: LdcadCoverage | null;
}

export interface ClosureLicenses {
  readonly files: number;
  readonly licenses: Readonly<Record<string, number>>;
  readonly withoutLicense: ReadonlyArray<string>;
  readonly nonCaLicense: ReadonlyArray<string>;
  readonly unofficial: ReadonlyArray<string>;
}

export function isCaLicense(license: string): boolean {
  return CA_LICENSE_LINES.includes(license);
}

function isUnofficial(file: LdrawFile): boolean {
  return file.header.ldrawOrg.startsWith(UNOFFICIAL_PREFIX);
}

function snapshot(file: LdrawFile): HeaderSnapshot {
  const { title, author, ldrawOrg, license } = file.header;
  return {
    title,
    author,
    ldrawOrg,
    license,
    keywords: keywords(file),
    movedTo: title.startsWith(MOVED_PREFIX) ? title.slice(MOVED_PREFIX.length).trim() : null,
  };
}

function snapLines(file: LdrawFile | undefined): ReadonlyArray<string> {
  if (file === undefined) return [];
  return metaValues(file, LDCAD_META).filter((value) => value.startsWith(SNAP_PREFIX));
}

function ldcadCoverage(shadow: LdrawLibrary, files: ReadonlySet<string>): LdcadCoverage {
  const patchedFiles = [...files]
    .toSorted()
    .filter((name) => snapLines(shadow.load(name)).length > 0);
  return {
    patchedFiles,
    trainTrackSnapLines: patchedFiles
      .flatMap((name) => snapLines(shadow.load(name)))
      .filter((line) => line.includes(TRAIN_TRACK_SNAP_GROUP)).length,
    studPrimitiveOnly: patchedFiles.every((name) => isStudPrimitive(name)),
  };
}

export function auditPart(
  library: LdrawLibrary,
  shadow: LdrawLibrary,
  group: string,
  id: string,
): PartAudit {
  const file = library.load(`${id}.dat`);
  if (file === undefined) {
    return {
      id,
      group,
      status: "absent",
      header: null,
      dependencyFiles: null,
      missingDependencies: [],
      unofficialDependencies: [],
      ldcad: null,
    };
  }
  const closure = dependencyClosure(library, `${id}.dat`);
  const loaded = [...closure.visitedFiles].map((name) => ({ name, file: library.load(name) }));
  const missingDependencies = [...closure.missingFiles].toSorted();
  const unofficialDependencies = loaded
    .filter(({ file: dependency }) => dependency !== undefined && isUnofficial(dependency))
    .map(({ name }) => name)
    .toSorted();
  const allCa = loaded.every(({ file: dependency }) =>
    isCaLicense(dependency?.header.license ?? ""),
  );
  const shippable =
    allCa && missingDependencies.length === 0 && unofficialDependencies.length === 0;
  return {
    id,
    group,
    status: shippable ? "officialCA" : "notShippable",
    header: snapshot(file),
    dependencyFiles: closure.visitedFiles.size,
    missingDependencies,
    unofficialDependencies,
    ldcad: ldcadCoverage(shadow, closure.visitedFiles),
  };
}

export function auditGroups(
  library: LdrawLibrary,
  shadow: LdrawLibrary,
  groups: ReadonlyArray<AuditGroup>,
): ReadonlyArray<PartAudit> {
  return groups.flatMap(({ group, parts }) =>
    parts.map((id) => auditPart(library, shadow, group, id)),
  );
}

export function closureLicenses(sources: ReadonlyMap<string, string>): ClosureLicenses {
  const counts = new Map<string, number>();
  const withoutLicense: string[] = [];
  const nonCaLicense: string[] = [];
  const unofficial: string[] = [];
  let files = 0;
  for (const [path, text] of sources) {
    if (!path.endsWith(".dat")) continue;
    files += 1;
    const file = parseLdraw(text);
    const { license } = file.header;
    if (license === "") withoutLicense.push(path);
    else {
      counts.set(license, (counts.get(license) ?? 0) + 1);
      if (!isCaLicense(license)) nonCaLicense.push(path);
    }
    if (isUnofficial(file)) unofficial.push(path);
  }
  return {
    files,
    licenses: Object.fromEntries([...counts].toSorted(([a], [b]) => a.localeCompare(b))),
    withoutLicense,
    nonCaLicense,
    unofficial,
  };
}
