import * as v from "valibot";

export const STARTER_SHELF_FILE = "starters.json";

const WORLD_DIRECTORY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const StarterV1 = v.strictObject({
  world: v.pipe(v.string(), v.regex(WORLD_DIRECTORY, "must be a kebab-case directory name")),
  summary: v.pipe(v.string(), v.minLength(1, "is empty")),
});
export type StarterV1 = v.InferOutput<typeof StarterV1>;

export const StarterShelfV1 = v.strictObject({
  starters: v.pipe(
    v.array(StarterV1),
    v.check(
      (starters) => new Set(starters.map((starter) => starter.world)).size === starters.length,
      "must list each world once",
    ),
  ),
});
export type StarterShelfV1 = v.InferOutput<typeof StarterShelfV1>;

export function starterFilePath(world: string, file: string): string {
  return `${world}/${file}`;
}
