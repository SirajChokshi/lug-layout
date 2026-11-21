import type { ImportReport, PartResolution } from "@brr/import";
import type { CustomPartCredit } from "../credits/credits-view.ts";

type CustomPart = Extract<PartResolution, { readonly kind: "custom" }>;

function isCustomPart(part: PartResolution): part is CustomPart {
  return part.kind === "custom";
}

export function customPartCredits(report: ImportReport): ReadonlyArray<CustomPartCredit> {
  return report.parts.filter(isCustomPart).map((part) => ({
    reference: part.reference,
    title: part.header.title,
    author: part.header.author,
    license: part.header.license,
  }));
}
