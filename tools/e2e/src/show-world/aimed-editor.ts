import type { EditorSnapshot, IEditor, PlacementMode } from "@brr/client";
import type { AimedBackend } from "../held-out/headless-editor.ts";

export interface Point {
  readonly x: number;
  readonly z: number;
}

const DRAG_STEP_LDU = 160;
const SETTLE_FRAME_LIMIT = 2_000;
const LOAD_POLL_MS = 5;
const LOAD_TIMEOUT_MS = 300_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dragSteps(from: Point, to: Point): number {
  return Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / DRAG_STEP_LDU));
}

export class AimedEditor {
  constructor(
    readonly editor: IEditor,
    private readonly backend: AimedBackend,
    private readonly frame: () => Promise<void>,
  ) {}

  snapshot(): EditorSnapshot {
    return this.editor.snapshot();
  }

  hover(at: Point): void {
    this.backend.aim(at.x, at.z);
    this.editor.pointerMove(0, 0);
  }

  leave(): void {
    this.editor.pointerLeave();
  }

  click(at: Point): void {
    this.hover(at);
    this.editor.click(0, 0, performance.now());
  }

  drag(from: Point, to: Point): void {
    this.hover(from);
    this.editor.dragStart(0, 0);
    const steps = dragSteps(from, to);
    for (let step = 1; step <= steps; step++) {
      this.backend.aim(
        from.x + ((to.x - from.x) * step) / steps,
        from.z + ((to.z - from.z) * step) / steps,
      );
      this.editor.dragMove(0, 0);
    }
    this.editor.dragEnd(0, 0, performance.now());
  }

  setPlacementMode(mode: PlacementMode): void {
    this.editor.setPlacementMode(mode);
  }

  async hold(item: string | null): Promise<void> {
    this.leave();
    this.editor.chooseItem(item);
    await this.until(
      () => this.snapshot().activeItem === item && this.snapshot().pendingItem === null,
      `${item ?? "nothing"} to be held`,
    );
  }

  async settled(): Promise<void> {
    for (let frames = 0; ; frames++) {
      const { hover, studChecks, pendingItem } = this.snapshot();
      const placement = hover?.placement ?? null;
      const hoverSettled = placement === null || (placement.settled && placement.turnSettled);
      if (hoverSettled && studChecks === 0 && pendingItem === null) return;
      if (frames >= SETTLE_FRAME_LIMIT) {
        throw new Error(`the editor hasn't settled after ${SETTLE_FRAME_LIMIT} frames`);
      }
      await this.frame();
      await pause(0);
    }
  }

  async until(done: () => boolean, what: string): Promise<void> {
    const deadline = performance.now() + LOAD_TIMEOUT_MS;
    while (!done()) {
      if (performance.now() > deadline) {
        throw new Error(`timed out after ${LOAD_TIMEOUT_MS} ms waiting for ${what}`);
      }
      await this.frame();
      await pause(LOAD_POLL_MS);
    }
  }
}
