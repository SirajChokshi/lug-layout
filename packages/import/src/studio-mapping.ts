import type { StudioArchive } from "./brick-compiler.ts";

export interface BricklinkToLdraw {
  ldrawCandidates(bricklinkId: string): ReadonlyArray<string>;
}

export interface LdrawPartExists {
  isLdrawPart(reference: string): Promise<boolean>;
}

export type StudioPartOutcome =
  | { readonly kind: "kept" }
  | { readonly kind: "bricklinkCrosswalk"; readonly ldraw: string }
  | { readonly kind: "crosswalkTargetMissing"; readonly ldraw: string }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<string> }
  | { readonly kind: "custom" };

export type BricklinkIdSource = "studioMetadata" | "fileName";

export interface StudioPart {
  readonly studio: string;
  readonly bricklinkId: string;
  readonly bricklinkIdSource: BricklinkIdSource;
  readonly instances: number;
  readonly outcome: StudioPartOutcome;
}

export interface StudioColor {
  readonly code: number;
  readonly instances: number;
}

export interface StudioFlexibleSection {
  readonly name: string;
  readonly instances: number;
}

export interface StudioMapping {
  readonly ldraw: string;
  readonly parts: ReadonlyArray<StudioPart>;
  readonly unknownColors: ReadonlyArray<StudioColor>;
  readonly flexibleSections: ReadonlyArray<StudioFlexibleSection>;
}

const LDRAW_NAMESPACE = "ldraw:";
const SUBFILE_LINE = "1";
const SUBFILE_REFERENCE_TOKEN = 14;
const PART_EXTENSION = ".dat";
const STUDIO_BRICKLINK_PREFIX = "bl_";
const STUDIO_FLEXIBLE_SECTION_PREFIX = "__flexiblesubmodel_";
const FILE_META = /^0\s+FILE\s+(.+)$/iu;

export class BricklinkPartsCrosswalk implements BricklinkToLdraw {
  private readonly candidates = new Map<string, ReadonlyArray<string>>();

  constructor(bricklinkParts: Readonly<Record<string, ReadonlyArray<string>>>) {
    for (const [bricklinkId, ldrawIds] of Object.entries(bricklinkParts)) {
      const key = bricklinkId.toLowerCase();
      const merged = [...(this.candidates.get(key) ?? []), ...ldrawIds.map(withoutNamespace)];
      this.candidates.set(key, [...new Set(merged)].toSorted());
    }
  }

  ldrawCandidates(bricklinkId: string): ReadonlyArray<string> {
    return this.candidates.get(bricklinkId.toLowerCase()) ?? [];
  }
}

function withoutNamespace(id: string): string {
  return id.startsWith(LDRAW_NAMESPACE) ? id.slice(LDRAW_NAMESPACE.length) : id;
}

function normalize(reference: string): string {
  return reference.trim().replaceAll("\\", "/").toLowerCase();
}

function stem(reference: string): string {
  return reference.endsWith(PART_EXTENSION)
    ? reference.slice(0, -PART_EXTENSION.length)
    : reference;
}

function withExtension(id: string): string {
  return id.endsWith(PART_EXTENSION) ? id : `${id}${PART_EXTENSION}`;
}

function withoutStudioPrefix(reference: string): string {
  return reference.startsWith(STUDIO_BRICKLINK_PREFIX)
    ? reference.slice(STUDIO_BRICKLINK_PREFIX.length)
    : reference;
}

function bricklinkIdOf(
  reference: string,
  archive: StudioArchive,
): { readonly id: string; readonly source: BricklinkIdSource } {
  const recorded =
    archive.bricklinkIds[reference] ?? archive.bricklinkIds[withoutStudioPrefix(reference)];
  if (recorded !== undefined) return { id: recorded, source: "studioMetadata" };
  return { id: withoutStudioPrefix(stem(reference)), source: "fileName" };
}

interface SubfileLine {
  readonly tokens: ReadonlyArray<string>;
  readonly reference: string;
  readonly color: number;
}

