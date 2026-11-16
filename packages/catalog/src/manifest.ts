import type {
  BundleColor,
  BundleCredit,
  BundleModelEntry,
  BundleSource,
  CatalogColorIds,
  CatalogCrosswalk,
  CatalogPartIds,
  ModelSection,
  PartRole,
  TrackEnd,
  Vec3Tuple,
} from "./part-bundle.ts";

export interface ManifestPart {
  readonly id: string;
  readonly role: PartRole;
  readonly file: string;
  readonly bounds: { readonly min: Vec3Tuple; readonly max: Vec3Tuple };
  readonly displayColor?: { readonly ldraw: number };
  readonly trackEnds?: ReadonlyArray<TrackEnd>;
}

export interface ManifestStudPrimitive {
  readonly name: string;
  readonly file: string;
}

export interface BundleCompiler {
  readonly file: string;
  readonly unofficialAllowlist: ReadonlyArray<string>;
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
  readonly crosswalk: { readonly file: string };
}

export interface CrosswalkFile {
  readonly parts: Readonly<Record<string, CatalogPartIds>>;
  readonly colors: Readonly<Record<string, CatalogColorIds>>;
  readonly bricklinkParts: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly bricklinkColors: Readonly<Record<string, ReadonlyArray<number>>>;
}

export interface ModelFile {
  readonly sections: ReadonlyArray<ModelSection>;
  readonly parts: ReadonlyArray<string>;
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
    !Array.isArray(value["models"]) ||
    !isBundleSource(value["source"]) ||
    !(
      value["compiler"] === null ||
      value["compiler"] === undefined ||
      isCompiler(value["compiler"])
    ) ||
    !isRecord(value["crosswalk"]) ||
    typeof value["crosswalk"]["file"] !== "string"
  ) {
    throw new Error("bundle manifest does not match the M1 bundle format");
  }
  return {
    ...(value as unknown as BundleManifest),
    compiler: isCompiler(value["compiler"]) ? value["compiler"] : null,
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || Number.isInteger(value);
}

function isCatalogPartIds(value: unknown): value is CatalogPartIds {
  return (
    isRecord(value) &&
    isNullableString(value["rebrickable"]) &&
    isNullableString(value["bricklink"])
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

export function crosswalkMaps(file: CrosswalkFile): CatalogCrosswalk {
  return {
    parts: new Map(
      Object.entries(file.parts).map(([id, ids]) => [
        id,
        { rebrickable: ids.rebrickable, bricklink: ids.bricklink },
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

export function parseModelFile(value: unknown, label: string): ModelFile {
  if (!isRecord(value) || !isRecord(value["instances"]) || !isStringArray(value["parts"])) {
    throw new Error(`${label}: model file does not match the M1 bundle format`);
  }
  const partCount = value["parts"].length;
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
  return value as unknown as ModelFile;
}
