import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuditLock, ConnectivityLock, InputLock } from "../fetch-ldraw.ts";
import type { LdrawLibrary } from "../ldraw/library.ts";
import type { Palette } from "@brr/schema/bundle";
import { CATALOG_LAYOUTS, catalogScene } from "../track/catalog-scenes.ts";
import {
  buildTrackCatalog,
  type MeasuredCurveSource,
  type TrackCatalogReport,
} from "../track/track-catalog.ts";
import { LEVEL_CROSSING_FILE, levelCrossingData } from "../crossing/level-crossing.ts";
import { loadTrackEndMarkers } from "../track/track-ends.ts";
import { measureBaseplate } from "./geometry.ts";
import { buildGeometryReport } from "./geometry-report.ts";
import { auditGroups, closureLicenses } from "./license-audit.ts";
import { measureMagnetSeat, type MagnetModel } from "./magnet-seat.ts";
import { milsModules } from "../mils/mils-modules.ts";
import { roadBaseplateScene, singlePartScene, switchParallelScene } from "./scenes.ts";
import { ovalPassingSidingScene, r40CircleScene, trackLoopReport } from "./track-loops.ts";

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
const RECESSED_ROAD_SCENE_PLATES = ["69958", "71772"];
const BASEPLATE_ROW_PLATES = ["3811", "44336"];
const DENSE_STACK_BRICK = "3001";
const LONE_BASEPLATE = "3811";
const OFFSET_STUD_JUMPER = "3794b";
const MAGNET_HOLDER = "2920";
const MAGNET_CASING = "2959";

export interface PinnedModel extends MagnetModel {
  readonly sha256: string;
}

function pinnedFile(files: Readonly<Record<string, string>>, part: string) {
  const file = `parts/${part}.dat`;
  const sha256 = files[file];
  if (sha256 === undefined) throw new Error(`ldraw.lock.json pins no ${file}`);
  return { file, sha256 };
}

export function magnetSeatReports(
  lock: InputLock,
  connectivity: ConnectivityLock,
  library: LdrawLibrary,
  shadowLibrary: LdrawLibrary,
  models: ReadonlyArray<PinnedModel>,
): ReadonlyArray<FactReport> {
  return [
    {
      fileName: "magnet-seat.json",
      render: () =>
        asJson({
          source: lock.source,
          connectivitySource: connectivity.source,
          inputs: [
            pinnedFile(lock.files, MAGNET_HOLDER),
            pinnedFile(lock.files, MAGNET_CASING),
            { shadow: true, ...pinnedFile(connectivity.files, MAGNET_HOLDER) },
          ],
          models: models.map(({ name, sha256 }) => ({ name, sha256 })),
          ...measureMagnetSeat(library, shadowLibrary, MAGNET_HOLDER, MAGNET_CASING, models),
        }),
    },
  ];
}

export function singlePartSceneReports(bundleLibrary: LdrawLibrary): ReadonlyArray<FactReport> {
  return [
    {
      fileName: "scenes/brick-2x4.ldr",
      render: () => singlePartScene(bundleLibrary, DENSE_STACK_BRICK, "Brick 2x4"),
    },
    {
      fileName: "scenes/baseplate-3811.ldr",
      render: () => singlePartScene(bundleLibrary, LONE_BASEPLATE, "Baseplate 3811"),
    },
    {
      fileName: "scenes/jumper.ldr",
      render: () => singlePartScene(bundleLibrary, OFFSET_STUD_JUMPER, "Jumper"),
    },
  ];
}

export function geometryReports(
  source: InputLock["source"],
  library: LdrawLibrary,
  shadowLibrary: LdrawLibrary,
  topStudPrimitives: ReadonlyArray<string>,
): ReadonlyArray<FactReport> {
  const geometry = buildGeometryReport(
    { official: library, shadow: shadowLibrary },
    topStudPrimitives,
  );
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
    {
      fileName: "scenes/road-baseplates.ldr",
      render: () => roadBaseplateScene(roadPlates, "Road Baseplates"),
    },
    {
      fileName: "scenes/baseplate-row.ldr",
      render: () =>
        roadBaseplateScene(
          BASEPLATE_ROW_PLATES.map((part) => measureBaseplate(library, part)),
          "Baseplate Row",
        ),
    },
    {
      fileName: "scenes/road-plates.ldr",
      render: () =>
        roadBaseplateScene(
          RECESSED_ROAD_SCENE_PLATES.map((part) => measureBaseplate(library, part)),
          "Road Plates",
        ),
    },
    {
      fileName: "track-loops.json",
      render: () => asJson(trackLoopReport(library, loadTrackEndMarkers())),
    },
    {
      fileName: "scenes/r40-circle-9v.ldr",
      render: () => r40CircleScene(library, loadTrackEndMarkers()),
    },
    {
      fileName: "scenes/oval-passing-siding-9v.ldr",
      render: () => ovalPassingSidingScene(library, loadTrackEndMarkers()),
    },
    ...milsModules(library).map((module) => ({
      fileName: `scenes/${module.name}.ldr`,
      render: () => module.ldraw,
    })),
  ];
}

export const TRACK_CATALOG_FILE = "track-catalog.json";

export function paletteTrackCatalog(
  library: LdrawLibrary,
  palette: Palette,
  thirdParty: ReadonlyArray<MeasuredCurveSource>,
): TrackCatalogReport {
  const trackParts = palette.parts.filter((part) => part.role === "track").map((part) => part.id);
  return buildTrackCatalog(library, trackParts, loadTrackEndMarkers(), thirdParty);
}

export function trackCatalogReports(
  library: LdrawLibrary,
  catalog: TrackCatalogReport,
): ReadonlyArray<FactReport> {
  const markers = loadTrackEndMarkers();
  const scenes = CATALOG_LAYOUTS.map((layout) => ({
    layout,
    scene: catalogScene(library, markers, catalog.pieces, layout),
  }));
  return [
    {
      fileName: TRACK_CATALOG_FILE,
      render: () => asJson({ ...catalog, layouts: scenes.map(({ scene }) => scene.check) }),
    },
    ...scenes.map(({ layout, scene }) => ({
      fileName: `scenes/${layout.name}.ldr`,
      render: () => scene.ldraw,
    })),
  ];
}

export function levelCrossingReports(
  library: LdrawLibrary,
  palette: Palette,
  catalog: TrackCatalogReport,
  source: InputLock["source"],
  studPrimitives: ReadonlyArray<string>,
): ReadonlyArray<FactReport> {
  const data = levelCrossingData(library, palette, catalog.pieces, studPrimitives);
  const frame = "part frame, bundle +Y up (z = −z_LDraw), LDU";
  return [
    {
      fileName: LEVEL_CROSSING_FILE,
      render: () =>
        asJson({
          source,
          frame,
          derivation: {
            railTopLdu:
              "rail head top above the underside of the system's certified straight (measureRails)",
            ramps:
              "every palette part whose highest tilted top face rises one way along a plan axis and reaches the part's downhill side; edge heights above the underside, run along the rise",
            antiStuds:
              "stud-lattice points under the underside where a cylinder of the measured stud's radius and height is free of the part's solid and touched by it",
          },
          systems: data.systems,
          ramps: data.ramps,
        }),
    },
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
