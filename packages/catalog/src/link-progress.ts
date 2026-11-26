export const LINK_PROGRESS_CHANNEL = "brr.link-progress";
export const LINK_PROGRESS_SHARE_EVERY_MS = 1000;

export interface LinkChannel {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: () => void): void;
}

export interface ILinkProgress {
  mark(): void;
  quietMs(): number;
}

export class LinkProgress implements ILinkProgress {
  private lastAt = Number.NEGATIVE_INFINITY;
  private lastSharedAt = Number.NEGATIVE_INFINITY;
  private readonly channel: LinkChannel;

  constructor(channel: LinkChannel) {
    this.channel = channel;
    channel.addEventListener("message", () => {
      this.lastAt = performance.now();
    });
  }

  mark(): void {
    const now = performance.now();
    this.lastAt = now;
    if (now - this.lastSharedAt < LINK_PROGRESS_SHARE_EVERY_MS) return;
    this.lastSharedAt = now;
    this.channel.postMessage(null, []);
  }

  quietMs(): number {
    return performance.now() - this.lastAt;
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
      link.mark();
      controller.enqueue(read.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export function reportingProgress(
  fetchUrl: (url: string) => Promise<Response>,
  link: ILinkProgress,
): (url: string) => Promise<Response> {
  return async (url) => {
    const response = await fetchUrl(url);
    link.mark();
    if (response.body === null) return response;
    return new Response(reportingBody(response.body, link), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
