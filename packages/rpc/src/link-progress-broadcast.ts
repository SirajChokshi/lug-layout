import { LINK_PROGRESS_PROTOCOL } from "./protocols.ts";
import { isEnvelope, RpcEndpoint, type RpcPort } from "./rpc-endpoint.ts";

interface LinkProgressShared {
  readonly kind: "progress";
}

const SHARED: LinkProgressShared = { kind: "progress" };

function isLinkProgressEnvelope(data: unknown): boolean {
  return (
    isEnvelope(data) &&
    data.protocol === LINK_PROGRESS_PROTOCOL.name &&
    data.version === LINK_PROGRESS_PROTOCOL.version
  );
}

function linkProgressOnly(channel: RpcPort): RpcPort {
  return {
    postMessage: (message, transfer) => channel.postMessage(message, transfer),
    addEventListener: (type, listener) =>
      channel.addEventListener(type, (event) => {
        if (isLinkProgressEnvelope(event.data)) listener(event);
      }),
  };
}

class LinkProgressBroadcast {
  private readonly endpoint: RpcEndpoint<LinkProgressShared, LinkProgressShared>;
  private readonly listeners: Array<() => void> = [];

  constructor(port: RpcPort) {
    this.endpoint = new RpcEndpoint(port, LINK_PROGRESS_PROTOCOL);
    this.endpoint.listen(() => {
      for (const listener of this.listeners) listener();
    });
  }

  share(): void {
    this.endpoint.post(SHARED);
  }

  listen(listener: () => void): void {
    this.listeners.push(listener);
  }
}

export function openLinkProgressBroadcast(): LinkProgressBroadcast {
  const { name, version } = LINK_PROGRESS_PROTOCOL;
  return new LinkProgressBroadcast(linkProgressOnly(new BroadcastChannel(`${name}.v${version}`)));
}
