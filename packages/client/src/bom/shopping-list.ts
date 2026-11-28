import type { PartShapeAsset } from "@brr/catalog";
import { isCustomPartId, type BundleColor, type PartRole } from "@brr/schema/bundle";
import { importedSha256 } from "@brr/schema/world";
import {
  CATEGORY_LABEL,
  PALETTE_CATEGORIES,
  colorDisplayName,
  type PaletteCategory,
} from "../catalog/palette-index.ts";
import type { CatalogItemView } from "../catalog/placeable-catalog.ts";
import { partItemId, partTitle, type Placeable } from "../edit/placeable.ts";
import type { PieceElement } from "../edit/track-pieces.ts";
import type { ColorTable } from "../scene/viewer-scene.ts";

export type ShoppingSection = PaletteCategory | "models" | "parts";

const SHOPPING_SECTIONS: ReadonlyArray<ShoppingSection> = [
  ...PALETTE_CATEGORIES,
  "models",
  "parts",
];

export const SHOPPING_SECTION_LABEL: Readonly<Record<ShoppingSection, string>> = {
  ...CATEGORY_LABEL,
  models: "My models",
  parts: "Loose parts",
};

const ROLE_SECTION: Readonly<Record<PartRole, ShoppingSection>> = {
  ground: "baseplates",
  road: "road",
  track: "track",
  wall: "parts",
  roof: "parts",
  detail: "parts",
  model: "parts",
};

export interface ShoppingLine {
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly thumbnail: string | null;
  readonly partsEach: number;
  readonly quantity: number;
}

export interface ShoppingGroup {
  readonly section: ShoppingSection;
  readonly lines: ReadonlyArray<ShoppingLine>;
}

export interface ShoppingList {
  readonly asSets: ReadonlyArray<ShoppingGroup>;
  readonly asParts: ReadonlyArray<ShoppingGroup>;
}

type SectionLine = readonly [ShoppingSection, ShoppingLine];

function byLabel(a: ShoppingLine, b: ShoppingLine): number {
  return a.label.localeCompare(b.label, "en", { numeric: true });
}

class LineTally {
  private readonly lines = new Map<string, SectionLine>();

  add(entry: SectionLine): void {
    const [, line] = entry;
    const counted = this.lines.get(line.key);
    if (!counted) {
      this.lines.set(line.key, entry);
      return;
    }
    const [section, first] = counted;
    this.lines.set(line.key, [section, { ...first, quantity: first.quantity + line.quantity }]);
  }

  groups(): ReadonlyArray<ShoppingGroup> {
    const entries = [...this.lines.values()];
    return SHOPPING_SECTIONS.flatMap((section) => {
      const lines = entries.flatMap(([of, line]) => (of === section ? [line] : []));
      return lines.length > 0 ? [{ section, lines: lines.toSorted(byLabel) }] : [];
    });
  }
}

export class ShoppingListBuilder {
  private readonly asSets = new LineTally();
  private readonly asParts = new LineTally();
  private readonly thumbnails: ReadonlyMap<string, string | null>;
  private readonly colorNames: ReadonlyMap<number, string>;

  constructor(
    private readonly parts: ReadonlyArray<PartShapeAsset>,
    private readonly colors: ColorTable,
    bundleColors: ReadonlyArray<BundleColor>,
    items: ReadonlyArray<CatalogItemView>,
  ) {
    this.thumbnails = new Map(items.map((item) => [item.id, item.thumbnail]));
    this.colorNames = new Map(bundleColors.map(({ code, name }) => [code, colorDisplayName(name)]));
  }

  addPlaced(placeable: Pick<Placeable, "id" | "label" | "parts">, quantity: number): void {
    const { id, label, parts } = placeable;
    if (parts.count === 1 && !isCustomPartId(this.part(parts.partIndex[0] ?? 0).id)) {
      this.addToBoth(this.partLine(parts.partIndex[0] ?? 0, parts.colorIndex[0] ?? 0, quantity));
      return;
    }
    const model: ShoppingLine = {
      key: id,
      id,
      label,
      thumbnail: this.thumbnails.get(id) ?? null,
      partsEach: parts.count,
      quantity,
    };
    if (importedSha256(id) !== null) {
      this.addToBoth(["models", model]);
      return;
    }
    this.asSets.add(["sets", model]);
    for (let i = 0; i < parts.count; i++) {
      this.asParts.add(this.partLine(parts.partIndex[i] ?? 0, parts.colorIndex[i] ?? 0, quantity));
    }
  }

  addTrack(partIndex: number, colorIndex: number, piece: PieceElement, quantity: number): void {
    this.addToBoth(this.partLine(partIndex, colorIndex, quantity, piece));
  }

  list(): ShoppingList {
    return { asSets: this.asSets.groups(), asParts: this.asParts.groups() };
  }

  private addToBoth(entry: SectionLine): void {
    this.asSets.add(entry);
    this.asParts.add(entry);
  }

  private part(partIndex: number): PartShapeAsset {
    const part = this.parts[partIndex];
    if (!part) throw new RangeError(`part index ${partIndex} is not in the part table`);
    return part;
  }

  private partLine(
    partIndex: number,
    colorIndex: number,
    quantity: number,
    piece?: PieceElement,
  ): SectionLine {
    const part = this.part(partIndex);
    const ldrawColor = this.colors.codeAt(colorIndex);
    const { element, title } = piece ?? { element: part.id, title: part.title };
    const id = partItemId(part.id, ldrawColor);
    const colorName = this.colorNames.get(ldrawColor) ?? `LDraw colour ${ldrawColor}`;
    return [
      ROLE_SECTION[part.role],
      {
        key: partItemId(element, ldrawColor),
        id,
        label: `${partTitle(element, title)}, ${colorName}`,
        thumbnail: this.thumbnails.get(id) ?? null,
        partsEach: 1,
        quantity,
      },
    ];
  }
}
