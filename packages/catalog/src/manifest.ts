import type {
  BundleColor,
  BundleCredit,
  BundleModelEntry,
  BundleModuleStandards,
  CatalogColorIds,
  CatalogCrosswalk,
  CatalogPartIds,
  ModelSection,
  PartRole,
  TrackEnd,
  Vec3Tuple,
} from "./part-bundle.ts";
import { parseBakedVehicle, type BakedVehicle } from "./model-vehicle.ts";
import { parseTrackCatalog, type TrackCatalog } from "./track-catalog.ts";

export interface ManifestPart {
  readonly id: string;
  readonly path: string;
  readonly role: PartRole;
  readonly file: string;
  readonly bounds: { readonly min: Vec3Tuple; readonly max: Vec3Tuple };
  readonly title?: string;
  readonly displayColor?: { readonly ldraw: number; readonly source: string };
  readonly trackEnds?: ReadonlyArray<TrackEnd>;
}

export interface ManifestStudPrimitive {
  readonly name: string;
  readonly path: string;
  readonly file: string;
}

export interface BundleCompiler {
  readonly file: string;
  readonly unofficialAllowlist: ReadonlyArray<string>;
}

export interface BundleSource {
  readonly repo: string;
  readonly commit: string;
  readonly root: string;
}

export interface BundleInputs {
  readonly ldraw: BundleSource;
  readonly omr: BundleSource;
}

export interface BundleManifest {
  readonly bundleVersion: string;
  readonly source: BundleSource;
  readonly compiler: BundleCompiler | null;
  readonly unit: "LDU";
  readonly upAxis: "+Y";
  readonly parts: ReadonlyArray<ManifestPart>;
  readonly studPrimitives: ReadonlyArray<ManifestStudPrimitive>;
  readonly colors: ReadonlyArray<BundleColor>;
  readonly credits: ReadonlyArray<BundleCredit>;
  readonly models: ReadonlyArray<BundleModelEntry>;
  readonly modified: string;
  readonly disclaimer: string;
  readonly inputs: BundleInputs;
  readonly trackCatalog: TrackCatalog;
  readonly crosswalk: { readonly file: string };
  readonly moduleStandards: BundleModuleStandards;
}

export interface CrosswalkFilePart extends CatalogPartIds {
  readonly via?: { readonly bricklink?: string | null };
}

export interface CrosswalkFile {
  readonly parts: Readonly<Record<string, CrosswalkFilePart>>;
  readonly colors: Readonly<Record<string, CatalogColorIds>>;
  readonly bricklinkParts: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly bricklinkColors: Readonly<Record<string, ReadonlyArray<number>>>;
}

export interface ModelFileLattice {
  readonly phase: readonly [number, number];
  readonly aabb: { readonly min: Vec3Tuple; readonly max: Vec3Tuple };
}

export interface ModelFile {
  readonly sections: ReadonlyArray<ModelSection>;
  readonly parts: ReadonlyArray<string>;
  readonly lattice: ModelFileLattice | null;
  readonly vehicles: ReadonlyArray<BakedVehicle>;
  readonly instances: {
    readonly part: ReadonlyArray<number>;
    readonly color: ReadonlyArray<number>;
    readonly matrix: ReadonlyArray<number>;
  };
}

export interface StudExtra {
  readonly primitive: string;
  readonly color: number;
  readonly matrix: ReadonlyArray<number>;
}

export interface SourceExtra {
  readonly path: string;
  readonly author: string;
  readonly license: string | null;
}

export interface PartExtras {
  readonly studs: ReadonlyArray<StudExtra>;
  readonly sources?: ReadonlyArray<SourceExtra>;
  readonly bounds?: { readonly min: Vec3Tuple; readonly max: Vec3Tuple };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isVec3(value: unknown): value is Vec3Tuple {
  return Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "number");
}

function isManifestPart(value: unknown): value is ManifestPart {
  if (!isRecord(value) || !isRecord(value["bounds"])) return false;
  return (
    typeof value["id"] === "string" &&
    typeof value["path"] === "string" &&
    typeof value["file"] === "string" &&
    typeof value["role"] === "string" &&
    isVec3(value["bounds"]["min"]) &&
    isVec3(value["bounds"]["max"])
  );
}

function isBundleSource(value: unknown): value is BundleSource {
  return (
    isRecord(value) &&
    typeof value["repo"] === "string" &&
    typeof value["commit"] === "string" &&
    typeof value["root"] === "string"
  );
}

