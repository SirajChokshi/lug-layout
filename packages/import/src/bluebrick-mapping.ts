import type { BlueBrickBudget, BlueBrickBudgetedPart, BlueBrickMap } from "@brr/schema/bluebrick";
import type { BrickCompiler, ModelRead } from "./brick-compiler.ts";
import type { LdrawMirror } from "./ldraw-mirror.ts";
import type { BricklinkToLdraw } from "./studio-mapping.ts";

export interface ResolvedPart {
  readonly part: string;
  readonly redirects: ReadonlyArray<string>;
  readonly component: boolean;
}

export interface LdrawPartResolver {
  resolve(part: string): Promise<ResolvedPart | null>;
}

export type BlueBrickPartVia = "ldraw" | "bricklink";

export type BlueBrickOutcome =
  | {
      readonly kind: "part";
      readonly part: string;
      readonly color: number;
      readonly via: BlueBrickPartVia;
      readonly redirects: ReadonlyArray<string>;
    }
  | { readonly kind: "model"; readonly model: string }
  | { readonly kind: "table" }
  | { readonly kind: "unknownColor"; readonly part: string; readonly color: number }
  | { readonly kind: "component"; readonly part: string }
  | {
      readonly kind: "ambiguous";
      readonly ldraw: string | null;
      readonly bricklink: ReadonlyArray<string>;
    }
  | { readonly kind: "notInLibrary" }
  | { readonly kind: "noModel" }
  | { readonly kind: "notAPart" };

export interface BlueBrickIdMapping {
  readonly id: string;
  readonly bricks: number;
  readonly groups: number;
  readonly outcome: BlueBrickOutcome;
}

export interface BlueBrickBudgetMapping extends BlueBrickBudgetedPart {
  readonly outcome: BlueBrickOutcome;
}

type PartReading =
  | Omit<Extract<BlueBrickOutcome, { kind: "part" }>, "color">
  | Extract<BlueBrickOutcome, { kind: "component" | "ambiguous" | "notInLibrary" }>;

type Resolve = (part: string) => Promise<ResolvedPart | null>;

interface ItemCounts {
  readonly bricks: number;
  readonly groups: number;
}

const PART_DIRECTORY = "parts/";
const PART_EXTENSION = ".dat";
const MOVED_TITLE = "~Moved to ";
const ALIAS_TITLE = "=";
const COMPONENT_TITLE = "~";
const INHERITED_COLOR = 16;
const IDENTITY_TRANSFORM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const COLORED_PART = /^(?<number>.+)\.(?<color>\d+)$/u;
const SET = /^(?<set>.+)\.set$/iu;
const TABLE = /^table/iu;
const NOT_A_FILE_NAME = /[\s/\\]/u;

