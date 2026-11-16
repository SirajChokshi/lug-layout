import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuditLock, InputLock } from "../fetch-ldraw.ts";
import type { LdrawLibrary } from "../ldraw/library.ts";
import type { Palette } from "../palette.ts";
import { loadTrackEndMarkers } from "../track/track-ends.ts";
import { buildGeometryReport } from "./geometry-report.ts";
import { auditGroups, closureLicenses } from "./license-audit.ts";
import { roadBaseplateScene, switchParallelScene } from "./scenes.ts";

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

function asJson(value: unknown): string {
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

const ROAD_SCENE_PLATES = ["44336", "2358", "610", "606", "30225b"];

export function geometryReports(
  source: InputLock["source"],
  library: LdrawLibrary,
  shadowLibrary: LdrawLibrary,
): ReadonlyArray<FactReport> {
  const geometry = buildGeometryReport({ official: library, shadow: shadowLibrary });
  const roadPlates = ROAD_SCENE_PLATES.map((part) => {
    const plate = geometry.baseplates.find((measured) => measured.part === part);
    if (plate === undefined) throw new Error(`road scene plate ${part} was not measured`);
    return plate;
  });
  return [
    { fileName: "geometry.json", render: () => asJson({ source, ...geometry }) },
    {
      fileName: "scenes/switch-then-reversed-curve.ldr",
      render: () => switchParallelScene(library, loadTrackEndMarkers()),
    },
    { fileName: "scenes/road-baseplates.ldr", render: () => roadBaseplateScene(roadPlates) },
  ];
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
