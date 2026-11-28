import type { ILinkProgressShare } from "@brr/catalog/link-progress";

export class SharedProgress implements ILinkProgressShare {
  shared = 0;

  share(): void {
    this.shared += 1;
  }

  listen(): void {}
}
