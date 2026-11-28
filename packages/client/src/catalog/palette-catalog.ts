import { inject, injectable } from "inversify";
import type { EditorSnapshot, IEditor } from "../edit/editor.ts";
import { TRACK_ITEM_ID } from "../edit/track-edit-session.ts";
import { EDITOR } from "../tokens.ts";
import { PaletteIndex } from "./palette-index.ts";

export interface PaletteCatalogSnapshot {
  readonly catalog: EditorSnapshot["catalog"];
  readonly index: PaletteIndex;
  readonly skipped: EditorSnapshot["catalogSkipped"];
  readonly unplaceable: PaletteIndex;
  readonly offeredParts: ReadonlySet<string>;
  readonly offeredItems: ReadonlySet<string>;
}

export interface IPaletteCatalog {
  subscribe(listener: () => void): () => void;
  snapshot(): PaletteCatalogSnapshot;
}

interface IndexedCatalog extends PaletteCatalogSnapshot {
  readonly trackTerms: string;
}

const ELEMENT_NAMESPACE = /^[a-z]+:/u;
const LDRAW_GROUP = "ldraw:";

function offeredParts(catalog: EditorSnapshot["catalog"]): ReadonlySet<string> {
  return new Set(
    catalog.flatMap((item) =>
      item.group.startsWith(LDRAW_GROUP) ? [item.group.slice(LDRAW_GROUP.length)] : [],
    ),
  );
}

function offeredItems(
  catalog: EditorSnapshot["catalog"],
  skipped: EditorSnapshot["catalogSkipped"],
): ReadonlySet<string> {
  return new Set([...catalog.map((item) => item.id), ...skipped.map((model) => model.item.id)]);
}

function trackTerms(track: EditorSnapshot["track"]): ReadonlyArray<string> {
  return (track?.bom ?? []).flatMap((line) => [
    line.piece.replace(ELEMENT_NAMESPACE, ""),
    line.title,
  ]);
}

function indexCatalog(
  { catalog, catalogSkipped, track }: EditorSnapshot,
  previous: IndexedCatalog | null,
): IndexedCatalog {
  const terms = trackTerms(track);
  const key = terms.join("\n");
  const sameSkipped = previous?.skipped === catalogSkipped;
  if (previous?.catalog === catalog && previous.trackTerms === key && sameSkipped) return previous;
  return {
    catalog,
    trackTerms: key,
    index: new PaletteIndex(catalog, [{ entryKey: TRACK_ITEM_ID, terms }]),
    skipped: catalogSkipped,
    unplaceable:
      previous && sameSkipped
        ? previous.unplaceable
        : new PaletteIndex(catalogSkipped.map((model) => model.item)),
    offeredParts: previous?.catalog === catalog ? previous.offeredParts : offeredParts(catalog),
    offeredItems:
      previous?.catalog === catalog && sameSkipped
        ? previous.offeredItems
        : offeredItems(catalog, catalogSkipped),
  };
}

@injectable()
export class PaletteCatalog implements IPaletteCatalog {
  private readonly listeners = new Set<() => void>();
  private indexed: IndexedCatalog;

  constructor(@inject(EDITOR) private readonly editor: Pick<IEditor, "snapshot" | "subscribe">) {
    this.indexed = indexCatalog(editor.snapshot(), null);
    editor.subscribe(() => this.reindex());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): PaletteCatalogSnapshot {
    return this.indexed;
  }

  private reindex(): void {
    const next = indexCatalog(this.editor.snapshot(), this.indexed);
    if (next === this.indexed) return;
    this.indexed = next;
    for (const listener of this.listeners) listener();
  }
}
