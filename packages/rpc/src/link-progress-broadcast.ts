import { LINK_PROGRESS_PROTOCOL } from "./protocols.ts";
import { RpcEndpoint, type RpcPort } from "./rpc-endpoint.ts";

export interface LinkProgressShared {
  readonly kind: "progress";
}

const SHARED: LinkProgressShared = { kind: "progress" };

export class LinkProgressBroadcast {
  private readonly endpoint: RpcEndpoint<LinkProgressShared, LinkProgressShared>;

  constructor(port: RpcPort) {
    this.endpoint = new RpcEndpoint(port, LINK_PROGRESS_PROTOCOL);
  }

  share(): void {
    this.endpoint.post(SHARED);
  }

  listen(listener: () => void): void {
    this.endpoint.listen(() => listener());
  }
}

export function openLinkProgressBroadcast(): LinkProgressBroadcast {
  const { name, version } = LINK_PROGRESS_PROTOCOL;
  return new LinkProgressBroadcast(new BroadcastChannel(`${name}.v${version}`));
}
