export const LDRAW_NAMESPACE = "ldraw:";
export const CROSSWALK_FORMAT = 1;

const MOVED_PREFIX = "~Moved to ";
const BRICKLINK_KEYWORD = "BrickLink";
const REBRICKABLE_KEYWORD = "Rebrickable";

export interface ApiPart {
  readonly r: string;
  readonly b: ReadonlyArray<string>;
  readonly l: ReadonlyArray<string>;
}

export interface ApiColor {
  readonly id: number;
  readonly name: string;
  readonly external_ids: Readonly<
    Record<string, { readonly ext_ids: ReadonlyArray<number | null> } | undefined>
  >;
}

export interface LdrawPartFacts {
  readonly title: string;
  readonly keywords: ReadonlyArray<string>;
}

export interface CrosswalkInputs {
  readonly apiParts: ReadonlyArray<ApiPart>;
  readonly apiColors: ReadonlyArray<ApiColor>;
  readonly rebrickableParts: ReadonlySet<string>;
  readonly elementCounts: ReadonlyMap<string, number>;
  readonly ldrawParts: ReadonlyMap<string, LdrawPartFacts>;
  readonly ldrawColors: ReadonlyArray<{ readonly code: number; readonly name: string }>;
}

export type RebrickableVia = "rebrickable-api" | "ldraw-keyword" | "same-id" | `moved:${string}`;
export type BrickLinkVia = "rebrickable-api" | "ldraw-keyword";

export interface CrosswalkPart {
  readonly rebrickable: string | null;
  readonly bricklink: string | null;
  readonly via: {
    readonly rebrickable: RebrickableVia | null;
    readonly bricklink: BrickLinkVia | null;
  };
  readonly rebrickableAlternatives: ReadonlyArray<string>;
  readonly bricklinkAlternatives: ReadonlyArray<string>;
}

export interface CrosswalkColor {
  readonly name: string;
  readonly rebrickable: number | null;
  readonly bricklink: number | null;
  readonly rebrickableAlternatives: ReadonlyArray<number>;
  readonly bricklinkAlternatives: ReadonlyArray<number>;
}

