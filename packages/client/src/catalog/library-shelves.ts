import type { BundleModelEntry } from "@brr/schema/bundle";

export type LibraryShelf = "buildings" | "stations" | "trains" | "modules" | "yours" | "other";

export const LIBRARY_SHELVES: ReadonlyArray<LibraryShelf> = [
  "buildings",
  "stations",
  "trains",
  "modules",
  "yours",
  "other",
];

export const SHELF_LABEL: Readonly<Record<LibraryShelf, string>> = {
  buildings: "Buildings",
  stations: "Stations",
  trains: "Trains",
  modules: "Modules",
  yours: "Your models",
  other: "Other sets",
};

const BUILDING_THEMES: ReadonlySet<string> = new Set(["Modular Buildings"]);
const RAILWAY_THEMES: ReadonlySet<string> = new Set(["Train", "Trains"]);

export function bundleShelf(
  entry: Pick<BundleModelEntry, "role" | "set" | "vehicles">,
): LibraryShelf {
  if (entry.role === "mils-module") return "modules";
  if (entry.vehicles > 0) return "trains";
  const theme = entry.set?.theme ?? [];
  if (theme.some((name) => BUILDING_THEMES.has(name))) return "buildings";
  return theme.some((name) => RAILWAY_THEMES.has(name)) ? "stations" : "other";
}
