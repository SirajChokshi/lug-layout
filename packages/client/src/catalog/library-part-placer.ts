import { inject, injectable } from "inversify";
import type { IEditor } from "../edit/editor.ts";
import type { ModelFileInput } from "../edit/world-session.ts";
import { EDITOR } from "../tokens.ts";
import type { LibraryPartView } from "./library-part-index.ts";
import { colorDisplayName } from "./palette-index.ts";
import type { CatalogColorView } from "./placeable-catalog.ts";

export interface LibraryPlacementTarget {
  readonly part: string;
  readonly color: number;
}

export interface LibraryPlacementRefusal extends LibraryPlacementTarget {
  readonly reason: string;
}

export interface LibraryPlacementView {
  readonly pending: LibraryPlacementTarget | null;
  readonly refused: LibraryPlacementRefusal | null;
}

export interface ILibraryPartPlacer {
  view(): LibraryPlacementView;
  subscribe(listener: () => void): () => void;
  place(part: LibraryPartView, color: CatalogColorView): Promise<boolean>;
}

const IDENTITY_AT_ORIGIN = "0 0 0 1 0 0 0 1 0 0 0 1";
const UNREADABLE_REFUSAL = "it could not be imported";

export function importRefusal(editor: Pick<IEditor, "snapshot">, fileName: string): string {
  const { modelImport, fileError } = editor.snapshot();
  if (modelImport?.file === fileName && modelImport.reason !== null) return modelImport.reason;
  return fileError ?? UNREADABLE_REFUSAL;
}

export function libraryPartFile(
  part: Pick<LibraryPartView, "id" | "title">,
  color: CatalogColorView,
): ModelFileInput {
  const line = `1 ${color.code} ${IDENTITY_AT_ORIGIN} ${part.id}.dat\n`;
  return {
    name: `${part.id} ${part.title} in ${colorDisplayName(color.name)}.ldr`,
    bytes: new TextEncoder().encode(line),
  };
}

@injectable()
export class LibraryPartPlacer implements ILibraryPartPlacer {
  private readonly listeners = new Set<() => void>();
  private state: LibraryPlacementView = { pending: null, refused: null };

  constructor(
    @inject(EDITOR) private readonly editor: Pick<IEditor, "importModelFile" | "snapshot">,
  ) {}

  view(): LibraryPlacementView {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async place(part: LibraryPartView, color: CatalogColorView): Promise<boolean> {
    if (this.state.pending !== null) return false;
    const target = { part: part.id, color: color.code };
    const file = libraryPartFile(part, color);
    this.set({ pending: target, refused: null });
    const placed = await this.editor.importModelFile(file);
    this.set({
      pending: null,
      refused: placed ? null : { ...target, reason: importRefusal(this.editor, file.name) },
    });
    return placed;
  }

  private set(next: LibraryPlacementView): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
