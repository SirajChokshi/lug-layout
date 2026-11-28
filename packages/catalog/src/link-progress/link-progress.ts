import { inject, injectable } from "inversify";
import { LINK_PROGRESS_SHARE } from "../tokens.ts";

export const LINK_PROGRESS_MIN_SHARE_GAP_MS = 1000;

export interface ILinkProgressShare {
  share(): void;
  listen(listener: () => void): void;
}

export interface ILinkProgress {
  markProgress(): void;
  silenceMs(): number;
}

@injectable()
export class LinkProgress implements ILinkProgress {
  private lastProgressAt = Number.NEGATIVE_INFINITY;
  private lastSharedAt = Number.NEGATIVE_INFINITY;

  constructor(@inject(LINK_PROGRESS_SHARE) private readonly peers: ILinkProgressShare) {
    peers.listen(() => {
      this.lastProgressAt = performance.now();
    });
  }

  markProgress(): void {
    const now = performance.now();
    this.lastProgressAt = now;
    if (now - this.lastSharedAt < LINK_PROGRESS_MIN_SHARE_GAP_MS) return;
    this.lastSharedAt = now;
    this.peers.share();
  }

  silenceMs(): number {
    return performance.now() - this.lastProgressAt;
  }
}
