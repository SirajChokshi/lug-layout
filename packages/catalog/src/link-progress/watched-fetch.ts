import type { ILinkProgress } from "./link-progress.ts";
import { markedBody, silenceBounded } from "./silence-watch.ts";

type AbortableFetch = (url: string, signal: AbortSignal) => Promise<Response>;

function streamTaking(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
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
      const { chunks } = await markedBody(response.body, link);
      return new Response(streamTaking(chunks), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    });
}
