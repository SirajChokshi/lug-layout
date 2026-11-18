import { THUMBNAIL_RENDERER, type IThumbnailRenderer } from "@brr/render";
import { inject, injectable } from "inversify";
import { PLACEABLE_CATALOG } from "../tokens.ts";
import type { CatalogItemModel, IPlaceableCatalog } from "./placeable-catalog.ts";

export const THUMBNAIL_PX = 112;

export interface IPaletteThumbnails {
  subscribe(listener: () => void): () => void;
  snapshot(): ReadonlyMap<string, string>;
  request(itemId: string): void;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

@injectable()
export class PaletteThumbnails implements IPaletteThumbnails {
  private readonly listeners = new Set<() => void>();
  private urls: ReadonlyMap<string, string> = new Map();
  private readonly asked = new Set<string>();
  private readonly queue: Array<{ readonly itemId: string; readonly source: CatalogItemModel }> =
    [];
  private draining = false;

  constructor(
    @inject(PLACEABLE_CATALOG) private readonly catalog: Pick<IPlaceableCatalog, "itemModel">,
    @inject(THUMBNAIL_RENDERER) private readonly renderer: IThumbnailRenderer,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): ReadonlyMap<string, string> {
    return this.urls;
  }

  request(itemId: string): void {
    if (this.asked.has(itemId)) return;
    this.asked.add(itemId);
    void this.catalog.itemModel(itemId).then((source) => {
      if (!source) return;
      this.queue.push({ itemId, source });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift()) {
        const url = await this.renderer.renderThumbnail({ ...next.source, sizePx: THUMBNAIL_PX });
        this.urls = new Map(this.urls).set(next.itemId, url);
        for (const listener of this.listeners) listener();
        await nextFrame();
      }
    } finally {
      this.draining = false;
    }
  }
}
