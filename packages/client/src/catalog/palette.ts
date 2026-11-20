import { inject, injectable } from "inversify";
import {
  PALETTE_DRAG,
  PALETTE_MEMORY,
  PALETTE_PREFETCH,
  PALETTE_SEARCH,
  PALETTE_THUMBNAILS,
} from "../tokens.ts";
import type { IPaletteDrag } from "./palette-drag.ts";
import type { IPaletteMemory } from "./palette-memory.ts";
import type { IPalettePrefetch } from "./palette-prefetch.ts";
import type { IPaletteSearch } from "./palette-search.ts";
import type { IPaletteThumbnails } from "./palette-thumbnails.ts";

export interface IPalette {
  readonly search: IPaletteSearch;
  readonly drag: IPaletteDrag;
  readonly prefetch: IPalettePrefetch;
  readonly memory: IPaletteMemory;
  readonly thumbnails: IPaletteThumbnails;
}

@injectable()
export class Palette implements IPalette {
  constructor(
    @inject(PALETTE_SEARCH) readonly search: IPaletteSearch,
    @inject(PALETTE_DRAG) readonly drag: IPaletteDrag,
    @inject(PALETTE_PREFETCH) readonly prefetch: IPalettePrefetch,
    @inject(PALETTE_MEMORY) readonly memory: IPaletteMemory,
    @inject(PALETTE_THUMBNAILS) readonly thumbnails: IPaletteThumbnails,
  ) {}
}