function isCompiler(value: unknown): value is BundleCompiler {
  return (
    isRecord(value) &&
    typeof value["file"] === "string" &&
    Array.isArray(value["unofficialAllowlist"]) &&
    value["unofficialAllowlist"].every((entry) => typeof entry === "string")
  );
}

function isCredit(value: unknown): value is BundleCredit {
  return (
    isRecord(value) &&
    typeof value["path"] === "string" &&
    typeof value["title"] === "string" &&
    typeof value["author"] === "string" &&
    (value["license"] === null || typeof value["license"] === "string")
  );
}

function isBundleModelEntry(value: unknown): value is BundleModelEntry {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    typeof value["file"] === "string" &&
    typeof value["source"] === "string" &&
    (value["origin"] === "omr" || value["origin"] === "generated") &&
    (value["set"] === null || isRecord(value["set"])) &&
    isStringArray(value["authors"]) &&
    isStringArray(value["licenses"]) &&
    Array.isArray(value["sections"]) &&
    (value["role"] === undefined || value["role"] === "road-module")
  );
}

function isSource(value: unknown): boolean {
  return (
    isRecord(value) && typeof value["repo"] === "string" && typeof value["commit"] === "string"
  );
}

function isStringList(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isBomLine(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value["part"] === "string" &&
    (value["ldrawColor"] === null || typeof value["ldrawColor"] === "number") &&
    typeof value["quantity"] === "number"
  );
}

function isCellRange(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number");
}

function isModuleRecipe(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value["groundPart"] === "string" &&
    Array.isArray(value["edgeJoinCells"]) &&
    value["edgeJoinCells"].every(isCellRange) &&
    typeof value["surfacePlates"] === "number" &&
    Array.isArray(value["substructure"]) &&
    value["substructure"].every(isBomLine)
  );
}

function isModuleProfile(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value["id"] === "lego-modular" || value["id"] === "mils") &&
    typeof value["moduleStuds"] === "number" &&
    isStringList(value["joinParts"]) &&
    typeof value["joinLevelPlates"] === "number" &&
    (value["recipe"] === null || isModuleRecipe(value["recipe"])) &&
    typeof value["source"] === "string"
  );
}

function isModuleStandards(value: unknown): value is BundleModuleStandards {
  return (
    isRecord(value) &&
    isStringList(value["groundParts"]) &&
    Array.isArray(value["profiles"]) &&
    value["profiles"].every(isModuleProfile)
  );
}

