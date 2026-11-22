import type { CreditsView, ImportedModelCredit } from "../credits/credits-view.ts";
import type { ModelCredit } from "../scene/viewer-scene.ts";

const FILE_NAME_UNSAFE = /[^A-Za-z0-9._-]+/g;
const WORLD_ARCHIVE_EXTENSION = ".brr.zip";
const PLAN_ARCHIVE_EXTENSION = ".brrplan.zip";

function fileStem(name: string, fallback: string): string {
  const stem = name
    .trim()
    .replace(FILE_NAME_UNSAFE, "-")
    .replace(/^-+|-+$/g, "");
  return stem === "" ? fallback : stem;
}

export function exportFileName(worldName: string): string {
  return `${fileStem(worldName, "world")}${WORLD_ARCHIVE_EXTENSION}`;
}

export function planFileName(planName: string): string {
  return `${fileStem(planName, "plan")}${PLAN_ARCHIVE_EXTENSION}`;
}

export function creditsForWorld(
  view: CreditsView,
  placed: ReadonlyArray<ModelCredit>,
): CreditsView {
  const placedSets = new Set(placed.map((credit) => credit.name));
  return {
    ...view,
    sets: view.sets.filter((set) => placedSets.has(set.name)),
    generated: [],
  };
}

export function creditsForPlan(
  view: CreditsView,
  placed: ReadonlyArray<ModelCredit>,
  imported: ReadonlyArray<ImportedModelCredit>,
): CreditsView {
  return { ...creditsForWorld(view, placed), imported };
}
