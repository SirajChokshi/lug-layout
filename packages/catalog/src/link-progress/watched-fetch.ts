import type { ILinkProgress } from "./link-progress.ts";
import { markedChunks, silenceBounded } from "./silence-watch.ts";

export type AbortableFetch = (url: string, signal: AbortSignal) => Promise<Response>;

function replayed(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks.splice(0)) controller.enqueue(chunk);
      controller.close();
    },
  });
}

export function watchedFetch(
  fetchUrl: AbortableFetch,
  link: ILinkProgress,
): (url: string) => Promise<Response> {
  return (url) =>
    silenceBounded(url, link, async (signal) => {
      const response = await fetchUrl(url, signal);
      link.markProgress();
      if (response.body === null) return response;
      const { chunks } = await markedChunks(response.body, link);
      return new Response(replayed(chunks), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    });
}
