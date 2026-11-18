import { inject, injectable } from "inversify";
import { PLACEABLE_CATALOG } from "../tokens.ts";
import type { IPlaceableCatalog } from "./placeable-catalog.ts";

export interface IPalettePrefetch {
  pointerEnter(id: string): void;
  pointerLeave(): void;
  focus(id: string): void;
}

const DWELL_MS = 120;

@injectable()
export class PalettePrefetch implements IPalettePrefetch {
  private dwell: ReturnType<typeof setTimeout> | null = null;

  constructor(
    @inject(PLACEABLE_CATALOG)
    private readonly catalog: Pick<IPlaceableCatalog, "itemRefId" | "load">,
  ) {}

  pointerEnter(id: string): void {
    this.pointerLeave();
    this.dwell = setTimeout(() => {
      this.dwell = null;
      this.prefetch(id);
    }, DWELL_MS);
  }

  pointerLeave(): void {
    if (this.dwell !== null) clearTimeout(this.dwell);
    this.dwell = null;
  }

  focus(id: string): void {
    this.prefetch(id);
  }

  private prefetch(id: string): void {
    const refId = this.catalog.itemRefId(id);
    if (refId !== null) void this.catalog.load(refId).catch(() => null);
  }
}
