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

export interface LdrawComponent {
  readonly id: string;
  readonly color: number;
}

export interface LdrawPartFacts {
  readonly title: string;
  readonly keywords: ReadonlyArray<string>;
  readonly ldrawOrg: string;
  readonly components: ReadonlyArray<LdrawComponent>;
}

export interface CrosswalkInputs {
  readonly apiParts: ReadonlyArray<ApiPart>;
  readonly apiColors: ReadonlyArray<ApiColor>;
  readonly rebrickableParts: ReadonlySet<string>;
  readonly ldrawParts: ReadonlyMap<string, LdrawPartFacts>;
  readonly ldrawColors: ReadonlyArray<{ readonly code: number; readonly name: string }>;
}

export type RebrickableVia =
  | "rebrickable-api"
  | "ldraw-keyword"
  | "bricklink-keyword"
  | `moved:${string}`;
export type BrickLinkVia = "rebrickable-api" | "ldraw-keyword";

export interface CrosswalkPart {
  readonly rebrickable: string | null;
  readonly bricklink: string | null;
  readonly via: {
    readonly rebrickable: RebrickableVia | null;
    readonly bricklink: BrickLinkVia | null;
  };
  readonly rebrickableAlternatives?: ReadonlyArray<string>;
  readonly bricklinkAlternatives?: ReadonlyArray<string>;
  readonly bricklinkKeywordNamesAssembly?: ReadonlyArray<string>;
  readonly components?: ReadonlyArray<{ readonly part: string; readonly color: number }>;
}

