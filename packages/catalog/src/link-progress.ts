export const LINK_PROGRESS_MIN_SHARE_GAP_MS = 1000;

export interface ILinkProgressShare {
  share(): void;
  listen(listener: () => void): void;
}

export interface ILinkProgress {
  markProgress(): void;
  silenceMs(): number;
}

export class LinkProgress implements ILinkProgress {
  private lastProgressAt = Number.NEGATIVE_INFINITY;
  private lastSharedAt = Number.NEGATIVE_INFINITY;
  private readonly peers: ILinkProgressShare;

  constructor(peers: ILinkProgressShare) {
    this.peers = peers;
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

function reportingBody(
  body: ReadableStream<Uint8Array>,
  link: ILinkProgress,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      const read = await reader.read();
      if (read.done) {
        controller.close();
        return;
      }
      link.markProgress();
      controller.enqueue(read.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export function reportingFetch(
  fetchUrl: (url: string) => Promise<Response>,
  link: ILinkProgress,
): (url: string) => Promise<Response> {
  return async (url) => {
    const response = await fetchUrl(url);
    link.markProgress();
    if (response.body === null) return response;
    return new Response(reportingBody(response.body, link), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
