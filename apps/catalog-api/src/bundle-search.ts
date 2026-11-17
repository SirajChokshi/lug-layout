import { BundleIndex, type BundleModelEntry } from "@brr/schema/bundle";
import {
  BUNDLE_SEARCH_LOD,
  MIN_PREFIX_LETTERS,
  bundleManifestFile,
  type BundleManifestKey,
  type BundleSearchHit,
  type BundleSearchSection,
} from "@brr/schema/catalog-api";
import { decode, issueText } from "@brr/schema/decode";
import * as v from "valibot";

const SearchedIndex = v.pick(BundleIndex, ["colors", "models", "catalogParts", "trackCatalog"]);
type SearchedIndex = v.InferOutput<typeof SearchedIndex>;

export type LoadedIndex =
  | { readonly kind: "found"; readonly index: BundleSearchIndex }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly message: string };

interface IndexedItem {
  readonly hit: BundleSearchHit;
  readonly identifiers: ReadonlySet<string>;
  readonly words: ReadonlySet<string>;
}

interface Scored {
  readonly hit: BundleSearchHit;
  readonly score: number;
  readonly order: number;
}

const SECTION_LABEL: Readonly<Record<BundleSearchSection, string>> = {
  track: "Track",
  baseplates: "Baseplates",
  road: "Road",
  mils: "MILS modules",
  sets: "Sets",
};
const IDENTIFIER_WORD = 3;
const WHOLE_WORD = 2;
const PREFIX_WORD = 1;
const KEPT_INDEXES = 4;
const MANIFEST_EDGE_TTL_SECONDS = 31_536_000;
const NOT_PUBLISHED = 404;
const LDRAW_NAMESPACE = /^ldraw:/u;
const queryWord = /[\p{L}\p{N}]+/gu;
const sizeWords = /(\d+)\s*x\s*(\d+)/gu;

function wordsOf(...texts: ReadonlyArray<string>): ReadonlyArray<string> {
  return texts.flatMap((text) => {
    const lower = text.normalize("NFKC").toLowerCase();
    return [
      ...(lower.match(queryWord) ?? []),
      ...[...lower.matchAll(sizeWords)].map(([, wide, deep]) => `${wide}x${deep}`),
    ];
  });
}

function partNumber(id: string): string {
  return id.replace(LDRAW_NAMESPACE, "");
}

function indexed(
  hit: BundleSearchHit,
  identifiers: ReadonlyArray<string>,
  texts: ReadonlyArray<string>,
): IndexedItem {
  return {
    hit,
    identifiers: new Set(wordsOf(...identifiers)),
    words: new Set(wordsOf(hit.label, SECTION_LABEL[hit.section], ...identifiers, ...texts)),
  };
}

function partItems(index: SearchedIndex): ReadonlyArray<IndexedItem> {
  const colorNames = new Map(index.colors.map((color) => [color.code, color.name]));
  return index.catalogParts.flatMap((part) => {
    if (part.role !== "ground" && part.role !== "road") return [];
    const number = partNumber(part.id);
    const section = part.role === "road" ? "road" : "baseplates";
    const kind = part.role === "road" ? "road-plate" : "baseplate";
    const rebrickable = part.producedColors?.rebrickable;
    return (part.producedColors?.colors ?? []).map((produced) => {
      const colorName = colorNames.get(produced.ldraw) ?? String(produced.ldraw);
      return indexed(
        {
          id: `${part.id}@${produced.ldraw}`,
          label: `${number} ${part.title}, ${colorName}`,
          section,
          kind,
          file: part.shape.file,
        },
        [number, ...(rebrickable === undefined ? [] : [rebrickable]), ...produced.elements],
        [colorName],
      );
    });
  });
}

function setLabel(model: BundleModelEntry): string {
  return model.set ? `${model.name} ${model.set.name} (${model.set.year})` : model.name;
}

function modelItem(model: BundleModelEntry): IndexedItem {
  const isModule = model.role === "mils-module";
  return indexed(
    {
      id: isModule ? `generated:${model.name}` : `omr:${model.name}`,
      label: isModule ? (model.sections[0]?.title ?? model.name) : setLabel(model),
      section: isModule ? "mils" : "sets",
      kind: isModule ? "mils-module" : "model",
      file: model.file,
    },
    isModule ? [] : [model.name],
    isModule ? [model.name] : [model.set?.name ?? ""],
  );
}

