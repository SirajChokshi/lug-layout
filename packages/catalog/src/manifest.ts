import type {
  BundleColor,
  BundleCredit,
  BundleModelEntry,
  ModelSection,
  PartRole,
  Vec3Tuple,
} from "./part-bundle.ts";

export interface ManifestPart {
  readonly id: string;
  readonly role: PartRole;
  readonly file: string;
  readonly bounds: { readonly min: Vec3Tuple; readonly max: Vec3Tuple };
  readonly displayColor?: { readonly ldraw: number };
}

export interface ManifestStudPrimitive {
  readonly name: string;
  readonly file: string;
}

export interface BundleManifest {
  readonly unit: "LDU";
  readonly upAxis: "+Y";
  readonly parts: ReadonlyArray<ManifestPart>;
  readonly studPrimitives: ReadonlyArray<ManifestStudPrimitive>;
  readonly colors: ReadonlyArray<BundleColor>;
  readonly credits: ReadonlyArray<BundleCredit>;
  readonly models: ReadonlyArray<BundleModelEntry>;
}

export interface ModelFile {
  readonly sections: ReadonlyArray<ModelSection>;
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

export interface PartExtras {
  readonly studs: ReadonlyArray<StudExtra>;
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

export function parseManifest(value: unknown): BundleManifest {
  if (
    !isRecord(value) ||
    value["unit"] !== "LDU" ||
    value["upAxis"] !== "+Y" ||
    !Array.isArray(value["parts"]) ||
    !value["parts"].every(isManifestPart) ||
    !Array.isArray(value["studPrimitives"]) ||
    !Array.isArray(value["colors"]) ||
    !Array.isArray(value["models"])
  ) {
    throw new Error("bundle manifest does not match the M0 bundle format");
  }
  return value as unknown as BundleManifest;
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

function isNumberArray(value: unknown): value is ReadonlyArray<number> {
  return Array.isArray(value) && value.every((v) => typeof v === "number");
}

export function parseModelFile(value: unknown, label: string): ModelFile {
  if (!isRecord(value) || !isRecord(value["instances"])) {
    throw new Error(`${label}: model file does not match the M0 bundle format`);
  }
  const { part, color, matrix } = value["instances"];
  if (
    !isNumberArray(part) ||
    !isNumberArray(color) ||
    !isNumberArray(matrix) ||
    part.length !== color.length ||
    matrix.length !== part.length * MATRIX_FLOATS
  ) {
    throw new Error(`${label}: model instance arrays are inconsistent`);
  }
  return value as unknown as ModelFile;
}
