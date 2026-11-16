import {
  placementId,
  type BuildablePlacement,
  type BuildableReport,
  type BuildableSettings,
} from "./buildable.ts";
import type { PlacementKey } from "./plan-rules.ts";
import type { ModuleProfileId } from "./item-spec.ts";
import {
  regionOriginX,
  regionOriginZ,
  type MmRect,
  type PlanFootprint,
  type PlanRegion,
} from "./plan-region.ts";

export const PLAN_ARCHIVE_FORMAT = "brrplan";
export const PLAN_ARCHIVE_VERSION = 1;

export interface ArchivedPlacement {
  readonly ref: string;
  readonly x: number;
  readonly z: number;
  readonly rot: number;
}

export interface ArchivedModel {
  readonly ref: string;
  readonly source: string;
  readonly authors: ReadonlyArray<string>;
  readonly licenses: ReadonlyArray<string>;
}

export interface PlanArchiveManifest {
  readonly format: typeof PLAN_ARCHIVE_FORMAT;
  readonly version: typeof PLAN_ARCHIVE_VERSION;
  readonly bundleVersion: string;
  readonly plan: {
    readonly name: string;
    readonly originChunkX: number;
    readonly originChunkZ: number;
    readonly maxOverhangMm: number;
    readonly footprint: PlanFootprint;
  };
  readonly settings: BuildableSettings;
  readonly placements: ReadonlyArray<ArchivedPlacement>;
  readonly models: ReadonlyArray<ArchivedModel>;
  readonly verdict: {
    readonly verdict: BuildableReport["verdict"];
    readonly errors: number;
    readonly warnings: number;
    readonly totalParts: number;
  };
  readonly files: ReadonlyArray<string>;
  readonly disclaimer: string;
}

export interface PlanArchiveInput {
  readonly bundleVersion: string;
  readonly region: PlanRegion;
  readonly settings: BuildableSettings;
  readonly placements: ReadonlyArray<BuildablePlacement>;
  readonly inside: ReadonlyArray<PlacementKey>;
  readonly models: ReadonlyArray<ArchivedModel>;
  readonly report: BuildableReport;
  readonly files: ReadonlyArray<string>;
  readonly disclaimer: string;
}

export function planArchiveManifest(input: PlanArchiveInput): PlanArchiveManifest {
  const { region } = input;
  const inside = new Set(input.inside.map(placementId));
  const placements = input.placements
    .filter((placement) => inside.has(placementId(placement.key)))
    .map((placement) => ({
      ref: placement.ref,
      x: placement.x - regionOriginX(region),
      z: placement.z - regionOriginZ(region),
      rot: placement.rot,
    }));
  const refs = new Set(placements.map((placement) => placement.ref));
  return {
    format: PLAN_ARCHIVE_FORMAT,
    version: PLAN_ARCHIVE_VERSION,
    bundleVersion: input.bundleVersion,
    plan: {
      name: region.name,
      originChunkX: region.originChunkX,
      originChunkZ: region.originChunkZ,
      maxOverhangMm: region.maxOverhangMm,
      footprint: {
        roomWidthMm: region.footprint.roomWidthMm,
        roomDepthMm: region.footprint.roomDepthMm,
        tables: region.footprint.tables.map((table) => ({
          id: table.id,
          name: table.name,
          rect: table.rect,
          heightMm: table.heightMm,
        })),
        obstacles: region.footprint.obstacles.map((obstacle) => ({
          id: obstacle.id,
          name: obstacle.name,
          rect: obstacle.rect,
        })),
      },
    },
    settings: { profile: input.settings.profile, maxReachMm: input.settings.maxReachMm },
    placements,
    models: input.models.filter((model) => refs.has(model.ref)),
    verdict: {
      verdict: input.report.verdict,
      errors: input.report.errors,
      warnings: input.report.warnings,
      totalParts: input.report.bom.totalParts,
    },
    files: input.files,
    disclaimer: input.disclaimer,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isMmRect(value: unknown): value is MmRect {
  return (
    isRecord(value) &&
    isInt(value["x"]) &&
    isInt(value["z"]) &&
    isInt(value["width"]) &&
    isInt(value["depth"])
  );
}

const PROFILES: ReadonlyArray<ModuleProfileId> = ["free", "lego-modular", "mils"];

function isPlacement(value: unknown): value is ArchivedPlacement {
  return (
    isRecord(value) &&
    typeof value["ref"] === "string" &&
    isInt(value["x"]) &&
    isInt(value["z"]) &&
    isInt(value["rot"]) &&
    value["rot"] >= 0 &&
    value["rot"] <= 3
  );
}

export function parsePlanArchiveManifest(value: unknown): PlanArchiveManifest | string {
  if (!isRecord(value) || value["format"] !== PLAN_ARCHIVE_FORMAT) {
    return "manifest.json is not a Brick Railroad plan";
  }
  if (value["version"] !== PLAN_ARCHIVE_VERSION) {
    return `plan archive version ${String(value["version"])} is not version ${PLAN_ARCHIVE_VERSION}`;
  }
  const plan = value["plan"];
  const settings = value["settings"];
  if (
    !isRecord(plan) ||
    typeof plan["name"] !== "string" ||
    !isInt(plan["originChunkX"]) ||
    !isInt(plan["originChunkZ"]) ||
    !isInt(plan["maxOverhangMm"]) ||
    !isRecord(plan["footprint"])
  ) {
    return "manifest.json has no plan footprint";
  }
  const footprint = plan["footprint"];
  const tables = footprint["tables"];
  const obstacles = footprint["obstacles"];
  if (
    !isInt(footprint["roomWidthMm"]) ||
    !isInt(footprint["roomDepthMm"]) ||
    !Array.isArray(tables) ||
    !tables.every(
      (t) =>
        isRecord(t) && typeof t["name"] === "string" && isMmRect(t["rect"]) && isInt(t["heightMm"]),
    ) ||
    !Array.isArray(obstacles) ||
    !obstacles.every((o) => isRecord(o) && typeof o["name"] === "string" && isMmRect(o["rect"]))
  ) {
    return "manifest.json has a malformed room, table or obstacle";
  }
  if (
    !isRecord(settings) ||
    !PROFILES.some((profile) => profile === settings["profile"]) ||
    !isInt(settings["maxReachMm"])
  ) {
    return "manifest.json has no module standard and reach";
  }
  if (!Array.isArray(value["placements"]) || !value["placements"].every(isPlacement)) {
    return "manifest.json has a malformed placement";
  }
  if (typeof value["bundleVersion"] !== "string") return "manifest.json has no bundle version";
  return value as unknown as PlanArchiveManifest;
}
