import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Palette, PartRole } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import * as v from "valibot";
import { LDRAW_NAMESPACE, movedTarget, type LdrawPartFacts } from "./crosswalk.ts";

export const PART_CATEGORY_SOURCE = "ldraw-part-categories";
const PART_CATEGORY_FILE = "PartCategory.php";

export interface LdrawCategories {
  readonly active: ReadonlySet<string>;
  readonly inactive: ReadonlySet<string>;
  readonly retired: ReadonlySet<string>;
}

export interface PartCategory {
  readonly ldrawCategory: string;
  readonly keywords: ReadonlyArray<string>;
}

interface RoleRule {
  readonly categories: ReadonlyArray<string>;
  readonly needsOneOf: ReadonlyArray<string>;
  readonly refusesAll: ReadonlyArray<string>;
}

const ROAD_WORDS = ["road", "roadplate", "street", "driveway"];

const ROLE_RULES: Readonly<Record<PartRole, RoleRule | null>> = {
  ground: { categories: ["Baseplate"], needsOneOf: [], refusesAll: ROAD_WORDS },
  road: { categories: ["Baseplate", "Plate"], needsOneOf: ROAD_WORDS, refusesAll: [] },
  track: { categories: ["Train"], needsOneOf: ["track"], refusesAll: [] },
  wall: { categories: ["Brick"], needsOneOf: [], refusesAll: [] },
  roof: { categories: ["Plate"], needsOneOf: [], refusesAll: [] },
  detail: { categories: ["Brick", "Plate", "Tile", "Slope"], needsOneOf: [], refusesAll: [] },
  model: null,
};

const ENUM_CASE = /^\s*case\s+(\w+)\s*=\s*'([^']+)'\s*;/gmu;
const TITLE_CATEGORY = /^\s*(?:([~_=|]+)\s*)?(\S+)/u;
const ALIAS_FLAG = "=";
const HIDDEN_FLAG = "~";
const PHYSICAL_COLOUR_FLAG = "_";

function enumCaseNames(
  source: string,
  method: string,
  cases: ReadonlyMap<string, string>,
): string[] {
  const body = new RegExp(`function\\s+${method}\\s*\\([^)]*\\)[^{]*\\{([^}]*)\\}`, "u").exec(
    source,
  )?.[1];
  if (body === undefined) throw new Error(`${PART_CATEGORY_FILE} has no ${method}()`);
  return [...body.matchAll(/PartCategory::(\w+)|self::(\w+)/gu)].map((match) => {
    const name = match[1] ?? match[2] ?? "";
    const value = cases.get(name);
    if (value === undefined) throw new Error(`${PART_CATEGORY_FILE} ${method}() names ${name}`);
    return value;
  });
}

export function parseLdrawCategories(source: string): LdrawCategories {
  const cases = new Map(
    [...source.matchAll(ENUM_CASE)].map(([, name = "", value = ""]) => [name, value]),
  );
  if (cases.size === 0) throw new Error(`${PART_CATEGORY_FILE} declares no categories`);
  const inactive = new Set(enumCaseNames(source, "inactiveCategories", cases));
  const retired = new Set(enumCaseNames(source, "retired", cases));
  return {
    active: new Set(
      [...cases.values()].filter((value) => !inactive.has(value) && !retired.has(value)),
    ),
    inactive,
    retired,
  };
}

function isKnown(categories: LdrawCategories, category: string): boolean {
  return (
    categories.active.has(category) ||
    categories.inactive.has(category) ||
    categories.retired.has(category)
  );
}

export function ldrawCategoryOf(facts: LdrawPartFacts, categories: LdrawCategories): string | null {
  const category = facts.category?.trim() ?? TITLE_CATEGORY.exec(facts.title)?.[2] ?? "";
  return isKnown(categories, category) ? category : null;
}

function titleFlags(facts: LdrawPartFacts): string {
  return TITLE_CATEGORY.exec(facts.title)?.[1] ?? "";
}

function wordsOf(facts: LdrawPartFacts): ReadonlySet<string> {
  return new Set(
    [facts.title, ...facts.keywords]
      .join(" ")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word !== ""),
  );
}

function canonicalFacts(
  id: string,
  ldrawParts: ReadonlyMap<string, LdrawPartFacts>,
): LdrawPartFacts | undefined {
  const seen = new Set([id]);
  let facts = ldrawParts.get(id);
  for (let target = movedTarget(facts); target !== undefined; target = movedTarget(facts)) {
    const key = target.toLowerCase();
    if (seen.has(key)) break;
    seen.add(key);
    const next = ldrawParts.get(key);
    if (!next) break;
    facts = next;
  }
  return facts;
}

