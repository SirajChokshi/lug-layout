import { inject, injectable } from "inversify";
import type { IEditor } from "../edit/editor.ts";
import { EDITOR } from "../tokens.ts";

export interface IPalettePrefetch {
  pointerEnter(id: string): void;
  pointerLeave(): void;
  focus(id: string): void;
}

const DWELL_MS = 120;

@injectable()
export class PalettePrefetch implements IPalettePrefetch {
  private dwell: ReturnType<typeof setTimeout> | null = null;

  constructor(@inject(EDITOR) private readonly editor: Pick<IEditor, "prefetch">) {}

  pointerEnter(id: string): void {
    this.pointerLeave();
    this.dwell = setTimeout(() => {
      this.dwell = null;
      void this.editor.prefetch(id);
    }, DWELL_MS);
  }

  pointerLeave(): void {
    if (this.dwell !== null) clearTimeout(this.dwell);
    this.dwell = null;
  }

  focus(id: string): void {
    void this.editor.prefetch(id);
  }
}