function partName(reference: string): string {
  const name = reference.toLowerCase();
  return name.endsWith(PART_EXTENSION) ? name.slice(0, -PART_EXTENSION.length) : name;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function renumberedAs(read: ModelRead, title: string): string | null {
  const [target] = read.parts;
  const renumbersOnly =
    (title.startsWith(MOVED_TITLE) || title.startsWith(ALIAS_TITLE)) &&
    read.instancePart.length === 1 &&
    read.looseGeometry.length === 0 &&
    read.instanceColor[0] === INHERITED_COLOR &&
    IDENTITY_TRANSFORM.every((value, index) => read.instanceTransform[index] === value);
  return renumbersOnly && target !== undefined ? partName(target) : null;
}

export class MirrorPartResolver implements LdrawPartResolver {
  constructor(
    private readonly compiler: Pick<BrickCompiler, "readModel">,
    private readonly mirror: Pick<LdrawMirror, "file">,
  ) {}

  resolve(part: string): Promise<ResolvedPart | null> {
    return this.follow(partName(part), []);
  }

  private async follow(
    part: string,
    redirects: ReadonlyArray<string>,
  ): Promise<ResolvedPart | null> {
    const text = await this.mirror.file(`${PART_DIRECTORY}${part}${PART_EXTENSION}`);
    if (text === undefined) return null;
    const read = this.compiler.readModel(text);
    const title = read.sections[0]?.title ?? "";
    const target = renumberedAs(read, title);
    if (target === null || target === part || redirects.includes(target)) {
      const component = title.startsWith(COMPONENT_TITLE) && !title.startsWith(MOVED_TITLE);
      return { part, redirects, component };
    }
    return this.follow(target, [...redirects, part]);
  }
}

function memoized(library: LdrawPartResolver): Resolve {
  const resolved = new Map<string, Promise<ResolvedPart | null>>();
  return (part) => {
    const name = partName(part);
    const reading = resolved.get(name) ?? library.resolve(name);
    resolved.set(name, reading);
    return reading;
  };
}

function standaloneParts(found: ReadonlyArray<ResolvedPart | null>): ReadonlyArray<ResolvedPart> {
  const byPart = new Map<string, ResolvedPart>();
  for (const part of found) {
    if (part !== null && !part.component && !byPart.has(part.part)) byPart.set(part.part, part);
  }
  return [...byPart.values()].toSorted((a, b) => byText(a.part, b.part));
}

function partReading({ part, redirects }: ResolvedPart, via: BlueBrickPartVia): PartReading {
  return { kind: "part", part, via, redirects };
}

function itemCounts(map: BlueBrickMap): ReadonlyMap<string, ItemCounts> {
  const counts = new Map<string, ItemCounts>();
  const add = (id: string, bricks: number, groups: number): void => {
    const known = counts.get(id) ?? { bricks: 0, groups: 0 };
    counts.set(id, { bricks: known.bricks + bricks, groups: known.groups + groups });
  };
  for (const layer of map.layers) {
    if (layer.kind !== "brick") continue;
    for (const brick of layer.bricks) add(brick.part, 1, 0);
    for (const group of layer.groups) {
      if (group.part !== null && SET.test(group.part)) add(group.part, 0, 1);
    }
  }
  return counts;
}

export class BlueBrickPartMapper {
  constructor(
    private readonly library: LdrawPartResolver,
    private readonly crosswalk: BricklinkToLdraw,
    private readonly colors: ReadonlySet<number>,
    private readonly omrModels: ReadonlySet<string>,
  ) {}

  map(map: BlueBrickMap): Promise<ReadonlyArray<BlueBrickIdMapping>> {
    return this.mapEach([...itemCounts(map)].map(([id, counts]) => ({ id, ...counts })));
  }

  mapBudget(budget: BlueBrickBudget): Promise<ReadonlyArray<BlueBrickBudgetMapping>> {
    return this.mapEach(budget.parts);
  }

  private async mapEach<TItem extends { readonly id: string }>(
    items: ReadonlyArray<TItem>,
  ): Promise<ReadonlyArray<TItem & { readonly outcome: BlueBrickOutcome }>> {
    const resolve = memoized(this.library);
    const mappings = await Promise.all(
      items.map(async (item) => ({ ...item, outcome: await this.outcome(item.id, resolve) })),
    );
    return mappings.toSorted((a, b) => byText(a.id, b.id));
  }

  private async outcome(id: string, resolve: Resolve): Promise<BlueBrickOutcome> {
    const colored = COLORED_PART.exec(id)?.groups;
    const number = colored?.["number"];
    const color = colored?.["color"];
    if (number !== undefined && color !== undefined) {
      const reading = await this.reading(number, resolve);
      if (reading.kind !== "part") return reading;
      const code = Number(color);
      return this.colors.has(code)
        ? { ...reading, color: code }
        : { kind: "unknownColor", part: reading.part, color: code };
    }
    const set = SET.exec(id)?.groups?.["set"];
    if (set !== undefined) {
      return this.omrModels.has(set) ? { kind: "model", model: set } : { kind: "noModel" };
    }
    return TABLE.test(id) ? { kind: "table" } : { kind: "notAPart" };
  }

  private async reading(number: string, resolve: Resolve): Promise<PartReading> {
    if (NOT_A_FILE_NAME.test(number)) return { kind: "notInLibrary" };
    const [file = null, ...bricklink] = await Promise.all([
      resolve(number),
      ...this.crosswalk.ldrawCandidates(number).map(resolve),
    ]);
    const ldraw = file !== null && !file.component ? file : null;
    const candidates = standaloneParts(bricklink);
    const named = candidates.map((candidate) => candidate.part);
    if (ldraw !== null && (named.length === 0 || named.includes(ldraw.part))) {
      return partReading(ldraw, "ldraw");
    }
    const [only, ...others] = candidates;
    if (ldraw === null && only !== undefined && others.length === 0) {
      return partReading(only, "bricklink");
    }
    if (ldraw === null && only === undefined) {
      return file === null ? { kind: "notInLibrary" } : { kind: "component", part: file.part };
    }
    return { kind: "ambiguous", ldraw: file?.part ?? null, bricklink: named };
  }
}
