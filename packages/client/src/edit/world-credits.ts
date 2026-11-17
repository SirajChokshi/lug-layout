import type { CreditsView } from "../credits/credits-view.ts";
import type { Placeable } from "./placeable.ts";

const FILE_NAME_UNSAFE = /[^A-Za-z0-9._-]+/g;
const WORLD_ARCHIVE_EXTENSION = ".brr.zip";

export function exportFileName(worldName: string): string {
  const stem = worldName
    .trim()
    .replace(FILE_NAME_UNSAFE, "-")
    .replace(/^-+|-+$/g, "");
  return `${stem === "" ? "world" : stem}${WORLD_ARCHIVE_EXTENSION}`;
}

export function creditsForWorld(
  view: CreditsView,
  placed: ReadonlyArray<Placeable>,
  rollingStock: ReadonlyArray<string> = [],
): CreditsView {
  const placedSets = new Set([
    ...placed.flatMap((p) => (p.credit ? [p.credit.name] : [])),
    ...rollingStock,
  ]);
  return {
    ...view,
    sets: view.sets.filter((set) => placedSets.has(set.name)),
    generated: [],
  };
}