function fileProblem(facts: LdrawPartFacts): string | null {
  const moved = movedTarget(facts);
  if (moved !== undefined) return `is a "~Moved to ${moved}" stub; bundle ${moved} instead`;
  const flags = titleFlags(facts);
  if (flags.includes(ALIAS_FLAG)) {
    const target = facts.components[0]?.id;
    return `is an alias ("${facts.title}")${target === undefined ? "" : `; bundle ${target} instead`}`;
  }
  if (flags.includes(PHYSICAL_COLOUR_FLAG)) {
    return `has its colour baked in ("${facts.title}"); bundle the uncoloured part`;
  }
  if (flags.includes(HIDDEN_FLAG)) {
    return `is a "~" file ("${facts.title}"), which LDraw keeps out of part lists`;
  }
  return null;
}

export function listedCategory(facts: LdrawPartFacts, categories: LdrawCategories): string | null {
  if (fileProblem(facts) !== null) return null;
  const category = ldrawCategoryOf(facts, categories);
  return category !== null && categories.active.has(category) ? category : null;
}

function roleProblem(role: PartRole, category: string, facts: LdrawPartFacts): string | null {
  const rule = ROLE_RULES[role];
  if (rule === null) return `has role ${role}, which no palette part may carry`;
  if (!rule.categories.includes(category)) {
    return `is LDraw category ${category}, but role ${role} takes ${rule.categories.join(" or ")}`;
  }
  const words = wordsOf(facts);
  if (rule.needsOneOf.length > 0 && !rule.needsOneOf.some((word) => words.has(word))) {
    return `has role ${role}, but neither its title nor its keywords say ${rule.needsOneOf.join(", ")}`;
  }
  const refused = rule.refusesAll.filter((word) => words.has(word));
  if (refused.length > 0) {
    return `has role ${role}, but its title or keywords say ${refused.join(", ")}`;
  }
  return null;
}

function rulesProblems(categories: LdrawCategories): string[] {
  return Object.entries(ROLE_RULES).flatMap(([role, rule]) =>
    (rule?.categories ?? [])
      .filter((category) => !categories.active.has(category))
      .map((category) => `role ${role} takes ${category}, which is not an active LDraw category`),
  );
}

export function paletteCategoryProblems(
  palette: Palette,
  ldrawParts: ReadonlyMap<string, LdrawPartFacts>,
  categories: LdrawCategories,
): string[] {
  const parts = palette.parts.flatMap(({ id, role }) => {
    const label = `${LDRAW_NAMESPACE}${id} (${role})`;
    const facts = ldrawParts.get(id.toLowerCase());
    if (!facts) return [`${label} is not a part of the pinned LDraw library`];
    const problem = fileProblem(facts);
    if (problem !== null) return [`${label} ${problem}`];
    const category = ldrawCategoryOf(facts, categories);
    if (category === null) return [`${label} "${facts.title}" has no LDraw category`];
    if (!categories.active.has(category)) {
      return [`${label} is in the inactive or retired LDraw category ${category}`];
    }
    const misfiled = roleProblem(role, category, facts);
    return misfiled === null ? [] : [`${label} ${misfiled}`];
  });
  const models = palette.models
    .filter((model) => model.origin === "omr")
    .flatMap((model) => {
      if (model.set === undefined) {
        return [
          `${model.name} is an OMR set with no Rebrickable set name, so the palette would list it by file name`,
        ];
      }
      if (model.set.theme === undefined) {
        return [
          `${model.name} is an OMR set with no Rebrickable theme, so the library can't shelve it`,
        ];
      }
      return [];
    });
  return [...rulesProblems(categories), ...parts, ...models];
}

export function partCategory(
  id: string,
  ldrawParts: ReadonlyMap<string, LdrawPartFacts>,
  categories: LdrawCategories,
): PartCategory | null {
  const facts = canonicalFacts(id.toLowerCase(), ldrawParts);
  if (!facts) return null;
  const ldrawCategory = ldrawCategoryOf(facts, categories);
  return ldrawCategory === null ? null : { ldrawCategory, keywords: facts.keywords };
}

const CompiledParts = v.looseObject({
  parts: v.array(v.looseObject({ id: v.string() })),
});

export async function attachPartCategories(
  manifestPath: string,
  ldrawParts: ReadonlyMap<string, LdrawPartFacts>,
  categories: LdrawCategories,
): Promise<void> {
  const manifest = decodedOrThrow(
    decode(CompiledParts, JSON.parse(await readFile(manifestPath, "utf8"))),
    manifestPath,
  );
  const uncategorized: string[] = [];
  const parts = manifest.parts.map((part) => {
    const category = partCategory(part.id.replace(LDRAW_NAMESPACE, ""), ldrawParts, categories);
    if (category === null) uncategorized.push(part.id);
    return { ...part, ...category };
  });
  if (uncategorized.length > 0) {
    throw new Error(`${manifestPath}: no LDraw category for ${uncategorized.join(", ")}`);
  }
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, parts }, null, 2)}\n`);
}

export async function readLdrawCategories(directory: string): Promise<LdrawCategories> {
  return parseLdrawCategories(await readFile(join(directory, PART_CATEGORY_FILE), "utf8"));
}