export function parseManifest(value: unknown): BundleManifest {
  if (
    !isRecord(value) ||
    typeof value["bundleVersion"] !== "string" ||
    value["unit"] !== "LDU" ||
    value["upAxis"] !== "+Y" ||
    !Array.isArray(value["parts"]) ||
    !value["parts"].every(isManifestPart) ||
    !Array.isArray(value["studPrimitives"]) ||
    !Array.isArray(value["colors"]) ||
    !Array.isArray(value["credits"]) ||
    !value["credits"].every(isCredit) ||
    !Array.isArray(value["models"]) ||
    !isBundleSource(value["source"]) ||
    !(
      value["compiler"] === null ||
      value["compiler"] === undefined ||
      isCompiler(value["compiler"])
    ) ||
    !value["models"].every(isBundleModelEntry) ||
    typeof value["modified"] !== "string" ||
    typeof value["disclaimer"] !== "string" ||
    !isRecord(value["inputs"]) ||
    !isSource(value["inputs"]["ldraw"]) ||
    !isSource(value["inputs"]["omr"]) ||
    !isRecord(value["crosswalk"]) ||
    typeof value["crosswalk"]["file"] !== "string" ||
    !isModuleStandards(value["moduleStandards"])
  ) {
    throw new Error("bundle manifest does not match the M1 bundle format");
  }
  return {
    ...(value as unknown as Omit<BundleManifest, "trackCatalog" | "compiler">),
    compiler: isCompiler(value["compiler"]) ? value["compiler"] : null,
    trackCatalog: parseTrackCatalog(value["trackCatalog"]),
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || Number.isInteger(value);
}

function isPartComponent(value: unknown): boolean {
  return isRecord(value) && typeof value["part"] === "string" && Number.isInteger(value["color"]);
}

function isCatalogPartIds(value: unknown): value is CatalogPartIds {
  return (
    isRecord(value) &&
    isNullableString(value["rebrickable"]) &&
    isNullableString(value["bricklink"]) &&
    (value["components"] === undefined ||
      (Array.isArray(value["components"]) && value["components"].every(isPartComponent)))
  );
}

function isCatalogColorIds(value: unknown): value is CatalogColorIds {
  return (
    isRecord(value) &&
    isNullableInteger(value["rebrickable"]) &&
    isNullableInteger(value["bricklink"])
  );
}

function isIntegerArray(value: unknown): value is ReadonlyArray<number> {
  return Array.isArray(value) && value.every((v) => Number.isInteger(v));
}

export function parseCrosswalkFile(value: unknown, label: string): CrosswalkFile {
  if (
    !isRecord(value) ||
    !isRecord(value["parts"]) ||
    !isRecord(value["colors"]) ||
    !isRecord(value["bricklinkParts"]) ||
    !isRecord(value["bricklinkColors"]) ||
    !Object.values(value["parts"]).every(isCatalogPartIds) ||
    !Object.values(value["colors"]).every(isCatalogColorIds) ||
    !Object.values(value["bricklinkParts"]).every(isStringArray) ||
    !Object.values(value["bricklinkColors"]).every(isIntegerArray)
  ) {
    throw new Error(`${label}: crosswalk does not match the bundle format`);
  }
  return value as unknown as CrosswalkFile;
}

const BRICKLINK_FROM_KEYWORD = "ldraw-keyword";

export function crosswalkMaps(file: CrosswalkFile): CatalogCrosswalk {
  return {
    parts: new Map(
      Object.entries(file.parts).map(([id, ids]) => [
        id,
        {
          rebrickable: ids.rebrickable,
          bricklink: ids.bricklink,
          ...(ids.via?.bricklink === BRICKLINK_FROM_KEYWORD
            ? { bricklinkFromKeywordOnly: true }
            : {}),
          ...(ids.components ? { components: ids.components } : {}),
        },
      ]),
    ),
    colors: new Map(
      Object.entries(file.colors).map(([code, ids]) => [
        Number(code),
        { rebrickable: ids.rebrickable, bricklink: ids.bricklink },
      ]),
    ),
  };
}

function isStudExtra(value: unknown): value is StudExtra {
  return (
    isRecord(value) &&
    typeof value["primitive"] === "string" &&
    typeof value["color"] === "number" &&
    Array.isArray(value["matrix"]) &&
    value["matrix"].length === 12
  );
}

export function parsePartExtras(value: unknown, label: string): PartExtras {
  if (!isRecord(value) || !Array.isArray(value["studs"]) || !value["studs"].every(isStudExtra)) {
    throw new Error(`${label}: GLB extras do not match the M0 bundle format`);
  }
  return value as unknown as PartExtras;
}

const MATRIX_FLOATS = 12;

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isNumberArray(value: unknown): value is ReadonlyArray<number> {
  return Array.isArray(value) && value.every((v) => typeof v === "number");
}

const STUD_PHASES = 20;

function isStudPhase(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < STUD_PHASES;
}

function isModelFileLattice(value: unknown): value is ModelFileLattice {
  if (!isRecord(value) || !Array.isArray(value["phase"]) || !isRecord(value["aabb"])) return false;
  const [phaseX, phaseZ] = value["phase"];
  return (
    value["phase"].length === 2 &&
    isStudPhase(phaseX) &&
    isStudPhase(phaseZ) &&
    isVec3(value["aabb"]["min"]) &&
    isVec3(value["aabb"]["max"])
  );
}

export function parseModelFile(value: unknown, label: string): ModelFile {
  if (!isRecord(value) || !isRecord(value["instances"]) || !isStringArray(value["parts"])) {
    throw new Error(`${label}: model file does not match the M1 bundle format`);
  }
  const partCount = value["parts"].length;
  if (value["lattice"] !== null && !isModelFileLattice(value["lattice"])) {
    throw new Error(`${label}: model file lattice is neither null nor a phase and AABB`);
  }
  const { part, color, matrix } = value["instances"];
  if (
    !isNumberArray(part) ||
    !isNumberArray(color) ||
    !isNumberArray(matrix) ||
    part.length !== color.length ||
    part.some((index) => index >= partCount) ||
    matrix.length !== part.length * MATRIX_FLOATS
  ) {
    throw new Error(`${label}: model instance arrays are inconsistent`);
  }
  const rawVehicles = value["vehicles"];
  if (!Array.isArray(rawVehicles)) throw new Error(`${label}: model file has no vehicles list`);
  return {
    ...(value as unknown as ModelFile),
    vehicles: rawVehicles.map((vehicle, v) =>
      parseBakedVehicle(vehicle, `${label}: vehicles[${v}]`, part.length),
    ),
  };
}
