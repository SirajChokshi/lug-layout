import { inject, injectable } from "inversify";
import type { IEditor } from "../edit/editor.ts";
import { EDITOR } from "../tokens.ts";

export interface IPaletteDrag {
  start(item: string): void;
  drop(ndcX: number, ndcY: number, eventTimeMs: number): void;
  end(): void;
}

interface DragSession {
  readonly item: string;
  readonly activeBefore: string | null;
}

@injectable()
export class PaletteDrag implements IPaletteDrag {
  private session: DragSession | null = null;

  constructor(
    @inject(EDITOR)
    private readonly editor: Pick<IEditor, "snapshot" | "chooseItem" | "pointerMove" | "click">,
  ) {}

  start(item: string): void {
    this.session = { item, activeBefore: this.editor.snapshot().activeItem };
    this.editor.chooseItem(item);
  }

  drop(ndcX: number, ndcY: number, eventTimeMs: number): void {
    if (!this.session) return;
    this.editor.pointerMove(ndcX, ndcY);
    this.editor.click(ndcX, ndcY, eventTimeMs);
  }

  end(): void {
    const finished = this.session;
    this.session = null;
    if (finished && finished.activeBefore !== finished.item) {
      this.editor.chooseItem(finished.activeBefore);
    }
  }
}