function trackItems(index: SearchedIndex): ReadonlyArray<IndexedItem> {
  const systems = [...new Set(index.trackCatalog.pieces.map((piece) => piece.system))];
  return systems.map((system) => {
    const pieces = index.trackCatalog.pieces.filter((piece) => piece.system === system);
    return indexed(
      {
        id: `track:${system}`,
        label: `Track (${system})`,
        section: "track",
        kind: "track",
        file: null,
      },
      pieces.map((piece) => partNumber(piece.part)),
      pieces.map((piece) => piece.title),
    );
  });
}

function wordScore(item: IndexedItem, token: string, prefix: boolean): number {
  if (item.identifiers.has(token)) return IDENTIFIER_WORD;
  if (item.words.has(token)) return WHOLE_WORD;
  if (!prefix) return 0;
  for (const word of item.words) if (word.startsWith(token)) return PREFIX_WORD;
  return 0;
}

export class BundleSearchIndex {
  private readonly items: ReadonlyArray<IndexedItem>;

  constructor(index: SearchedIndex) {
    const placeableModels = index.models.filter(
      (model) => model.role === "mils-module" || model.origin === "omr",
    );
    this.items = [...trackItems(index), ...partItems(index), ...placeableModels.map(modelItem)];
  }

  search(tokens: ReadonlyArray<string>, limit: number): ReadonlyArray<BundleSearchHit> {
    const last = tokens.length - 1;
    const scored: Scored[] = [];
    this.items.forEach((item, order) => {
      let score = 0;
      for (const [position, token] of tokens.entries()) {
        const typing = position === last && token.length >= MIN_PREFIX_LETTERS;
        const matched = wordScore(item, token, typing);
        if (matched === 0) return;
        score += matched;
      }
      scored.push({ hit: item.hit, score, order });
    });
    return scored
      .toSorted((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, limit)
      .map(({ hit }) => hit);
  }
}

export function bundleSearchObjectKey(key: BundleManifestKey): string {
  return `${BUNDLE_SEARCH_LOD}/${bundleManifestFile(key)}`;
}

export class BundleSearchDirectory {
  private readonly loaded = new Map<BundleManifestKey, Promise<LoadedIndex>>();

  async find(bundleBaseUrl: string, key: BundleManifestKey): Promise<LoadedIndex> {
    const known = this.loaded.get(key);
    if (known !== undefined) {
      this.loaded.delete(key);
      this.loaded.set(key, known);
      return known;
    }
    const loading = readIndex(bundleBaseUrl, key);
    this.loaded.set(key, loading);
    try {
      const result = await loading;
      if (result.kind === "found") this.evictBeyond(KEPT_INDEXES);
      else this.loaded.delete(key);
      return result;
    } catch (error) {
      this.loaded.delete(key);
      throw error;
    }
  }

  private evictBeyond(count: number): void {
    for (const key of this.loaded.keys()) {
      if (this.loaded.size <= count) return;
      this.loaded.delete(key);
    }
  }
}

async function readIndex(bundleBaseUrl: string, key: BundleManifestKey): Promise<LoadedIndex> {
  const url = new URL(bundleSearchObjectKey(key), bundleBaseUrl);
  let response: Response;
  try {
    response = await fetch(url, {
      cf: { cacheEverything: true, cacheTtl: MANIFEST_EDGE_TTL_SECONDS },
    });
  } catch (error) {
    return { kind: "unreadable", message: `the part bundle is unreachable: ${String(error)}` };
  }
  if (response.status === NOT_PUBLISHED) {
    await response.body?.cancel();
    return { kind: "missing" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { kind: "unreadable", message: `the part bundle answered ${response.status}` };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    return { kind: "unreadable", message: `manifest is not JSON: ${String(error)}` };
  }
  const decoded = decode(SearchedIndex, parsed, "manifest");
  if (!decoded.ok) return { kind: "unreadable", message: issueText(decoded.issues) };
  return { kind: "found", index: new BundleSearchIndex(decoded.value) };
}
