import { inject, injectable } from "inversify";
import type { EditorSnapshot, IEditor } from "../edit/editor.ts";
import { TRACK_ITEM_ID } from "../edit/track-edit-session.ts";
import { EDITOR } from "../tokens.ts";
import { PaletteIndex } from "./palette-index.ts";

export interface PaletteCatalogSnapshot {
  readonly catalog: EditorSnapshot["catalog"];
  readonly index: PaletteIndex;
  readonly offeredParts: ReadonlySet<string>;
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

function trackTerms(track: EditorSnapshot["track"]): ReadonlyArray<string> {
  return (track?.bom ?? []).flatMap((line) => [
    line.piece.replace(ELEMENT_NAMESPACE, ""),
    line.title,
  ]);
}

function indexCatalog(
  { catalog, track }: EditorSnapshot,
  previous: IndexedCatalog | null,
): IndexedCatalog {
  const terms = trackTerms(track);
  const key = terms.join("\n");
  if (previous?.catalog === catalog && previous.trackTerms === key) return previous;
  return {
    catalog,
    trackTerms: key,
    index: new PaletteIndex(catalog, [{ entryKey: TRACK_ITEM_ID, terms }]),
    offeredParts: previous?.catalog === catalog ? previous.offeredParts : offeredParts(catalog),
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
