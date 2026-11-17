import { THUMBNAIL_RENDERER, type IThumbnailRenderer } from "@brr/render";
import { inject, injectable } from "inversify";
import type { IEditor } from "../edit/editor.ts";
import { EDITOR } from "../tokens.ts";

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
  private readonly queue: string[] = [];
  private draining = false;

  constructor(
    @inject(EDITOR) private readonly editor: IEditor,
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
    this.queue.push(itemId);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let itemId = this.queue.shift(); itemId !== undefined; itemId = this.queue.shift()) {
        const source = this.editor.catalogItemModel(itemId);
        if (!source) continue;
        const url = await this.renderer.renderThumbnail({ ...source, sizePx: THUMBNAIL_PX });
        this.urls = new Map(this.urls).set(itemId, url);
        for (const listener of this.listeners) listener();
        await nextFrame();
      }
    } finally {
      this.draining = false;
    }
  }
}