export interface CrosswalkColor {
  readonly name: string;
  readonly rebrickable: number | null;
  readonly bricklink: number | null;
  readonly rebrickableAlternatives?: ReadonlyArray<number>;
  readonly bricklinkAlternatives?: ReadonlyArray<number>;
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

const REBRICKABLE_UNKNOWN_COLOR = -1;
const REBRICKABLE_ANY_COLOR = 9999;
const REBRICKABLE_PLACEHOLDER_COLORS: ReadonlySet<number> = new Set([
  REBRICKABLE_UNKNOWN_COLOR,
  REBRICKABLE_ANY_COLOR,
]);
const EXPANDED_ORG_KINDS: ReadonlySet<string> = new Set(["Shortcut", "Alias"]);

function keywordIds(facts: LdrawPartFacts | undefined, system: string): string[] {
  if (!facts) return [];
  const wanted = system.toLowerCase();
  return facts.keywords.flatMap((keyword) => {
    const [name, id, ...rest] = keyword.split(/\s+/u);
    return name?.toLowerCase() === wanted && id !== undefined && rest.length === 0 ? [id] : [];
  });
}

function expandsToComponents(facts: LdrawPartFacts | undefined): boolean {
  return (facts?.ldrawOrg.split(/\s+/u) ?? []).some((kind) => EXPANDED_ORG_KINDS.has(kind));
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

const NOT_A_FILE_NAME = /[\s/\\]/u;

function isLdrawFileName(id: string): boolean {
  return id !== "" && !NOT_A_FILE_NAME.test(id);
}

function assemblyKeywords(inputs: CrosswalkInputs): Map<string, Set<string>> {
  const holders = new Map<string, string[]>();
  for (const [ldraw, facts] of inputs.ldrawParts) {
    for (const bricklink of keywordIds(facts, BRICKLINK_KEYWORD)) pushTo(holders, bricklink, ldraw);
  }
  const rejected = new Map<string, Set<string>>();
  for (const [bricklink, files] of holders) {
    for (const piece of files) {
      const inAssembly = files.some((other) => {
        const components = inputs.ldrawParts.get(other)?.components ?? [];
        return (
          other !== piece &&
          components.length > 1 &&
          components.some((component) => component.id === piece)
        );
      });
      if (!inAssembly) continue;
      const set = rejected.get(piece) ?? new Set<string>();
      set.add(bricklink);
      rejected.set(piece, set);
    }
  }
  return rejected;
}

class PartResolver {
  private readonly rebrickableByLdraw = new Map<string, string[]>();
  private readonly bricklinkByRebrickable = new Map<string, ReadonlyArray<string>>();
  private readonly rebrickableByBrickLink = new Map<string, string[]>();
  private readonly inputs: CrosswalkInputs;
  private readonly rejectedKeywords: ReadonlyMap<string, ReadonlySet<string>>;

  constructor(inputs: CrosswalkInputs, rejectedKeywords: ReadonlyMap<string, ReadonlySet<string>>) {
    this.inputs = inputs;
    this.rejectedKeywords = rejectedKeywords;
    for (const part of inputs.apiParts) {
      this.bricklinkByRebrickable.set(part.r, part.b);
      for (const ldraw of part.l.filter(isLdrawFileName)) {
        pushTo(this.rebrickableByLdraw, ldraw, part.r);
      }
      for (const bricklink of part.b) pushTo(this.rebrickableByBrickLink, bricklink, part.r);
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
    const throughBrickLink = this.brickLinkKeywords(id).flatMap(
      (bricklink) => this.rebrickableByBrickLink.get(bricklink) ?? [],
    );
    if (throughBrickLink.length > 0) {
      return { ids: sortedUnique(throughBrickLink), via: "bricklink-keyword" };
    }
    const target = movedTarget(facts);
    if (target !== undefined && !seen.has(target)) {
      const moved = this.candidates(target, new Set([...seen, target]));
      if (moved) return { ids: moved.ids, via: `moved:${target}` };
    }
    return null;
  }

  private choose(id: string, ids: ReadonlyArray<string>): string | null {
    const named = keywordIds(this.inputs.ldrawParts.get(id), REBRICKABLE_KEYWORD).filter((rb) =>
      ids.includes(rb),
    );
    if (named.length === 1) return named[0] ?? null;
    if (ids.length === 1) return ids[0] ?? null;
    return ids.includes(id) ? id : null;
  }

  private brickLinkKeywords(id: string): string[] {
    const rejected = this.rejectedKeywords.get(id);
    return keywordIds(this.inputs.ldrawParts.get(id), BRICKLINK_KEYWORD).filter(
      (bricklink) => !rejected?.has(bricklink),
    );
  }

  resolve(id: string): CrosswalkPart {
    const found = this.candidates(id, new Set([id]));
    const rebrickable = found ? this.choose(id, found.ids) : null;
    const keywordBrickLink = this.brickLinkKeywords(id);
    const assemblyKeywordsOfPart = [...(this.rejectedKeywords.get(id) ?? [])].toSorted();
    const apiBrickLink =
      rebrickable === null ? [] : [...(this.bricklinkByRebrickable.get(rebrickable) ?? [])];
    const bricklinkCandidates = apiBrickLink.length > 0 ? apiBrickLink : keywordBrickLink;
    const bricklink =
      bricklinkCandidates.find((candidate) => keywordBrickLink.includes(candidate)) ??
      bricklinkCandidates[0] ??
      null;
    const rebrickableAlternatives = (found?.ids ?? []).filter((other) => other !== rebrickable);
    const bricklinkAlternatives = sortedUnique(bricklinkCandidates).filter(
      (other) => other !== bricklink,
    );
    return {
      rebrickable,
      bricklink,
      via: {
        rebrickable: found?.via ?? null,
        bricklink:
          bricklink === null ? null : apiBrickLink.length > 0 ? "rebrickable-api" : "ldraw-keyword",
      },
      ...(rebrickableAlternatives.length > 0 ? { rebrickableAlternatives } : {}),
      ...(bricklinkAlternatives.length > 0 ? { bricklinkAlternatives } : {}),
      ...(assemblyKeywordsOfPart.length > 0
        ? { bricklinkKeywordNamesAssembly: assemblyKeywordsOfPart }
        : {}),
      ...this.components(id, rebrickable, bricklink),
    };
  }

  private components(
    id: string,
    rebrickable: string | null,
    bricklink: string | null,
  ): { components?: ReadonlyArray<{ part: string; color: number }> } {
    const facts = this.inputs.ldrawParts.get(id);
    if (rebrickable !== null || bricklink !== null || !expandsToComponents(facts)) return {};
    const components = facts?.components ?? [];
    if (components.length === 0) return {};
    return {
      components: components.map(({ id: part, color }) => ({
        part: LDRAW_NAMESPACE + part,
        color,
      })),
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
    if (REBRICKABLE_PLACEHOLDER_COLORS.has(color.id)) continue;
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
      ...(matches.length > 1 ? { rebrickableAlternatives: matches.map((m) => m.id) } : {}),
      ...(bricklink.length > 1 ? { bricklinkAlternatives: bricklink } : {}),
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

function reverseBrickLinkParts(
  inputs: CrosswalkInputs,
  rejectedKeywords: ReadonlyMap<string, ReadonlySet<string>>,
): ReverseParts {
  const reverse = new Map<string, Set<string>>();
  const add = (bricklink: string, ldraw: string): void => {
    const target = canonicalTarget(ldraw, inputs.ldrawParts);
    const set = reverse.get(bricklink) ?? new Set<string>();
    set.add(target);
    reverse.set(bricklink, set);
  };
  for (const part of inputs.apiParts) {
    for (const bricklink of part.b) {
      for (const ldraw of part.l.filter(isLdrawFileName)) add(bricklink, ldraw);
    }
  }
  for (const [ldraw, facts] of inputs.ldrawParts) {
    for (const bricklink of keywordIds(facts, BRICKLINK_KEYWORD)) {
      if (!rejectedKeywords.get(ldraw)?.has(bricklink)) add(bricklink, ldraw);
    }
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
  const rejectedKeywords = assemblyKeywords(inputs);
  const resolver = new PartResolver(inputs, rejectedKeywords);
  const ldrawIds = [
    ...inputs.ldrawParts.keys(),
    ...inputs.apiParts.flatMap((part) => part.l.filter(isLdrawFileName)),
  ];
  const parts = Object.fromEntries(
    sortedUnique(ldrawIds).flatMap((id) => {
      const part = resolver.resolve(id);
      const listed =
        part.rebrickable !== null ||
        part.bricklink !== null ||
        part.components !== undefined ||
        part.rebrickableAlternatives !== undefined ||
        part.bricklinkKeywordNamesAssembly !== undefined;
      return listed ? [[LDRAW_NAMESPACE + id, part] as const] : [];
    }),
  );
  const colors = deriveColors(inputs);
  const reverse = reverseBrickLinkParts(inputs, rejectedKeywords);
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
