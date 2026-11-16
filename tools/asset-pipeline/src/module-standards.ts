import { readFile } from "node:fs/promises";

const LDRAW_NAMESPACE = "ldraw:";

interface SourceLine {
  readonly part: string;
  readonly quantity: number;
}

interface SourceRecipe {
  readonly groundPart: string;
  readonly edgeJoinCells: ReadonlyArray<readonly [number, number]>;
  readonly surfacePlates: number;
  readonly substructure: ReadonlyArray<SourceLine>;
}

interface SourceProfile {
  readonly id: string;
  readonly moduleStuds: number;
  readonly joinParts: ReadonlyArray<string>;
  readonly joinLevelPlates: number;
  readonly recipe: SourceRecipe | null;
  readonly source: string;
}

export interface PublishedModuleStandards {
  readonly groundParts: ReadonlyArray<string>;
  readonly profiles: ReadonlyArray<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWholePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isCellRange(value: unknown, moduleStuds: number): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [first, last] = value as unknown[];
  return (
    typeof first === "number" &&
    typeof last === "number" &&
    Number.isInteger(first) &&
    Number.isInteger(last) &&
    first >= 0 &&
    last >= first &&
    last < moduleStuds
  );
}

function isRecipe(value: unknown, moduleStuds: number): value is SourceRecipe {
  return (
    isRecord(value) &&
    typeof value["groundPart"] === "string" &&
    Array.isArray(value["edgeJoinCells"]) &&
    value["edgeJoinCells"].every((range) => isCellRange(range, moduleStuds)) &&
    isWholePositive(value["surfacePlates"]) &&
    Array.isArray(value["substructure"]) &&
    value["substructure"].every(
      (line) =>
        isRecord(line) && typeof line["part"] === "string" && isWholePositive(line["quantity"]),
    )
  );
}

function isProfile(value: unknown): value is SourceProfile {
  if (!isRecord(value) || !isWholePositive(value["moduleStuds"])) return false;
  const moduleStuds = value["moduleStuds"];
  return (
    (value["id"] === "lego-modular" || value["id"] === "mils") &&
    Array.isArray(value["joinParts"]) &&
    value["joinParts"].every((part) => typeof part === "string") &&
    typeof value["joinLevelPlates"] === "number" &&
    Number.isInteger(value["joinLevelPlates"]) &&
    (value["recipe"] === null || isRecipe(value["recipe"], moduleStuds)) &&
    typeof value["source"] === "string" &&
    value["source"].length > 0
  );
}

function groundPartsOf(geometry: unknown): string[] {
  if (!isRecord(geometry) || !Array.isArray(geometry["baseplates"])) {
    throw new Error("geometry.json has no measured baseplates");
  }
  return geometry["baseplates"].map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry["part"] !== "string") {
      throw new Error("geometry.json baseplate entry has no part");
    }
    return `${LDRAW_NAMESPACE}${entry["part"]}`;
  });
}

function namespaced(profile: SourceProfile): unknown {
  const recipe = profile.recipe;
  return {
    id: profile.id,
    moduleStuds: profile.moduleStuds,
    joinParts: profile.joinParts.map((part) => `${LDRAW_NAMESPACE}${part}`),
    joinLevelPlates: profile.joinLevelPlates,
    recipe: recipe
      ? {
          groundPart: `${LDRAW_NAMESPACE}${recipe.groundPart}`,
          edgeJoinCells: recipe.edgeJoinCells,
          surfacePlates: recipe.surfacePlates,
          substructure: recipe.substructure.map((line) => ({
            part: `${LDRAW_NAMESPACE}${line.part}`,
            ldrawColor: null,
            quantity: line.quantity,
          })),
        }
      : null,
    source: profile.source,
  };
}

export async function readModuleStandards(
  standardsPath: string,
  geometryPath: string,
): Promise<PublishedModuleStandards> {
  const standards: unknown = JSON.parse(await readFile(standardsPath, "utf8"));
  if (
    !isRecord(standards) ||
    !Array.isArray(standards["profiles"]) ||
    !standards["profiles"].every(isProfile)
  ) {
    throw new Error(`${standardsPath} does not match the module standards format`);
  }
  const geometry: unknown = JSON.parse(await readFile(geometryPath, "utf8"));
  return {
    groundParts: groundPartsOf(geometry),
    profiles: standards["profiles"].map(namespaced),
  };
}
