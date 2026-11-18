import type { BundleModelEntry } from "@brr/schema/bundle";

export function modelLabel(
  entry: Pick<BundleModelEntry, "name" | "origin" | "set" | "sections">,
): string {
  if (entry.origin === "generated") return entry.sections[0]?.title ?? entry.name;
  return entry.set ? `${entry.name} ${entry.set.name} (${entry.set.year})` : entry.name;
}

const YEAR_SUFFIX = / \(\d{4}\)$/u;

export function withoutYear(label: string): string {
  return label.replace(YEAR_SUFFIX, "");
}
