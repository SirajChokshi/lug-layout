import { AssetStalledError } from "../asset-stalled-error.ts";
import type { ILinkProgress } from "./link-progress.ts";

export const LINK_SILENCE_LIMIT_MS = 55_000;

interface MarkedBody {
  readonly chunks: Uint8Array[];
  readonly length: number;
}

class SilenceWatch {
  readonly signal: AbortSignal;
  readonly stalled: Promise<never>;
  private timer: ReturnType<typeof setTimeout>;

  constructor(url: string, link: ILinkProgress) {
    const controller = new AbortController();
    const { promise, reject } = Promise.withResolvers<never>();
    this.signal = controller.signal;
    this.stalled = promise;
    const check = (): void => {
      const remainingMs = LINK_SILENCE_LIMIT_MS - link.silenceMs();
      if (remainingMs > 0) {
        this.timer = setTimeout(check, Math.ceil(remainingMs));
        return;
      }
      reject(new AssetStalledError(url, LINK_SILENCE_LIMIT_MS));
      controller.abort();
    };
    this.timer = setTimeout(check, LINK_SILENCE_LIMIT_MS);
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}

export async function silenceBounded<T>(
  url: string,
  link: ILinkProgress,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const watch = new SilenceWatch(url, link);
  try {
    return await Promise.race([watch.stalled, read(watch.signal)]);
  } finally {
    watch.stop();
  }
}

export async function markedBody(
  body: ReadableStream<Uint8Array>,
  link: ILinkProgress,
): Promise<MarkedBody> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    link.markProgress();
    chunks.push(read.value);
    length += read.value.byteLength;
  }
  return { chunks, length };
}
