import { readFile } from "node:fs/promises";

export type PartRole = "ground" | "wall" | "roof" | "detail";

export interface Palette {
  readonly source: {
    readonly kind: "github-mirror";
    readonly repo: string;
    readonly commit: string;
    readonly root: string;
  };
  readonly config: ReadonlyArray<string>;
  readonly studPrimitives: ReadonlyArray<string>;
  readonly parts: ReadonlyArray<{ readonly id: string; readonly role: PartRole }>;
}

export async function readPalette(path: string): Promise<Palette> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isPalette(parsed)) throw new Error(`${path} is not a valid palette`);
  return parsed;
}

function isPalette(value: unknown): value is Palette {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["source"] === "object" &&
    Array.isArray(candidate["config"]) &&
    Array.isArray(candidate["studPrimitives"]) &&
    Array.isArray(candidate["parts"])
  );
}
