import { inject, injectable } from "inversify";
import type { ICommandPaletteSearch } from "../commands/command-palette-search.ts";
import {
  COMMAND_PALETTE_SEARCH,
  LIBRARY_PART_PLACER,
  OMR_SET_PLACER,
  PALETTE_DRAG,
  PALETTE_MEMORY,
  PALETTE_PREFETCH,
  PALETTE_SEARCH,
  PALETTE_THUMBNAILS,
} from "../tokens.ts";
import type { ILibraryPartPlacer } from "./library-part-placer.ts";
import type { IOmrSetPlacer } from "./omr-set-placer.ts";
import type { IPaletteDrag } from "./palette-drag.ts";
import type { IPaletteMemory } from "./palette-memory.ts";
import type { IPalettePrefetch } from "./palette-prefetch.ts";
import type { IPaletteSearch } from "./palette-search.ts";
import type { IPaletteThumbnails } from "./palette-thumbnails.ts";

export interface IPalette {
  readonly search: IPaletteSearch;
  readonly commandSearch: ICommandPaletteSearch;
  readonly drag: IPaletteDrag;
  readonly prefetch: IPalettePrefetch;
  readonly memory: IPaletteMemory;
  readonly thumbnails: IPaletteThumbnails;
  readonly libraryPlacer: ILibraryPartPlacer;
  readonly omrSetPlacer: IOmrSetPlacer;
}

@injectable()
export class Palette implements IPalette {
  constructor(
    @inject(PALETTE_SEARCH) readonly search: IPaletteSearch,
    @inject(COMMAND_PALETTE_SEARCH) readonly commandSearch: ICommandPaletteSearch,
    @inject(PALETTE_DRAG) readonly drag: IPaletteDrag,
    @inject(PALETTE_PREFETCH) readonly prefetch: IPalettePrefetch,
    @inject(PALETTE_MEMORY) readonly memory: IPaletteMemory,
    @inject(PALETTE_THUMBNAILS) readonly thumbnails: IPaletteThumbnails,
    @inject(LIBRARY_PART_PLACER) readonly libraryPlacer: ILibraryPartPlacer,
    @inject(OMR_SET_PLACER) readonly omrSetPlacer: IOmrSetPlacer,
  ) {}
}
