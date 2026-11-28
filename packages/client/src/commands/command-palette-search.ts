import { inject, injectable } from "inversify";
import type { ICatalogSearch } from "../catalog/catalog-search.ts";
import { LibraryQuery } from "../catalog/library-query.ts";
import type { IPaletteCatalog } from "../catalog/palette-catalog.ts";
import type { IPaletteMemory } from "../catalog/palette-memory.ts";
import { COMMAND_CATALOG_SEARCH, PALETTE_CATALOG, PALETTE_MEMORY } from "../tokens.ts";
import { searchPalette, type PaletteResult } from "./command-search.ts";
import type { CommandId } from "./editor-commands.ts";

export type PaletteFind = (
  query: string,
  enabled: (id: CommandId) => boolean,
) => ReadonlyArray<PaletteResult>;

export interface CommandPaletteSnapshot {
  readonly find: PaletteFind;
}

export interface ICommandPaletteSearch {
  subscribe(listener: () => void): () => void;
  snapshot(): CommandPaletteSnapshot;
  search(query: string): void;
}

@injectable()
export class CommandPaletteSearch implements ICommandPaletteSearch {
  private readonly listeners = new Set<() => void>();
  private state: CommandPaletteSnapshot;

  constructor(
    @inject(PALETTE_CATALOG)
    private readonly catalog: Pick<IPaletteCatalog, "snapshot" | "subscribe">,
    @inject(COMMAND_CATALOG_SEARCH) private readonly catalogSearch: ICatalogSearch,
    @inject(PALETTE_MEMORY) private readonly memory: Pick<IPaletteMemory, "snapshot" | "subscribe">,
  ) {
    this.state = this.searched();
    catalog.subscribe(() => this.update());
    catalogSearch.subscribe(() => this.update());
    memory.subscribe(() => this.update());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): CommandPaletteSnapshot {
    return this.state;
  }

  search(query: string): void {
    this.catalogSearch.search(LibraryQuery.parse(query).remoteText);
  }

  private update(): void {
    this.state = this.searched();
    for (const listener of this.listeners) listener();
  }

  private searched(): CommandPaletteSnapshot {
    const { catalog, index } = this.catalog.snapshot();
    const recent = this.memory.snapshot().recents;
    const remote = this.catalogSearch.view();
    return {
      find: (query, enabled) => searchPalette(query, { catalog, index, recent, remote, enabled }),
    };
  }
}