function subfileLine(line: string): SubfileLine | undefined {
  const tokens = line.trim().split(/\s+/u);
  if (tokens[0] !== SUBFILE_LINE || tokens.length <= SUBFILE_REFERENCE_TOKEN) return undefined;
  return {
    tokens,
    reference: normalize(tokens.slice(SUBFILE_REFERENCE_TOKEN).join(" ")),
    color: Number(tokens[1]),
  };
}

function submodelNames(lines: ReadonlyArray<string>): ReadonlySet<string> {
  const names = new Set<string>();
  for (const line of lines) {
    const match = FILE_META.exec(line.trim());
    if (match?.[1] !== undefined) names.add(normalize(match[1]));
  }
  return names;
}

async function decide(
  reference: string,
  bricklinkId: string,
  archive: StudioArchive,
  crosswalk: BricklinkToLdraw,
  exists: LdrawPartExists,
): Promise<StudioPartOutcome> {
  if (archive.customParts.includes(reference)) return { kind: "custom" };
  const name = stem(reference);
  const candidates = [...new Set(crosswalk.ldrawCandidates(bricklinkId).map(stem))].toSorted();
  if (candidates.length === 0 || (candidates.length === 1 && candidates[0] === name)) {
    return { kind: "kept" };
  }
  if (await exists.isLdrawPart(reference)) return { kind: "kept" };
  const [only] = candidates;
  if (candidates.length === 1 && only !== undefined) {
    return (await exists.isLdrawPart(withExtension(only)))
      ? { kind: "bricklinkCrosswalk", ldraw: only }
      : { kind: "crosswalkTargetMissing", ldraw: only };
  }
  return { kind: "ambiguous", candidates };
}

export async function mapStudioParts(
  archive: StudioArchive,
  crosswalk: BricklinkToLdraw,
  exists: LdrawPartExists,
  knownColors: ReadonlySet<number>,
): Promise<StudioMapping> {
  const lines = archive.ldraw.split("\n");
  const submodels = submodelNames(lines);
  const instances = new Map<string, number>();
  const colors = new Map<number, number>();
  const flexible = new Map<string, number>();
  for (const line of lines) {
    const subfile = subfileLine(line);
    if (!subfile) continue;
    if (submodels.has(subfile.reference)) {
      if (subfile.reference.startsWith(STUDIO_FLEXIBLE_SECTION_PREFIX)) {
        flexible.set(subfile.reference, (flexible.get(subfile.reference) ?? 0) + 1);
      }
      continue;
    }
    instances.set(subfile.reference, (instances.get(subfile.reference) ?? 0) + 1);
    if (!knownColors.has(subfile.color)) {
      colors.set(subfile.color, (colors.get(subfile.color) ?? 0) + 1);
    }
  }
  const parts = await Promise.all(
    [...instances].map(async ([reference, count]): Promise<StudioPart> => {
      const { id: bricklinkId, source } = bricklinkIdOf(reference, archive);
      return {
        studio: reference,
        bricklinkId,
        bricklinkIdSource: source,
        instances: count,
        outcome: await decide(reference, bricklinkId, archive, crosswalk, exists),
      };
    }),
  );
  const rewrites = new Map<string, string>();
  for (const part of parts) {
    if (part.outcome.kind === "bricklinkCrosswalk") {
      rewrites.set(part.studio, withExtension(part.outcome.ldraw));
    }
  }
  const ldraw = lines
    .map((line) => {
      const subfile = subfileLine(line);
      const target = subfile && rewrites.get(subfile.reference);
      if (!subfile || target === undefined) return line;
      return [...subfile.tokens.slice(0, SUBFILE_REFERENCE_TOKEN), target].join(" ");
    })
    .join("\n");
  return {
    ldraw,
    parts: parts.toSorted((a, b) => a.studio.localeCompare(b.studio)),
    unknownColors: [...colors]
      .map(([code, count]) => ({ code, instances: count }))
      .toSorted((a, b) => b.instances - a.instances || a.code - b.code),
    flexibleSections: [...flexible]
      .map(([name, count]) => ({ name, instances: count }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
  };
}
