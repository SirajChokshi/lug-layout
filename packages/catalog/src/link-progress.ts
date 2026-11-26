export const LINK_PROGRESS_MIN_SHARE_GAP_MS = 1000;

export interface ILinkShare {
  share(): void;
  onShared(listener: () => void): void;
}

export interface ILinkProgress {
  markProgress(): void;
  silenceMs(): number;
}

export class LinkProgress implements ILinkProgress {
  private lastProgressAt = Number.NEGATIVE_INFINITY;
  private lastSharedAt = Number.NEGATIVE_INFINITY;
  private readonly link: ILinkShare;

  constructor(link: ILinkShare) {
    this.link = link;
    link.onShared(() => {
      this.lastProgressAt = performance.now();
    });
  }

  markProgress(): void {
    const now = performance.now();
    this.lastProgressAt = now;
    if (now - this.lastSharedAt < LINK_PROGRESS_MIN_SHARE_GAP_MS) return;
    this.lastSharedAt = now;
    this.link.share();
  }

  silenceMs(): number {
    return performance.now() - this.lastProgressAt;
  }
}

export function reportingFetch(
  fetchUrl: (url: string) => Promise<Response>,
  link: ILinkProgress,
): (url: string) => Promise<Response> {
  return async (url) => {
    const response = await fetchUrl(url);
    link.markProgress();
    if (response.body === null) return response;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          link.markProgress();
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
