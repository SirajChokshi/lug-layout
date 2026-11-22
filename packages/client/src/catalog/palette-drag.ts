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

interface Drop {
  readonly ndcX: number;
  readonly ndcY: number;
  readonly eventTimeMs: number;
}

interface HeldDrop {
  readonly session: DragSession;
  readonly drop: Drop;
  readonly stop: () => void;
  ended: boolean;
}

@injectable()
export class PaletteDrag implements IPaletteDrag {
  private session: DragSession | null = null;
  private held: HeldDrop | null = null;

  constructor(
    @inject(EDITOR)
    private readonly editor: Pick<
      IEditor,
      "snapshot" | "subscribe" | "chooseItem" | "pointerMove" | "click"
    >,
  ) {}

  start(item: string): void {
    this.session = { item, activeBefore: this.editor.snapshot().activeItem };
    this.editor.chooseItem(item);
  }

  drop(ndcX: number, ndcY: number, eventTimeMs: number): void {
    const session = this.session;
    if (!session) return;
    const drop = { ndcX, ndcY, eventTimeMs };
    if (this.editor.snapshot().pendingItem !== session.item) {
      this.place(drop);
      return;
    }
    this.held?.stop();
    const stop = this.editor.subscribe(() => {
      if (this.held?.session === session && this.editor.snapshot().pendingItem !== session.item) {
        queueMicrotask(() => this.landHeld(session));
      }
    });
    this.held = { session, drop, stop, ended: false };
  }

  end(): void {
    const finished = this.session;
    this.session = null;
    if (!finished) return;
    if (this.held?.session === finished) {
      this.held.ended = true;
      return;
    }
    this.restore(finished);
  }

  private landHeld(session: DragSession): void {
    const held = this.held;
    if (held?.session !== session) return;
    held.stop();
    this.held = null;
    const { activeItem } = this.editor.snapshot();
    if (activeItem === session.item) this.place(held.drop);
    if (held.ended && (activeItem === session.item || activeItem === null)) this.restore(session);
  }

  private place(drop: Drop): void {
    this.editor.pointerMove(drop.ndcX, drop.ndcY);
    this.editor.click(drop.ndcX, drop.ndcY, drop.eventTimeMs);
  }

  private restore(finished: DragSession): void {
    if (finished.activeBefore !== finished.item) this.editor.chooseItem(finished.activeBefore);
  }
}
