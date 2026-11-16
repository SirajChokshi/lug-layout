import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuditLock, InputLock } from "../fetch-ldraw.ts";
import type { LdrawLibrary } from "../ldraw/library.ts";
import type { Palette } from "../palette.ts";
import { auditGroups, closureLicenses } from "./license-audit.ts";

export interface FactReport {
  readonly fileName: string;
  readonly render: () => string;
}

export interface LicenseAuditInputs {
  readonly lock: InputLock;
  readonly audit: AuditLock;
  readonly palette: Palette;
  readonly bundleSources: ReadonlyMap<string, string>;
  readonly auditSources: ReadonlyMap<string, string>;
  readonly shadowSources: ReadonlyMap<string, string>;
  readonly auditLibrary: LdrawLibrary;
  readonly shadowLibrary: LdrawLibrary;
}

const SHADOW_LICENSE_FILE = "LICENSE.md";

function bigintAsString(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function asJson(value: unknown): string {
  return `${JSON.stringify(value, bigintAsString, 2)}\n`;
}

export function licenseAuditReport(inputs: LicenseAuditInputs): FactReport {
  return {
    fileName: "license-audit.json",
    render: () =>
      asJson({
        source: inputs.lock.source,
        connectivitySource: inputs.audit.connectivity.source,
        bundleClosure: closureLicenses(inputs.bundleSources),
        auditClosure: closureLicenses(inputs.auditSources),
        absentFromPin: inputs.audit.absentParts,
        ldcadShadow: {
          licenseFileFirstLine:
            inputs.shadowSources.get(SHADOW_LICENSE_FILE)?.split("\n")[0] ?? null,
          patchFileLicenses: closureLicenses(inputs.shadowSources).licenses,
        },
        parts: auditGroups(inputs.auditLibrary, inputs.shadowLibrary, inputs.palette.audit),
      }),
  };
}

export async function readSources(
  directory: string,
  files: Readonly<Record<string, string>>,
): Promise<ReadonlyMap<string, string>> {
  const sources = new Map<string, string>();
  for (const path of Object.keys(files))
    sources.set(path, await readFile(join(directory, path), "utf8"));
  return sources;
}

export async function writeReports(
  reports: ReadonlyArray<FactReport>,
  directory: string,
  check: boolean,
): Promise<boolean> {
  let drifted = false;
  for (const report of reports) {
    const path = join(directory, report.fileName);
    const text = report.render();
    if (check) {
      const committed = await readFile(path, "utf8").catch(() => "");
      const same = committed === text;
      drifted ||= !same;
      process.stdout.write(`${report.fileName}: ${same ? "matches" : "DRIFT"}\n`);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
      process.stdout.write(`${report.fileName}: written\n`);
    }
  }
  return drifted;
}
