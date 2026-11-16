import type {
  BundleColor,
  BundleCredit,
  BundleModelEntry,
  ModelSection,
  PartRole,
  TrackEnd,
  Vec3Tuple,
} from "./part-bundle.ts";

export interface ManifestPart {
  readonly id: string;
  readonly path: string;
  readonly role: PartRole;
  readonly file: string;
  readonly bounds: { readonly min: Vec3Tuple; readonly max: Vec3Tuple };
  readonly displayColor?: { readonly ldraw: number; readonly source: string };
  readonly trackEnds?: ReadonlyArray<TrackEnd>;
}

export interface ManifestStudPrimitive {
  readonly name: string;
  readonly path: string;
  readonly file: string;
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
}

export interface ModelFileLattice {
  readonly phase: readonly [number, number];
  readonly aabb: { readonly min: Vec3Tuple; readonly max: Vec3Tuple };
}

export interface ModelFile {
  readonly sections: ReadonlyArray<ModelSection>;
  readonly parts: ReadonlyArray<string>;
  readonly lattice: ModelFileLattice | null;
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
    typeof value["path"] === "string" &&
    typeof value["file"] === "string" &&
    typeof value["role"] === "string" &&
    isVec3(value["bounds"]["min"]) &&
    isVec3(value["bounds"]["max"])
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
    Array.isArray(value["sections"])
  );
}

function isSource(value: unknown): boolean {
  return (
    isRecord(value) && typeof value["repo"] === "string" && typeof value["commit"] === "string"
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
    !value["models"].every(isBundleModelEntry) ||
    typeof value["modified"] !== "string" ||
    typeof value["disclaimer"] !== "string" ||
    !isRecord(value["inputs"]) ||
    !isSource(value["inputs"]["ldraw"]) ||
    !isSource(value["inputs"]["omr"])
  ) {
    throw new Error("bundle manifest does not match the M1 bundle format");
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
  return value as unknown as ModelFile;
}