export interface CrosswalkSourcePin {
  readonly repo: string;
  readonly commit: string;
  readonly root: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface CrosswalkFile {
  readonly format: typeof CROSSWALK_FORMAT;
  readonly sources: Readonly<Record<string, CrosswalkSourcePin>>;
  readonly parts: Readonly<Record<string, CrosswalkPart>>;
  readonly colors: Readonly<Record<string, CrosswalkColor>>;
  readonly bricklinkParts: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly bricklinkPartVariants: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly bricklinkColors: Readonly<Record<string, ReadonlyArray<number>>>;
}

function keywordIds(facts: LdrawPartFacts | undefined, system: string): string[] {
  if (!facts) return [];
  return facts.keywords.flatMap((keyword) => {
    const [name, id, ...rest] = keyword.split(/\s+/u);
    return name === system && id !== undefined && rest.length === 0 ? [id] : [];
  });
}

function movedTarget(facts: LdrawPartFacts | undefined): string | undefined {
  if (!facts?.title.startsWith(MOVED_PREFIX)) return undefined;
  return facts.title
    .slice(MOVED_PREFIX.length)
    .trim()
    .replace(/\.dat$/iu, "");
}

function sortedUnique<T extends string | number>(values: Iterable<T>): T[] {
  return [...new Set(values)].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

class PartResolver {
  private readonly rebrickableByLdraw = new Map<string, string[]>();
  private readonly bricklinkByRebrickable = new Map<string, ReadonlyArray<string>>();
  private readonly inputs: CrosswalkInputs;

  constructor(inputs: CrosswalkInputs) {
    this.inputs = inputs;
    for (const part of inputs.apiParts) {
      this.bricklinkByRebrickable.set(part.r, part.b);
      for (const ldraw of part.l) pushTo(this.rebrickableByLdraw, ldraw, part.r);
    }
  }

  private candidates(
    id: string,
    seen: ReadonlySet<string>,
  ): { readonly ids: string[]; readonly via: RebrickableVia } | null {
    const facts = this.inputs.ldrawParts.get(id);
    const fromApi = this.rebrickableByLdraw.get(id) ?? [];
    if (fromApi.length > 0) return { ids: sortedUnique(fromApi), via: "rebrickable-api" };
    const fromKeyword = keywordIds(facts, REBRICKABLE_KEYWORD).filter((rb) =>
      this.inputs.rebrickableParts.has(rb),
    );
    if (fromKeyword.length > 0) return { ids: sortedUnique(fromKeyword), via: "ldraw-keyword" };
    const target = movedTarget(facts);
    if (target !== undefined && !seen.has(target)) {
      const moved = this.candidates(target, new Set([...seen, target]));
      if (moved) return { ids: moved.ids, via: `moved:${target}` };
    }
    return this.inputs.rebrickableParts.has(id) ? { ids: [id], via: "same-id" } : null;
  }

  private choose(id: string, ids: ReadonlyArray<string>): string | null {
    if (ids.includes(id)) return id;
    const ranked = ids.toSorted(
      (a, b) =>
        (this.inputs.elementCounts.get(b) ?? 0) - (this.inputs.elementCounts.get(a) ?? 0) ||
        (a < b ? -1 : a > b ? 1 : 0),
    );
    return ranked[0] ?? null;
  }

  resolve(id: string): CrosswalkPart {
    const found = this.candidates(id, new Set([id]));
    const rebrickable = found ? this.choose(id, found.ids) : null;
    const keywordBrickLink = keywordIds(this.inputs.ldrawParts.get(id), BRICKLINK_KEYWORD);
    const apiBrickLink =
      rebrickable === null ? [] : [...(this.bricklinkByRebrickable.get(rebrickable) ?? [])];
    const bricklinkCandidates = apiBrickLink.length > 0 ? apiBrickLink : keywordBrickLink;
    const bricklink =
      bricklinkCandidates.find((candidate) => keywordBrickLink.includes(candidate)) ??
      bricklinkCandidates[0] ??
      null;
    return {
      rebrickable,
      bricklink,
      via: {
        rebrickable: found?.via ?? null,
        bricklink:
          bricklink === null ? null : apiBrickLink.length > 0 ? "rebrickable-api" : "ldraw-keyword",
      },
      rebrickableAlternatives: (found?.ids ?? []).filter((candidate) => candidate !== rebrickable),
      bricklinkAlternatives: sortedUnique(bricklinkCandidates).filter(
        (candidate) => candidate !== bricklink,
      ),
    };
  }
}

function colorIds(color: ApiColor, system: string): number[] {
  return (color.external_ids[system]?.ext_ids ?? []).filter(
    (id): id is number => typeof id === "number",
  );
}

function deriveColors(inputs: CrosswalkInputs): Record<string, CrosswalkColor> {
  const byLdraw = new Map<number, ApiColor[]>();
  for (const color of inputs.apiColors) {
    for (const code of colorIds(color, "LDraw")) pushTo(byLdraw, code, color);
  }
  const colors: Record<string, CrosswalkColor> = {};
  for (const { code, name } of inputs.ldrawColors) {
    const matches = byLdraw.get(code) ?? [];
    const only = matches.length === 1 ? matches[0] : undefined;
    const bricklink = only ? sortedUnique(colorIds(only, BRICKLINK_KEYWORD)) : [];
    colors[String(code)] = {
      name,
      rebrickable: only?.id ?? null,
      bricklink: bricklink.length === 1 ? (bricklink[0] ?? null) : null,
      rebrickableAlternatives: matches.length > 1 ? matches.map((m) => m.id) : [],
      bricklinkAlternatives: bricklink.length > 1 ? bricklink : [],
    };
  }
  return colors;
}

type LdrawFileKind = "canonical" | "alias" | "obsolete" | "physical-colour";

const FILE_KIND_PREFIXES: ReadonlyArray<readonly [string, LdrawFileKind]> = [
  ["=", "alias"],
  ["~", "obsolete"],
  ["_", "physical-colour"],
];

function fileKind(facts: LdrawPartFacts | undefined): LdrawFileKind {
  const title = facts?.title ?? "";
  return FILE_KIND_PREFIXES.find(([prefix]) => title.startsWith(prefix))?.[1] ?? "canonical";
}

function canonicalTarget(id: string, ldrawParts: ReadonlyMap<string, LdrawPartFacts>): string {
  const seen = new Set([id]);
  let current = id;
  for (
    let target = movedTarget(ldrawParts.get(current));
    target !== undefined && !seen.has(target);
    target = movedTarget(ldrawParts.get(current))
  ) {
    seen.add(target);
    current = target;
  }
  return current;
}

interface ReverseParts {
  readonly candidates: Record<string, string[]>;
  readonly variants: Record<string, string[]>;
}

function reverseBrickLinkParts(inputs: CrosswalkInputs): ReverseParts {
  const reverse = new Map<string, Set<string>>();
  const add = (bricklink: string, ldraw: string): void => {
    const target = canonicalTarget(ldraw, inputs.ldrawParts);
    const set = reverse.get(bricklink) ?? new Set<string>();
    set.add(target);
    reverse.set(bricklink, set);
  };
  for (const part of inputs.apiParts) {
    for (const bricklink of part.b) for (const ldraw of part.l) add(bricklink, ldraw);
  }
  for (const [ldraw, facts] of inputs.ldrawParts) {
    for (const bricklink of keywordIds(facts, BRICKLINK_KEYWORD)) add(bricklink, ldraw);
  }
  const candidates: Record<string, string[]> = {};
  const variants: Record<string, string[]> = {};
  for (const bricklink of sortedUnique(reverse.keys())) {
    const ids = sortedUnique(reverse.get(bricklink) ?? []);
    const canonical = ids.filter((id) => fileKind(inputs.ldrawParts.get(id)) === "canonical");
    const others = ids.filter((id) => !canonical.includes(id));
    const chosen = canonical.length > 0 ? canonical : others;
    candidates[bricklink] = chosen.map((id) => LDRAW_NAMESPACE + id);
    if (canonical.length > 0 && others.length > 0) {
      variants[bricklink] = others.map((id) => LDRAW_NAMESPACE + id);
    }
  }
  return { candidates, variants };
}

function reverseBrickLinkColors(colors: Record<string, CrosswalkColor>): Record<string, number[]> {
  const reverse = new Map<number, number[]>();
  for (const [code, color] of Object.entries(colors)) {
    if (color.bricklink !== null) pushTo(reverse, color.bricklink, Number(code));
  }
  return Object.fromEntries(
    sortedUnique(reverse.keys()).map((bricklink) => [
      String(bricklink),
      sortedUnique(reverse.get(bricklink) ?? []),
    ]),
  );
}

export function deriveCrosswalk(
  inputs: CrosswalkInputs,
  sources: Readonly<Record<string, CrosswalkSourcePin>>,
): CrosswalkFile {
  const resolver = new PartResolver(inputs);
  const parts = Object.fromEntries(
    sortedUnique(inputs.ldrawParts.keys()).map((id) => [
      LDRAW_NAMESPACE + id,
      resolver.resolve(id),
    ]),
  );
  const colors = deriveColors(inputs);
  const reverse = reverseBrickLinkParts(inputs);
  return {
    format: CROSSWALK_FORMAT,
    sources,
    parts,
    colors,
    bricklinkParts: reverse.candidates,
    bricklinkPartVariants: reverse.variants,
    bricklinkColors: reverseBrickLinkColors(colors),
  };
}
