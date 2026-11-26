import type { ILinkProgressShare } from "./link-progress.ts";

export class Peers implements ILinkProgressShare {
  shared = 0;
  private readonly listeners: Array<() => void> = [];

  share(): void {
    this.shared += 1;
  }

  listen(listener: () => void): void {
    this.listeners.push(listener);
  }

  deliverShare(): void {
    for (const listener of this.listeners) listener();
  }
}
